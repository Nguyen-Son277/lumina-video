import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'

let ctx: TestContext

beforeAll(async () => {
  ctx = await startTestServer()
})

afterAll(async () => {
  if (ctx) await ctx.close()
})

describe('Bảo mật provider và API key', () => {
  it('không bao giờ trả API key về client', async () => {
    await registerUser(ctx)
    const secret = 'sk-tuyet-mat-khong-duoc-lo-12345'

    const created = await call(ctx, '/api/providers', {
      method: 'POST',
      body: { name: 'Bảo mật', baseUrl: 'https://secure.mock.test/v1', apiKey: secret },
    })

    expect(created.status).toBe(201)
    expect(JSON.stringify(created.body)).not.toContain(secret)
    // Chỉ trả 4 ký tự cuối để người dùng nhận biết key nào.
    expect(created.body.provider.keyHint).toBe('••••2345')

    const listed = await call(ctx, '/api/providers')
    expect(JSON.stringify(listed.body)).not.toContain(secret)
  })

  it('lưu key dưới dạng đã mã hóa trong database', async () => {
    await registerUser(ctx)
    const secret = 'sk-luu-trong-db-98765'

    await call(ctx, '/api/providers', {
      method: 'POST',
      body: { name: 'DB', baseUrl: 'https://db.mock.test/v1', apiKey: secret },
    })

    const row = ctx.db
      .prepare('SELECT api_key_ciphertext, api_key_iv, api_key_tag FROM provider_connections ORDER BY created_at DESC LIMIT 1')
      .get() as { api_key_ciphertext: Uint8Array; api_key_iv: Uint8Array; api_key_tag: Uint8Array }

    // Bản rõ không được xuất hiện trong cột ciphertext.
    const cipherText = Buffer.from(row.api_key_ciphertext).toString('utf8')
    expect(cipherText).not.toContain(secret)
    expect(row.api_key_iv.length).toBe(12)
    expect(row.api_key_tag.length).toBe(16)
  })

  it('chặn Base URL trỏ tới địa chỉ nội bộ và metadata', async () => {
    await registerUser(ctx)

    const targets = [
      'http://169.254.169.254/latest/meta-data',
      'http://127.0.0.1:8080/v1',
      'http://10.0.0.1/v1',
      'http://192.168.1.1/v1',
      'http://[::1]/v1',
    ]

    for (const baseUrl of targets) {
      const result = await call(ctx, '/api/providers', {
        method: 'POST',
        body: { name: 'SSRF', baseUrl, apiKey: 'sk-test' },
      })
      expect(result.status, `phải chặn ${baseUrl}`).toBe(400)
    }
  })

  it('từ chối giao thức không phải http/https', async () => {
    await registerUser(ctx)
    const result = await call(ctx, '/api/providers', {
      method: 'POST',
      body: { name: 'File', baseUrl: 'file:///etc/passwd', apiKey: 'sk-test' },
    })
    expect(result.status).toBe(400)
  })

  it('từ chối Base URL chứa thông tin đăng nhập', async () => {
    await registerUser(ctx)
    const result = await call(ctx, '/api/providers', {
      method: 'POST',
      body: { name: 'Creds', baseUrl: 'https://user:pass@api.mock.test/v1', apiKey: 'sk-test' },
    })
    expect(result.status).toBe(400)
  })
})

