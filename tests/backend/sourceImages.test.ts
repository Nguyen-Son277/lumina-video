import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, seedProviderAndModel, startTestServer, waitForGeneration, type TestContext } from './helpers'
import { MOCK_PNG_BYTES } from '../../server/generations/adapters/mock'
import { buildImageEditForm, readSourceImages } from '../../server/generations/adapters/image'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { if (ctx) await ctx.close() })

function upload(file: Uint8Array, type = 'image/png') {
  return fetch(`${ctx.baseUrl}/api/uploads`, {
    method: 'POST',
    headers: { Cookie: ctx.cookie, 'Content-Type': type },
    body: file,
  })
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])

describe('Ảnh nguồn để tạo ảnh từ ảnh', () => {
  it('tải lên, phục vụ qua endpoint có xác thực và xóa được', async () => {
    await registerUser(ctx)
    const response = await upload(MOCK_PNG_BYTES)
    expect(response.status).toBe(201)
    const body = (await response.json()) as { upload: { id: string; url: string; mimeType: string } }
    expect(body.upload.mimeType).toBe('image/png')
    expect(body.upload.url).toBe(`/api/uploads/${body.upload.id}`)

    const served = await fetch(`${ctx.baseUrl}${body.upload.url}`, { headers: { Cookie: ctx.cookie } })
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await served.arrayBuffer())[0]).toBe(0x89)

    const removed = await call(ctx, `/api/uploads/${body.upload.id}`, { method: 'DELETE' })
    expect(removed.status).toBe(204)

    const after = await fetch(`${ctx.baseUrl}${body.upload.url}`, { headers: { Cookie: ctx.cookie } })
    expect(after.status).toBe(404)
  })

  it('bắt buộc nhận dạng ảnh bằng magic bytes', async () => {
    await registerUser(ctx)
    const html = new TextEncoder().encode('<html>không phải ảnh</html>')
    const response = await upload(html, 'image/png')
    expect(response.status).toBe(502)
  })

  it('từ chối ảnh quá dung lượng', async () => {
    await registerUser(ctx)
    const big = new Uint8Array(ctx.env.MAX_SOURCE_IMAGE_BYTES + 2048)
    big.set(MOCK_PNG_BYTES, 0)
    const response = await upload(big)
    expect(response.status).toBe(413)
  })

  it('yêu cầu đăng nhập và tách biệt tài khoản', async () => {
    await registerUser(ctx)
    const created = (await (await upload(MOCK_PNG_BYTES)).json()) as { upload: { id: string } }

    const anonymous = await fetch(`${ctx.baseUrl}/api/uploads/${created.upload.id}`)
    expect(anonymous.status).toBe(401)

    await registerUser(ctx)
    const stranger = await fetch(`${ctx.baseUrl}/api/uploads/${created.upload.id}`, {
      headers: { Cookie: ctx.cookie },
    })
    expect(stranger.status).toBe(404)
    expect((await call(ctx, `/api/uploads/${created.upload.id}`, { method: 'DELETE' })).status).toBe(404)
  })
})

