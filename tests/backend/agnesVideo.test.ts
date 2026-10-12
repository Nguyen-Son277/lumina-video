import { createServer, type Server, type RequestListener } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGNES_ASPECT_RATIOS, inferVideoApiStyle, isAgnesFlash, normalizeAgnesParams } from '../../shared/videoApi'
import { buildAgnesRequestBody, guardAgnesMedia, readAgnesJob } from '../../server/generations/adapters/agnes'
import { call, registerUser, startTestServer, type TestContext } from './helpers'
import { createWorker } from '../../server/generations/worker'
import { guardProviderUrl } from '../../server/providers/urlGuard'

const flash = 'agnes-video-2.5-flash'
const publicUrl = 'http://8.8.8.8/video.mp4?signature=internal-secret'
const mp4 = Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex')
afterEach(() => vi.restoreAllMocks())

describe('Agnes shared validation', () => {
  it('infers exact ids only and defaults Flash params', () => {
    expect(inferVideoApiStyle(flash)).toBe('agnes')
    expect(inferVideoApiStyle('agnes-video-2.5')).toBe('agnes')
    expect(inferVideoApiStyle('AGNES-video-2.5')).toBe('openai')
    expect(inferVideoApiStyle('agnes-video-2.5-flash-new')).toBe('openai')
    expect(isAgnesFlash(flash)).toBe(true)
    expect(normalizeAgnesParams(flash, {})).toEqual({ mode: 'text', size: '720P', seconds: '5', n: 1 })
    expect(normalizeAgnesParams('agnes-video-2.5', { size: '1080P', seconds: '20', n: 4 })).toMatchObject({ seconds: '20', n: 4 })
  })
  it('validates all Flash ranges, aspect enums, seed, modes and media', () => {
    for (const seconds of ['4', '5', '12']) expect(normalizeAgnesParams(flash, { seconds }).seconds).toBe(seconds)
    for (const aspectRatio of AGNES_ASPECT_RATIOS) expect(normalizeAgnesParams(flash, { aspectRatio }).aspectRatio).toBe(aspectRatio)
    for (const p of [{ seconds: 5 }, { seconds: '3' }, { seconds: '13' }, { size: '1080P' }, { n: 2 }, { seed: 1.2 }, { aspectRatio: '2:1' }, { mode: 'text', firstFrame: publicUrl }, { mode: 'keyframe' }, { mode: 'reference' }, { mode: 'reference', firstFrame: publicUrl, referenceImages: [publicUrl] }, { mode: 'keyframe', firstFrame: publicUrl, referenceAudios: [publicUrl] }, { mode: 'reference', referenceImages: Array(6).fill(publicUrl) }, { mode: 'reference', referenceAudios: Array(4).fill(publicUrl) }, { mode: 'keyframe', firstFrame: 'data:image/png;base64,abc' }, { videos: [] }, { images: [] }]) {
      expect(() => normalizeAgnesParams(flash, p as any)).toThrow()
    }
    expect(buildAgnesRequestBody(flash, 'p', { mode: 'keyframe', lastFrame: publicUrl, aspectRatio: '9:16', seed: 0 })).toMatchObject({ last_frame: publicUrl, aspect_ratio: '9:16', seed: 0 })
    expect(buildAgnesRequestBody(flash, 'p', { mode: 'reference', referenceAudios: [publicUrl] }).audios).toEqual([publicUrl])
  })
  it('POST requires video_id but not status; GET accepts status without id and ignores internal fields', () => {
    expect(readAgnesJob({ video_id: 'v' }, true).state).toBe('queued')
    for (const p of [{ id: 'x' }, { task_id: 'x' }, {}]) expect(() => readAgnesJob(p, true)).toThrow()
    expect(readAgnesJob({ status: 'processing', progress: 70, api_key: 'ignored', id: 'ignored' }, false, 'v')).toEqual({ id: 'v', state: 'in_progress', progress: 70, resultUrl: null, errorMessage: null })
    expect(readAgnesJob({ status: 'completed', url: publicUrl, internal_status: 'pending', internal_progress: 0 }, false, 'v')).toMatchObject({ state: 'completed', resultUrl: publicUrl })
    expect(() => readAgnesJob({ status: 'completed', completed: { url: publicUrl } }, false, 'v')).toThrow()
  })
  it('blocks private media even with private provider permission; permits public HTTP', async () => {
    for (const url of ['http://127.0.0.1/a', 'https://10.0.0.1/a', 'http://169.254.169.254/a', 'https://[::1]/a', 'https://localhost/a']) {
      await expect(guardAgnesMedia({ mode: 'keyframe', firstFrame: url })).rejects.toThrow()
    }
    expect((await guardProviderUrl(publicUrl, { allowPrivate: false, allowHttp: true })).addresses[0]?.address).toBe('8.8.8.8')
  })
})

