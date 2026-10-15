import { createServer, type Server, type RequestListener } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { normalizeHiggsfieldParams } from '../../shared/higgsfield'
import { guardedRequestUrl } from '../../server/generations/adapters/higgsfield'
import { call, registerUser, startTestServer, type TestContext } from './helpers'
import { createWorker } from '../../server/generations/worker'

const requestId = 'd7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff'
const mp4 = Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex')
afterEach(() => vi.restoreAllMocks())
async function fixture(handler: RequestListener) {
  const server = createServer(handler)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const ctx = await startTestServer({ allowPrivate: true, providerMode: 'live' })
  await registerUser(ctx)
  vi.spyOn(ctx.worker, 'wake').mockImplementation(() => {})
  const provider = await call(ctx, '/api/providers', { method: 'POST', body: { name: 'HF', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: 'hf-id-123:hf-secret-456', authScheme: 'higgsfield' } })
  expect(provider.status).toBe(201)
  const models = await call(ctx, '/api/models')
  return { ctx, server, providerId: provider.body.provider.id, modelId: models.body.models[0].id }
}
async function close(ctx: TestContext, server: Server) { await ctx.close(); await new Promise<void>(r => server.close(() => r())) }
const row = (ctx: TestContext, id: string): any => ctx.db.prepare('SELECT * FROM generations WHERE id = ?').get(id)

