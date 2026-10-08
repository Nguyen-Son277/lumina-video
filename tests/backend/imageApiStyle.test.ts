import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  registerUser,
  seedProviderAndModel,
  startTestServer,
  waitForGeneration,
  type TestContext,
} from './helpers'
import { MOCK_PNG_BYTES } from '../../server/generations/adapters/mock'
import {
  buildExtraBodyImageRequest,
  buildImageRequestBody,
  readImageApiStyle,
} from '../../server/generations/adapters/image'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { if (ctx) await ctx.close() })

describe('Dựng request kiểu extra_body (Agnes Image 2.0 Flash)', () => {
  it('đặt response_format trong extra_body, không đặt ở top-level', () => {
    const body = buildExtraBodyImageRequest({
      modelId: 'agnes-image-2.0-flash',
      prompt: 'A glass cube on a white studio background',
      params: { size: '1024x768' },
      sources: [],
    })

    expect(body.model).toBe('agnes-image-2.0-flash')
    expect(body.prompt).toBe('A glass cube on a white studio background')
    expect(body.size).toBe('1024x768')

    // Mấu chốt: response_format phải nằm trong extra_body, đặt top-level có thể lỗi 400.
    expect(body).not.toHaveProperty('response_format')
    expect(body.extra_body).toEqual({ response_format: 'url' })
  })

  it('gửi ảnh nguồn trong extra_body.image dạng Data URI', () => {
    const body = buildExtraBodyImageRequest({
      modelId: 'agnes-image-2.0-flash',
      prompt: 'Transform into cyberpunk style',
      params: { size: '1024x768' },
      sources: [{ bytes: MOCK_PNG_BYTES, mimeType: 'image/png' }],
    }) as { extra_body: { image: string[] } }

    expect(body.extra_body.image).toHaveLength(1)
    const dataUrl = body.extra_body.image[0]!
    expect(dataUrl).toMatch(/^data:image\/png;base64,/)
    expect(Buffer.from(dataUrl.split(',')[1]!, 'base64').subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    )
    // Không cần tag img2img theo tài liệu.
    expect(body).not.toHaveProperty('tags')
  })

  it('gộp nhiều ảnh tham chiếu trong cùng một mảng', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x10, 0x20])
    const body = buildExtraBodyImageRequest({
      modelId: 'm',
      prompt: 'Ghép hai ảnh',
      params: {},
      sources: [
        { bytes: MOCK_PNG_BYTES, mimeType: 'image/png' },
        { bytes: jpeg, mimeType: 'image/jpeg' },
      ],
    }) as { extra_body: { image: string[] } }

    expect(body.extra_body.image).toHaveLength(2)
    expect(body.extra_body.image[1]).toMatch(/^data:image\/jpeg;base64,/)
  })

  it('không gửi quality và chỉ gửi n khi cần nhiều ảnh', () => {
    const single = buildExtraBodyImageRequest({
      modelId: 'm',
      prompt: 'p',
      params: { quality: 'high', n: 1 },
      sources: [],
    })
    expect(single).not.toHaveProperty('quality')
    expect(single).not.toHaveProperty('n')

    const multi = buildExtraBodyImageRequest({
      modelId: 'm',
      prompt: 'p',
      params: { n: 3 },
      sources: [],
    })
    expect(multi.n).toBe(3)
  })

  it('không bao giờ gửi quality, kể cả khi người dùng đặt', () => {
    const body = buildExtraBodyImageRequest({
      modelId: 'agnes-image-2.0-flash',
      prompt: 'p',
      params: { quality: 'high' },
      sources: [],
    })
    expect(body).not.toHaveProperty('quality')
    expect(JSON.stringify(body)).not.toContain('quality')
  })

  it('bỏ qua tham số không phải chuỗi', () => {
    const body = buildExtraBodyImageRequest({
      modelId: 'm',
      prompt: 'p',
      params: { size: 1234 as unknown as string },
      sources: [],
    })
    expect(body).not.toHaveProperty('size')
  })

  it('đọc kiểu API an toàn với giá trị lạ', () => {
    expect(readImageApiStyle('extra_body')).toBe('extra_body')
    expect(readImageApiStyle('openai')).toBe('openai')
    expect(readImageApiStyle(null)).toBe('openai')
    expect(readImageApiStyle(undefined)).toBe('openai')
    expect(readImageApiStyle('gi-do-do')).toBe('openai')
  })
})

