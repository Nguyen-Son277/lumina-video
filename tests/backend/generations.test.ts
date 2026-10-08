import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  registerUser,
  seedProviderAndModel,
  startTestServer,
  waitForGeneration,
  type TestContext,
} from './helpers'
import { buildImageRequestBody, readImageEntries } from '../../server/generations/adapters/image'
import { buildVideoRequestBody, readVideoJob } from '../../server/generations/adapters/video'
import { sniffMime } from '../../server/media/store'
import { providerIncompatible } from '../../server/lib/errors'

let ctx: TestContext

beforeAll(async () => {
  ctx = await startTestServer()
})

afterAll(async () => {
  if (ctx) await ctx.close()
})

describe('Tạo ảnh', () => {
  it('hoàn tất và lưu asset', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')

    const created = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, prompt: 'Một khung cảnh yên bình', params: { size: '1024x1024' } },
    })
    expect(created.status).toBe(202)
    expect(created.body.generation.status).toBe('queued')

    const done = await waitForGeneration(ctx, created.body.generation.id)
    expect(done.status).toBe('succeeded')
    expect(done.progress).toBe(100)
    expect(done.assets).toHaveLength(1)
    expect(done.assets[0].mimeType).toBe('image/png')
    expect(done.assets[0].byteSize).toBeGreaterThan(0)
  })

  it('tạo nhiều ảnh khi yêu cầu n=3', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')

    const created = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, prompt: 'Ba biến thể', params: { n: 3 } },
    })
    const done = await waitForGeneration(ctx, created.body.generation.id)
    expect(done.assets).toHaveLength(3)

    // Mỗi ảnh phải là tệp riêng, không ghi đè nhau.
    const paths = new Set(done.assets.map((asset: any) => asset.id))
    expect(paths.size).toBe(3)
  })

  it('phục vụ media kèm header an toàn', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')

    const created = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, prompt: 'Kiểm tra header' },
    })
    const done = await waitForGeneration(ctx, created.body.generation.id)
    const url = done.assets[0].url

    const response = await fetch(`${ctx.baseUrl}${url}`, { headers: { Cookie: ctx.cookie } })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-disposition')).toContain('inline')

    const bytes = new Uint8Array(await response.arrayBuffer())
    expect(bytes[0]).toBe(0x89)
    expect(bytes[1]).toBe(0x50)
  })

  it('đặt tên tải xuống khi có download=1', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const created = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, prompt: 'Tải xuống' },
    })
    const done = await waitForGeneration(ctx, created.body.generation.id)

    const response = await fetch(`${ctx.baseUrl}${done.assets[0].url}?download=1`, {
      headers: { Cookie: ctx.cookie },
    })
    expect(response.headers.get('content-disposition')).toContain('attachment')
  })
})

describe('Tạo video', () => {
  it('trải qua trạng thái trung gian rồi hoàn tất', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'video')

    const created = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, prompt: 'Sóng biển', params: { seconds: '4' } },
    })
    const id = created.body.generation.id
    expect(created.body.generation.kind).toBe('video')

    // Sau vòng đầu tiên, job đã có ID ở provider.
    await ctx.worker.tick()
    const afterStart = await call(ctx, `/api/generations/${id}`)
    expect(afterStart.body.generation.providerJobId).toBeTruthy()

    const done = await waitForGeneration(ctx, id)
    expect(done.status).toBe('succeeded')
    expect(done.assets).toHaveLength(1)
    expect(done.assets[0].mimeType).toBe('video/mp4')
  })

  it('hỗ trợ Range cho video', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'video')
    const created = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, prompt: 'Range' },
    })
    const done = await waitForGeneration(ctx, created.body.generation.id)
    const url = done.assets[0].url

    const full = await fetch(`${ctx.baseUrl}${url}`, { headers: { Cookie: ctx.cookie } })
    expect(full.status).toBe(200)
    expect(full.headers.get('accept-ranges')).toBe('bytes')

    const partial = await fetch(`${ctx.baseUrl}${url}`, {
      headers: { Cookie: ctx.cookie, Range: 'bytes=0-9' },
    })
    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-range')).toMatch(/^bytes 0-9\//)

    const invalid = await fetch(`${ctx.baseUrl}${url}`, {
      headers: { Cookie: ctx.cookie, Range: 'bytes=99999-100000' },
    })
    expect(invalid.status).toBe(416)
  })

  it('giữ providerJobId khi provider báo lỗi để có thể thử lại', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'video')

    const created = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, prompt: 'Sẽ lỗi' },
    })
    const id = created.body.generation.id

    // Sau vòng đầu, job đã có ID ở provider.
    await ctx.worker.tick()
    const afterStart = await call(ctx, `/api/generations/${id}`)
    const jobId = afterStart.body.generation.providerJobId
    expect(jobId).toBeTruthy()

    // Dù kết quả cuối là thành công hay thất bại, ID job phải được giữ lại
    // để người dùng có thể thử tải lại mà không tạo video mới.
    const done = await waitForGeneration(ctx, id, { timeoutMs: 8000 })
    expect(['succeeded', 'failed']).toContain(done.status)
    expect(done.providerJobId).toBe(jobId)
  })
})

