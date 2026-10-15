import { agnesMediaUrls, normalizeAgnesParams, type AgnesVideoParams } from '../../../shared/videoApi'
import { AppError, providerIncompatible, uncertainOutcome, errorMeta } from '../../lib/errors'
import { callProvider, parseRetryAfterSeconds, readProviderError, type ProviderResponse } from '../../providers/client'
import { pinGenerationTarget, poolExhaustedError, submitWithPool } from '../../providers/pool'
import { guardProviderUrl } from '../../providers/urlGuard'
import type { GenerationContext, GenerationRow } from '../types'
import { normalizeState, readVideoContent, recordPinnedResult, sanitizeDiagnostic, type VideoJobSnapshot } from './video'

/** Only server-issued source grants are bearer secrets; ordinary media/prompt text is not. */
export function collectGenerationMediaSecrets(generation: Pick<GenerationRow, 'params_json'>): string[] {
  let params: unknown
  try { params = JSON.parse(generation.params_json) } catch { return [] }
  if (!params || typeof params !== 'object' || Array.isArray(params)) return []
  const references = (params as { referenceImages?: unknown }).referenceImages
  if (!Array.isArray(references)) return []
  const secrets = new Set<string>()
  for (const reference of references) {
    if (typeof reference !== 'string') continue
    try {
      const url = new URL(reference)
      if (!['https:', 'http:'].includes(url.protocol) || !url.pathname.includes('/api/provider-media/')) continue
      secrets.add(reference)
      const token = url.pathname.split('/').at(-1)
      if (token && /^[a-f0-9]+$/i.test(token) && token.length >= 4) secrets.add(token)
    } catch { /* Not a recognized grant URL. */ }
  }
  return [...secrets]
}

/** Keep error semantics/metadata, but redact every diagnostic before any length limit. */
function sanitizeAgnesError(error: unknown, secrets: string[]): unknown {
  if (error instanceof AppError) {
    const clean = (value: unknown): unknown => {
      if (typeof value === 'string') return sanitizeDiagnostic(value, secrets)
      if (Array.isArray(value)) return value.map(clean)
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)]))
      return value
    }
    return new AppError(error.status, error.code, sanitizeDiagnostic(error.message, secrets), clean(error.details), {
      messageKey: error.messageKey, messageParams: clean(error.messageParams) as AppError['messageParams'],
    })
  }
  return error instanceof Error ? new Error(sanitizeDiagnostic(error.message, secrets)) : error
}

export async function guardAgnesMedia(params: AgnesVideoParams): Promise<void> {
  for (const url of agnesMediaUrls(params)) await guardProviderUrl(url, { allowPrivate: false, allowHttp: true })
}

export function buildAgnesRequestBody(modelId: string, prompt: string, params: AgnesVideoParams): Record<string, unknown> {
  const p = normalizeAgnesParams(modelId, params)
  const body: Record<string, unknown> = { model: modelId, prompt, mode: p.mode }
  for (const field of ['size', 'seconds', 'n', 'seed'] as const) if (p[field] !== undefined) body[field] = p[field]
  if (p.aspectRatio !== undefined) body.aspect_ratio = p.aspectRatio
  if (p.mode === 'keyframe') {
    if (p.firstFrame !== undefined) body.first_frame = p.firstFrame
    if (p.lastFrame !== undefined) body.last_frame = p.lastFrame
  }
  if (p.mode === 'reference') {
    if (p.referenceImages?.length) body.images = p.referenceImages
    if (p.referenceAudios?.length) body.audios = p.referenceAudios
  }
  return body
}

/** POST requires video_id; GET deliberately does not require any id field. */
export function readAgnesJob(payload: unknown, submitted: boolean, jobId = '', secrets: string[] = []): VideoJobSnapshot {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw providerIncompatible('Invalid Agnes video response')
  const p = payload as Record<string, unknown>
  const id = submitted ? typeof p.video_id === 'string' ? p.video_id : '' : jobId
  if (submitted && !id.trim()) throw providerIncompatible('Agnes did not return video_id', undefined, errorMeta('agnes.video_id_missing'))
  const state = submitted && p.status === undefined ? 'queued' : normalizeState(p.status)
  if (!state) throw providerIncompatible('Unsupported Agnes video status', undefined, errorMeta('agnes.status_invalid'))
  const progress = typeof p.progress === 'number' && Number.isFinite(p.progress) ? Math.max(0, Math.min(100, p.progress)) : null
  const resultUrl = state === 'completed' && typeof p.url === 'string' ? p.url : null
  if (state === 'completed' && !resultUrl) throw providerIncompatible('Agnes completed video has no URL', undefined, errorMeta('agnes.result_missing'))
  const error = typeof p.error === 'string' ? p.error : p.error && typeof p.error === 'object' ? (p.error as { message?: unknown }).message : null
  return { id, state, progress, resultUrl, errorMessage: typeof error === 'string' ? sanitizeDiagnostic(error, secrets) : null }
}

