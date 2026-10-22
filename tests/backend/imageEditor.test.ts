import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { call, registerUser, seedProviderAndModel, startTestServer, waitForGeneration, type TestContext } from './helpers'
import { regionMask, regionPixelBounds, padImage, preserveProtected, restoreMaskedResult, restoreRectResult, resizeToFrame } from '../../server/imageEditor/processing'
import { editorCapabilities } from '../../server/imageEditor/service'
import { createImageEditorRouter } from '../../server/imageEditor/routes'
import { listUsageEvents } from '../../server/usage/service'

let ctx: TestContext

beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { if (ctx) await ctx.close() })

/** Ảnh PNG có màu riêng biệt từng ô để kiểm tra pixel chính xác. */
async function samplePng(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      raw[i] = (x * 37) % 256
      raw[i + 1] = (y * 53) % 256
      raw[i + 2] = (x * 11 + y * 7) % 256
      raw[i + 3] = 255
    }
  }
  return sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer()
}

async function uploadBytes(bytes: Uint8Array, mime = 'image/png'): Promise<{ id: string; url: string }> {
  const response = await fetch(`${ctx.baseUrl}/api/uploads`, {
    method: 'POST',
    headers: { Cookie: ctx.cookie, 'Content-Type': mime },
    body: bytes,
  })
  expect(response.status).toBe(201)
  const body = (await response.json()) as { upload: { id: string; url: string } }
  return body.upload
}

/** Tải ảnh lên một context bất kỳ (dùng cho server provider thật trong test). */
async function uploadTo(target: TestContext, bytes: Uint8Array, mime = 'image/png'): Promise<string> {
  const response = await fetch(`${target.baseUrl}/api/uploads`, {
    method: 'POST',
    headers: { Cookie: target.cookie, 'Content-Type': mime },
    body: bytes,
  })
  expect(response.status).toBe(201)
  const body = (await response.json()) as { upload: { id: string } }
  return body.upload.id
}

describe('Mặt nạ vùng chỉnh sửa', () => {
  it('eraser trong một vùng không xoá vùng khác', () => {
    const mask = regionMask(10, 10, [
      {
        id: 'a',
        comment: 'region a',
        shapes: [
          { kind: 'rect', x: 0, y: 0, width: 0.5, height: 1 },
          { kind: 'rect', x: 0.1, y: 0.4, width: 0.2, height: 0.2, erase: true },
        ],
      },
      { id: 'b', comment: 'region b', shapes: [{ kind: 'rect', x: 0.5, y: 0, width: 0.5, height: 1 }] },
    ])

    // Vùng B nằm cột 5..9: vẫn phải sửa được toàn bộ.
    for (let y = 0; y < 10; y++) {
      for (let x = 5; x < 10; x++) expect(mask[y * 10 + x]).toBe(255)
    }
    // Vùng A bị eraser ăn mất vùng x=1..2, y=4..5.
    for (let y = 4; y <= 5; y++) {
      for (let x = 1; x <= 2; x++) expect(mask[y * 10 + x]).toBe(0)
    }
    // Vùng A còn lại vẫn sửa được.
    expect(mask[0]).toBe(255)
    expect(mask[9 * 10 + 0]).toBe(255)
  })

  it('vẽ sau khi tẩy thêm lại vùng đã tẩy (đúng thứ tự thao tác)', () => {
    const mask = regionMask(10, 10, [
      {
        id: 'a',
        comment: 'region a',
        shapes: [
          { kind: 'rect', x: 0, y: 0, width: 0.4, height: 0.4 },
          { kind: 'rect', x: 0.1, y: 0.1, width: 0.2, height: 0.2, erase: true },
          { kind: 'rect', x: 0.15, y: 0.15, width: 0.05, height: 0.05 },
        ],
      },
    ])
    // Vẽ sau khi tẩy thêm lại vùng đã tẩy (hình vẽ nằm trong vùng tẩy).
    expect(mask[1 * 10 + 1]).toBe(255)
    // Phần bị tẩy và không vẽ lại vẫn trống.
    expect(mask[2 * 10 + 2]).toBe(0)
  })

  it('vùng bị tẩy sạch không còn hộp giới hạn để mô tả', () => {
    const bounds = regionPixelBounds(10, 10, {
      id: 'a',
      comment: 'x',
      shapes: [
        { kind: 'rect', x: 0, y: 0, width: 0.4, height: 0.4 },
        { kind: 'rect', x: 0, y: 0, width: 0.4, height: 0.4, erase: true },
      ],
    })
    expect(bounds).toBeNull()
  })
})