describe('Chống gửi trùng và giới hạn', () => {
  it('idempotencyKey trả lại cùng tác vụ', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const key = `idem-${Date.now()}`

    const first = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, prompt: 'Trùng', idempotencyKey: key },
    })
    const second = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, prompt: 'Trùng', idempotencyKey: key },
    })

    expect(first.status).toBe(202)
    expect(second.status).toBe(200)
    expect(second.body.generation.id).toBe(first.body.generation.id)
  })

  it('từ chối model chưa phân loại', async () => {
    await registerUser(ctx)
    const provider = await call(ctx, '/api/providers', {
      method: 'POST',
      body: { name: 'Chưa rõ', baseUrl: 'https://unknown.test/v1', apiKey: 'sk-mock' },
    })
    const model = await call(ctx, '/api/models', {
      method: 'POST',
      body: { providerId: provider.body.provider.id, modelId: 'mystery', kind: 'unclassified' },
    })

    const result = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: model.body.model.id, prompt: 'Thử' },
    })
    expect(result.status).toBe(400)
    expect(result.body.error.message).toContain('chưa được phân loại')
  })

  it('từ chối model đang bị tắt', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    await call(ctx, `/api/models/${modelPk}`, { method: 'PATCH', body: { enabled: false } })

    const result = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, prompt: 'Bị tắt' },
    })
    expect(result.status).toBe(400)
    expect(result.body.error.message).toContain('bị tắt')
  })

  it('từ chối prompt rỗng', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const result = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, prompt: '   ' },
    })
    expect(result.status).toBe(400)
  })

  it('giới hạn số tác vụ chạy đồng thời', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'video')

    const limit = ctx.env.MAX_CONCURRENT_JOBS_PER_USER
    for (let index = 0; index < limit; index += 1) {
      const result = await call(ctx, '/api/generations', {
        method: 'POST',
        body: { modelId: modelPk, prompt: `Đồng thời ${index}` },
      })
      expect(result.status).toBe(202)
    }

    const overflow = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, prompt: 'Vượt giới hạn' },
    })
    expect(overflow.status).toBe(400)
    expect(overflow.body.error.message).toContain('tác vụ chạy')
  })

  it('chặn xóa tác vụ đang chạy', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'video')
    const created = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, prompt: 'Đang chạy' },
    })

    const result = await call(ctx, `/api/generations/${created.body.generation.id}`, {
      method: 'DELETE',
    })
    expect(result.status).toBe(400)
  })

  it('xóa tác vụ đã xong và xóa cả media', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const created = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, prompt: 'Sẽ xóa' },
    })
    const done = await waitForGeneration(ctx, created.body.generation.id)
    const assetUrl = done.assets[0].url

    const removed = await call(ctx, `/api/generations/${done.id}`, { method: 'DELETE' })
    expect(removed.status).toBe(204)

    // Bản ghi đã mất.
    const after = await call(ctx, `/api/generations/${done.id}`)
    expect(after.status).toBe(404)

    // Media cũng không còn phục vụ được.
    const asset = await fetch(`${ctx.baseUrl}${assetUrl}`, { headers: { Cookie: ctx.cookie } })
    expect(asset.status).toBe(404)
  })
})

