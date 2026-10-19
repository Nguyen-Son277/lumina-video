/**
 * Cấu hình kiểu gửi ảnh tham chiếu video phải đi từ UI/API xuống tới payload
 * thật gửi provider, và được chụp lại (snapshot) theo từng tác vụ.
 *
 * Gateway new-api khai báo `input_reference` là CHUỖI; gửi object `{ image_url }`
 * khiến provider từ chối yêu cầu. Vì vậy cấu hình phải bị ràng buộc đúng vào
 * provider và không đổi cách xử lý của tác vụ đang chạy.
 */
import { createServer, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'
import { enqueueGeneration } from '../../server/generations/enqueue'
import { MOCK_PNG_BYTES } from '../../server/generations/adapters/mock'

const servers: Server[] = []
let ctx: TestContext | null = null

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    ),
  )
  if (ctx) await ctx.close()
  ctx = null
})

type Captured = { method: string; path: string; body: unknown }

/** Provider giả chấp nhận mọi payload và cấp ID job, để test chỉ soi thân POST. */
async function startFakeProvider(captured: Captured[]): Promise<number> {
  const server = createServer((request, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8')
      captured.push({
        method: request.method ?? 'GET',
        path: request.url ?? '',
        body: bodyText ? JSON.parse(bodyText) : null,
      })
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ id: 'job-1', object: 'video', status: 'queued', progress: 0 }))
    })
  })
  servers.push(server)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  })
}

async function setup(referenceStyle: 'image_url_object' | 'image_url_string') {
  const captured: Captured[] = []
  const port = await startFakeProvider(captured)
  ctx = await startTestServer({ allowPrivate: true, providerMode: 'live' })
  const { userId } = await registerUser(ctx)

  const provider = await call(ctx, '/api/providers', {
    method: 'POST',
    body: { name: 'Gateway video', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-live-video-1234', videoReferenceStyle: referenceStyle },
  })
  expect(provider.status, JSON.stringify(provider.body)).toBe(201)
  const providerId = provider.body.provider.id as string
  expect(provider.body.provider.videoReferenceStyle).toBe(referenceStyle)

  const model = await call(ctx, '/api/models', {
    method: 'POST',
    body: { providerId, modelId: 'gateway-video', displayName: 'Gateway video', kind: 'video' },
  })
  expect(model.status).toBe(201)

  const uploadId = `upload-${userId}`
  const saved = ctx.mediaStore.saveUpload({ userId, uploadId, bytes: MOCK_PNG_BYTES, maxBytes: ctx.env.MAX_REFERENCE_BYTES })
  ctx.db
    .prepare('INSERT INTO uploads(id,user_id,relative_path,mime_type,byte_size,created_at) VALUES(?,?,?,?,?,?)')
    .run(uploadId, userId, saved.relativePath, saved.mimeType, saved.byteSize, Date.now())

  return { captured, userId, providerId, modelPk: model.body.model.id as string, uploadId }
}

function enqueueVideo(userId: string, modelPk: string, uploadId: string) {
  return enqueueGeneration({
    db: ctx!.db,
    env: ctx!.env,
    worker: { wake() {} } as never,
    userId,
    request: {
      data: { modelId: modelPk, prompt: 'Motion', params: { seconds: '8', useCharacterReference: false } },
      videoInput: { nodeId: 'u', uploadId },
    },
  })
}

async function runWorkerUntilJobId(id: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await ctx!.worker.tick()
    const row = ctx!.db.prepare('SELECT provider_job_id AS jobId FROM generations WHERE id = ?').get(id) as { jobId: string | null }
    if (row.jobId) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Tác vụ ${id} không nhận được provider_job_id`)
}

describe('Kiểu gửi ảnh tham chiếu video tới provider', () => {
  it('provider image_url_string ⇒ input_reference là CHUỖI trong thân POST thật', async () => {
    const s = await setup('image_url_string')
    const result = enqueueVideo(s.userId, s.modelPk, s.uploadId)

    // Cấu hình được chụp lại vào tác vụ, không đọc lúc chạy.
    const snap = ctx!.db
      .prepare('SELECT snap_video_reference_style AS style FROM generations WHERE id = ?')
      .get(result.generation.id) as { style: string }
    expect(snap.style).toBe('image_url_string')

    await runWorkerUntilJobId(result.generation.id)
    const post = s.captured.find((entry) => entry.method === 'POST' && entry.path.includes('/videos'))
    expect(post, 'chưa có POST /videos').toBeDefined()
    expect(post!.body).toMatchObject({ model: 'gateway-video', seconds: '8' })
    expect((post!.body as { input_reference: unknown }).input_reference).toMatch(/^data:image\/png;base64,/)
  })

  it('provider image_url_object ⇒ input_reference là OBJECT { image_url }', async () => {
    const s = await setup('image_url_object')
    const result = enqueueVideo(s.userId, s.modelPk, s.uploadId)
    await runWorkerUntilJobId(result.generation.id)
    const post = s.captured.find((entry) => entry.method === 'POST' && entry.path.includes('/videos'))
    expect(post).toBeDefined()
    const reference = (post!.body as { input_reference: { image_url: string } }).input_reference
    expect(reference.image_url).toMatch(/^data:image\/png;base64,/)
  })

  it('đổi cấu hình provider sau khi xếp hàng không làm đổi tác vụ đang chạy', async () => {
    const s = await setup('image_url_string')
    const result = enqueueVideo(s.userId, s.modelPk, s.uploadId)

    // Đổi sang kiểu object SAU khi tác vụ đã chụp snapshot.
    await call(ctx!, `/api/providers/${s.providerId}`, {
      method: 'PATCH',
      body: { videoReferenceStyle: 'image_url_object' },
    })

    await runWorkerUntilJobId(result.generation.id)
    const post = s.captured.find((entry) => entry.method === 'POST' && entry.path.includes('/videos'))
    expect(typeof (post!.body as { input_reference: unknown }).input_reference).toBe('string')
  })
})