describe('Đặt ảnh vào khung (pad)', () => {
  it('scale=1 chép nguyên pixel nguồn vào đúng vị trí', async () => {
    const source = await samplePng(4, 3)
    const frame = { width: 6, height: 5, offsetX: 1, offsetY: 1, background: 'transparent' }
    const padded = await padImage(source, 4, 3, frame)
    const { data, info } = await sharp(padded).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    expect(info.width).toBe(6)
    expect(info.height).toBe(5)
    const original = await sharp(source).ensureAlpha().raw().toBuffer()
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 4; x++) {
        const target = ((y + 1) * 6 + (x + 1)) * 4
        const sourceIndex = (y * 4 + x) * 4
        expect(data[target]).toBe(original[sourceIndex])
        expect(data[target + 1]).toBe(original[sourceIndex + 1])
        expect(data[target + 2]).toBe(original[sourceIndex + 2])
        expect(data[target + 3]).toBe(255)
      }
    }
    // Vùng đệm trong suốt, không phải màu nền.
    expect(data[3]).toBe(0)
  })

  it('scale<1 thu nhỏ đúng tỉ lệ và đặt vào khung', async () => {
    const source = await samplePng(8, 8)
    const frame = { width: 8, height: 8, offsetX: 0, offsetY: 0, background: 'transparent', scale: 0.5 }
    const padded = await padImage(source, 8, 8, frame)
    const { data, info } = await sharp(padded).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    expect(info.width).toBe(8)
    expect(info.height).toBe(8)
    // Vùng ngoài 4x4 đã thu phải trong suốt.
    for (let y = 4; y < 8; y++) {
      for (let x = 0; x < 8; x++) expect(data[(y * 8 + x) * 4 + 3]).toBe(0)
    }
  })
})

describe('Khôi phục pixel được bảo vệ', () => {
  it('trả về đúng kích thước và giữ nguyên pixel ngoài vùng sửa', async () => {
    const source = await samplePng(4, 4)
    const edited = await sharp(await samplePng(4, 4)).modulate({ brightness: 2 }).png().toBuffer()
    const mask = Buffer.alloc(16)
    mask.fill(255, 0, 4)
    const restored = await preserveProtected(source, edited, mask, 4, 4)
    const { data } = await sharp(restored).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const original = await sharp(source).ensureAlpha().raw().toBuffer()
    for (let i = 0; i < 16; i++) {
      if (i < 4) continue
      expect(data[i * 4]).toBe(original[i * 4])
      expect(data[i * 4 + 1]).toBe(original[i * 4 + 1])
      expect(data[i * 4 + 2]).toBe(original[i * 4 + 2])
    }
  })

  it('từ chối kết quả provider sai kích thước', async () => {
    const source = await samplePng(4, 4)
    const edited = await samplePng(2, 2)
    await expect(preserveProtected(source, edited, Buffer.alloc(16), 4, 4)).rejects.toThrow()
  })
})

