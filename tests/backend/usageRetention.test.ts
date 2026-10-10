import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, seedProviderAndModel, startTestServer, waitForGeneration, type TestContext } from './helpers'
import { recordLlmUsage } from '../../server/usage/log'
import { purgeExpiredUsageLogs } from '../../server/usage/service'
import { RETENTION_DAYS, maintainUsageRetention, resetUsageRetentionClock } from '../../server/usage/retention'

let ctx: TestContext
beforeAll(async () => {
  ctx = await startTestServer()
})
afterAll(async () => {
  if (ctx) await ctx.close()
})

const DAY = 24 * 60 * 60 * 1000

function insertUsage(userId: string, age: number): void {
  recordLlmUsage(ctx.db, {
    userId,
    source: 'planner_chat',
    status: 'ok',
    latencyMs: 1,
    now: Date.now() - age,
  })
}

const idsFor = (userId: string): string[] =>
  (
    ctx.db
      .prepare('SELECT id FROM llm_usage WHERE user_id = ? ORDER BY created_at ASC')
      .all(userId) as unknown as Array<{ id: string }>
  ).map((row) => row.id)

describe('Dọn nhật ký sử dụng sau 90 ngày', () => {
  it('xoá bản ghi cũ hơn 90 ngày và giữ bản ghi mới', async () => {
    const user = await registerUser(ctx)
    insertUsage(user.userId, (RETENTION_DAYS + 1) * DAY)
    insertUsage(user.userId, 89 * DAY)
    insertUsage(user.userId, 0)
    expect(idsFor(user.userId)).toHaveLength(3)

    const deleted = purgeExpiredUsageLogs(ctx.db, { days: RETENTION_DAYS })
    expect(deleted).toBe(1)
    expect(idsFor(user.userId)).toHaveLength(2)
  })

  it('job định kỳ chỉ chạy tối đa một lần mỗi giờ và không ném lỗi', async () => {
    const user = await registerUser(ctx)
    insertUsage(user.userId, (RETENTION_DAYS + 2) * DAY)
    const now = Date.now()

    resetUsageRetentionClock()
    expect(maintainUsageRetention({ db: ctx.db, now, force: true })).toBeGreaterThanOrEqual(1)
    // Lần gọi ngay sau đó bị bỏ qua vì chưa qua một giờ.
    expect(maintainUsageRetention({ db: ctx.db, now: now + 1000 })).toBe(0)
    expect(idsFor(user.userId)).toHaveLength(0)
  })

  it('không đụng tới ảnh/video của người dùng', async () => {
    const user = await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const created = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, prompt: 'Nội dung phải được giữ', params: {} },
    })
    await waitForGeneration(ctx, created.body.generation.id)
    const before = (
      ctx.db.prepare('SELECT COUNT(*) AS total FROM generations WHERE user_id = ?').get(user.userId) as { total: number }
    ).total
    expect(Number(before)).toBe(1)

    insertUsage(user.userId, (RETENTION_DAYS + 5) * DAY)
    resetUsageRetentionClock()
    maintainUsageRetention({ db: ctx.db, now: Date.now(), force: true })

    expect(idsFor(user.userId)).toHaveLength(0)
    const after = (
      ctx.db.prepare('SELECT COUNT(*) AS total FROM generations WHERE user_id = ?').get(user.userId) as { total: number }
    ).total
    expect(Number(after)).toBe(1)
  })
})
