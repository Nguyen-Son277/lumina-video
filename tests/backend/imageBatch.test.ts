import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  registerUser,
  seedProviderAndModel,
  startTestServer,
  waitForGeneration,
  type TestContext,
} from './helpers'

let ctx: TestContext
beforeAll(async () => {
  ctx = await startTestServer()
})
afterAll(async () => {
  if (ctx) await ctx.close()
})

type BatchItem = { id: string; frameId: string; status: string; title: string; error: string | null }
type Batch = {
  id: string
  status: string
  total: number
  done: number
  failed: number
  pending: number
  items: BatchItem[]
}

/** Phiên có kịch bản + nhân vật + timeline + model ảnh, sẵn sàng sinh ảnh hàng loạt. */
async function timelineSession(target: TestContext) {
  await registerUser(target)
  const provider = await call(target, '/api/providers', {
    method: 'POST',
    body: { name: 'LLM', baseUrl: 'https://llm.mock.test/v1', apiKey: 'sk-llm-abcd1234' },
  })
  const chat = await call(target, '/api/models', {
    method: 'POST',
    body: { providerId: provider.body.provider.id, modelId: 'mock-chat-model', kind: 'llm' },
  })
  const { modelPk: imageModelId } = await seedProviderAndModel(target, 'image')

  const created = await call(target, '/api/plans', { method: 'POST', body: { kind: 'planner' } })
  const sessionId = created.body.session.id as string
  await call(target, `/api/plans/${sessionId}/setup`, {
    method: 'PATCH',
    body: { chatModelId: chat.body.model.id, imageModelId },
  })
  await call(target, `/api/plans/${sessionId}/script`, { method: 'POST' })
  await call(target, `/api/plans/${sessionId}/cast`, { method: 'POST' })
  const timeline = await call(target, `/api/plans/${sessionId}/timeline`, { method: 'POST' })
  return { sessionId, imageModelId, session: timeline.body.session }
}

/** Chạy worker cho item đang chạy rồi tiến batch cho tới khi xong. */
async function driveBatch(target: TestContext, sessionId: string, batchId: string): Promise<Batch> {
  for (let step = 0; step < 40; step += 1) {
    const running = target.db
      .prepare(
        "SELECT generation_id FROM plan_image_batch_items WHERE batch_id = ? AND status = 'running'",
      )
      .all(batchId) as Array<{ generation_id: string | null }>
    for (const row of running) {
      if (row.generation_id) await waitForGeneration(target, row.generation_id)
    }
    const result = await call(target, `/api/plans/${sessionId}/image-batch/${batchId}`)
    expect(result.status).toBe(200)
    if (result.body.batch.status !== 'running') return result.body.batch as Batch
  }
  throw new Error('Batch không kết thúc sau 40 nhịp')
}

