import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  registerUser,
  seedProviderAndModel,
  startTestServer,
  waitForGeneration,
  type TestContext,
} from './helpers'
import { readTokenUsage, recordLlmUsage } from '../../server/usage/log'

let ctx: TestContext
beforeAll(async () => {
  ctx = await startTestServer()
})
afterAll(async () => {
  if (ctx) await ctx.close()
})

type UsageRow = {
  userId: string
  source: string
  status: string
  preview: string
  promptChars: number
  promptTokens: number | null
  completionTokens: number | null
  modelPk: string | null
  planSessionId: string | null
  messageId: string | null
}

/** Log LLM của một tài khoản, độc lập với dữ liệu của tài khoản khác. */
function logRowsFor(userId: string): UsageRow[] {
  return ctx.db
    .prepare(
      `SELECT user_id AS userId, source, status, preview, prompt_chars AS promptChars,
              prompt_tokens AS promptTokens, completion_tokens AS completionTokens,
              model_pk AS modelPk, plan_session_id AS planSessionId, message_id AS messageId
         FROM llm_usage WHERE user_id = ? ORDER BY created_at ASC, rowid ASC`,
    )
    .all(userId) as unknown as UsageRow[]
}

/** Phiên Tạo kịch bản AI đã có kịch bản nháp; dùng tài khoản đang đăng nhập. */
async function plannerSession(target: TestContext) {
  const provider = await call(target, '/api/providers', {
    method: 'POST',
    body: { name: 'LLM', baseUrl: 'https://llm.mock.test/v1', apiKey: 'sk-llm-abcd1234' },
  })
  const chat = await call(target, '/api/models', {
    method: 'POST',
    body: { providerId: provider.body.provider.id, modelId: 'mock-chat-model', kind: 'llm' },
  })
  const { modelPk: imageModelId } = await seedProviderAndModel(target, 'image')
  const { modelPk: videoModelId } = await seedProviderAndModel(target, 'video')
  const created = await call(target, '/api/plans', { method: 'POST', body: { kind: 'planner' } })
  const sessionId = created.body.session.id as string
  await call(target, `/api/plans/${sessionId}/setup`, {
    method: 'PATCH',
    body: { chatModelId: chat.body.model.id, imageModelId, videoModelId },
  })
  return { sessionId }
}

describe('Nhật ký sử dụng — đọc token từ provider', () => {
  it('chấp nhận cả hai cách đặt tên trường và bỏ giá trị vô lý', () => {
    expect(readTokenUsage({ usage: { prompt_tokens: 120, completion_tokens: 30 } })).toEqual({
      promptTokens: 120,
      completionTokens: 30,
    })
    expect(readTokenUsage({ usage: { input_tokens: 7, output_tokens: 3 } })).toEqual({
      promptTokens: 7,
      completionTokens: 3,
    })
    expect(readTokenUsage({ usage: { prompt_tokens: -5, completion_tokens: 'x' } })).toEqual({
      promptTokens: null,
      completionTokens: null,
    })
    expect(readTokenUsage({})).toEqual({ promptTokens: null, completionTokens: null })
  })
})