describe('Cấu hình kiểu API ảnh theo provider', () => {
  it('mặc định là openai và đổi được sang extra_body', async () => {
    await registerUser(ctx)
    const created = await call(ctx, '/api/providers', {
      method: 'POST',
      body: { name: 'Agnes', baseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: 'sk-agnes' },
    })
    expect(created.status).toBe(201)
    expect(created.body.provider.imageApiStyle).toBe('openai')

    const patched = await call(ctx, `/api/providers/${created.body.provider.id}`, {
      method: 'PATCH',
      body: { imageApiStyle: 'extra_body' },
    })
    expect(patched.status).toBe(200)
    expect(patched.body.provider.imageApiStyle).toBe('extra_body')

    const list = await call(ctx, '/api/providers')
    expect(list.body.providers[0].imageApiStyle).toBe('extra_body')
  })

  it('tạo provider với kiểu extra_body ngay từ đầu', async () => {
    await registerUser(ctx)
    const created = await call(ctx, '/api/providers', {
      method: 'POST',
      body: {
        name: 'Agnes',
        baseUrl: 'https://apihub.agnes-ai.com/v1',
        apiKey: 'sk-agnes',
        imageApiStyle: 'extra_body',
      },
    })
    expect(created.status).toBe(201)
    expect(created.body.provider.imageApiStyle).toBe('extra_body')
  })

  it('từ chối kiểu API không hợp lệ', async () => {
    await registerUser(ctx)
    const created = await call(ctx, '/api/providers', {
      method: 'POST',
      body: {
        name: 'Sai',
        baseUrl: 'https://x.test/v1',
        apiKey: 'sk-x',
        imageApiStyle: 'khong-hop-le',
      },
    })
    expect(created.status).toBe(400)
  })

  it('tác vụ lưu snapshot kiểu API tại thời điểm tạo', async () => {
    await registerUser(ctx)
    const { providerId, modelPk } = await seedProviderAndModel(ctx, 'image')

    // Mặc định là openai.
    const first = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, prompt: 'Ảnh thường' },
    })
    let row = ctx.db
      .prepare('SELECT snap_image_style AS style FROM generations WHERE id = ?')
      .get(first.body.generation.id) as { style: string }
    expect(row.style).toBe('openai')

    // Đổi provider sang extra_body rồi tạo tác vụ mới.
    await call(ctx, `/api/providers/${providerId}`, {
      method: 'PATCH',
      body: { imageApiStyle: 'extra_body' },
    })
    const second = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, prompt: 'Ảnh kiểu Agnes' },
    })
    row = ctx.db
      .prepare('SELECT snap_image_style AS style FROM generations WHERE id = ?')
      .get(second.body.generation.id) as { style: string }
    expect(row.style).toBe('extra_body')

    // Tác vụ cũ giữ nguyên snapshot.
    const old = ctx.db
      .prepare('SELECT snap_image_style AS style FROM generations WHERE id = ?')
      .get(first.body.generation.id) as { style: string }
    expect(old.style).toBe('openai')
  })
})

describe('Gọi HTTP thật tới provider giả lập kiểu Agnes', () => {
  it('gửi đúng hợp đồng: response_format trong extra_body và ảnh nguồn dạng Data URI', async () => {
    const captured: Array<{ path: string; body: any }> = []

    // Một handler duy nhất, điều hướng theo đường dẫn.
    const fake = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')

        if (req.url === '/ket-qua.png') {
          res.writeHead(200, { 'Content-Type': 'image/png' })
          res.end(MOCK_PNG_BYTES)
          return
        }

        captured.push({ path: req.url ?? '', body: JSON.parse(raw || '{}') })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            created: Math.floor(Date.now() / 1000),
            data: [
              { url: `http://127.0.0.1:${port}/ket-qua.png`, b64_json: null, revised_prompt: null },
            ],
          }),
        )
      })
    })

    const port = await new Promise<number>((resolve) => {
      fake.listen(0, '127.0.0.1', () => {
        resolve((fake.address() as { port: number }).port)
      })
    })

    const live = await startTestServer({ allowPrivate: true, providerMode: 'live' })
    try {
      await registerUser(live)
      const provider = (await call(live, '/api/providers', {
        method: 'POST',
        body: {
          name: 'Agnes',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: 'sk-agnes-test',
          imageApiStyle: 'extra_body',
        },
      })).body.provider
      expect(provider.imageApiStyle).toBe('extra_body')

      const model = (await call(live, '/api/models', {
        method: 'POST',
        body: {
          providerId: provider.id,
          modelId: 'agnes-image-2.0-flash',
          displayName: 'Agnes Image 2.0 Flash',
          kind: 'image',
        },
      })).body.model

      const created = await call(live, '/api/generations', {
        method: 'POST',
        body: { modelId: model.id, prompt: 'A glass cube', params: { size: '1024x768' } },
      })
      expect(created.status).toBe(202)

      // Chờ worker gọi provider giả lập.
      const deadline = Date.now() + 10_000
      while (captured.length === 0 && Date.now() < deadline) {
        await live.worker.tick()
        await new Promise((resolve) => setTimeout(resolve, 50))
      }

      expect(captured).toHaveLength(1)
      const first = captured[0]!
      expect(first.path).toBe('/v1/images/generations')
      const body = first.body
      expect(body.model).toBe('agnes-image-2.0-flash')
      expect(body.prompt).toContain('A glass cube')
      expect(body.size).toBe('1024x768')
      expect(body).not.toHaveProperty('response_format')
      expect(body.extra_body.response_format).toBe('url')
      expect(body.extra_body.image).toBeUndefined()

      // Tác vụ phải hoàn tất và tải được ảnh từ URL provider trả về.
      const done = await waitForGeneration(live, created.body.generation.id)
      expect(done.status).toBe('succeeded')
      expect(done.assets.length).toBeGreaterThan(0)
    } finally {
      await live.close()
      await new Promise<void>((resolve) => fake.close(() => resolve()))
    }
  })
})

describe('Không gửi trường quality cho provider không hỗ trợ', () => {
  it('kiểu openai bỏ quality khi để mặc định', () => {
    // Giao diện mặc định không chọn chất lượng -> không có quality trong request.
    const body = buildImageRequestBody('agnes-image-2.0-flash', 'A glass cube', { size: '1024x768' })
    expect(body).not.toHaveProperty('quality')
    expect(body).toEqual({ model: 'agnes-image-2.0-flash', prompt: 'A glass cube', size: '1024x768' })

    // Chỉ gửi khi người dùng chủ động chọn.
    const explicit = buildImageRequestBody('gpt-image-1', 'p', { quality: 'high' })
    expect(explicit.quality).toBe('high')
  })
})