describe('Khôi phục sau khi khởi động lại', () => {
  it('tác vụ running không có provider_job_id chuyển thành unknown', async () => {
    await registerUser(ctx)
    const { modelPk, providerId } = await seedProviderAndModel(ctx, 'image')

    // Mô phỏng tác vụ bị bỏ dở khi backend tắt: running nhưng chưa có ID job.
    const id = `orphan-${Date.now()}`
    const now = Date.now()
    ctx.db
      .prepare(
        `INSERT INTO generations
           (id, user_id, model_pk, provider_id, kind, prompt, params_json,
            snap_provider, snap_base_url, snap_model_id, status, attempt_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'image', 'bỏ dở', '{}', 'P', 'https://x.test/v1', 'm', 'running', 1, ?, ?)`,
      )
      .run(id, ctx.db.prepare('SELECT user_id FROM models WHERE id = ?').get(modelPk)!.user_id as string, modelPk, providerId, now, now)

    // Khởi động lại worker trên cùng database.
    const { createWorker } = await import('../../server/generations/worker')
    const worker = createWorker({ db: ctx.db, mediaStore: ctx.mediaStore, env: ctx.env, intervalMs: 60_000 })
    await worker.stop()
    // recoverOnBoot chạy trong start(); gọi tick sau khi start để xử lý.
    worker.start()
    await worker.stop()

    const detail = await call(ctx, `/api/generations/${id}`)
    expect(detail.body.generation.status).toBe('unknown')
    expect(detail.body.generation.errorCode).toBe('INTERRUPTED')
    // Thông báo phải nói rõ không tự gửi lại.
    expect(detail.body.generation.errorMessage.toLowerCase()).toContain('không tự gửi lại')
  })

  it('tác vụ running có provider_job_id tiếp tục được theo dõi', async () => {
    await registerUser(ctx)
    const { modelPk, providerId } = await seedProviderAndModel(ctx, 'video')

    const { createMockVideoJob } = await import('../../server/generations/adapters/mock')
    const job = createMockVideoJob()

    const id = `resume-${Date.now()}`
    const now = Date.now()
    ctx.db
      .prepare(
        `INSERT INTO generations
           (id, user_id, model_pk, provider_id, kind, prompt, params_json,
            snap_provider, snap_base_url, snap_model_id, status, provider_job_id,
            attempt_count, poll_started_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'video', 'tiếp tục', '{}', 'P', 'https://x.test/v1', 'm',
                 'running', ?, 1, ?, ?, ?)`,
      )
      .run(
        id,
        ctx.db.prepare('SELECT user_id FROM models WHERE id = ?').get(modelPk)!.user_id as string,
        modelPk,
        providerId,
        job.id,
        now,
        now,
        now,
      )

    const done = await waitForGeneration(ctx, id)
    expect(done.status).toBe('succeeded')
    expect(done.assets.length).toBeGreaterThan(0)
  })
})

describe('Đọc dữ liệu provider', () => {
  it('chỉ gửi tham số người dùng đặt', () => {
    const body = buildImageRequestBody('model-x', 'prompt', {})
    expect(body).toEqual({ model: 'model-x', prompt: 'prompt' })

    const withParams = buildImageRequestBody('model-x', 'prompt', {
      size: '1024x1024',
      quality: 'high',
      n: 2,
    })
    expect(withParams).toEqual({
      model: 'model-x',
      prompt: 'prompt',
      size: '1024x1024',
      quality: 'high',
      n: 2,
    })
  })

  it('đọc ảnh từ b64_json và url', () => {
    expect(readImageEntries({ data: [{ b64_json: 'abc' }] })).toEqual([{ b64: 'abc', url: undefined }])
    expect(readImageEntries({ data: [{ url: 'https://x.test/a.png' }] })).toEqual([
      { b64: undefined, url: 'https://x.test/a.png' },
    ])
  })

  it('báo lỗi khi response lệch hợp đồng', () => {
    expect(() => readImageEntries({ data: [] })).toThrow()
    expect(() => readImageEntries({ data: [{ khac: 1 }] })).toThrow()
    expect(() => readImageEntries(null)).toThrow()
  })

  it('đọc trạng thái video với nhiều cách đặt tên', () => {
    expect(readVideoJob({ id: 'v1', status: 'queued' }).state).toBe('queued')
    expect(readVideoJob({ id: 'v1', status: 'processing' }).state).toBe('in_progress')
    expect(readVideoJob({ id: 'v1', state: 'succeeded' }).state).toBe('completed')
    expect(readVideoJob({ id: 'v1', status: 'error', error: { message: 'lỗi' } }).errorMessage).toBe('lỗi')

    // Tiến trình 0..1 được quy đổi thành phần trăm.
    expect(readVideoJob({ id: 'v1', status: 'processing', progress: 0.5 }).progress).toBe(50)
    expect(readVideoJob({ id: 'v1', status: 'processing', progress: 75 }).progress).toBe(75)
  })

  it('báo lỗi khi thiếu ID hoặc trạng thái lạ', () => {
    expect(() => readVideoJob({ status: 'queued' })).toThrow()
    expect(() => readVideoJob({ id: 'v1', status: 'khong-biet' })).toThrow()
  })

  it('ghép body video đúng kiểu', () => {
    expect(buildVideoRequestBody('m', 'p', { seconds: 4 })).toEqual({
      model: 'm',
      prompt: 'p',
      seconds: '4',
    })
  })

  it('nhận dạng định dạng media từ magic bytes', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(sniffMime(png)).toBe('image/png')

    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
    expect(sniffMime(jpeg)).toBe('image/jpeg')

    const mp4 = Buffer.alloc(16)
    mp4.write('ftyp', 4, 'ascii')
    mp4.write('isom', 8, 'ascii')
    expect(sniffMime(mp4)).toBe('video/mp4')

    // Nội dung không phải media phải bị từ chối.
    expect(sniffMime(Buffer.from('<html><body>hi</body></html>'))).toBeNull()
    expect(sniffMime(Buffer.from([0x00, 0x01, 0x02]))).toBeNull()
  })

  it('lỗi provider không tương thích có mã riêng', () => {
    const error = providerIncompatible('sai định dạng')
    expect(error.code).toBe('PROVIDER_INCOMPATIBLE')
    expect(error.status).toBe(502)
  })
})
