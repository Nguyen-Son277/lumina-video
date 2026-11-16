import { createServer, type Server, type RequestListener } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inferVideoApiStyle, isXpikiBaseUrl } from '../../shared/videoApi'
import {
  buildXpikiRequestBody,
  readXpikiJob,
} from '../../server/generations/adapters/xpiki'
import { call, registerUser, startTestServer, type TestContext } from './helpers'

const mp4 = Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex')
afterEach(() => vi.restoreAllMocks())

describe('Xpiki shared validation & request builder', () => {
  it('correctly detects xpiki base URLs and model IDs', () => {
    expect(isXpikiBaseUrl('https://api.xpiki.com/v1')).toBe(true)
    expect(isXpikiBaseUrl('http://api.xpiki.com')).toBe(true)
    expect(isXpikiBaseUrl('https://sub.xpiki.com/v1')).toBe(true)
    expect(isXpikiBaseUrl('https://api.openai.com/v1')).toBe(false)
    expect(isXpikiBaseUrl('https://api.nexusmmo.store/v1')).toBe(false)

    expect(inferVideoApiStyle('xpiki-free-video')).toBe('xpiki')
    expect(inferVideoApiStyle('xpiki-custom-model')).toBe('xpiki')
    expect(inferVideoApiStyle('any-model', 'https://api.xpiki.com/v1')).toBe('xpiki')
    expect(inferVideoApiStyle('sora-1')).toBe('openai')
    expect(inferVideoApiStyle('agnes-video-2.5')).toBe('agnes')
  })

  it('builds request body with default duration, resolution, and ratio', () => {
    const body = buildXpikiRequestBody('xpiki-free-video', 'A scenic waterfall', {})
    expect(body).toEqual({
      model: 'xpiki-free-video',
      prompt: 'A scenic waterfall',
      resolution: '720p',
      aspect_ratio: '16:9',
      duration_seconds: 5,
    })
  })

  it('handles custom resolution, aspect ratio, and seconds', () => {
    const body = buildXpikiRequestBody('xpiki-free-video', 'A cat running', {
      size: '1920x1080',
      seconds: '8',
      aspectRatio: '16:9',
    })
    expect(body.duration_seconds).toBe(8)
    expect(body.resolution).toBe('1080p')
    expect(body.aspect_ratio).toBe('16:9')
  })

  it('enforces duration_seconds = 10 for muse-video', () => {
    const body = buildXpikiRequestBody('muse-video', 'A dancing robot', {
      seconds: 5,
    })
    expect(body.duration_seconds).toBe(10)
  })

  it('includes references when reference or input image is provided', () => {
    const refUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'
    const body = buildXpikiRequestBody(
      'xpiki-free-video',
      'A character walking',
      {},
      refUrl,
    )
    expect(body.references).toEqual([refUrl])

    const bodyNoRef = buildXpikiRequestBody(
      'xpiki-free-video',
      'A character walking',
      { useCharacterReference: false },
      refUrl,
    )
    expect(bodyNoRef.references).toBeUndefined()
  })

  it('reads job status correctly for queued, running, completed, and failed states', () => {
    const queued = readXpikiJob({ task_id: 'gen_1', status: 'queued' })
    expect(queued).toEqual({
      id: 'gen_1',
      state: 'queued',
      progress: 0,
      errorMessage: null,
      resultUrl: null,
    })

    const running = readXpikiJob({ task_id: 'gen_2', status: 'running', progress: 45 })
    expect(running).toEqual({
      id: 'gen_2',
      state: 'in_progress',
      progress: 45,
      errorMessage: null,
      resultUrl: null,
    })

    const succeeded = readXpikiJob({
      task_id: 'gen_3',
      status: 'succeeded',
      outputs: [{ url: '/v1/generation-tasks/gen_3/outputs/0' }],
    })
    expect(succeeded).toEqual({
      id: 'gen_3',
      state: 'completed',
      progress: 100,
      errorMessage: null,
      resultUrl: '/v1/generation-tasks/gen_3/outputs/0',
    })

    const failed = readXpikiJob({
      task_id: 'gen_4',
      status: 'failed',
      error_message: 'Upstream quota exhausted',
    })
    expect(failed.state).toBe('failed')
    expect(failed.errorMessage).toBe('Upstream quota exhausted')
  })

  it('throws on invalid payload or missing task_id', () => {
    expect(() => readXpikiJob(null)).toThrow()
    expect(() => readXpikiJob({})).toThrow()
    expect(() => readXpikiJob({ status: 'running' })).toThrow()
  })
})

async function fixture(handler: RequestListener): Promise<{
  ctx: TestContext
  server: Server
  modelId: string
  providerId: string
}> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const ctx = await startTestServer({ allowPrivate: true, providerMode: 'live' })
  await registerUser(ctx)
  const port = (server.address() as AddressInfo).port
  const provider = await call(ctx, '/api/providers', {
    method: 'POST',
    body: {
      name: 'Xpiki mock HTTP',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-xpiki-test-key-xyz',
    },
  })
  expect(provider.status).toBe(201)

  const model = await call(ctx, '/api/models', {
    method: 'POST',
    body: {
      providerId: provider.body.provider.id,
      modelId: 'xpiki-free-video',
      kind: 'video',
    },
  })
  expect(model.body.model.videoApiStyle).toBe('xpiki')

  vi.spyOn(ctx.worker, 'wake').mockImplementation(() => {})
  return { ctx, server, modelId: model.body.model.id, providerId: provider.body.provider.id }
}