describe('Nhật ký sử dụng — ghi log LLM', () => {
  it('cắt preview 500 ký tự, giữ số ký tự và không ném lỗi khi ghi hỏng', async () => {
    const user = await registerUser(ctx)
    recordLlmUsage(ctx.db, {
      userId: user.userId,
      source: 'planner_chat',
      requestText: 'x'.repeat(900),
      responseText: 'y'.repeat(900),
      promptTokens: 10,
      completionTokens: 5,
      status: 'ok',
      latencyMs: 12,
    })
    const row = logRowsFor(user.userId)[0]!
    expect(row.preview).toHaveLength(500)
    expect(row.promptChars).toBe(900)
    expect(row.promptTokens).toBe(10)

    // Database hỏng: log là tính năng phụ trợ nên không được ném lỗi ra ngoài.
    const broken = { prepare: () => { throw new Error('db hỏng') } } as unknown as typeof ctx.db
    expect(() =>
      recordLlmUsage(broken, { userId: user.userId, source: 'planner_chat', status: 'ok', latencyMs: 1 }),
    ).not.toThrow()
  })

  it('ghi đủ 9 nguồn gọi LLM, mỗi lần gọi một dòng kèm token từ provider', async () => {
    const user = await registerUser(ctx)
    const { sessionId } = await plannerSession(ctx)

    await call(ctx, `/api/plans/${sessionId}/messages`, {
      method: 'POST',
      body: { content: 'Viết kịch bản cho tôi', target: 'script' },
    })
    await call(ctx, `/api/plans/${sessionId}/script`, { method: 'POST' })
    await call(ctx, `/api/plans/${sessionId}/cast`, { method: 'POST' })
    await call(ctx, `/api/plans/${sessionId}/locations/propose`, { method: 'POST' })

    const withCast = (await call(ctx, `/api/plans/${sessionId}`)).body.session
    const castId = withCast.cast[0].id as string
    await call(ctx, `/api/plans/${sessionId}/cast/${castId}/variants/propose`, {
      method: 'POST',
      body: { count: 2 },
    })

    const withVariants = (await call(ctx, `/api/plans/${sessionId}`)).body.session
    const variant = withVariants.cast[0].variants[0]
    await call(ctx, `/api/plans/${sessionId}/cast/${castId}/variants/${variant.id}/profile/complete`, {
      method: 'POST',
      body: { revision: variant.revision },
    })

    await call(ctx, `/api/plans/${sessionId}/timeline`, { method: 'POST' })
    const timeline = (await call(ctx, `/api/plans/${sessionId}`)).body.session.timeline
    await call(ctx, `/api/plans/${sessionId}/timeline/${timeline.frames[0].id}/arrange`, {
      method: 'POST',
      body: {},
    })

    await call(ctx, '/api/shared-characters/generate', {
      method: 'POST',
      body: { description: 'Một người bạn đồng hành', count: 2, language: 'vi' },
    })

    const rows = logRowsFor(user.userId)
    const sources = new Set(rows.map((row) => row.source))
    for (const expected of [
      'planner_chat',
      'planner_script',
      'planner_cast',
      'planner_locations',
      'planner_variant',
      'planner_profile',
      'planner_timeline',
      'planner_arrange',
      'character_ai',
    ]) {
      expect(sources.has(expected), `thiếu nguồn ${expected}`).toBe(true)
    }

    for (const row of rows) {
      expect(row.status).toBe('ok')
      expect(row.preview.length).toBeGreaterThan(0)
      expect(row.promptTokens).toBeGreaterThan(0)
      expect(row.completionTokens).toBeGreaterThan(0)
      expect(row.modelPk).toBeTruthy()
    }

    // Lần gọi từ chat nối được với đúng phiên và đúng tin nhắn người dùng.
    const chat = rows.filter((row) => row.source === 'planner_chat')
    expect(chat.length).toBeGreaterThan(0)
    expect(chat.every((row) => row.planSessionId === sessionId)).toBe(true)
    expect(chat.some((row) => Boolean(row.messageId))).toBe(true)
  })

  it('ghi trạng thái lỗi khi provider thật trả lỗi, và vẫn trả lỗi cho người dùng', async () => {
    // Provider thật trỏ tới cổng không mở ⇒ lần gọi thất bại và phải được ghi log.
    const live = await startTestServer({ allowPrivate: true, providerMode: 'live' })
    try {
      await registerUser(live)
      const provider = await call(live, '/api/providers', {
        method: 'POST',
        body: { name: 'Chết', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-live-abcd1234' },
      })
      const model = await call(live, '/api/models', {
        method: 'POST',
        body: { providerId: provider.body.provider.id, modelId: 'mock-chat-model', kind: 'llm' },
      })
      const created = await call(live, '/api/plans', { method: 'POST', body: { kind: 'planner' } })
      const sessionId = created.body.session.id as string
      await call(live, `/api/plans/${sessionId}/setup`, {
        method: 'PATCH',
        body: { chatModelId: model.body.model.id },
      })

      const failed = await call(live, `/api/plans/${sessionId}/script`, { method: 'POST' })
      expect(failed.status).toBeGreaterThanOrEqual(400)

      const rows = live.db
        .prepare("SELECT status, source, model_pk AS modelPk FROM llm_usage ORDER BY created_at ASC")
        .all() as unknown as Array<{ status: string; source: string; modelPk: string | null }>
      expect(rows).toHaveLength(1)
      expect(rows[0]!.status).toBe('error')
      expect(rows[0]!.source).toBe('planner_script')
      expect(rows[0]!.modelPk).toBe(model.body.model.id)
    } finally {
      await live.close()
    }
  })
})

describe('Nhật ký sử dụng — cách ly giữa các tài khoản', () => {
  it('tài khoản khác không thấy log của người dùng', async () => {
    const owner = await registerUser(ctx)
    const { sessionId } = await plannerSession(ctx)
    await call(ctx, `/api/plans/${sessionId}/script`, { method: 'POST' })
    expect(logRowsFor(owner.userId).length).toBeGreaterThan(0)

    const other = await registerUser(ctx)
    const usage = await call(ctx, '/api/usage', { cookie: ctx.cookie })
    expect(usage.status).toBe(200)
    expect(usage.body.events).toHaveLength(0)
    expect(usage.body.summary.overall.count).toBe(0)
    // Dữ liệu của chủ sở hữu vẫn nguyên.
    expect(logRowsFor(owner.userId).length).toBeGreaterThan(0)
  })
})

describe('Nhật ký sử dụng — ảnh và video', () => {
  it('suy sự kiện media từ generations kèm trạng thái và dung lượng', async () => {
    const user = await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const created = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, prompt: 'Một khung hình thử nghiệm', params: {} },
    })
    expect(created.status).toBe(202)
    const done = await waitForGeneration(ctx, created.body.generation.id)
    expect(done.status).toBe('succeeded')

    const usage = await call(ctx, '/api/usage', { cookie: ctx.cookie })
    expect(usage.status).toBe(200)
    const image = usage.body.events.find((event: { kind: string }) => event.kind === 'image')
    expect(image).toBeTruthy()
    expect(image.outcome).toBe('ok')
    expect(image.preview).toContain('khung hình thử nghiệm')
    expect(image.byteSize).toBeGreaterThan(0)
    // Chưa nhập đơn giá nên chi phí chưa xác định.
    expect(image.cost).toBeNull()
    expect(image.costUnknown).toBe(true)
    expect(usage.body.summary.overall.count).toBe(1)
  })
})
