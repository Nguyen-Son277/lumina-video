import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, startTestServer, waitForGeneration, type TestContext } from './helpers'
import { MOCK_PNG_BYTES } from '../../server/generations/adapters/mock'

/**
 * Kiểm tra HTTP thật: khi tạo ảnh trong dự án có nhân vật, ảnh tham chiếu của
 * nhân vật phải được gửi tới provider theo đúng hợp đồng của từng kiểu API.
 */
let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer({ allowPrivate: true, providerMode: 'live' }) })
afterAll(async () => { if (ctx) await ctx.close() })

type Captured = { path: string; contentType: string; raw: Buffer }

/** Provider giả lập: ghi lại request và luôn trả về một ảnh PNG. */
function createFakeProvider(captured: Captured[], port: { value: number }) {
  return createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      if (req.url === '/anh.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' })
        res.end(MOCK_PNG_BYTES)
        return
      }

      captured.push({
        path: req.url ?? '',
        contentType: req.headers['content-type'] ?? '',
        raw: Buffer.concat(chunks),
      })

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          data: [{ url: `http://127.0.0.1:${port.value}/anh.png` }],
        }),
      )
    })
  })
}

async function startFakeProvider(captured: Captured[]) {
  const port = { value: 0 }
  const server = createFakeProvider(captured, port)
  port.value = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  })
  return server
}

/** Tạo user, provider (kiểu API cho trước), model ảnh, dự án và nhân vật có ảnh. */
async function setupImageJob(imageApiStyle: 'openai' | 'extra_body', port: number) {
  await registerUser(ctx)
  const provider = (await call(ctx, '/api/providers', {
    method: 'POST',
    body: {
      name: `Fake ${imageApiStyle}`,
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-fake-key',
      imageApiStyle,
    },
  })).body.provider
  const model = (await call(ctx, '/api/models', {
    method: 'POST',
    body: { providerId: provider.id, modelId: 'fake-image-model', displayName: 'Fake', kind: 'image' },
  })).body.model
  const project = (await call(ctx, '/api/projects', {
    method: 'POST',
    body: { name: 'Dự án ảnh' },
  })).body.project
  const character = (await call(ctx, `/api/projects/${project.id}/characters`, {
    method: 'POST',
    body: { name: 'Lan', appearance: 'Áo đỏ' },
  })).body.character

  const upload = await fetch(
    `${ctx.baseUrl}/api/projects/${project.id}/characters/${character.id}/reference`,
    { method: 'POST', headers: { Cookie: ctx.cookie, 'Content-Type': 'image/png' }, body: MOCK_PNG_BYTES },
  )
  expect(upload.status).toBe(201)

  return { model, project, character }
}

async function waitForCapture(captured: Captured[]) {
  const deadline = Date.now() + 10_000
  while (captured.length === 0 && Date.now() < deadline) {
    await ctx.worker.tick()
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe('Gửi ảnh tham chiếu nhân vật khi tạo ảnh trong dự án', () => {
  it('kiểu openai dùng multipart /images/edits kèm ảnh nhân vật', async () => {
    const captured: Captured[] = []
    const server = await startFakeProvider(captured)
    const port = (server.address() as { port: number }).port
    try {
      const { model, project, character } = await setupImageJob('openai', port)
      const created = await call(ctx, '/api/generations', {
        method: 'POST',
        body: {
          modelId: model.id,
          projectId: project.id,
          characterId: character.id,
          prompt: 'Lan đi dạo',
        },
      })
      expect(created.status).toBe(202)

      await waitForCapture(captured)
      expect(captured).toHaveLength(1)
      const request = captured[0]!
      expect(request.path).toBe('/v1/images/edits')
      expect(request.contentType).toContain('multipart/form-data')
      // Ảnh nhân vật là PNG thật, không phải ảnh rỗng.
      expect(request.raw.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true)
      expect(request.raw.toString('latin1')).toContain('name="image"')

      const done = await waitForGeneration(ctx, created.body.generation.id)
      expect(done.status).toBe('succeeded')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('kiểu extra_body đặt ảnh nhân vật trong extra_body.image', async () => {
    const captured: Captured[] = []
    const server = await startFakeProvider(captured)
    const port = (server.address() as { port: number }).port
    try {
      const { model, project, character } = await setupImageJob('extra_body', port)
      const created = await call(ctx, '/api/generations', {
        method: 'POST',
        body: {
          modelId: model.id,
          projectId: project.id,
          characterId: character.id,
          prompt: 'Lan đi dạo',
        },
      })
      expect(created.status).toBe(202)

      await waitForCapture(captured)
      expect(captured).toHaveLength(1)
      const request = captured[0]!
      expect(request.path).toBe('/v1/images/generations')
      const body = JSON.parse(request.raw.toString('utf8')) as {
        extra_body: { response_format: string; image?: string[] }
      }
      expect(body.extra_body.response_format).toBe('url')
      expect(body.extra_body.image).toHaveLength(1)
      expect(body.extra_body.image![0]).toMatch(/^data:image\/png;base64,/)

      const done = await waitForGeneration(ctx, created.body.generation.id)
      expect(done.status).toBe('succeeded')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('tắt gửi ảnh tham chiếu thì gọi JSON /images/generations như ảnh thường', async () => {
    const captured: Captured[] = []
    const server = await startFakeProvider(captured)
    const port = (server.address() as { port: number }).port
    try {
      const { model, project, character } = await setupImageJob('openai', port)
      const created = await call(ctx, '/api/generations', {
        method: 'POST',
        body: {
          modelId: model.id,
          projectId: project.id,
          characterId: character.id,
          prompt: 'Không gửi ảnh tham chiếu',
          params: { useCharacterReference: false },
        },
      })
      expect(created.status).toBe(202)

      await waitForCapture(captured)
      expect(captured).toHaveLength(1)
      const request = captured[0]!
      expect(request.path).toBe('/v1/images/generations')
      expect(request.contentType).toContain('application/json')
      const body = JSON.parse(request.raw.toString('utf8')) as Record<string, unknown>
      expect(body).not.toHaveProperty('extra_body')

      const done = await waitForGeneration(ctx, created.body.generation.id)
      expect(done.status).toBe('succeeded')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