describe('Tạo ảnh từ ảnh nguồn', () => {
  it('lưu snapshot ảnh nguồn và báo số lượng trong kết quả', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const first = (await (await upload(MOCK_PNG_BYTES)).json()) as { upload: { id: string } }
    const second = (await (await upload(JPEG, 'image/jpeg')).json()) as { upload: { id: string } }

    const created = await call(ctx, '/api/generations', {
      method: 'POST',
      body: {
        modelId: modelPk,
        prompt: 'Biến bức ảnh này thành tranh màu nước',
        sourceUploadIds: [first.upload.id, second.upload.id],
      },
    })
    expect(created.status).toBe(202)
    expect(created.body.generation.sourceImageCount).toBe(2)

    // Snapshot đường dẫn được lưu cùng tác vụ để không phụ thuộc ảnh nguồn.
    const row = ctx.db
      .prepare('SELECT source_images_json AS json FROM generations WHERE id = ?')
      .get(created.body.generation.id) as { json: string }
    const sources = readSourceImages(row.json)
    expect(sources.map((source) => source.mime)).toEqual(['image/png', 'image/jpeg'])

    const done = await waitForGeneration(ctx, created.body.generation.id)
    expect(done.status).toBe('succeeded')
    expect(done.assets.length).toBeGreaterThan(0)
  })

  it('tác vụ không có ảnh nguồn giữ nguyên hành vi cũ', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const created = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, prompt: 'Chỉ có chữ' },
    })
    expect(created.body.generation.sourceImageCount).toBe(0)
    const row = ctx.db
      .prepare('SELECT source_images_json AS json FROM generations WHERE id = ?')
      .get(created.body.generation.id) as { json: string | null }
    expect(row.json).toBeNull()
  })

  it('từ chối ảnh nguồn của tài khoản khác', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const mine = (await (await upload(MOCK_PNG_BYTES)).json()) as { upload: { id: string } }

    await registerUser(ctx)
    const stolen = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, prompt: 'Mượn ảnh', sourceUploadIds: [mine.upload.id] },
    })
    // Model của tài khoản trước cũng không thuộc tài khoản này.
    expect(stolen.status).toBe(400)
  })

  it('từ chối ảnh nguồn với model video', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'video')
    const source = (await (await upload(MOCK_PNG_BYTES)).json()) as { upload: { id: string } }

    const result = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, prompt: 'Video', sourceUploadIds: [source.upload.id] },
    })
    expect(result.status).toBe(400)
    expect(result.body.error.message).toContain('Chỉ model tạo ảnh')
  })

  it('giới hạn số ảnh nguồn mỗi lần tạo', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const ids: string[] = []
    for (let index = 0; index < ctx.env.MAX_SOURCE_IMAGES; index += 1) {
      ids.push(((await (await upload(MOCK_PNG_BYTES)).json()) as { upload: { id: string } }).upload.id)
    }

    const ok = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, prompt: 'Trong giới hạn', sourceUploadIds: ids },
    })
    expect(ok.status).toBe(202)

    const tooMany = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, prompt: 'Vượt giới hạn', sourceUploadIds: [...ids, 'them-mot-id'] },
    })
    expect(tooMany.status).toBe(400)
  })

  it('ảnh nguồn không tồn tại bị từ chối', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const result = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, prompt: 'Ảnh lạ', sourceUploadIds: ['khong-ton-tai'] },
    })
    expect(result.status).toBe(400)
  })
})

describe('Dựng multipart cho /images/edits', () => {
  it('gồm model, prompt, tham số và các ảnh dưới khóa image', () => {
    const form = buildImageEditForm({
      modelId: 'gpt-image-1',
      prompt: 'Thành tranh màu nước',
      params: { size: '1024x1024', quality: 'high', n: 2 },
      sources: [
        { bytes: MOCK_PNG_BYTES, mimeType: 'image/png' },
        { bytes: JPEG, mimeType: 'image/jpeg' },
      ],
    })

    expect(form.get('model')).toBe('gpt-image-1')
    expect(form.get('prompt')).toBe('Thành tranh màu nước')
    expect(form.get('size')).toBe('1024x1024')
    expect(form.get('quality')).toBe('high')
    expect(form.get('n')).toBe('2')

    // Nhiều ảnh dùng cùng khóa `image` theo hợp đồng của OpenAI.
    const images = form.getAll('image')
    expect(images).toHaveLength(2)
    for (const image of images) expect(image).toBeInstanceOf(Blob)
  })

  it('bỏ qua tham số người dùng không đặt', () => {
    const form = buildImageEditForm({
      modelId: 'm',
      prompt: 'p',
      params: {},
      sources: [{ bytes: MOCK_PNG_BYTES, mimeType: 'image/png' }],
    })
    expect(form.get('size')).toBeNull()
    expect(form.get('quality')).toBeNull()
    expect(form.get('n')).toBeNull()
  })

  it('đọc snapshot chịu được dữ liệu hỏng', () => {
    expect(readSourceImages(null)).toEqual([])
    expect(readSourceImages('')).toEqual([])
    expect(readSourceImages('không phải json')).toEqual([])
    expect(readSourceImages('{"a":1}')).toEqual([])
    expect(readSourceImages('[{"path":"x"},{"path":"y","mime":"image/png"}]')).toEqual([
      { path: 'y', mime: 'image/png' },
    ])
  })
})