describe('Tách biệt dữ liệu giữa các tài khoản', () => {
  it('tài khoản B không đọc, sửa hay xóa được dữ liệu của tài khoản A', async () => {
    // Tài khoản A tạo dữ liệu.
    await registerUser(ctx, `a-${Date.now()}@gigone.com`)
    const { providerId, modelPk } = await seedProviderAndModel(ctx, 'image')

    const generation = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, prompt: 'Dữ liệu riêng của A' },
    })
    expect(generation.status).toBe(202)
    const generationId = generation.body.generation.id

    // Chuyển sang tài khoản B.
    await registerUser(ctx, `b-${Date.now()}@gigone.com`)

    const providers = await call(ctx, '/api/providers')
    expect(providers.body.providers).toHaveLength(0)

    const models = await call(ctx, '/api/models')
    expect(models.body.models).toHaveLength(0)

    const generations = await call(ctx, '/api/generations')
    expect(generations.body.generations).toHaveLength(0)

    // Không đọc được tác vụ của A.
    const otherGeneration = await call(ctx, `/api/generations/${generationId}`)
    expect(otherGeneration.status).toBe(404)

    // Không sửa được provider của A.
    const patch = await call(ctx, `/api/providers/${providerId}`, {
      method: 'PATCH',
      body: { name: 'Bị chiếm' },
    })
    expect(patch.status).toBe(404)

    // Không xóa được provider của A.
    const remove = await call(ctx, `/api/providers/${providerId}`, { method: 'DELETE' })
    expect(remove.status).toBe(404)

    // Không xóa được model của A.
    const removeModel = await call(ctx, `/api/models/${modelPk}`, { method: 'DELETE' })
    expect(removeModel.status).toBe(404)

    // Không dùng được model của A để tạo nội dung.
    const useModel = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, prompt: 'Mượn model của A' },
    })
    expect(useModel.status).toBe(400)
  })

  it('tài khoản B không tải được media của tài khoản A', async () => {
    await registerUser(ctx, `media-a-${Date.now()}@gigone.com`)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')

    const created = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, prompt: 'Ảnh riêng tư' },
    })
    const id = created.body.generation.id

    // Chờ worker xử lý để có asset.
    const deadline = Date.now() + 8000
    let assetUrl = ''
    while (Date.now() < deadline) {
      await ctx.worker.tick()
      const detail = await call(ctx, `/api/generations/${id}`)
      if (detail.body.generation.assets.length > 0) {
        assetUrl = detail.body.generation.assets[0].url
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    expect(assetUrl).not.toBe('')

    // Chủ sở hữu tải được.
    const owner = await fetch(`${ctx.baseUrl}${assetUrl}`, { headers: { Cookie: ctx.cookie } })
    expect(owner.status).toBe(200)

    // Tài khoản khác bị chặn.
    await registerUser(ctx, `media-b-${Date.now()}@gigone.com`)
    const stranger = await fetch(`${ctx.baseUrl}${assetUrl}`, { headers: { Cookie: ctx.cookie } })
    expect(stranger.status).toBe(404)
  })

  it('yêu cầu media khi chưa đăng nhập bị chặn', async () => {
    const response = await fetch(`${ctx.baseUrl}/api/assets/khong-ton-tai`, { headers: { Cookie: '' } })
    expect(response.status).toBe(401)
  })
})

describe('Kiểm tra Origin cho request thay đổi trạng thái', () => {
  it('từ chối Origin lạ', async () => {
    await registerUser(ctx)
    const response = await fetch(`${ctx.baseUrl}/api/providers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: ctx.cookie,
        Origin: 'https://ke-tan-cong.example',
      },
      body: JSON.stringify({ name: 'X', baseUrl: 'https://x.mock.test/v1', apiKey: 'sk-x' }),
    })
    expect(response.status).toBe(403)
  })

  it('chấp nhận Origin được cấu hình', async () => {
    await registerUser(ctx)
    const response = await fetch(`${ctx.baseUrl}/api/providers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: ctx.cookie,
        Origin: 'http://127.0.0.1:5173',
      },
      body: JSON.stringify({ name: 'OK', baseUrl: 'https://ok.mock.test/v1', apiKey: 'sk-ok' }),
    })
    expect(response.status).toBe(201)
  })
})

describe('Không rò rỉ key trong log', () => {
  it('logger che Authorization và api key', async () => {
    const { redact } = await import('../../server/lib/logger')

    const samples = [
      'Authorization: Bearer sk-bi-mat-1234567890',
      'api_key=sk-khong-duoc-lo-abcdef',
      'token: sk-token-abcdefghij',
      '{"apiKey":"sk-trong-json-1234567"}',
    ]

    for (const sample of samples) {
      const output = redact(sample)
      expect(output).not.toMatch(/sk-(bi-mat|khong-duoc-lo|token|trong-json)/)
      expect(output).toContain('[đã ẩn]')
    }
  })
})
