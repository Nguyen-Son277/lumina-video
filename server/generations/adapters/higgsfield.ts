import { randomUUID } from 'node:crypto'
import { normalizeHiggsfieldParams, type HiggsfieldParams } from '../../../shared/higgsfield'
import { AppError, errorMeta, providerIncompatible, uncertainOutcome } from '../../lib/errors'
import { callProvider, parseRetryAfterSeconds, type ProviderResponse } from '../../providers/client'
import { guardProviderUrl } from '../../providers/urlGuard'
import { sniffMime } from '../../media/store'
import type { GenerationContext } from '../types'
import { readVideoContent, sanitizeDiagnostic, type VideoJobSnapshot } from './video'

export type HiggsfieldOperation = {
  key: string; endpoint?: string; body?: Record<string, unknown>; firstSentAt?: number
  attempts: number; pollAttempts?: number; frames?: Record<string, string>
  statusUrl?: string; cancelUrl?: string
}
export function operation(context: GenerationContext): HiggsfieldOperation {
  return context.generation.higgsfield_json ? JSON.parse(context.generation.higgsfield_json) : { key: randomUUID(), attempts: 0 }
}
function persist(context: GenerationContext, op: HiggsfieldOperation, state?: string): void {
  const json = JSON.stringify(op)
  context.db.prepare('UPDATE generations SET higgsfield_json = ?, provider_status = COALESCE(?, provider_status), updated_at = ? WHERE id = ?').run(json, state ?? null, Date.now(), context.generation.id)
  context.generation.higgsfield_json = json
}
function secrets(context: GenerationContext): string[] {
  const op = context.generation.higgsfield_json ? JSON.parse(context.generation.higgsfield_json) as HiggsfieldOperation : null
  return [context.provider.apiKey, ...context.provider.apiKey.split(':'), ...Object.values(op?.frames ?? {})]
}
export async function withHiggsfieldDiagnostics<T>(context: GenerationContext, call: () => Promise<T>): Promise<T> {
  try { return await call() } catch (error) {
    const redact = (v: unknown): unknown => typeof v === 'string' ? sanitizeDiagnostic(v, secrets(context)) : Array.isArray(v) ? v.map(redact) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, item]) => [k, redact(item)])) : v
    if (error instanceof AppError) throw new AppError(error.status, error.code, String(redact(error.message)), redact(error.details), { messageKey: error.messageKey, messageParams: redact(error.messageParams) as AppError['messageParams'] })
    throw new Error(String(redact(error instanceof Error ? error.message : 'Higgsfield request failed')))
  }
}
async function detail(context: GenerationContext, response: ProviderResponse): Promise<string> {
  try {
    const text = await response.text(); let value: unknown
    try { const p = JSON.parse(text); value = p.detail ?? p.error?.message ?? p.message ?? text } catch { value = text }
    return sanitizeDiagnostic(typeof value === 'string' ? value : JSON.stringify(value), secrets(context))
  } catch { return `HTTP ${response.status}` }
}
function target(context: GenerationContext) { return { ...context.provider, authScheme: 'higgsfield' as const } }
/** Never authenticate an arbitrary provider-returned URL. */
export function guardedRequestUrl(baseUrl: string, requestId: string, action: 'status' | 'cancel', supplied?: unknown): string {
  const expected = new URL(`/requests/${encodeURIComponent(requestId)}/${action}`, baseUrl)
  if (supplied !== undefined) {
    if (typeof supplied !== 'string') throw providerIncompatible('Invalid Higgsfield request URL')
    const url = new URL(supplied)
    if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.search || url.hash || url.username || url.password) throw providerIncompatible('Unexpected Higgsfield request URL')
  }
  return expected.toString()
}
async function uploadFrame(context: GenerationContext, p: HiggsfieldParams, prefix: 'image' | 'endImage'): Promise<string | undefined> {
  const url = p[`${prefix}Url`]
  if (typeof url === 'string') { await guardProviderUrl(url, { allowPrivate: false }); return url }
  const uploadId = p[`${prefix}UploadId`], assetId = p[`${prefix}AssetId`]
  if (!uploadId && !assetId) return undefined
  const row = uploadId
    ? context.db.prepare('SELECT relative_path AS path, mime_type AS mime FROM uploads WHERE id = ? AND user_id = ?').get(String(uploadId), context.generation.user_id)
    : context.db.prepare("SELECT a.relative_path AS path, a.mime_type AS mime FROM assets a JOIN generations g ON g.id = a.generation_id WHERE a.id = ? AND a.user_id = ? AND g.deleted_at IS NULL AND a.mime_type LIKE 'image/%'").get(String(assetId), context.generation.user_id)
  if (!row) throw providerIncompatible('Input frame is no longer available')
  const bytes = context.mediaStore.readFile(String(row.path))
  const mime = sniffMime(bytes)
  if (!mime?.startsWith('image/') || bytes.byteLength > context.env.MAX_SOURCE_IMAGE_BYTES) throw providerIncompatible('Invalid input frame')
  const response = await callProvider(target(context), 'files/generate-upload-url', { method: 'POST', body: { content_type: mime } })
  if (!response.ok) throw providerIncompatible(await detail(context, response))
  const upload = await response.json() as { public_url?: string; upload_url?: string; upload_headers?: Record<string, string> }
  if (!upload.public_url || !upload.upload_url) throw providerIncompatible('Invalid Higgsfield upload receipt')
  await guardProviderUrl(upload.public_url, { allowPrivate: false })
  const guarded = await guardProviderUrl(upload.upload_url, { allowPrivate: false })
  // callProvider pins DNS and disallows redirects. Use raw body without auth.
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(upload.upload_headers ?? {})) {
    if (!/^(content-type|x-amz-[a-z0-9-]+|x-goog-[a-z0-9-]+|x-ms-[a-z0-9-]+)$/i.test(name) || typeof value !== 'string' || /[\r\n]/.test(value)) throw providerIncompatible('Unsafe Higgsfield upload headers')
    headers[name] = value
  }
  if (!Object.keys(headers).some(name => name.toLowerCase() === 'content-type')) headers['Content-Type'] = mime
  const put = await callProvider(target(context), '', { absoluteUrl: guarded.url.toString(), publicMedia: true, method: 'PUT', sendApiKey: false, rawBody: bytes, headers })
  if (!put.ok) throw providerIncompatible('Higgsfield input upload failed')
  return upload.public_url
}
export async function startHiggsfieldVideo(context: GenerationContext): Promise<{ providerJobId: string; progress: number | null }> {
  const op = operation(context)
  if (!op.body) {
    persist(context, op)
    const p = normalizeHiggsfieldParams(JSON.parse(context.generation.params_json), context.generation.prompt)
    op.frames ??= {}
    for (const prefix of ['image', 'endImage'] as const) {
      if (!op.frames[prefix]) {
        const url = await uploadFrame(context, p, prefix)
        if (url) { op.frames[prefix] = url; persist(context, op) }
      }
    }
    op.endpoint = `bytedance/seedance-2.5/${p.mode === 'image' ? 'image-to-video' : 'text-to-video'}`
    op.body = { duration: p.duration, resolution: p.resolution, bitrate_mode: p.bitrateMode, generate_audio: p.generateAudio }
    const prompt = context.generation.effective_prompt ?? context.generation.prompt
    if (prompt.trim()) op.body.prompt = prompt
    if (p.mode === 'text') { op.body.aspect_ratio = p.aspectRatio; op.body.output_format = p.outputFormat }
    else { op.body.image_url = op.frames.image; if (op.frames.endImage) op.body.end_image_url = op.frames.endImage }
  }
  if (op.firstSentAt && (op.attempts >= 6 || Date.now() - op.firstSentAt > 600_000)) throw uncertainOutcome('Higgsfield submission retry deadline exceeded. Do not create a new request automatically.')
  op.attempts++; op.firstSentAt ??= Date.now(); persist(context, op)
  let response: ProviderResponse
  try { response = await callProvider(target(context), op.endpoint!, { method: 'POST', body: op.body, headers: { 'Idempotency-Key': op.key }, timeoutMs: 120_000 }) }
  catch { throw retrySubmit(context, op) }
  if (!response.ok) {
    if (response.status >= 500 || [423, 429].includes(response.status)) throw retrySubmit(context, op, parseRetryAfterSeconds(response.headers))
    throw providerIncompatible(await detail(context, response), { status: response.status })
  }
  let receipt: { request_id?: unknown; status_url?: unknown; cancel_url?: unknown }
  try { receipt = await response.json() as typeof receipt } catch { throw retrySubmit(context, op) }
  if (typeof receipt?.request_id !== 'string' || !receipt.request_id.trim()) throw retrySubmit(context, op)
  op.statusUrl = guardedRequestUrl(context.provider.baseUrl, receipt.request_id, 'status', receipt.status_url)
  op.cancelUrl = guardedRequestUrl(context.provider.baseUrl, receipt.request_id, 'cancel', receipt.cancel_url)
  persist(context, op, 'queued')
  context.db.prepare('UPDATE generations SET provider_job_id = ? WHERE id = ?').run(receipt.request_id, context.generation.id)
  return { providerJobId: receipt.request_id, progress: null }
}
function retrySubmit(context: GenerationContext, op: HiggsfieldOperation, retryAfter?: number | null): AppError {
  if (op.attempts >= 6 || Date.now() - (op.firstSentAt ?? Date.now()) > 600_000) return uncertainOutcome('Higgsfield submission could not be reconciled. Keep the same request identity when retrying.')
  return new AppError(503, 'HIGGSFIELD_REPLAY', 'Waiting to reconcile Higgsfield submission.', undefined,
    errorMeta('higgsfield.retrying', { retryAfter: Math.min(900, Math.max(retryAfter ?? 0, Math.min(30, 2 ** op.attempts) + Math.random() * 0.5)) }))
}
export async function pollHiggsfieldVideo(context: GenerationContext): Promise<VideoJobSnapshot> {
  const id = context.generation.provider_job_id!
  if (context.generation.provider_result_url) return { id, state: 'completed', progress: 100, errorMessage: null, resultUrl: context.generation.provider_result_url }
  const op = operation(context)
  const url = guardedRequestUrl(context.provider.baseUrl, id, 'status', op.statusUrl)
  const response = await callProvider(target(context), '', { absoluteUrl: url, timeoutMs: 30_000 })
  if (!response.ok) {
    if ([401,403,404].includes(response.status)) throw new AppError(502, 'HIGGSFIELD_POLL_STOP', 'Higgsfield status polling stopped.', undefined, errorMeta('higgsfield.poll_stopped', { detail: await detail(context, response) }))
    throw providerIncompatible(await detail(context, response))
  }
  const p = await response.json() as { request_id?: string; status?: string; video?: { url?: string }; error?: string }
  if (p.request_id !== id || !['queued','in_progress','completed','failed','nsfw','canceled'].includes(p.status ?? '')) throw providerIncompatible('Invalid Higgsfield status payload')
  op.pollAttempts = (op.pollAttempts ?? 0) + 1
  persist(context, op, p.status)
  if (p.status === 'canceled') throw new AppError(409, 'CANCELLED', 'Video creation stopped.', undefined, errorMeta('generations.cancelled'))
  if (p.status === 'nsfw') throw new AppError(502, 'HIGGSFIELD_NSFW', 'Higgsfield content moderation rejected the video.', undefined, errorMeta('higgsfield.nsfw'))
  const resultUrl = p.status === 'completed' ? p.video?.url : null
  if (p.status === 'completed') {
    if (!resultUrl) throw providerIncompatible('Higgsfield completed video has no URL')
    await guardProviderUrl(resultUrl, { allowPrivate: false })
    context.db.prepare('UPDATE generations SET provider_result_url = ? WHERE id = ?').run(resultUrl, context.generation.id)
    context.generation.provider_result_url = resultUrl
  }
  return { id, state: p.status === 'completed' ? 'completed' : p.status === 'failed' ? 'failed' : p.status === 'queued' ? 'queued' : 'in_progress', progress: null, resultUrl: resultUrl ?? null, errorMessage: p.error ? sanitizeDiagnostic(p.error, secrets(context)) : null }
}
export async function cancelHiggsfieldVideo(context: GenerationContext): Promise<boolean> {
  const id = context.generation.provider_job_id
  if (!id) return false
  const op = operation(context)
  const response = await callProvider(target(context), '', { absoluteUrl: guardedRequestUrl(context.provider.baseUrl, id, 'cancel', op.cancelUrl), method: 'POST', timeoutMs: 30_000 })
  if (response.status === 202) return true
  if (response.status === 400) return false
  throw providerIncompatible(await detail(context, response))
}
export async function downloadHiggsfieldVideo(context: GenerationContext): Promise<Uint8Array> {
  const url = context.generation.provider_result_url
  if (!url) throw providerIncompatible('Higgsfield video has no result URL')
  const response = await callProvider(target(context), '', { absoluteUrl: url, publicMedia: true, sendApiKey: false, headers: { Accept: 'video/*' }, timeoutMs: 300_000 })
  if (!response.ok) throw providerIncompatible('Higgsfield video download failed')
  const bytes = await readVideoContent(context, response)
  if (!['video/mp4','video/quicktime'].includes(sniffMime(bytes) ?? '')) throw providerIncompatible('Higgsfield result is not MP4/MOV')
  return bytes
}