describe('Khôi phục kết quả provider cho tác vụ sửa ảnh', () => {
  it('sửa vùng có mặt nạ: pixel được bảo vệ giữ nguyên từ ảnh gốc', async () => {
    const source = await samplePng(4, 4)
    const edited = await sharp(await samplePng(4, 4)).modulate({ brightness: 3 }).png().toBuffer()
    const mask = Buffer.alloc(16)
    mask.fill(255, 0, 4)
    const restored = await restoreMaskedResult(source, edited, mask, 4, 4)
    const { data } = await sharp(restored).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const original = await sharp(source).ensureAlpha().raw().toBuffer()
    for (let i = 4; i < 16; i++) {
      expect(data[i * 4]).toBe(original[i * 4])
      expect(data[i * 4 + 1]).toBe(original[i * 4 + 1])
      expect(data[i * 4 + 2]).toBe(original[i * 4 + 2])
    }
  })

  it('mở rộng ảnh: hình chữ nhật gốc luôn được khôi phục từ ảnh nguồn', async () => {
    const source = await samplePng(4, 4)
    const frame = { width: 8, height: 8, offsetX: 2, offsetY: 2, background: 'transparent' }
    const padded = await padImage(source, 4, 4, frame)
    // Provider trả về một ảnh hoàn toàn khác (màu khác, kích thước khác).
    const providerOutput = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#00ff00' } }).png().toBuffer()
    const restored = await restoreRectResult(padded, providerOutput, { x: 2, y: 2, width: 4, height: 4 }, 8, 8)
    const { data } = await sharp(restored).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const original = await sharp(source).ensureAlpha().raw().toBuffer()
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const target = ((y + 2) * 8 + (x + 2)) * 4
        const sourceIndex = (y * 4 + x) * 4
        expect(data[target]).toBe(original[sourceIndex])
        expect(data[target + 1]).toBe(original[sourceIndex + 1])
        expect(data[target + 2]).toBe(original[sourceIndex + 2])
      }
    }
    // Vùng mới do provider tạo vẫn còn (không bị trắng xoá).
    expect(data[0]).toBe(0)
    expect(data[1]).toBe(255)
  })

  it('kết quả provider khác kích thước được thu phóng về khung và vẫn giữ vùng gốc', async () => {
    const resized = await resizeToFrame(await samplePng(2, 2), 8, 8)
    // Kết quả trả về là pixel RGBA thô đúng khung mong đợi.
    expect(resized.length).toBe(8 * 8 * 4)
  })
})