async function close(ctx: TestContext, server: Server) {
  await ctx.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

function row(ctx: TestContext, id: string): any {
  return ctx.db.prepare('SELECT * FROM generations WHERE id = ?').get(id)
}

describe('Xpiki HTTP lifecycle with mock server', () => {
  it('submits to /v1/video-generations, polls /v1/generation-tasks/:id, and downloads /outputs/0', async () => {
    const requests: Array<{ url: string; method: string; auth: string | undefined; body?: any }> = []
    let pollCount = 0

    const { ctx, server, modelId } = await fixture(async (req, res) => {
      let raw = ''
      for await (const chunk of req) raw += chunk
      requests.push({
        url: req.url!,
        method: req.method!,
        auth: req.headers.authorization,
        body: raw ? JSON.parse(raw) : undefined,
      })

      if (req.method === 'POST' && req.url === '/v1/video-generations') {
        res.writeHead(202, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            task_id: 'gen_mock_123',
            status: 'queued',
            events_url: '/v1/generation-tasks/gen_mock_123/events',
          }),
        )
        return
      }

      if (req.method === 'GET' && req.url === '/v1/generation-tasks/gen_mock_123') {
        pollCount++
        res.writeHead(200, { 'Content-Type': 'application/json' })
        if (pollCount === 1) {
          res.end(JSON.stringify({ task_id: 'gen_mock_123', status: 'running', progress: 50 }))
        } else {
          res.end(
            JSON.stringify({
              task_id: 'gen_mock_123',
              status: 'succeeded',
              outputs: [
                {
                  index: 0,
                  type: 'video',
                  mime_type: 'video/mp4',
                  url: '/v1/generation-tasks/gen_mock_123/outputs/0',
                },
              ],
            }),
          )
        }
        return
      }

      if (req.method === 'GET' && req.url === '/v1/generation-tasks/gen_mock_123/outputs/0') {
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': String(mp4.byteLength),
        })
        res.end(mp4)
        return
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('404 page not found')
    })

    try {
      const created = await call(ctx, '/api/generations', {
        method: 'POST',
        body: { modelId, prompt: 'A sunny mountain peak', params: { seconds: '5', size: '1280x720' } },
      })
      expect(created.status).toBe(202)
      const genId = created.body.generation.id
      expect(row(ctx, genId).snap_video_style).toBe('xpiki')

      // Tick 1: Submit to provider
      await ctx.worker.tick()
      const started = row(ctx, genId)
      expect(started.status).toBe('running')
      expect(started.provider_job_id).toBe('gen_mock_123')
      expect(requests[0]).toMatchObject({
        method: 'POST',
        url: '/v1/video-generations',
        auth: 'Bearer sk-xpiki-test-key-xyz',
        body: {
          model: 'xpiki-free-video',
          prompt: 'A sunny mountain peak',
          duration_seconds: 5,
          resolution: '720p',
          aspect_ratio: '16:9',
        },
      })

      // Tick 2: Poll 1 (status: running)
      ctx.db.prepare('UPDATE generations SET next_poll_at = NULL WHERE id = ?').run(genId)
      await ctx.worker.tick()
      expect(row(ctx, genId).status).toBe('running')
      expect(row(ctx, genId).progress).toBe(50)
      expect(requests[1]).toMatchObject({
        method: 'GET',
        url: '/v1/generation-tasks/gen_mock_123',
        auth: 'Bearer sk-xpiki-test-key-xyz',
      })

      // Tick 3: Poll 2 (status: succeeded) -> Download video
      ctx.db.prepare('UPDATE generations SET next_poll_at = NULL WHERE id = ?').run(genId)
      await ctx.worker.tick()
      const final = row(ctx, genId)
      expect(final.status).toBe('succeeded')
      expect(final.progress).toBe(100)
      expect(requests[2]).toMatchObject({
        method: 'GET',
        url: '/v1/generation-tasks/gen_mock_123',
      })
      expect(requests[3]).toMatchObject({
        method: 'GET',
        url: '/v1/generation-tasks/gen_mock_123/outputs/0',
        auth: 'Bearer sk-xpiki-test-key-xyz',
      })
    } finally {
      await close(ctx, server)
    }
  })

  it('handles upstream task failure during polling', async () => {
    const { ctx, server, modelId } = await fixture(async (req, res) => {
      if (req.method === 'POST') {
        res.writeHead(202, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ task_id: 'gen_mock_failed', status: 'queued' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          task_id: 'gen_mock_failed',
          status: 'failed',
          error_code: 'UPSTREAM_QUOTA_EXHAUSTED',
          error_message: 'Upstream quota exhausted; retry later.',
        }),
      )
    })

    try {
      const created = await call(ctx, '/api/generations', {
        method: 'POST',
        body: { modelId, prompt: 'Fail test' },
      })
      const genId = created.body.generation.id

      await ctx.worker.tick() // start
      expect(row(ctx, genId).status).toBe('running')

      ctx.db.prepare('UPDATE generations SET next_poll_at = NULL WHERE id = ?').run(genId)
      await ctx.worker.tick() // poll -> failed

      const failed = row(ctx, genId)
      expect(failed.status).toBe('failed')
      expect(failed.error_message).toContain('Upstream quota exhausted')
    } finally {
      await close(ctx, server)
    }
  })

  it('handles provider rejection on start gracefully', async () => {
    const { ctx, server, modelId } = await fixture(async (_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          error: {
            message: 'Model "xpiki-free-video" does not support duration_seconds=0',
          },
        }),
      )
    })

    try {
      const created = await call(ctx, '/api/generations', {
        method: 'POST',
        body: { modelId, prompt: 'Reject test' },
      })
      const genId = created.body.generation.id

      await ctx.worker.tick()
      const failed = row(ctx, genId)
      expect(failed.status).toBe('failed')
      expect(failed.error_message).toContain('duration_seconds=0')
    } finally {
      await close(ctx, server)
    }
  })
})