function rootEndpoint(context: GenerationContext, path: string): string {
  return new URL(path, new URL(context.provider.baseUrl).origin).toString()
}

function safeRequestId(response: ProviderResponse, secrets: string[]): string | undefined {
  for (const header of ['x-request-id', 'request-id', 'x-correlation-id']) {
    const raw = response.headers.get(header)
    if (raw?.trim()) return sanitizeDiagnostic(raw, secrets).replace(/[\r\n\t]/g, ' ').slice(0, 160)
  }
  return undefined
}

export async function startAgnesVideo(context: GenerationContext): Promise<{ providerJobId: string; progress: number | null }> {
  const { generation, provider } = context
  const mediaSecrets = collectGenerationMediaSecrets(generation)
  const initialSecrets = [provider.apiKey, ...mediaSecrets]
  let params: AgnesVideoParams
  try {
    params = normalizeAgnesParams(generation.snap_model_id, JSON.parse(generation.params_json))
    await guardAgnesMedia(params)
  } catch (error) { throw sanitizeAgnesError(error, initialSecrets) }
  if (!generation.provider_id) throw providerIncompatible('Video has no provider')
  const outcome = await submitWithPool({
    db: context.db, env: context.env, providerId: generation.provider_id, initial: provider,
    onAttempt: target => pinGenerationTarget(context.db, generation.id, target),
    call: async target => {
      try {
        return await callProvider(target, 'videos', {
          method: 'POST', body: buildAgnesRequestBody(generation.snap_model_id, generation.effective_prompt ?? generation.prompt, params), timeoutMs: 120_000,
        })
      } catch (error) { throw sanitizeAgnesError(error, [...initialSecrets, target.apiKey]) }
    },
  })
  const secrets = [...initialSecrets, outcome.target.apiKey]
  if (!outcome.response.ok) {
    if (outcome.exhausted) throw sanitizeAgnesError(poolExhaustedError(outcome.response, outcome.target), secrets)
    const detail = await readProviderError(outcome.response, secrets)
    // Only Agnes' explicit admission rejection is safe to retry. Generic 5xx,
    // timeouts and malformed success responses remain uncertain (no extra POST).
    if (outcome.response.status === 503 && /^video queue is full, please retry later(?:\s*\(request id:\s*[^\r\n()]+\))?\.?$/i.test(detail.trim())) {
      const retryAfter = Math.min(900, Math.max(30, parseRetryAfterSeconds(outcome.response.headers) ?? 60))
      const requestId = safeRequestId(outcome.response, secrets)
      throw new AppError(503, 'AGNES_QUEUE_FULL', 'Agnes video queue is full; waiting to retry.',
        { retryAfterSeconds: retryAfter },
        errorMeta('agnes.queue_full', { retryAfter, detail, ...(requestId ? { requestId } : {}) }))
    }
    if (outcome.response.status >= 500) {
      const status = outcome.response.status
      const requestId = safeRequestId(outcome.response, secrets)
      throw uncertainOutcome(
        `Agnes returned HTTP ${status}: ${detail}. Task creation is unconfirmed; check Agnes before submitting again.`,
        { status, detail, ...(requestId ? { requestId } : {}) },
        errorMeta('agnes.submit_http_unknown', { status, detail, ...(requestId ? { requestId } : {}) }),
      )
    }
    throw providerIncompatible(detail, { status: outcome.response.status }, errorMeta('generations.video_request_rejected', { detail }))
  }
  let snapshot: VideoJobSnapshot
  try { snapshot = readAgnesJob(await outcome.response.json(), true, '', secrets) }
  catch {
    const status = outcome.response.status
    const requestId = safeRequestId(outcome.response, secrets)
    throw uncertainOutcome(
      `Agnes returned HTTP ${status} but did not return a readable video_id. Do not resubmit automatically.`,
      { status, ...(requestId ? { requestId } : {}) },
      errorMeta('agnes.submit_id_unknown', { status, ...(requestId ? { requestId } : {}) }),
    )
  }
  if (snapshot.state === 'failed') throw providerIncompatible(snapshot.errorMessage ?? 'Agnes video failed')
  if (snapshot.resultUrl) {
    await guardResultUrl(snapshot.resultUrl, secrets)
    persistResult(context, snapshot.resultUrl)
  }
  return { providerJobId: snapshot.id, progress: snapshot.progress }
}

