import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, startTestServer, type TestContext } from './helpers'

let ctx: TestContext

beforeAll(async () => {
  ctx = await startTestServer()
})

afterAll(async () => {
  if (ctx) await ctx.close()
})

async function newUser() {
  await registerUser(ctx)
}

describe('Quản lý provider', () => {
  it('thêm, sửa và xóa provider', async () => {
    await newUser()

    const created = await call(ctx, '/api/providers', {
      method: 'POST',
      body: { name: 'Gateway', baseUrl: 'https://api.mock.test/v1', apiKey: 'sk-abc' },
    })
    expect(created.status).toBe(201)
    const id = created.body.provider.id

    const patched = await call(ctx, `/api/providers/${id}`, {
      method: 'PATCH',
      body: { name: 'Gateway mới' },
    })
    expect(patched.status).toBe(200)
    expect(patched.body.provider.name).toBe('Gateway mới')

    const removed = await call(ctx, `/api/providers/${id}`, { method: 'DELETE' })
    expect(removed.status).toBe(204)

    const list = await call(ctx, '/api/providers')
    expect(list.body.providers).toHaveLength(0)
  })

  it('cho phép thay API key mới mà không đọc lại key cũ', async () => {
    await newUser()
    const created = await call(ctx, '/api/providers', {
      method: 'POST',
      body: { name: 'Xoay key', baseUrl: 'https://rotate.mock.test/v1', apiKey: 'sk-cu-1111' },
    })
    const id = created.body.provider.id
    expect(created.body.provider.keyHint).toBe('••••1111')

    const patched = await call(ctx, `/api/providers/${id}`, {
      method: 'PATCH',
      body: { apiKey: 'sk-moi-2222' },
    })
    expect(patched.status).toBe(200)
    expect(patched.body.provider.keyHint).toBe('••••2222')
    expect(JSON.stringify(patched.body)).not.toContain('sk-moi-2222')
  })

  it('từ chối khi thiếu trường bắt buộc', async () => {
    await newUser()
    const missingKey = await call(ctx, '/api/providers', {
      method: 'POST',
      body: { name: 'Thiếu key', baseUrl: 'https://x.mock.test/v1' },
    })
    expect(missingKey.status).toBe(400)

    const missingUrl = await call(ctx, '/api/providers', {
      method: 'POST',
      body: { name: 'Thiếu url', apiKey: 'sk-x' },
    })
    expect(missingUrl.status).toBe(400)
  })

  it('trả 404 khi sửa provider không tồn tại', async () => {
    await newUser()
    const result = await call(ctx, '/api/providers/khong-co-that', {
      method: 'PATCH',
      body: { name: 'X' },
    })
    expect(result.status).toBe(404)
  })

  it('kiểm tra kết nối và đồng bộ model ở chế độ mock', async () => {
    await newUser()
    const created = await call(ctx, '/api/providers', {
      method: 'POST',
      body: { name: 'Mock', baseUrl: 'https://mock.test/v1', apiKey: 'sk-mock' },
    })
    const id = created.body.provider.id

    // Chế độ mock trả danh sách model cố định, không gọi mạng.
    const sync = await call(ctx, `/api/providers/${id}/sync-models`, { method: 'POST' })
    expect(sync.status).toBe(200)
    expect(sync.body.added).toBeGreaterThan(0)

    // Đồng bộ lần hai không thêm trùng.
    const again = await call(ctx, `/api/providers/${id}/sync-models`, { method: 'POST' })
    expect(again.body.added).toBe(0)
    expect(again.body.skipped).toBeGreaterThan(0)

    // Model đồng bộ về mặc định là chưa phân loại.
    const models = await call(ctx, '/api/models')
    expect(models.body.models.every((model: any) => model.kind === 'unclassified')).toBe(true)

    const test = await call(ctx, `/api/providers/${id}/test`, { method: 'POST' })
    expect(test.status).toBe(200)
    expect(test.body.ok).toBe(true)
  })

  it('đồng bộ không ghi đè phân loại đã đặt', async () => {
    await newUser()
    const created = await call(ctx, '/api/providers', {
      method: 'POST',
      body: { name: 'Phân loại', baseUrl: 'https://classify.test/v1', apiKey: 'sk-mock' },
    })
    const providerId = created.body.provider.id

    await call(ctx, `/api/providers/${providerId}/sync-models`, { method: 'POST' })
    const models = await call(ctx, '/api/models')
    const first = models.body.models[0]

    await call(ctx, `/api/models/${first.id}`, { method: 'PATCH', body: { kind: 'image' } })

    await call(ctx, `/api/providers/${providerId}/sync-models`, { method: 'POST' })
    const after = await call(ctx, '/api/models')
    const same = after.body.models.find((model: any) => model.id === first.id)
    expect(same.kind).toBe('image')
  })

  it('chặn xóa provider khi còn tác vụ đang chạy', async () => {
    await newUser()
    const created = await call(ctx, '/api/providers', {
      method: 'POST',
      body: { name: 'Bận', baseUrl: 'https://busy.test/v1', apiKey: 'sk-mock' },
    })
    const providerId = created.body.provider.id

    const model = await call(ctx, '/api/models', {
      method: 'POST',
      body: { providerId, modelId: 'busy-video', displayName: 'Busy', kind: 'video' },
    })

    await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: model.body.model.id, prompt: 'video đang chạy' },
    })

    const blocked = await call(ctx, `/api/providers/${providerId}`, { method: 'DELETE' })
    expect(blocked.status).toBe(400)
    expect(blocked.body.error.message).toContain('tác vụ đang chạy')
  })
})