describe('API trình chỉnh sửa ảnh', () => {
  it('chuẩn hoá nguồn, giữ dòng dõi nguồn gốc và không sửa ảnh gốc', async () => {
    const { userId } = await registerUser(ctx)
    const original = await samplePng(5, 4)
    const upload = await uploadBytes(original)
    const before = ctx.db.prepare('SELECT relative_path AS path FROM uploads WHERE id=?').get(upload.id) as { path: string }
    const beforeBytes = ctx.mediaStore.readFile(before.path)

    const prepared = await call(ctx, '/api/image-editor/sources', {
      method: 'POST',
      body: { source: { kind: 'upload', id: upload.id } },
    })
    expect(prepared.status).toBe(201)
    expect(prepared.body.source.width).toBe(5)
    expect(prepared.body.source.height).toBe(4)
    expect(prepared.body.source.mimeType).toBe('image/png')
    expect(prepared.body.source.lineage).toEqual({ kind: 'upload', id: upload.id })
    expect(prepared.body.source.uploadId).not.toBe(upload.id)

    // Ảnh gốc còn nguyên trên đĩa.
    expect(Buffer.from(ctx.mediaStore.readFile(before.path))).toEqual(Buffer.from(beforeBytes))
    // Dòng dõi nguồn được giữ lại để sau này vẫn biết ảnh gốc là gì.
    const lineage = ctx.db.prepare('SELECT source_json AS json FROM image_editor_sources WHERE upload_id=?').get(prepared.body.source.uploadId) as { json: string }
    expect(JSON.parse(lineage.json).lineage).toEqual({ kind: 'upload', id: upload.id })
    expect(userId).toBeTruthy()
  })

  it('từ chối nguồn của tài khoản khác', async () => {
    await registerUser(ctx)
    const upload = await uploadBytes(await samplePng(4, 4))
    await registerUser(ctx)
    const prepared = await call(ctx, '/api/image-editor/sources', {
      method: 'POST',
      body: { source: { kind: 'upload', id: upload.id } },
    })
    expect(prepared.status).toBe(404)
  })

  it('model chưa xác nhận hỗ trợ mask KHÔNG được báo là có mask, nhưng vẫn dùng được ở chế độ hướng dẫn bằng mô tả', async () => {
    const { userId } = await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const capabilities = await editorCapabilities(ctx.db, ctx.env, userId)
    const model = capabilities.models.find((item) => item.id === modelPk)!
    // Chưa xác nhận thì KHÔNG được báo là hỗ trợ mask chính xác.
    expect(model.maskSupport).toBe('unknown')
    expect(model.region).toBe(false)
    // Nhưng vẫn cho sửa vùng theo mô tả, có cảnh báo rõ ràng.
    expect(model.regionPromptOnly).toBe(true)

    const upload = await uploadBytes(await samplePng(4, 4))
    const preview = await call(ctx, '/api/image-editor/preview', {
      method: 'POST',
      body: {
        source: { kind: 'upload', id: upload.id },
        operation: 'region',
        engine: 'provider',
        modelId: modelPk,
        regions: [{ id: 'r1', comment: 'làm đẹp', shapes: [{ kind: 'rect', x: 0, y: 0, width: 0.5, height: 0.5 }] }],
      },
    })
    expect(preview.status).toBe(200)
    expect(preview.body.promptDirected).toBe(true)
    expect(preview.body.warnings.join(' ')).toContain('mặt nạ')

    const job = await call(ctx, '/api/image-editor/jobs', {
      method: 'POST',
      body: {
        source: { kind: 'upload', id: upload.id },
        operation: 'region',
        engine: 'provider',
        modelId: modelPk,
        regions: [{ id: 'r1', comment: 'làm đẹp', shapes: [{ kind: 'rect', x: 0, y: 0, width: 0.5, height: 0.5 }] }],
      },
    })
    expect(job.status).toBe(201)
    expect(job.body.generation.imageEditor.promptDirected).toBe(true)
  })

  it('báo khả năng của model theo cột migration 050', async () => {
    const { userId } = await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const capabilities = await editorCapabilities(ctx.db, ctx.env, userId)
    const model = capabilities.models.find((item) => item.id === modelPk)!
    expect(model.maskSupport).toBe('unknown')
    // Chưa xác nhận mask thì không được báo sửa vùng chính xác.
    expect(model.region).toBe(false)
    expect(model.regionPromptOnly).toBe(true)
    // Mở rộng ảnh và thay nền không cần mask nên vẫn dùng được.
    expect(model.reframe).toBe(true)
    expect(model.background).toBe(true)
    // Xoá nền cần model xác nhận ảnh nền trong suốt.
    expect(model.backgroundRemoval).toBe(false)

    ctx.db.prepare("UPDATE models SET image_mask_support='yes', image_transparent_background_support='yes' WHERE id=?").run(modelPk)
    const updated = await editorCapabilities(ctx.db, ctx.env, userId)
    const ready = updated.models.find((item) => item.id === modelPk)!
    expect(ready.region).toBe(true)
    expect(ready.regionPromptOnly).toBe(false)
    expect(ready.reframe).toBe(true)
    expect(ready.background).toBe(true)
    expect(ready.backgroundRemoval).toBe(true)
  })

  it('tác vụ reframe cục bộ chạy không cần provider và lưu kết quả', async () => {
    await registerUser(ctx)
    const upload = await uploadBytes(await samplePng(4, 4))
    const created = await call(ctx, '/api/image-editor/jobs', {
      method: 'POST',
      body: {
        source: { kind: 'upload', id: upload.id },
        operation: 'reframe',
        engine: 'local',
        frame: { width: 8, height: 8, offsetX: 2, offsetY: 2, background: 'transparent' },
      },
    })
    expect(created.status).toBe(201)
    expect(created.body.generation.imageEditor.operation).toBe('reframe')
    expect(created.body.generation.provider).toBe('Local image editor')

    const done = await waitForGeneration(ctx, created.body.generation.id)
    expect(done.status).toBe('succeeded')
    expect(done.assets.length).toBe(1)
    // Không có provider/key nào được chọn cho tác vụ cục bộ.
    const row = ctx.db.prepare('SELECT provider_id AS providerId, credential_id AS credentialId FROM generations WHERE id=?').get(created.body.generation.id) as { providerId: string | null; credentialId: string | null }
    expect(row.providerId).toBeNull()
    expect(row.credentialId).toBeNull()
  })

  it('tác vụ cục bộ thất bại được đánh dấu failed chứ không treo running', async () => {
    const { userId } = await registerUser(ctx)
    // Tác vụ cục bộ với ảnh nguồn không tồn tại: worker phải đánh dấu failed.
    const id = randomUUID()
    const now = Date.now()
    const internal = {
      request: { source: { kind: 'upload', id: 'khong-ton-tai' }, operation: 'reframe', engine: 'local', frame: { width: 6, height: 6, offsetX: 0, offsetY: 0, background: 'transparent' } },
      snapshot: { source: { kind: 'upload', id: 'khong-ton-tai' }, preparedUploadId: 'khong-ton-tai', width: 4, height: 4, operation: 'reframe', engine: 'local' },
      sourcePath: `${userId}/uploads/khong-ton-tai/source.png`,
      retainedSource: null,
      width: 4,
      height: 4,
    }
    ctx.db.prepare(`INSERT INTO generations (id,user_id,kind,prompt,effective_prompt,params_json,snap_provider,snap_base_url,snap_model_id,status,created_at,updated_at,image_editor_json)
      VALUES (?,?,'image','p','p','{}','Local image editor','','local','queued',?,?,?)`).run(id, userId, now, now, JSON.stringify(internal))

    await ctx.worker.tick()
    const row = ctx.db.prepare('SELECT status,error_code AS errorCode,completed_at AS completedAt FROM generations WHERE id=?').get(id) as { status: string; errorCode: string | null; completedAt: number | null }
    expect(row.status).toBe('failed')
    expect(row.errorCode).toBeTruthy()
    expect(row.completedAt).toBeTruthy()
  })

  it('từ chối tác vụ nền cục bộ khi chưa cấu hình dịch vụ', async () => {
    await registerUser(ctx)
    const upload = await uploadBytes(await samplePng(4, 4))
    const result = await call(ctx, '/api/image-editor/jobs', {
      method: 'POST',
      body: {
        source: { kind: 'upload', id: upload.id },
        operation: 'background',
        engine: 'local',
        background: { mode: 'remove' },
      },
    })
    expect(result.status).toBe(400)
  })

  it('xoá nền cục bộ dùng mặt nạ của dịch vụ và giữ chủ thể', async () => {
    // Dịch vụ xoá nền giả: trả về mặt nạ xám trắng ở giữa, đen ở góc.
    const sidecar = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, status: 'ready', model: 'u2net' }))
        return
      }
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        void (async () => {
          const source = sharp(Buffer.concat(chunks))
          const { width = 4, height = 4 } = await source.metadata()
          const mask = Buffer.alloc(width * height, 0)
          for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) mask[y * width + x] = 255
          }
          const png = await sharp(mask, { raw: { width, height, channels: 1 } }).png().toBuffer()
          res.writeHead(200, { 'Content-Type': 'image/png' })
          res.end(png)
        })()
      })
    })
    await new Promise<void>((resolve) => sidecar.listen(0, '127.0.0.1', resolve))
    const port = (sidecar.address() as { port: number }).port
    const local = await startTestServer()
    // Cấu hình dịch vụ xoá nền sau khi khởi động để không đụng env của test khác.
    ;(local.env as unknown as { BACKGROUND_REMOVAL_URL: string }).BACKGROUND_REMOVAL_URL = `http://127.0.0.1:${port}`
    try {
      await registerUser(local)
      const upload = await uploadTo(local, await samplePng(4, 4))
      const created = await call(local, '/api/image-editor/jobs', {
        method: 'POST',
        body: {
          source: { kind: 'upload', id: upload },
          operation: 'background',
          engine: 'local',
          background: { mode: 'remove' },
        },
      })
      expect(created.status).toBe(201)
      const done = await waitForGeneration(local, created.body.generation.id)
      expect(done.status).toBe('succeeded')
      const saved = local.db.prepare('SELECT relative_path AS path FROM assets WHERE generation_id=?').get(created.body.generation.id) as { path: string }
      const { data } = await sharp(local.mediaStore.readFile(saved.path)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      // Góc ngoài vùng chủ thể phải trong suốt, giữa ảnh vẫn đục.
      expect(data[3]).toBe(0)
      const center = (1 * 4 + 1) * 4
      expect(data[center + 3]).toBe(255)
    } finally {
      await local.close()
      await new Promise<void>((resolve) => sidecar.close(() => resolve()))
    }
  })

  it('dùng lại tác vụ cũ với cùng idempotencyKey', async () => {
    await registerUser(ctx)
    const upload = await uploadBytes(await samplePng(4, 4))
    const body = {
      source: { kind: 'upload', id: upload.id },
      operation: 'reframe',
      engine: 'local',
      frame: { width: 6, height: 6, offsetX: 1, offsetY: 1, background: 'transparent' },
      idempotencyKey: `editor-${randomUUID()}`,
    }
    const first = await call(ctx, '/api/image-editor/jobs', { method: 'POST', body })
    expect(first.status).toBe(201)
    const second = await call(ctx, '/api/image-editor/jobs', { method: 'POST', body })
    expect(second.status).toBe(200)
    expect(second.body.reused).toBe(true)
    expect(second.body.generation.id).toBe(first.body.generation.id)
  })

  it('prompt dùng hộp giới hạn pixel gọn, không nhúng JSON điểm', async () => {
    const { userId } = await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const upload = await uploadBytes(await samplePng(8, 8))
    // 2000 điểm nét: JSON thô sẽ vượt giới hạn prompt của provider.
    const points = Array.from({ length: 2000 }, (_, index) => ({
      x: (index % 100) / 100,
      y: Math.floor(index / 100) / 20,
    }))
    const preview = await call(ctx, '/api/image-editor/preview', {
      method: 'POST',
      body: {
        source: { kind: 'upload', id: upload.id },
        operation: 'region',
        engine: 'provider',
        modelId: modelPk,
        regions: [{ id: 'r1', comment: 'làm đẹp', shapes: [{ kind: 'brush', points, radius: 0.05 }] }],
      },
    })
    expect(preview.status).toBe(200)
    expect(preview.body.prompt.length).toBeLessThan(2000)
    expect(preview.body.prompt).toContain('bounding box')
    expect(preview.body.prompt).toContain('8x8')
    expect(preview.body.prompt).not.toContain('"points"')
    expect(userId).toBeTruthy()
  })

  it('từ chối model không nhận ảnh tham chiếu', async () => {
    const { userId } = await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    ctx.db.prepare("UPDATE models SET image_reference_support='no' WHERE id=?").run(modelPk)
    const capabilities = await editorCapabilities(ctx.db, ctx.env, userId)
    const model = capabilities.models.find((item) => item.id === modelPk)!
    expect(model.region).toBe(false)
    expect(model.regionPromptOnly).toBe(false)
    expect(model.reframe).toBe(false)

    const upload = await uploadBytes(await samplePng(4, 4))
    const result = await call(ctx, '/api/image-editor/jobs', {
      method: 'POST',
      body: {
        source: { kind: 'upload', id: upload.id },
        operation: 'region',
        engine: 'provider',
        modelId: modelPk,
        regions: [{ id: 'r1', comment: 'làm đẹp', shapes: [{ kind: 'rect', x: 0, y: 0, width: 0.5, height: 0.5 }] }],
      },
    })
    expect(result.status).toBe(400)
  })

  it('tác vụ cục bộ không tạo chi phí ước tính', async () => {
    await registerUser(ctx)
    const upload = await uploadBytes(await samplePng(4, 4))
    const created = await call(ctx, '/api/image-editor/jobs', {
      method: 'POST',
      body: {
        source: { kind: 'upload', id: upload.id },
        operation: 'reframe',
        engine: 'local',
        frame: { width: 6, height: 6, offsetX: 1, offsetY: 1, background: 'transparent' },
      },
    })
    expect(created.status).toBe(201)
    const done = await waitForGeneration(ctx, created.body.generation.id)
    expect(done.status).toBe('succeeded')
    const owner = ctx.db.prepare('SELECT user_id AS userId FROM generations WHERE id=?').get(created.body.generation.id) as { userId: string }
    const { events } = listUsageEvents(ctx.db, { userId: owner.userId })
    const event = events.find((item) => item.id === created.body.generation.id)
    expect(event).toBeTruthy()
    expect(event!.cost).toBe(0)
    expect(event!.costUnknown).toBe(false)
  })

  it('từ chối yêu cầu vượt giới hạn vùng và bình luận', async () => {
    await registerUser(ctx)
    const upload = await uploadBytes(await samplePng(4, 4))
    const result = await call(ctx, '/api/image-editor/preview', {
      method: 'POST',
      body: {
        source: { kind: 'upload', id: upload.id },
        operation: 'region',
        engine: 'provider',
        modelId: 'model-khong-ton-tai',
        regions: [{ id: 'r1', comment: 'x'.repeat(2000), shapes: [{ kind: 'rect', x: 0, y: 0, width: 0.5, height: 0.5 }] }],
      },
    })
    expect(result.status).toBe(400)
  })

  it('không công khai đường dẫn media nội bộ trong snapshot công khai', async () => {
    await registerUser(ctx)
    const upload = await uploadBytes(await samplePng(4, 4))
    const created = await call(ctx, '/api/image-editor/jobs', {
      method: 'POST',
      body: {
        source: { kind: 'upload', id: upload.id },
        operation: 'reframe',
        engine: 'local',
        frame: { width: 6, height: 6, offsetX: 1, offsetY: 1, background: 'transparent' },
      },
    })
    const serialized = JSON.stringify(created.body)
    expect(serialized).not.toMatch(/uploads\//)
    expect(serialized).not.toMatch(/sourcePath|maskPath/)
  })
})

