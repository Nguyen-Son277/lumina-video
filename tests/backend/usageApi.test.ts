import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  ensureSuperAdmin,
  registerUser,
  seedProviderAndModel,
  startTestServer,
  waitForGeneration,
  type TestContext,
} from './helpers'

let ctx: TestContext
beforeAll(async () => {
  ctx = await startTestServer({ superAdminEmails: 'quan-tri@gigone.com' })
})
afterAll(async () => {
  if (ctx) await ctx.close()
})

/** Tạo một provider LLM + model chat cho tài khoản đang đăng nhập. */
async function seedLlm(target: TestContext) {
  const provider = await call(target, '/api/providers', {
    method: 'POST',
    body: { name: 'LLM', baseUrl: 'https://llm.mock.test/v1', apiKey: 'sk-llm-abcd1234' },
  })
  const model = await call(target, '/api/models', {
    method: 'POST',
    body: { providerId: provider.body.provider.id, modelId: 'mock-chat-model', kind: 'llm' },
  })
  return model.body.model.id as string
}

/** Phiên có kịch bản nháp và một lần gọi LLM đã ghi log. */
async function sessionWithLlmCall(target: TestContext) {
  const chatModelId = await seedLlm(target)
  const created = await call(target, '/api/plans', { method: 'POST', body: { kind: 'planner' } })
  const sessionId = created.body.session.id as string
  await call(target, `/api/plans/${sessionId}/setup`, {
    method: 'PATCH',
    body: { chatModelId },
  })
  await call(target, `/api/plans/${sessionId}/script`, { method: 'POST' })
  // Một tin nhắn chat để có bản ghi plan_messages nối với lần gọi LLM.
  await call(target, `/api/plans/${sessionId}/messages`, {
    method: 'POST',
    body: { content: 'Chào bạn', target: 'script' },
  })
  return { sessionId, chatModelId }
}