async function fixture(handler: RequestListener): Promise<{ ctx: TestContext; server: Server; modelId: string; providerId: string; requests: never[] }> {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const ctx = await startTestServer({ allowPrivate: true, providerMode: 'live' })
  await registerUser(ctx)
  const port = (server.address() as AddressInfo).port
  const provider = await call(ctx, '/api/providers', { method: 'POST', body: { name: 'Agnes mock HTTP', baseUrl: `http://127.0.0.1:${port}/custom/v1`, apiKey: 'sk-agnes-test-key-123' } })
  expect(provider.status).toBe(201)
  const model = await call(ctx, '/api/models', { method: 'POST', body: { providerId: provider.body.provider.id, modelId: flash, kind: 'video' } })
  expect(model.body.model.videoApiStyle).toBe('agnes')
  // Deterministic ticks: prevent enqueue's wake from racing assertions.
  vi.spyOn(ctx.worker, 'wake').mockImplementation(() => {})
  return { ctx, server, modelId: model.body.model.id, providerId: provider.body.provider.id, requests: [] }
}
async function close(ctx: TestContext, server: Server) {
  await ctx.close()
  await new Promise<void>(resolve => server.close(() => resolve()))
}
function row(ctx: TestContext, id: string): any { return ctx.db.prepare('SELECT * FROM generations WHERE id = ?').get(id) }

it('mock HTTP full lifecycle uses origin-root query, pinned key, guarded cross-origin streaming and persisted retry', async () => {
  const requests: Array<{ url: string; auth: string | undefined; body?: any }> = []
  const { ctx, server, modelId, providerId } = await fixture(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    requests.push({ url: req.url!, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined })
    res.setHeader('Content-Type', 'application/json')
    if (req.method === 'POST') res.end(JSON.stringify({ video_id: 'video /?1' }))
    else res.end(JSON.stringify({ status: 'completed', progress: 100, url: publicUrl, internal_key: 'do not expose' }))
  })
  try {
    let downloads = 0
    const realFetch = globalThis.fetch
    const fetched: any[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input) === publicUrl) {
        fetched.push(init); downloads++
        return new Response(downloads === 1 ? 'temporary failure' : mp4, { status: downloads === 1 ? 503 : 200, headers: { 'content-type': 'video/mp4' } })
      }
      return realFetch(input, init)
    })
    const created = await call(ctx, '/api/generations', { method: 'POST', body: { modelId, prompt: 'Ocean', params: {} } })
    expect(created.status).toBe(202)
    const id = created.body.generation.id
    expect(row(ctx, id).snap_video_style).toBe('agnes')
    await ctx.worker.tick()
    const started = row(ctx, id)
    expect(started.provider_job_id).toBe('video /?1')
    expect(started.next_poll_at - started.updated_at).toBeLessThanOrEqual(2000)
    expect(requests[0]).toMatchObject({ url: '/custom/v1/videos', auth: 'Bearer sk-agnes-test-key-123', body: { mode: 'text', size: '720P', seconds: '5', n: 1 } })
    // Change provider URL/key configuration; polling still uses pinned URL/key.
    ctx.db.prepare("UPDATE provider_connections SET base_url = 'https://invalid.example/v1' WHERE id = ?").run(providerId)
    ctx.db.prepare('UPDATE generations SET next_poll_at = NULL WHERE id = ?').run(id)
    await ctx.worker.tick()
    expect(row(ctx, id).status).toBe('failed')
    expect(row(ctx, id).provider_result_url).toBe(publicUrl)
    const pollUrl = new URL(requests[1]!.url, 'http://mock')
    expect(pollUrl.pathname).toBe('/agnesapi')
    expect(pollUrl.searchParams.get('video_id')).toBe('video /?1')
    expect(pollUrl.searchParams.get('model_name')).toBe(flash)
    expect(requests[1]!.auth).toBe(requests[0]!.auth)
    expect(fetched[0].headers.Authorization).toBeUndefined()
    expect(fetched[0].redirect).toBe('manual')
    expect(fetched[0].dispatcher).toBeDefined()
    const publicState = await call(ctx, `/api/generations/${id}`)
    expect(JSON.stringify(publicState.body)).not.toContain('signature=internal-secret')
    expect(JSON.stringify(publicState.body)).not.toContain('internal_key')
    const retried = await call(ctx, `/api/generations/${id}/retry-download`, { method: 'POST' })
    expect(retried.status).toBe(200)
    const restarted = createWorker({ db: ctx.db, env: ctx.env, mediaStore: ctx.mediaStore })
    await restarted.tick()
    await restarted.stop()
    expect(row(ctx, id).status).toBe('succeeded')
    expect(requests).toHaveLength(2) // no extra POST and persisted URL skips GET
    expect((await call(ctx, `/api/generations/${id}`)).body.generation.assets[0].mimeType).toBe('video/mp4')
  } finally { await close(ctx, server) }
})