it('validates full credential format on create and replacement without echoing input', async () => {
  const { ctx, server, providerId } = await fixture((req, res) => res.end('{}'))
  try {
    const list = await call(ctx, `/api/providers/${providerId}/credentials`)
    const keyId = list.body.credentials[0].id
    for (const value of ['missing-colon', ':secret', 'id:', 'id:secret:extra', 'id:sec ret']) {
      const results = await Promise.all([
        call(ctx, `/api/providers/${providerId}/credentials`, { method: 'POST', body: { apiKey: value } }),
        call(ctx, `/api/providers/${providerId}/credentials/${keyId}`, { method: 'PATCH', body: { apiKey: value } }),
        call(ctx, `/api/providers/${providerId}`, { method: 'PATCH', body: { apiKey: value } }),
      ])
      for (const result of results) {
        expect(result.status).toBe(400)
        expect(JSON.stringify(result.body)).not.toContain(value)
      }
    }
    const result = await call(ctx, `/api/providers/${providerId}/credentials`, { method: 'POST', body: { apiKey: '  fake-new-id:fake-new-secret  ' } })
    expect(result.status).toBe(201)
    expect(JSON.stringify(result.body)).not.toContain('fake-new-id:fake-new-secret')
  } finally { await close(ctx, server) }
})
it('validates separate schemas and rejects unsupported image/text fields', () => {
  expect(normalizeHiggsfieldParams({}, 'P')).toMatchObject({ mode: 'text', duration: 5, resolution: '720p', outputFormat: 'mp4' })
  expect(normalizeHiggsfieldParams({ mode: 'image', imageUrl: 'https://8.8.8.8/start.jpg' }, '')).toMatchObject({ mode: 'image' })
  for (const p of [{ duration: 3 }, { duration: 31 }, { duration: 4.5 }, { resolution: '4k' }, { bitrateMode: 'max' }, { generateAudio: 'true' }, { outputFormat: 'webm' }, { aspectRatio: '2:1' }, { imageUrl: 'https://8.8.8.8/a' }, { mode: 'image' }, { mode: 'image', imageUrl: 'https://8.8.8.8/a', aspectRatio: '16:9' }, { mode: 'image', imageUrl: 'https://8.8.8.8/a', outputFormat: 'mp4' }, { mode: 'image', imageUrl: 'asset://a' }, { mode: 'image', imageUrl: 'https://8.8.8.8/a', imageUploadId: 'u' }, { referenceImages: [] }]) expect(() => normalizeHiggsfieldParams(p as any, 'P')).toThrow()
  expect(() => normalizeHiggsfieldParams({}, '  ')).toThrow()
})
it('rejects cross-origin status/cancel URLs', () => {
  expect(guardedRequestUrl('https://api.higgsfield.ai', requestId, 'status')).toContain(`/requests/${requestId}/status`)
  for (const url of ['https://evil.example/a', `https://api.higgsfield.ai/requests/wrong/status`, `https://api.higgsfield.ai/requests/${requestId}/status?key=secret`]) expect(() => guardedRequestUrl('https://api.higgsfield.ai', requestId, 'status', url)).toThrow()
})
it('uses Key auth, immutable idempotency replay after 503 and recovers after restart', async () => {
  const requests: any[] = []
  const { ctx, server, modelId } = await fixture(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    requests.push({ url: req.url, auth: req.headers.authorization, key: req.headers['idempotency-key'], body: raw ? JSON.parse(raw) : null })
    if (requests.length === 1) { res.statusCode = 503; res.end('{"detail":"retry later"}') }
    else res.end(JSON.stringify({ status: 'queued', request_id: requestId }))
  })
  let restarted: ReturnType<typeof createWorker> | undefined
  try {
    const created = await call(ctx, '/api/generations', { method: 'POST', body: { modelId, prompt: 'Ocean', params: {} } })
    expect(created.status).toBe(202)
    const id = created.body.generation.id
    await ctx.worker.tick()
    expect(row(ctx, id)).toMatchObject({ status: 'queued', error_code: 'HIGGSFIELD_REPLAY' })
    ctx.db.prepare("UPDATE generations SET status = 'running' WHERE id = ?").run(id)
    restarted = createWorker({ db: ctx.db, env: ctx.env, mediaStore: ctx.mediaStore })
    restarted.start()
    await restarted.stop()
    expect(requests).toHaveLength(2)
    expect(requests[0]).toEqual(requests[1])
    expect(requests[0]).toMatchObject({ auth: 'Key hf-id-123:hf-secret-456', url: '/bytedance/seedance-2.5/text-to-video', body: { prompt: 'Ocean', duration: 5, resolution: '720p', bitrate_mode: 'high', generate_audio: true, aspect_ratio: '16:9', output_format: 'mp4' } })
    expect(row(ctx, id)).toMatchObject({ status: 'running', provider_job_id: requestId })
    const publicJob = (await call(ctx, `/api/generations/${id}`)).body.generation
    expect(publicJob.canCancel).toBe(true)
    expect(JSON.stringify(publicJob)).not.toContain('hf-secret-456')
    expect(JSON.stringify(publicJob)).not.toContain('higgsfield_json')
  } finally { await restarted?.stop(); await close(ctx, server) }
})
it('rejects blank text but accepts image without prompt and omits foreign image fields', async () => {
  let received: any
  const { ctx, server, modelId } = await fixture(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    received = JSON.parse(raw); res.end(JSON.stringify({ request_id: requestId, status: 'queued' }))
  })
  try {
    expect((await call(ctx, '/api/generations', { method: 'POST', body: { modelId, prompt: ' ' } })).status).toBe(400)
    const created = await call(ctx, '/api/generations', { method: 'POST', body: { modelId, params: { mode: 'image', imageUrl: 'https://8.8.8.8/a.jpg' } } })
    expect(created.status).toBe(202)
    await ctx.worker.tick()
    expect(received.image_url).toBe('https://8.8.8.8/a.jpg')
    expect(received.prompt).toBeUndefined()
    expect(received.aspect_ratio).toBeUndefined()
    expect(received.output_format).toBeUndefined()
  } finally { await close(ctx, server) }
})
it('cancels an upstream queued request only after provider returns 202 without body', async () => {
  let cancels = 0
  const { ctx, server, modelId } = await fixture((req, res) => {
    if (req.url?.endsWith('/cancel')) { cancels++; expect(req.headers.authorization).toBe('Key hf-id-123:hf-secret-456'); res.statusCode = 202; res.end() }
    else res.end(JSON.stringify({ request_id: requestId, status: 'queued' }))
  })
  try {
    const created = await call(ctx, '/api/generations', { method: 'POST', body: { modelId, prompt: 'P' } })
    const id = created.body.generation.id
    await ctx.worker.tick()
    const cancel = await call(ctx, `/api/generations/${id}/cancel`, { method: 'POST' })
    expect(cancel.status).toBe(202)
    expect(row(ctx, id).status).toBe('running')
    await ctx.worker.tick()
    expect(cancels).toBe(1)
    expect(row(ctx, id)).toMatchObject({ status: 'failed', error_code: 'CANCELLED' })
  } finally { await close(ctx, server) }
})
it('reconciles a cancel requested during an in-flight submission instead of claiming success early', async () => {
  let cancels = 0
  const { ctx, server, modelId } = await fixture((req, res) => {
    if (req.url?.endsWith('/cancel')) { cancels++; res.statusCode = 202; res.end() }
    else res.end(JSON.stringify({ request_id: requestId, status: 'queued' }))
  })
  try {
    const created = await call(ctx, '/api/generations', { method: 'POST', body: { modelId, prompt: 'P' } })
    const id = created.body.generation.id
    // Simulate a user cancel that arrives while the first POST is still in flight.
    ctx.db.prepare("UPDATE generations SET higgsfield_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify({ key: 'in-flight-key', attempts: 1, firstSentAt: Date.now() }), Date.now(), id)
    const cancel = await call(ctx, `/api/generations/${id}/cancel`, { method: 'POST' })
    expect(cancel.status).toBe(202)
    expect(row(ctx, id).cancel_requested).toBe(1)
    expect(row(ctx, id).status).toBe('queued')
    await ctx.worker.tick()
    expect(row(ctx, id).provider_job_id).toBe(requestId)
    expect(cancels).toBe(0)
    ctx.db.prepare('UPDATE generations SET next_poll_at = 0 WHERE id = ?').run(id)
    await ctx.worker.tick()
    expect(cancels).toBe(1)
    expect(row(ctx, id)).toMatchObject({ status: 'failed', error_code: 'CANCELLED' })
    const job = (await call(ctx, `/api/generations/${id}`)).body.generation
    expect(job.canCancel).toBe(false)
  } finally { await close(ctx, server) }
})
it('does not cancel upstream once the provider has started rendering', async () => {
  let cancels = 0
  const { ctx, server, modelId } = await fixture((req, res) => {
    if (req.url?.endsWith('/cancel')) { cancels++; res.statusCode = 400; res.end() }
    else res.end(JSON.stringify({ request_id: requestId, status: req.method === 'POST' ? 'queued' : 'in_progress' }))
  })
  try {
    const created = await call(ctx, '/api/generations', { method: 'POST', body: { modelId, prompt: 'P' } })
    const id = created.body.generation.id
    await ctx.worker.tick()
    ctx.db.prepare('UPDATE generations SET next_poll_at = 0 WHERE id = ?').run(id)
    await ctx.worker.tick()
    expect((await call(ctx, `/api/generations/${id}/cancel`, { method: 'POST' })).status).toBe(409)
    expect(cancels).toBe(0)
    expect(row(ctx, id)).toMatchObject({ status: 'running', provider_status: 'in_progress' })
  } finally { await close(ctx, server) }
})
it('uploads a local frame with presigned headers and no credential, then freezes public URL', async () => {
  const publicUrl = 'https://8.8.8.8/frame.png'
  const uploadUrl = 'https://8.8.8.8/presigned?signature=private'
  let received: any; let puts = 0
  const { ctx, server, modelId } = await fixture(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    if (req.url === '/files/generate-upload-url') res.end(JSON.stringify({ public_url: publicUrl, upload_url: uploadUrl, upload_headers: { 'Content-Type': 'image/png', 'x-amz-tagging': 'retention=temporary' } }))
    else { received = JSON.parse(raw); res.end(JSON.stringify({ request_id: requestId, status: 'queued' })) }
  })
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64')
    const uploaded = await fetch(`${ctx.baseUrl}/api/uploads`, { method: 'POST', headers: { Cookie: ctx.cookie, 'Content-Type': 'image/png' }, body: png })
    const uploadId = (await uploaded.json() as any).upload.id
    const realFetch = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input) === uploadUrl) {
        puts++; expect(init?.method).toBe('PUT')
        expect((init?.headers as any).Authorization).toBeUndefined()
        expect((init?.headers as any)['x-amz-tagging']).toBe('retention=temporary')
        expect(Buffer.from(init?.body as Uint8Array)).toEqual(png)
        return new Response('', { status: 200 })
      }
      return realFetch(input, init)
    })
    const created = await call(ctx, '/api/generations', { method: 'POST', body: { modelId, params: { mode: 'image', imageUploadId: uploadId } } })
    expect(created.status).toBe(202)
    const id = created.body.generation.id
    expect((await call(ctx, `/api/uploads/${uploadId}`, { method: 'DELETE' })).status).toBe(400)
    await ctx.worker.tick()
    expect(puts).toBe(1); expect(received.image_url).toBe(publicUrl)
    expect(row(ctx, id).status).toBe('running')
    const job = (await call(ctx, `/api/generations/${id}`)).body.generation
    expect(JSON.stringify(job)).not.toContain('presigned')
  } finally { await close(ctx, server) }
})
it.each(['nsfw','canceled','failed'])('stops polling on terminal status %s', async status => {
  const { ctx, server, modelId } = await fixture((req, res) => res.end(JSON.stringify({ request_id: requestId, status: req.method === 'POST' ? 'queued' : status, error: 'rejected hf-secret-456' })))
  try {
    const created = await call(ctx, '/api/generations', { method: 'POST', body: { modelId, prompt: 'P' } })
    const id = created.body.generation.id
    await ctx.worker.tick(); ctx.db.prepare('UPDATE generations SET next_poll_at = 0 WHERE id = ?').run(id); await ctx.worker.tick()
    expect(row(ctx, id).status).toBe('failed')
    expect(row(ctx, id).error_message).not.toContain('hf-secret-456')
    if (status === 'canceled') expect(row(ctx, id).error_code).toBe('CANCELLED')
  } finally { await close(ctx, server) }
})
it('downloads completed video without credential at media origin and stores it locally', async () => {
  const resultUrl = 'https://8.8.8.8/output.mp4?signed=private'
  const { ctx, server, modelId } = await fixture((req, res) => res.end(JSON.stringify(req.method === 'POST' ? { request_id: requestId, status: 'queued' } : { request_id: requestId, status: 'completed', video: { url: resultUrl } })))
  try {
    const realFetch = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input) === resultUrl) {
        expect((init?.headers as any).Authorization).toBeUndefined()
        return new Response(mp4, { headers: { 'content-type': 'video/mp4' } })
      }
      return realFetch(input, init)
    })
    const created = await call(ctx, '/api/generations', { method: 'POST', body: { modelId, prompt: 'P' } })
    const id = created.body.generation.id
    await ctx.worker.tick(); ctx.db.prepare('UPDATE generations SET next_poll_at = 0 WHERE id = ?').run(id); await ctx.worker.tick()
    expect(row(ctx, id).status).toBe('succeeded')
    const publicJob = (await call(ctx, `/api/generations/${id}`)).body.generation
    expect(publicJob.assets[0].mimeType).toBe('video/mp4')
    expect(JSON.stringify(publicJob)).not.toContain('signed=private')
  } finally { await close(ctx, server) }
})
