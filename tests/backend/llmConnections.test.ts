import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, startTestServer, type TestContext } from './helpers'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { if (ctx) await ctx.close() })

const draft = {
  name: 'OpenAI chat',
  baseUrl: 'https://llm.mock.test/v1',
  modelId: 'gpt-4o-mini',
  apiKey: 'sk-llm-abcd1234',
}

describe('Kết nối LLM cho chat và tạo kịch bản', () => {
  it('dò danh sách model bằng credential chưa lưu, không ghi database', async () => {
    await registerUser(ctx)

    const discovered = await call(ctx, '/api/llm/models', {
      method: 'POST',
      body: { baseUrl: 'https://llm.mock.test/v1', apiKey: 'sk-llm-abcd1234' },
    })
    expect(discovered.status).toBe(200)
    expect(discovered.body.models).toContain('mock-chat-model')
    expect(discovered.body.models).toContain('mock-script-model')
    // Danh sách phải sạch và ổn định để đổ vào dropdown.
    expect(discovered.body.models).toEqual([...discovered.body.models].sort())
    expect(new Set(discovered.body.models).size).toBe(discovered.body.models.length)
    // Không trả key và không tạo kết nối nào.
    expect(JSON.stringify(discovered.body)).not.toContain('sk-llm-abcd1234')
    expect((await call(ctx, '/api/llm')).body.connections).toHaveLength(0)
  })

  it('dò model từ chối thiếu dữ liệu, URL nội bộ và yêu cầu đăng nhập', async () => {
    await registerUser(ctx)

    expect((await call(ctx, '/api/llm/models', { method: 'POST', body: {} })).status).toBe(400)
    expect(
      (await call(ctx, '/api/llm/models', {
        method: 'POST',
        body: { baseUrl: 'https://llm.mock.test/v1' },
      })).status,
    ).toBe(400)
    // SSRF: URL nội bộ bị chặn trước khi ra mạng.
    expect(
      (await call(ctx, '/api/llm/models', {
        method: 'POST',
        body: { baseUrl: 'http://127.0.0.1:8080/v1', apiKey: 'sk-x' },
      })).status,
    ).toBe(400)

    expect(
      (await fetch(`${ctx.baseUrl}/api/llm/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: 'https://llm.mock.test/v1', apiKey: 'sk-x' }),
      })).status,
    ).toBe(401)
  })

  it('tạo kết nối không cần tên hiển thị, tự suy ra từ tên miền', async () => {
    await registerUser(ctx)

    const created = await call(ctx, '/api/llm', {
      method: 'POST',
      body: { baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-4o-mini', apiKey: 'sk-llm-abcd1234' },
    })
    expect(created.status).toBe(201)
    expect(created.body.connection.name).toBe('api.openai.com')
  })

  it('tạo kết nối chỉ với URL + key, chưa cần chọn model', async () => {
    await registerUser(ctx)

    const created = await call(ctx, '/api/llm', {
      method: 'POST',
      body: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-llm-abcd1234', name: 'Nhà' },
    })
    expect(created.status).toBe(201)
    // Chưa chọn model: lưu chuỗi rỗng, người dùng tải và chọn sau.
    expect(created.body.connection.modelId).toBe('')
    expect(created.body.connection.name).toBe('Nhà')

    // Chọn model sau đó bằng PATCH vẫn lưu bình thường.
    const picked = await call(ctx, `/api/llm/${created.body.connection.id}`, {
      method: 'PATCH',
      body: { modelId: 'gpt-4o-mini' },
    })
    expect(picked.body.connection.modelId).toBe('gpt-4o-mini')
  })

  it('tạo kết nối, che key và không bao giờ trả key về client', async () => {
    await registerUser(ctx)

    const created = await call(ctx, '/api/llm', { method: 'POST', body: draft })
    expect(created.status).toBe(201)
    expect(created.body.connection.keyHint).toBe('••••1234')
    expect(created.body.connection.status).toBe('untested')
    expect(JSON.stringify(created.body)).not.toContain('sk-llm-abcd1234')

    // Key phải được mã hóa trong database, không lưu dạng rõ.
    const row = ctx.db
      .prepare('SELECT api_key_ciphertext AS ciphertext, api_key_iv AS iv, api_key_tag AS tag FROM llm_connections WHERE id = ?')
      .get(created.body.connection.id) as { ciphertext: Uint8Array; iv: Uint8Array; tag: Uint8Array }
    expect(Buffer.from(row.ciphertext).toString('utf8')).not.toContain('sk-llm-abcd1234')
    expect(row.iv.byteLength).toBe(12)
    expect(row.tag.byteLength).toBe(16)

    const list = await call(ctx, '/api/llm')
    expect(list.body.connections).toHaveLength(1)
    expect(JSON.stringify(list.body)).not.toContain('sk-llm-abcd1234')
  })

  it('xoay key và đổi cấu hình, không đọc lại key cũ', async () => {
    await registerUser(ctx)
    const created = await call(ctx, '/api/llm', { method: 'POST', body: draft })
    const id = created.body.connection.id as string

    const rotated = await call(ctx, `/api/llm/${id}`, {
      method: 'PATCH',
      body: { apiKey: 'sk-llm-9999', modelId: 'gpt-4o', name: 'Chat mới' },
    })
    expect(rotated.status).toBe(200)
    expect(rotated.body.connection.keyHint).toBe('••••9999')
    expect(rotated.body.connection.modelId).toBe('gpt-4o')
    expect(rotated.body.connection.name).toBe('Chat mới')
    expect(JSON.stringify(rotated.body)).not.toContain('sk-llm-9999')

    // Đổi Base URL thì trạng thái kiểm tra cũ bị bỏ.
    await call(ctx, `/api/llm/${id}/test`, { method: 'POST' })
    const changed = await call(ctx, `/api/llm/${id}`, {
      method: 'PATCH',
      body: { baseUrl: 'https://khac.mock.test/v1' },
    })
    expect(changed.body.connection.status).toBe('untested')

    expect((await call(ctx, `/api/llm/${id}`, { method: 'PATCH', body: {} })).status).toBe(400)
  })

  it('kiểm tra kết nối và liệt kê model chat ở chế độ mock', async () => {
    await registerUser(ctx)
    const id = (await call(ctx, '/api/llm', { method: 'POST', body: draft })).body.connection.id as string

    const tested = await call(ctx, `/api/llm/${id}/test`, { method: 'POST' })
    expect(tested.status).toBe(200)
    expect(tested.body.ok).toBe(true)
    expect(tested.body.modelCount).toBeGreaterThan(0)
    expect(tested.body.models).toContain('mock-chat-model')

    const list = await call(ctx, '/api/llm')
    expect(list.body.connections[0].status).toBe('connected')

    const models = await call(ctx, `/api/llm/${id}/models`, { method: 'POST' })
    expect(models.body.models).toContain('mock-script-model')
  })

  it('từ chối dữ liệu thiếu và URL nội bộ, xóa được kết nối', async () => {
    await registerUser(ctx)

    expect((await call(ctx, '/api/llm', { method: 'POST', body: { name: 'Thiếu' } })).status).toBe(400)
    expect(
      (await call(ctx, '/api/llm', {
        method: 'POST',
        body: { ...draft, baseUrl: 'http://127.0.0.1:8080/v1' },
      })).status,
    ).toBe(400)

    const id = (await call(ctx, '/api/llm', { method: 'POST', body: draft })).body.connection.id as string
    expect((await call(ctx, `/api/llm/${id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await call(ctx, '/api/llm')).body.connections).toHaveLength(0)
    expect((await call(ctx, `/api/llm/${id}`, { method: 'DELETE' })).status).toBe(404)
  })

  it('yêu cầu đăng nhập và tách biệt tài khoản', async () => {
    await registerUser(ctx)
    const id = (await call(ctx, '/api/llm', { method: 'POST', body: draft })).body.connection.id as string

    expect((await fetch(`${ctx.baseUrl}/api/llm`)).status).toBe(401)

    await registerUser(ctx)
    // Không có endpoint đọc một kết nối, nên tài khoản khác chỉ thấy 404.
    expect((await call(ctx, `/api/llm/${id}`)).status).toBe(404)
    expect((await call(ctx, `/api/llm/${id}`, { method: 'PATCH', body: { name: 'X' } })).status).toBe(404)
    expect((await call(ctx, `/api/llm/${id}`, { method: 'DELETE' })).status).toBe(404)
    expect((await call(ctx, `/api/llm/${id}/test`, { method: 'POST' })).status).toBe(404)
    expect((await call(ctx, '/api/llm')).body.connections).toHaveLength(0)
  })
})

/**
 * Provider không có `GET /models` phải báo lỗi rõ ràng để giao diện chuyển sang
 * nhập model thủ công, thay vì hiện lỗi chung chung.
 */
describe('Provider không hỗ trợ /models', () => {
  it('báo lỗi kèm hướng dẫn nhập model thủ công', async () => {
    const fake = createServer((req, res) => {
      if (req.url?.startsWith('/v1/models')) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'not found' } }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
    })
    const port = await new Promise<number>((resolve) => {
      fake.listen(0, '127.0.0.1', () => resolve((fake.address() as { port: number }).port))
    })

    const live = await startTestServer({ allowPrivate: true, providerMode: 'live' })
    try {
      await registerUser(live)
      const result = await call(live, '/api/llm/models', {
        method: 'POST',
        body: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-fake' },
      })
      expect(result.status).toBe(400)
      expect(result.body.error.message).toContain('không hỗ trợ endpoint /models')
      expect(result.body.error.message).toContain('thủ công')
      // Mã lỗi riêng để giao diện vẫn cho lưu kết nối kèm cảnh báo.
      expect(result.body.error.code).toBe('MODELS_UNSUPPORTED')
    } finally {
      await live.close()
      await new Promise<void>((resolve) => fake.close(() => resolve()))
    }
  })

  it('vẫn lưu được kết nối khi nhập model thủ công', async () => {
    await registerUser(ctx)
    const created = await call(ctx, '/api/llm', {
      method: 'POST',
      body: {
        baseUrl: 'https://khong-co-models.mock.test/v1',
        modelId: 'model-nhap-tay',
        apiKey: 'sk-llm-abcd1234',
      },
    })
    expect(created.status).toBe(201)
    expect(created.body.connection.modelId).toBe('model-nhap-tay')
  })
})