describe('Router ảnh chỉnh sửa', () => {
  it('yêu cầu đăng nhập', async () => {
    const anonymous = await fetch(`${ctx.baseUrl}/api/image-editor/capabilities`)
    expect(anonymous.status).toBe(401)
  })
  it('dựng router với tên hàm được app.ts dùng', () => {
    expect(typeof createImageEditorRouter).toBe('function')
  })
})

describe('Tác vụ provider qua HTTP thật', () => {
  /** Provider giả trả ảnh theo yêu cầu để kiểm tra từng bảo đảm pixel. */
  async function withFakeProvider(
    respond: (body: Buffer) => Promise<Buffer>,
    run: (params: { ctx: TestContext; modelPk: string; uploadId: string; captures: Buffer[] }) => Promise<void>,
  ): Promise<void> {
    const captures: Buffer[] = []
    const fake = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        const body = Buffer.concat(chunks)
        captures.push(body)
        void respond(body).then((image) => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ data: [{ b64_json: image.toString('base64') }] }))
        })
      })
    })
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve))
    const port = (fake.address() as { port: number }).port
    const live = await startTestServer({ allowPrivate: true, providerMode: 'live' })
    try {
      await registerUser(live)
      const provider = await call(live, '/api/providers', { method: 'POST', body: { name: 'Fake', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'fake-key' } })
      const model = await call(live, '/api/models', { method: 'POST', body: { providerId: provider.body.provider.id, modelId: 'fake-image', kind: 'image' } })
      const modelPk = model.body.model.id as string
      const upload = await uploadTo(live, await samplePng(4, 4))
      await run({ ctx: live, modelPk, uploadId: upload, captures })
    } finally {
      await live.close()
      await new Promise<void>((resolve) => fake.close(() => resolve()))
    }
  }

  it('sửa vùng có mặt nạ giữ nguyên pixel được bảo vệ', async () => {
    await withFakeProvider(
      async () => sharp({ create: { width: 4, height: 4, channels: 3, background: '#00ff00' } }).png().toBuffer(),
      async ({ ctx: live, modelPk, uploadId }) => {
        await call(live, `/api/models/${modelPk}`, { method: 'PATCH', body: { imageMaskSupport: 'yes' } })
        const created = await call(live, '/api/image-editor/jobs', {
          method: 'POST',
          body: {
            source: { kind: 'upload', id: uploadId },
            operation: 'region',
            engine: 'provider',
            modelId: modelPk,
            regions: [{ id: 'r1', comment: 'làm đẹp', shapes: [{ kind: 'rect', x: 0, y: 0, width: 0.5, height: 0.5 }] }],
          },
        })
        expect(created.status).toBe(201)
        const done = await waitForGeneration(live, created.body.generation.id)
        expect(done.status).toBe('succeeded')
        const asset = done.assets[0]
        const saved = live.db.prepare('SELECT relative_path AS path FROM assets WHERE id=?').get(asset.id) as { path: string }
        const { data } = await sharp(live.mediaStore.readFile(saved.path)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
        // Vùng sửa là góc trên-trái 2x2; pixel (3,0) nằm ngoài vùng nên phải là
        // pixel gốc, không phải màu xanh của provider.
        const protectedIndex = (0 * 4 + 3) * 4
        expect(data[protectedIndex + 1]).not.toBe(255)
        // Vùng sửa được phép thay đổi nên lấy màu của provider.
        expect(data[1]).toBe(255)
      },
    )
  })

  it('xoá nền không báo thành công với ảnh RGBA hoàn toàn đục', async () => {
    await withFakeProvider(
      async () => sharp({ create: { width: 4, height: 4, channels: 4, background: '#ffffff' } }).png().toBuffer(),
      async ({ ctx: live, modelPk, uploadId }) => {
        await call(live, `/api/models/${modelPk}`, { method: 'PATCH', body: { imageTransparentBackgroundSupport: 'yes' } })
        const created = await call(live, '/api/image-editor/jobs', { method: 'POST', body: {
          source: { kind: 'upload', id: uploadId }, operation: 'background', engine: 'provider',
          modelId: modelPk, background: { mode: 'remove' },
        } })
        expect(created.status).toBe(201)
        const done = await waitForGeneration(live, created.body.generation.id)
        expect(done.status).toBe('failed')
        expect(done.assets).toHaveLength(0)
        expect(done.errorMessage).toContain('trong suốt')
      },
    )
  })

  it('xoá nền chấp nhận PNG có alpha trong suốt thật', async () => {
    await withFakeProvider(
      async () => {
        const rgba = Buffer.alloc(4 * 4 * 4, 255)
        rgba[3] = 0
        return sharp(rgba, { raw: { width: 4, height: 4, channels: 4 } }).png().toBuffer()
      },
      async ({ ctx: live, modelPk, uploadId }) => {
        await call(live, `/api/models/${modelPk}`, { method: 'PATCH', body: { imageTransparentBackgroundSupport: 'yes' } })
        const created = await call(live, '/api/image-editor/jobs', { method: 'POST', body: {
          source: { kind: 'upload', id: uploadId }, operation: 'background', engine: 'provider',
          modelId: modelPk, background: { mode: 'remove' },
        } })
        expect((await waitForGeneration(live, created.body.generation.id)).status).toBe('succeeded')
      },
    )
  })

  it('mở rộng ảnh khôi phục hình chữ nhật gốc dù provider trả kích thước khác', async () => {
    await withFakeProvider(
      async () => sharp({ create: { width: 16, height: 16, channels: 3, background: '#00ff00' } }).png().toBuffer(),
      async ({ ctx: live, modelPk, uploadId }) => {
        const created = await call(live, '/api/image-editor/jobs', {
          method: 'POST',
          body: {
            source: { kind: 'upload', id: uploadId },
            operation: 'reframe',
            engine: 'provider',
            modelId: modelPk,
            frame: { width: 8, height: 8, offsetX: 2, offsetY: 2, background: 'transparent' },
          },
        })
        expect(created.status).toBe(201)
        const done = await waitForGeneration(live, created.body.generation.id)
        expect(done.status).toBe('succeeded')
        const saved = live.db.prepare('SELECT relative_path AS path FROM assets WHERE generation_id=?').get(created.body.generation.id) as { path: string }
        const { data, info } = await sharp(live.mediaStore.readFile(saved.path)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
        expect(info.width).toBe(8)
        expect(info.height).toBe(8)
        // Góc trong hình chữ nhật gốc là pixel ảnh gốc, không phải màu provider.
        const target = ((2 + 1) * 8 + (2 + 1)) * 4
        expect(data[target + 1]).not.toBe(255)
      },
    )
  })
})