async function guardResultUrl(url: string, secrets: string[]): Promise<void> {
  try { await guardProviderUrl(url, { allowPrivate: false, allowHttp: true }) }
  catch (error) {
    // A malicious result hostname can contain the key or signed tokens. Never echo it.
    throw providerIncompatible(sanitizeDiagnostic('Agnes result URL is invalid or not publicly accessible', secrets), undefined, errorMeta('agnes.invalid_result_url'))
  }
}

function persistResult(context: GenerationContext, url: string): void {
  context.db.prepare('UPDATE generations SET provider_result_url = ?, updated_at = ? WHERE id = ?').run(url, Date.now(), context.generation.id)
  context.generation.provider_result_url = url
}

async function pinnedRead(context: GenerationContext, url: string, media = false): Promise<ProviderResponse> {
  const secrets = [context.provider.apiKey, ...collectGenerationMediaSecrets(context.generation)]
  let response: ProviderResponse
  try {
    response = await callProvider(context.provider, '', { absoluteUrl: url, publicMedia: media, timeoutMs: media ? 300_000 : 30_000, headers: media ? { Accept: 'video/mp4' } : undefined })
  } catch (error) {
    const message = sanitizeDiagnostic(error instanceof Error ? error.message : 'Agnes network error', secrets)
    recordPinnedResult(context, { message })
    throw providerIncompatible(message)
  }
  if (!response.ok) {
    const detail = await readProviderError(response, secrets)
    recordPinnedResult(context, { status: response.status, retryAfterSeconds: parseRetryAfterSeconds(response.headers), message: detail })
    throw providerIncompatible(detail)
  }
  recordPinnedResult(context, { status: response.status, ok: true })
  return response
}

export async function pollAgnesVideo(context: GenerationContext): Promise<VideoJobSnapshot> {
  const secrets = [context.provider.apiKey, ...collectGenerationMediaSecrets(context.generation)]
  const id = context.generation.provider_job_id
  if (!id) throw providerIncompatible('Video has no video_id')
  // Persisted completion survives restart and download retry without POST or even a new poll.
  if (context.generation.provider_result_url) return { id, state: 'completed', progress: 100, errorMessage: null, resultUrl: context.generation.provider_result_url }
  const url = new URL(rootEndpoint(context, '/agnesapi'))
  url.searchParams.set('video_id', id)
  url.searchParams.set('model_name', context.generation.snap_model_id)
  const response = await pinnedRead(context, url.toString())
  let snapshot: VideoJobSnapshot
  try { snapshot = readAgnesJob(await response.json(), false, id, secrets) }
  catch (error) { throw providerIncompatible(sanitizeDiagnostic(error instanceof Error ? error.message : 'Invalid Agnes payload', secrets)) }
  if (snapshot.resultUrl) {
    await guardResultUrl(snapshot.resultUrl, secrets)
    persistResult(context, snapshot.resultUrl)
  }
  return snapshot
}

export async function downloadAgnesVideo(context: GenerationContext): Promise<Uint8Array> {
  const url = context.generation.provider_result_url
  if (!url) throw providerIncompatible('Agnes video has no completed URL')
  const response = await pinnedRead(context, url, true)
  const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  if (type && type !== 'video/mp4' && type !== 'application/octet-stream') throw providerIncompatible('Agnes result is not MP4', undefined, errorMeta('agnes.not_mp4'))
  let bytes: Uint8Array
  try { bytes = await readVideoContent(context, response) }
  catch (error) { throw sanitizeAgnesError(error, [context.provider.apiKey, ...collectGenerationMediaSecrets(context.generation)]) }
  // ISO BMFF MP4 signature: do not trust a CDN filename or Content-Type alone.
  if (bytes.length < 12 || Buffer.from(bytes.subarray(4, 8)).toString('ascii') !== 'ftyp') throw providerIncompatible('Agnes result is not MP4', undefined, errorMeta('agnes.not_mp4'))
  return bytes
}