describe('API nhật ký sử dụng — lọc, chi phí và ngân sách', () => {
  it('tính chi phí ảnh theo đơn giá mỗi lượt và LLM theo token', async () => {
    await registerUser(ctx)
    const { modelPk: imageModelId } = await seedProviderAndModel(ctx, 'image')
    const { chatModelId } = await sessionWithLlmCall(ctx)

    // Đơn giá: ảnh 0.04/lượt, LLM 0.002 mỗi 1K token vào, 0.004 mỗi 1K token ra.
    const pricedImage = await call(ctx, `/api/models/${imageModelId}`, {
      method: 'PATCH',
      body: { priceUnit: 0.04, priceCurrency: 'USD' },
    })
    expect(pricedImage.status).toBe(200)
    expect(pricedImage.body.model.priceUnit).toBe(0.04)
    const pricedLlm = await call(ctx, `/api/models/${chatModelId}`, {
      method: 'PATCH',
      body: { priceInput1k: 0.002, priceOutput1k: 0.004 },
    })
    expect(pricedLlm.status).toBe(200)

    const created = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: imageModelId, prompt: 'Khung hình có đơn giá', params: {} },
    })
    const done = await waitForGeneration(ctx, created.body.generation.id)
    expect(done.status).toBe('succeeded')

    const usage = await call(ctx, '/api/usage')
    expect(usage.status).toBe(200)
    const events = usage.body.events as Array<{ kind: string; cost: number | null; promptTokens: number | null; completionTokens: number | null; modelPk: string }>
    const image = events.find((event) => event.kind === 'image')
    expect(image).toBeTruthy()
    expect(image!.cost).toBeCloseTo(0.04, 4)

    const calls = events.filter((event) => event.kind === 'llm')
    expect(calls.length).toBeGreaterThan(0)
    let expected = 0
    for (const call of calls) {
      expect(call.promptTokens).toBeGreaterThan(0)
      const callCost =
        ((call.promptTokens ?? 0) / 1000) * 0.002 + ((call.completionTokens ?? 0) / 1000) * 0.004
      expect(call.cost).toBeCloseTo(callCost, 4)
      expected += callCost
    }

    // Tổng chi phí = ảnh + mọi lần gọi LLM.
    expect(usage.body.summary.overall.cost).toBeCloseTo(0.04 + expected, 3)
    expect(usage.body.summary.overall.costUnknownCount).toBe(0)
    expect(usage.body.summary.totals.image.cost).toBeCloseTo(0.04, 4)
  })

  it('lọc theo loại, trạng thái, khoảng thời gian và phân trang', async () => {
    await registerUser(ctx)
    const { modelPk: imageModelId } = await seedProviderAndModel(ctx, 'image')
    await sessionWithLlmCall(ctx)

    const created = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: imageModelId, prompt: 'Ảnh để lọc', params: {} },
    })
    await waitForGeneration(ctx, created.body.generation.id)

    const images = await call(ctx, '/api/usage?kind=image')
    expect(images.body.events.every((event: { kind: string }) => event.kind === 'image')).toBe(true)
    expect(images.body.events.length).toBe(1)

    const llm = await call(ctx, '/api/usage?kind=llm')
    expect(llm.body.events.length).toBeGreaterThan(0)
    expect(llm.body.events.every((event: { kind: string }) => event.kind === 'llm')).toBe(true)

    const okOnly = await call(ctx, '/api/usage?outcome=ok')
    expect(okOnly.body.events.every((event: { outcome: string }) => event.outcome === 'ok')).toBe(true)

    const noneYet = await call(ctx, '/api/usage?outcome=failed')
    expect(noneYet.body.events).toHaveLength(0)

    // Khoảng thời gian trong quá khứ: không có sự kiện nào.
    const past = await call(ctx, `/api/usage?to=${Date.now() - 60_000}`)
    expect(past.body.events).toHaveLength(0)

    // Tìm trong preview.
    const search = await call(ctx, '/api/usage?q=Ảnh để lọc')
    expect(search.body.events).toHaveLength(1)

    // Phân trang: lấy từng trang 1 dòng.
    const page1 = await call(ctx, '/api/usage?limit=1&offset=0')
    const page2 = await call(ctx, '/api/usage?limit=1&offset=1')
    expect(page1.body.events).toHaveLength(1)
    expect(page2.body.events).toHaveLength(1)
    expect(page1.body.events[0].id).not.toBe(page2.body.events[0].id)
    expect(page1.body.total).toBeGreaterThanOrEqual(2)
  })

  it('đọc token và chi phí theo từng tin nhắn', async () => {
    await registerUser(ctx)
    const { chatModelId } = await sessionWithLlmCall(ctx)
    await call(ctx, `/api/models/${chatModelId}`, {
      method: 'PATCH',
      body: { priceInput1k: 1, priceOutput1k: 1 },
    })

    const messages = await call(ctx, '/api/usage/messages')
    expect(messages.status).toBe(200)
    expect(messages.body.messages.length).toBeGreaterThan(0)
    const user = messages.body.messages.find((message: { role: string }) => message.role === 'user')
    const assistant = messages.body.messages.find((message: { role: string }) => message.role === 'assistant')
    expect(user.preview).toContain('Chào bạn')
    expect(user.llmCalls).toBe(1)
    expect(user.cost).toBeGreaterThan(0)
    expect(user.sessionTitle).toBeDefined()
    // Tin nhắn trả lời của cùng nhịp được gán chi phí của lần gọi mà nó tạo ra.
    expect(assistant.llmCalls).toBe(1)
    expect(assistant.cost).toBeCloseTo(user.cost, 4)
  })

  it('lưu ngân sách tháng và trả lại khi đọc', async () => {
    await registerUser(ctx)
    const saved = await call(ctx, '/api/usage/settings', {
      method: 'PUT',
      body: { monthlyBudget: 25.5, currency: 'USD' },
    })
    expect(saved.status).toBe(200)
    expect(saved.body.settings.monthlyBudget).toBe(25.5)

    const usage = await call(ctx, '/api/usage')
    expect(usage.body.settings.monthlyBudget).toBe(25.5)
    expect(usage.body.retentionDays).toBe(90)

    const cleared = await call(ctx, '/api/usage/settings', {
      method: 'PUT',
      body: { monthlyBudget: null, currency: 'USD' },
    })
    expect(cleared.body.settings.monthlyBudget).toBeNull()
  })

  it('xoá log LLM của mình nhưng không đụng tới ảnh/video', async () => {
    await registerUser(ctx)
    const { modelPk: imageModelId } = await seedProviderAndModel(ctx, 'image')
    await sessionWithLlmCall(ctx)
    const created = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: imageModelId, prompt: 'Ảnh giữ lại', params: {} },
    })
    await waitForGeneration(ctx, created.body.generation.id)

    const before = await call(ctx, '/api/usage')
    expect(before.body.events.some((event: { kind: string }) => event.kind === 'llm')).toBe(true)

    const deleted = await call(ctx, '/api/usage/logs', { method: 'DELETE' })
    expect(deleted.status).toBe(200)
    expect(deleted.body.deleted).toBeGreaterThan(0)

    const after = await call(ctx, '/api/usage')
    expect(after.body.events.some((event: { kind: string }) => event.kind === 'llm')).toBe(false)
    // Ảnh vẫn còn: đây là nội dung thật của người dùng.
    expect(after.body.events.some((event: { kind: string }) => event.kind === 'image')).toBe(true)
  })
})

describe('API nhật ký sử dụng — quản trị viên', () => {
  it('admin xem được log của mọi người kèm email; người thường bị chặn', async () => {
    const user = await registerUser(ctx)
    await sessionWithLlmCall(ctx)
    const userUsage = await call(ctx, '/api/usage', { cookie: ctx.cookie })
    expect(userUsage.body.events.length).toBeGreaterThan(0)

    // Người dùng thường không vào được API quản trị.
    const forbidden = await call(ctx, '/api/admin/usage', { cookie: ctx.cookie })
    expect(forbidden.status).toBe(403)

    const admin = await ensureSuperAdmin(ctx, 'quan-tri@gigone.com')
    const signedIn = await call(ctx, '/api/auth/login', {
      method: 'POST',
      body: { email: admin.email, password: 'matkhau-admin-rat-dai-123' },
    })
    expect(signedIn.status).toBe(200)

    const overview = await call(ctx, '/api/admin/usage')
    expect(overview.status).toBe(200)
    expect(overview.body.events.length).toBeGreaterThan(0)
    const withEmail = overview.body.events.find((event: { userEmail?: string }) => Boolean(event.userEmail))
    expect(withEmail?.userEmail).toContain('@')

    // Lọc theo đúng người dùng.
    const onlyUser = await call(ctx, `/api/admin/usage?userId=${user.userId}&kind=llm`)
    expect(onlyUser.body.events.length).toBeGreaterThan(0)
    expect(
      onlyUser.body.events.every((event: { userId: string }) => event.userId === user.userId),
    ).toBe(true)

    // Người dùng bị từ chối vì chưa đăng nhập (cookie admin đang đặt trong ctx).
    const anonymous = await call(ctx, '/api/admin/usage', { cookie: '' })
    expect(anonymous.status).toBe(401)
  })
})
