import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, startTestServer, type TestContext } from './helpers'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { if (ctx) await ctx.close() })

const endpoint = '/api/quick-home/messages'

describe('Quick home messages', () => {
  it('requires login and persists ordered user messages without creating a session or AI reply', async () => {
    expect((await call(ctx, endpoint)).status).toBe(401)
    expect((await call(ctx, endpoint, { method: 'POST', body: { content: 'Hello' } })).status).toBe(401)

    const { userId } = await registerUser(ctx)
    expect((await call(ctx, endpoint)).body.messages).toEqual([])
    const first = await call(ctx, endpoint, { method: 'POST', body: { content: '  Xin chào  ' } })
    expect(first.status).toBe(201)
    expect(first.body.message).toMatchObject({ content: 'Xin chào' })
    expect(first.body.message.id).toEqual(expect.any(String))
    expect(first.body.message.createdAt).toEqual(expect.any(Number))

    const second = await call(ctx, endpoint, { method: 'POST', body: { content: 'Tạo video ngắn' } })
    expect(second.status).toBe(201)
    const listed = await call(ctx, endpoint)
    expect(listed.status).toBe(200)
    expect(listed.body.messages).toEqual([first.body.message, second.body.message])
    expect(ctx.db.prepare('SELECT COUNT(*) AS count FROM quick_sessions WHERE user_id = ?').get(userId)).toMatchObject({ count: 0 })
    expect(ctx.db.prepare('SELECT COUNT(*) AS count FROM plan_sessions WHERE user_id = ?').get(userId)).toMatchObject({ count: 0 })
  })

  it('rejects empty, oversized and malformed content', async () => {
    await registerUser(ctx)
    for (const body of [{ content: '' }, { content: '   ' }, { content: 'x'.repeat(8001) }, { content: 123 }, {}, { content: 'ok', role: 'assistant' }]) {
      const result = await call(ctx, endpoint, { method: 'POST', body })
      expect(result.status).toBe(400)
    }
    expect((await call(ctx, endpoint)).body.messages).toEqual([])
  })

  it('isolates messages by owner', async () => {
    const first = await registerUser(ctx)
    const firstCookie = ctx.cookie
    const saved = await call(ctx, endpoint, { method: 'POST', body: { content: 'Chỉ tài khoản A' } })
    const second = await registerUser(ctx)
    expect((await call(ctx, endpoint)).body.messages).toEqual([])
    await call(ctx, endpoint, { method: 'POST', body: { content: 'Chỉ tài khoản B' } })
    expect((await call(ctx, endpoint)).body.messages.map((message: { content: string }) => message.content)).toEqual(['Chỉ tài khoản B'])
    expect((await call(ctx, endpoint, { cookie: firstCookie })).body.messages).toEqual([saved.body.message])
    expect(ctx.db.prepare('SELECT user_id FROM quick_home_messages WHERE id = ?').get(saved.body.message.id)).toMatchObject({ user_id: first.userId })
    expect(second.userId).not.toBe(first.userId)
  })
})