describe('Quản lý model và phân loại', () => {
  it('thêm model và đổi phân loại', async () => {
    await newUser()
    const provider = await call(ctx, '/api/providers', {
      method: 'POST',
      body: { name: 'Models', baseUrl: 'https://models.test/v1', apiKey: 'sk-mock' },
    })

    const created = await call(ctx, '/api/models', {
      method: 'POST',
      body: {
        providerId: provider.body.provider.id,
        modelId: 'gpt-image-1',
        displayName: 'GPT Image 1',
        kind: 'image',
      },
    })
    expect(created.status).toBe(201)
    expect(created.body.model.kind).toBe('image')

    const updated = await call(ctx, `/api/models/${created.body.model.id}`, {
      method: 'PATCH',
      body: { kind: 'video' },
    })
    expect(updated.body.model.kind).toBe('video')

    const filtered = await call(ctx, '/api/models?kind=video')
    expect(filtered.body.models).toHaveLength(1)

    const none = await call(ctx, '/api/models?kind=image')
    expect(none.body.models).toHaveLength(0)
  })

  it('từ chối model ID trùng trong cùng provider', async () => {
    await newUser()
    const provider = await call(ctx, '/api/providers', {
      method: 'POST',
      body: { name: 'Trùng', baseUrl: 'https://dup.test/v1', apiKey: 'sk-mock' },
    })
    const providerId = provider.body.provider.id

    await call(ctx, '/api/models', {
      method: 'POST',
      body: { providerId, modelId: 'same-id', kind: 'image' },
    })
    const duplicate = await call(ctx, '/api/models', {
      method: 'POST',
      body: { providerId, modelId: 'same-id', kind: 'video' },
    })
    expect(duplicate.status).toBe(409)
  })

  it('cho phép cùng model ID ở provider khác nhau', async () => {
    await newUser()
    const first = await call(ctx, '/api/providers', {
      method: 'POST',
      body: { name: 'P1', baseUrl: 'https://p1.test/v1', apiKey: 'sk-mock' },
    })
    const second = await call(ctx, '/api/providers', {
      method: 'POST',
      body: { name: 'P2', baseUrl: 'https://p2.test/v1', apiKey: 'sk-mock' },
    })

    await call(ctx, '/api/models', {
      method: 'POST',
      body: { providerId: first.body.provider.id, modelId: 'chung-id', kind: 'image' },
    })
    const other = await call(ctx, '/api/models', {
      method: 'POST',
      body: { providerId: second.body.provider.id, modelId: 'chung-id', kind: 'image' },
    })
    expect(other.status).toBe(201)
  })

  it('từ chối provider không thuộc tài khoản', async () => {
    await newUser()
    const result = await call(ctx, '/api/models', {
      method: 'POST',
      body: { providerId: 'khong-ton-tai', modelId: 'x', kind: 'image' },
    })
    expect(result.status).toBe(400)
  })

  it('từ chối loại model không hợp lệ', async () => {
    await newUser()
    const provider = await call(ctx, '/api/providers', {
      method: 'POST',
      body: { name: 'Kind', baseUrl: 'https://kind.test/v1', apiKey: 'sk-mock' },
    })
    const result = await call(ctx, '/api/models', {
      method: 'POST',
      body: { providerId: provider.body.provider.id, modelId: 'x', kind: 'audio' },
    })
    expect(result.status).toBe(400)
  })
})