describe('Batch sinh ảnh storyboard', () => {
  it('tạo batch chỉ cho frame chưa có ảnh và gắn ảnh vào đúng frame', async () => {
    const { sessionId, session } = await timelineSession(ctx)
    const frameIds = session.timeline.frames.map((frame: { id: string }) => frame.id)

    const created = await call(ctx, `/api/plans/${sessionId}/image-batch`, {
      method: 'POST',
      body: {},
    })
    expect(created.status).toBe(202)
    const batch = created.body.batch as Batch
    expect(batch.total).toBe(frameIds.length)
    expect(batch.items.map((item) => item.frameId)).toEqual(frameIds)
    // Item đầu được xếp hàng ngay khi tạo batch.
    expect(batch.items[0]!.status).toBe('running')

    // Prompt được chốt lúc tạo batch, có nhân vật và vị trí.
    const snapshot = JSON.parse(
      (
        ctx.db
          .prepare('SELECT snapshot_json AS json FROM plan_image_batch_items WHERE batch_id = ? ORDER BY position LIMIT 1')
          .get(batch.id) as { json: string }
      ).json,
    ) as { prompt: string }
    expect(snapshot.prompt).toContain('storyboard')

    const finished = await driveBatch(ctx, sessionId, batch.id)
    expect(finished.status).toBe('done')
    expect(finished.done).toBe(frameIds.length)
    expect(finished.failed).toBe(0)

    const after = await call(ctx, `/api/plans/${sessionId}`)
    for (const frame of after.body.session.timeline.frames) {
      expect(frame.background).not.toBeNull()
    }
  })

  it('chỉ chạy một batch mỗi phiên và tôn trọng lựa chọn tạo lại', async () => {
    const { sessionId } = await timelineSession(ctx)

    const first = await call(ctx, `/api/plans/${sessionId}/image-batch`, { method: 'POST', body: {} })
    expect(first.status).toBe(202)

    // Đang có batch chạy thì không tạo thêm.
    const conflict = await call(ctx, `/api/plans/${sessionId}/image-batch`, { method: 'POST', body: {} })
    expect(conflict.status).toBe(400)

    // Chạy xong batch đầu (mọi frame có ảnh).
    await driveBatch(ctx, sessionId, first.body.batch.id)

    // Sau khi mọi frame có ảnh: mặc định từ chối, bật "tạo lại tất cả" thì chạy.
    const again = await call(ctx, `/api/plans/${sessionId}/image-batch`, { method: 'POST', body: {} })
    expect(again.status).toBe(400)
    expect(again.body.error.message).toContain('đã có ảnh')

    const regenerate = await call(ctx, `/api/plans/${sessionId}/image-batch`, {
      method: 'POST',
      body: { regenerateAll: true },
    })
    expect(regenerate.status).toBe(202)
    expect(regenerate.body.batch.total).toBe(2)
  })

  it('dừng batch thì không xếp thêm tác vụ, và thử lại được frame lỗi', async () => {
    const { sessionId } = await timelineSession(ctx)
    const created = await call(ctx, `/api/plans/${sessionId}/image-batch`, { method: 'POST', body: {} })
    const batchId = created.body.batch.id as string

    const stopped = await call(ctx, `/api/plans/${sessionId}/image-batch/${batchId}/stop`, { method: 'POST' })
    expect(stopped.status).toBe(200)
    expect(stopped.body.batch.status).toBe('stopped')
    const stoppedItem = stopped.body.batch.items.find((item: BatchItem) => item.status === 'stopped')
    expect(stoppedItem).toBeTruthy()

    // Giả lập một frame lỗi rồi thử lại: item lỗi quay lại hàng chờ.
    ctx.db
      .prepare("UPDATE plan_image_batch_items SET status = 'error', error = 'lỗi thử nghiệm' WHERE batch_id = ? AND status = 'stopped'")
      .run(batchId)
    const retried = await call(ctx, `/api/plans/${sessionId}/image-batch/${batchId}/retry`, { method: 'POST' })
    expect(retried.status).toBe(200)
    expect(retried.body.batch.status).toBe('running')
    expect(retried.body.batch.failed).toBe(0)
  })

  it('frame bị xoá giữa chừng thì item báo lỗi, ảnh vẫn nằm trong Thư viện', async () => {
    const { sessionId, session } = await timelineSession(ctx)
    const frames = session.timeline.frames as Array<Record<string, unknown>>

    const created = await call(ctx, `/api/plans/${sessionId}/image-batch`, { method: 'POST', body: {} })
    const batchId = created.body.batch.id as string
    const secondFrameId = frames[1]!.id as string

    // Xoá frame thứ hai khỏi timeline trong lúc batch đang chạy.
    const remaining = frames.filter((frame) => frame.id !== secondFrameId).map((frame) => ({
      ...frame,
      background: null,
      backgroundUploadId: null,
    }))
    const saved = await call(ctx, `/api/plans/${sessionId}/timeline`, {
      method: 'PUT',
      body: { frames: remaining },
    })
    expect(saved.status).toBe(200)

    const finished = await driveBatch(ctx, sessionId, batchId)
    const missing = finished.items.find((item) => item.frameId === secondFrameId)
    expect(missing?.status).toBe('error')
    expect(missing?.error).toContain('xoá khỏi timeline')
    // Item còn lại vẫn hoàn tất bình thường.
    expect(finished.done).toBeGreaterThanOrEqual(1)
  })

  it('theo dõi được batch gần nhất sau khi tải lại và không lộ batch của người khác', async () => {
    const { sessionId } = await timelineSession(ctx)
    const created = await call(ctx, `/api/plans/${sessionId}/image-batch`, { method: 'POST', body: {} })
    const batchId = created.body.batch.id as string

    const latest = await call(ctx, `/api/plans/${sessionId}/image-batch`)
    expect(latest.status).toBe(200)
    expect(latest.body.batch.id).toBe(batchId)

    // Người dùng khác không đọc được batch này.
    await registerUser(ctx)
    const other = await call(ctx, `/api/plans/${sessionId}/image-batch/${batchId}`)
    expect(other.status).toBe(404)
  })
})