it('uncertain POST responses never retry and missing video_id is not replaced by id/task_id', async () => {
  let posts = 0
  const { ctx, server, modelId } = await fixture((req, res) => {
    posts++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ id: 'wrong', task_id: 'wrong' }))
  })
  try {
    const created = await call(ctx, '/api/generations', { method: 'POST', body: { modelId, prompt: 'P' } })
    await ctx.worker.tick(); await ctx.worker.tick()
    expect(posts).toBe(1)
    expect(row(ctx, created.body.generation.id).status).toBe('unknown')
    expect(row(ctx, created.body.generation.id).provider_job_id).toBeNull()
  } finally { await close(ctx, server) }
})

it('model 2.5 uses Agnes routing without Flash-specific caps', async () => {
  const bodies: any[] = []
  const { ctx, server, modelId } = await fixture(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    bodies.push(JSON.parse(raw)); res.end(JSON.stringify({ video_id: 'standard-job' }))
  })
  try {
    ctx.db.prepare("UPDATE models SET model_id = 'agnes-video-2.5' WHERE id = ?").run(modelId)
    const created = await call(ctx, '/api/generations', { method: 'POST', body: { modelId, prompt: 'P', params: { size: '1080P', seconds: '20', n: 4 } } })
    expect(created.status).toBe(202)
    await ctx.worker.tick()
    expect(bodies[0]).toMatchObject({ model: 'agnes-video-2.5', size: '1080P', seconds: '20', n: 4 })
    expect(row(ctx, created.body.generation.id).snap_video_style).toBe('agnes')
  } finally { await close(ctx, server) }
})

it.each([
  { status: 503, body: JSON.stringify({ error: { message: 'Upstream overloaded sk-agnes-test-key-123' } }) },
  { status: 502, body: 'Gateway unavailable' },
  { status: 500, body: '' },
  { status: 200, body: '{not-json' },
  { status: 200, body: JSON.stringify({ id: 'task-only' }) },
])('preserves safe submit diagnostics for HTTP $status without resubmission', async ({ status, body }) => {
  let posts = 0
  const { ctx, server, modelId } = await fixture((req, res) => {
    posts++; res.statusCode = status
    res.setHeader('x-request-id', 'req-sk-agnes-test-key-123-abc')
    res.end(body)
  })
  try {
    const result = await call(ctx, '/api/generations', { method: 'POST', body: { modelId, prompt: 'P' } })
    await ctx.worker.tick(); await ctx.worker.tick()
    expect(posts).toBe(1)
    const publicJob = (await call(ctx, `/api/generations/${result.body.generation.id}`)).body.generation
    expect(publicJob.status).toBe('unknown')
    expect(publicJob.providerJobId).toBeNull()
    expect(publicJob.errorMessageParams.status).toBe(status)
    expect(publicJob.errorMessageKey).toBe(status >= 500 ? 'agnes.submit_http_unknown' : 'agnes.submit_id_unknown')
    expect(publicJob.errorMessageParams.requestId).toBe('req-***-abc')
    expect(JSON.stringify(publicJob)).not.toContain('sk-agnes-test-key-123')
    if (status === 503) expect(publicJob.errorMessageParams.detail).toContain('Upstream overloaded ***')
    expect(publicJob.errorMessage).toContain(`HTTP ${status}`)
  } finally { await close(ctx, server) }
})

it('enqueue rejects private URL and invalid params before any POST', async () => {
  let requests = 0
  const { ctx, server, modelId } = await fixture((_, res) => { requests++; res.end('{}') })
  try {
    for (const params of [{ seconds: 5 }, { mode: 'keyframe', firstFrame: 'http://127.0.0.1/a' }, { mode: 'reference', referenceImages: ['data:image/png;base64,a'] }, { mode: 'text', videos: ['https://8.8.8.8/a'] }]) {
      expect((await call(ctx, '/api/generations', { method: 'POST', body: { modelId, prompt: 'P', params } })).status).toBe(400)
    }
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM generations').get()!.n).toBe(0)
    expect(requests).toBe(0)
  } finally { await close(ctx, server) }
})
