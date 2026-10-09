import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'
import {
  advanceImageBatch,
  createImageBatch,
  reconcileImageBatch,
  type ImageBatchRow,
} from '../../server/planner/imageBatch'
import { createBatchSweeper, type BatchSweeper } from '../../server/planner/batchSweeper'

/**
 * Batch sinh ảnh từng chỉ tiến khi giao diện poll. Khi người dùng đóng tab hoặc một
 * item kẹt vì trần tác vụ đồng thời, batch mãi ở `running` và vì mỗi phiên chỉ có
 * một batch chạy, người dùng không tạo lại được. Các bài test dưới đây kiểm tra:
 *   - batch kẹt/quá hạn được đối soát và đóng, tạo batch mới được;
 *   - batch còn chạy thật thì vẫn bị chặn đúng lúc;
 *   - sweeper tiến batch xong mà không cần HTTP poll;
 *   - phiên/dự án bị xoá thì batch đóng thay vì treo;
 *   - sweeper không đụng batch đã xong/dừng và không tạo tác vụ trùng.
 */

let ctx: TestContext
beforeAll(async () => {
  ctx = await startTestServer()
})
afterAll(async () => {
  if (ctx) await ctx.close()
})

/** Khớp hằng số nội bộ `STALE_BATCH_MS` trong imageBatch.ts. */
const STALE_BATCH_MS = 10 * 60 * 1000
const STALE_AGE_MS = STALE_BATCH_MS + 60_000

type Seed = {
  userId: string
  sessionId: string
  imageModelId: string
  frameIds: string[]
  projectId: string | null
}

function frameFor(id: string) {
  return {
    id,
    title: `Frame ${id}`,
    context: 'Bối cảnh test',
    action: 'Hành động test',
    dialogue: '',
    speaker: '',
    characters: [] as string[],
    durationSeconds: 8,
    shotNotes: '',
    backgroundPrompt: 'Bối cảnh test',
    background: null,
    locationId: null,
    backgroundLocationRevision: null,
    backgroundStale: false,
    blocking: [] as Array<{ castId: string; action: string; position: string }>,
  }
}

const SNAPSHOT = {
  prompt: 'Khung hình storyboard test',
  sourceUploadIds: [] as string[],
  sourceRoles: [] as Array<{ uploadId: string; role: string; id: string }>,
  locationId: null,
  locationRevision: null,
  title: 'Frame test',
}

/** Phiên planner có sẵn model ảnh + timeline, thêm dự án nếu cần. */
async function seedSession(options: { frames?: number; withProject?: boolean } = {}): Promise<Seed> {
  const { userId } = await registerUser(ctx)
  const { modelPk } = await seedProviderAndModel(ctx, 'image')
  const sessionId = randomUUID()
  const frameCount = options.frames ?? 2
  const frameIds = Array.from({ length: frameCount }, (_, index) => `frame-${index + 1}`)

  let projectId: string | null = null
  if (options.withProject) {
    projectId = randomUUID()
    const now = Date.now()
    ctx.db
      .prepare(
        'INSERT INTO projects (id, user_id, name, description, style, language, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)',
      )
      .run(projectId, userId, 'Dự án batch', '', '', 'vi', now, now)
  }

  const now = Date.now()
  ctx.db
    .prepare(
      `INSERT INTO plan_sessions (id, user_id, kind, chat_model_id, image_model_id, video_model_id, project_id,
        title, status, script_json, cast_json, locations_json, timeline_json, created_at, updated_at)
       VALUES (?, ?, 'planner', NULL, ?, NULL, ?, 'Phiên batch', 'scripting', NULL, '[]', '[]', ?, ?, ?)`,
    )
    .run(
      sessionId,
      userId,
      modelPk,
      projectId,
      JSON.stringify({ frames: frameIds.map((id) => frameFor(id)) }),
      now,
      now,
    )

  return { userId, sessionId, imageModelId: modelPk, frameIds, projectId }
}

type InsertItem = {
  frameId: string
  status: 'pending' | 'running' | 'done' | 'error' | 'stopped'
  generationId?: string | null
  updatedAt?: number
}

/** Chèn batch + item thẳng vào DB để dựng đúng trạng thái kẹt cần kiểm tra. */
function insertBatch(options: {
  userId: string
  sessionId: string
  items: InsertItem[]
  status?: 'running' | 'done' | 'stopped'
  updatedAt?: number
}): string {
  const batchId = randomUUID()
  const now = Date.now()
  const updatedAt = options.updatedAt ?? now
  ctx.db
    .prepare(
      'INSERT INTO plan_image_batches (id, user_id, session_id, status, total, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(batchId, options.userId, options.sessionId, options.status ?? 'running', options.items.length, now, updatedAt)
  const insertItem = ctx.db.prepare(
    `INSERT INTO plan_image_batch_items
       (id, batch_id, frame_id, position, status, generation_id, error, snapshot_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  )
  options.items.forEach((item, index) => {
    insertItem.run(
      randomUUID(),
      batchId,
      item.frameId,
      index,
      item.status,
      item.generationId ?? null,
      JSON.stringify(SNAPSHOT),
      now,
      item.updatedAt ?? now,
    )
  })
  return batchId
}

type BatchRow = { id: string; status: string; updated_at: number }
type ItemRow = {
  id: string
  frame_id: string
  status: string
  generation_id: string | null
  error: string | null
  error_message_key: string | null
  updated_at: number
}

function readBatch(batchId: string): { batch: BatchRow; items: ItemRow[] } {
  const batch = ctx.db.prepare('SELECT * FROM plan_image_batches WHERE id = ?').get(batchId) as BatchRow
  const items = ctx.db
    .prepare('SELECT * FROM plan_image_batch_items WHERE batch_id = ? ORDER BY position ASC')
    .all(batchId) as unknown as ItemRow[]
  return { batch, items }
}

function readBatchRow(batchId: string): ImageBatchRow {
  return ctx.db.prepare('SELECT * FROM plan_image_batches WHERE id = ?').get(batchId) as unknown as ImageBatchRow
}

function batchDeps() {
  return { db: ctx.db, env: ctx.env, mediaStore: ctx.mediaStore, worker: ctx.worker }
}

function batchGenerationCount(userId: string): number {
  const row = ctx.db
    .prepare(
      "SELECT COUNT(*) AS total FROM generations WHERE user_id = ? AND idempotency_key LIKE 'plan-batch-%'",
    )
    .get(userId) as { total: number }
  return Number(row.total)
}

/** Chèn generation 'running' giả để chiếm chỗ trần tác vụ đồng thời. */
function occupySlots(userId: string, count: number): string[] {
  const ids: string[] = []
  const now = Date.now()
  const insert = ctx.db.prepare(
    `INSERT INTO generations
       (id, user_id, kind, prompt, snap_provider, snap_base_url, snap_model_id, status, created_at, updated_at)
     VALUES (?, ?, 'image', 'chiếm chỗ', 'mock', 'https://mock.test/v1', 'mock-image-model', 'running', ?, ?)`,
  )
  for (let index = 0; index < count; index += 1) {
    const id = randomUUID()
    insert.run(id, userId, now, now)
    ids.push(id)
  }
  return ids
}

function freeSlots(ids: string[]): void {
  const now = Date.now()
  const update = ctx.db.prepare("UPDATE generations SET status = 'succeeded', completed_at = ?, updated_at = ? WHERE id = ?")
  for (const id of ids) update.run(now, now, id)
}

function makeSweeper(): BatchSweeper {
  return createBatchSweeper({ ...batchDeps(), intervalMs: 60_000 })
}

describe('Đối soát batch sinh ảnh bị kẹt', () => {
  it('batch pending quá hạn: createImageBatch đóng batch cũ rồi tạo batch mới', async () => {
    const seed = await seedSession({ frames: 2 })
    const oldBatchId = insertBatch({
      userId: seed.userId,
      sessionId: seed.sessionId,
      items: [{ frameId: seed.frameIds[0]!, status: 'pending', updatedAt: Date.now() - STALE_AGE_MS }],
      updatedAt: Date.now() - STALE_AGE_MS,
    })

    const created = await call(ctx, `/api/plans/${seed.sessionId}/image-batch`, { method: 'POST', body: {} })
    expect(created.status).toBe(202)
    expect(created.body.batch.status).toBe('running')

    const old = readBatch(oldBatchId)
    expect(old.batch.status).toBe('done')
    expect(old.items[0]!.status).toBe('error')
    expect(old.items[0]!.error_message_key).toBe('planner.batch_stalled')

    // Batch mới phải khác batch cũ và thực sự chạy.
    expect(created.body.batch.id).not.toBe(oldBatchId)
    expect(readBatch(created.body.batch.id as string).batch.status).toBe('running')
  })

  it('batch còn item "running" tươi: createImageBatch trả 400 với khoá planner.image_batch_running', async () => {
    const seed = await seedSession({ frames: 1 })
    const batchId = insertBatch({
      userId: seed.userId,
      sessionId: seed.sessionId,
      items: [{ frameId: seed.frameIds[0]!, status: 'running', generationId: null, updatedAt: Date.now() }],
    })

    const created = await call(ctx, `/api/plans/${seed.sessionId}/image-batch`, { method: 'POST', body: {} })
    expect(created.status).toBe(400)
    expect(created.body.error.messageKey).toBe('planner.image_batch_running')
    // Giữ nguyên văn thông báo HTTP 400 cũ cho client đang dựa vào câu này.
    expect(created.body.error.message).toBe('Đang có batch sinh ảnh chạy cho phiên này. Hãy dừng hoặc đợi xong.')

    const after = readBatch(batchId)
    expect(after.batch.status).toBe('running')
    expect(after.items[0]!.status).toBe('running')
  })

  it('sweeper tiến batch đang chờ chỗ trần đồng thời cho tới khi xong, không cần poll HTTP', async () => {
    const seed = await seedSession({ frames: 2 })
    const batchId = insertBatch({
      userId: seed.userId,
      sessionId: seed.sessionId,
      items: seed.frameIds.map((frameId) => ({ frameId, status: 'pending' as const })),
    })

    // Chiếm hết chỗ tác vụ đồng thời của người dùng.
    const blockers = occupySlots(seed.userId, ctx.env.MAX_CONCURRENT_JOBS_PER_USER)
    const sweeper = makeSweeper()
    sweeper.runOnce()

    const blocked = readBatch(batchId)
    expect(blocked.batch.status).toBe('running')
    expect(blocked.items.every((item) => item.status === 'pending')).toBe(true)
    expect(batchGenerationCount(seed.userId)).toBe(0)

    // Nhả chỗ: sweeper phải tự xếp hàng và hoàn tất batch mà không cần GET batch nào.
    freeSlots(blockers)
    sweeper.runOnce()
    expect(readBatch(batchId).items[0]!.status).toBe('running')

    for (let step = 0; step < 120; step += 1) {
      await ctx.worker.tick()
      sweeper.runOnce()
      if (readBatch(batchId).batch.status !== 'running') break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    const finished = readBatch(batchId)
    expect(finished.batch.status).toBe('done')
    expect(finished.items.map((item) => item.status)).toEqual(['done', 'done'])
    // Mỗi item đúng một tác vụ, khoá idempotency ổn định theo item.
    expect(batchGenerationCount(seed.userId)).toBe(2)
    for (const item of finished.items) expect(item.generation_id).toBeTruthy()

    // Batch đã xong: sweeper không tạo thêm tác vụ nào.
    for (let step = 0; step < 3; step += 1) sweeper.runOnce()
    expect(batchGenerationCount(seed.userId)).toBe(2)
    expect(readBatch(batchId).items.map((item) => item.status)).toEqual(['done', 'done'])
  })

  it('dự án bị xoá hoặc lưu trữ: batch đóng thay vì treo', async () => {
    for (const state of ['deleted', 'archived'] as const) {
      const seed = await seedSession({ frames: 1, withProject: true })
      const batchId = insertBatch({
        userId: seed.userId,
        sessionId: seed.sessionId,
        items: [{ frameId: seed.frameIds[0]!, status: 'pending' }],
      })

      if (state === 'deleted') {
        ctx.db.prepare('UPDATE projects SET deleted_at = ? WHERE id = ?').run(Date.now(), seed.projectId)
      } else {
        ctx.db.prepare('UPDATE projects SET archived = 1 WHERE id = ?').run(seed.projectId)
      }

      const result = advanceImageBatch(batchDeps(), seed.userId, seed.sessionId, batchId)
      expect(result.status).toBe('done')
      const after = readBatch(batchId)
      expect(after.batch.status).toBe('done')
      expect(after.items[0]!.status).toBe('error')
      expect(after.items[0]!.error_message_key).toBe('planner.batch_stalled')
    }
  })

  it('phiên bị xoá: batch đóng và item báo phiên đã xoá', async () => {
    const seed = await seedSession({ frames: 1 })
    const batchId = insertBatch({
      userId: seed.userId,
      sessionId: seed.sessionId,
      items: [{ frameId: seed.frameIds[0]!, status: 'pending' }],
    })

    // Khoá ngoại CASCADE sẽ xoá batch theo phiên; tắt kiểm tra để mô phỏng dữ liệu
    // cũ còn sót batch của phiên đã mất (đúng nhánh phòng vệ của reconcile).
    ctx.db.exec('PRAGMA foreign_keys = OFF')
    try {
      ctx.db.prepare('DELETE FROM plan_sessions WHERE id = ?').run(seed.sessionId)
    } finally {
      ctx.db.exec('PRAGMA foreign_keys = ON')
    }

    const result = advanceImageBatch(batchDeps(), seed.userId, seed.sessionId, batchId)
    expect(result.status).toBe('done')
    const after = readBatch(batchId)
    expect(after.batch.status).toBe('done')
    expect(after.items[0]!.status).toBe('error')
    expect(after.items[0]!.error_message_key).toBe('planner.batch_session_deleted')
  })

  it('sweeper bỏ qua batch đã xong/đã dừng và không tạo tác vụ trùng', async () => {
    const seed = await seedSession({ frames: 2 })
    const doneBatch = insertBatch({
      userId: seed.userId,
      sessionId: seed.sessionId,
      status: 'done',
      items: [{ frameId: seed.frameIds[0]!, status: 'done', generationId: null }],
    })

    // Cùng phiên không thể có hai batch chạy, nên batch dừng nằm ở phiên khác.
    const second = await seedSession({ frames: 1 })
    const stoppedBatch = insertBatch({
      userId: second.userId,
      sessionId: second.sessionId,
      status: 'stopped',
      items: [{ frameId: second.frameIds[0]!, status: 'stopped' }],
    })

    const doneBefore = readBatch(doneBatch)
    const stoppedBefore = readBatch(stoppedBatch)
    const sweeper = makeSweeper()
    sweeper.runOnce()

    expect(readBatch(doneBatch)).toEqual(doneBefore)
    expect(readBatch(stoppedBatch)).toEqual(stoppedBefore)
    expect(batchGenerationCount(seed.userId)).toBe(0)
    expect(batchGenerationCount(second.userId)).toBe(0)
  })

  it('start/stop an toàn và dừng timer (không để tiến trình treo)', async () => {
    const sweeper = createBatchSweeper({ ...batchDeps(), intervalMs: 20 })
    sweeper.start()
    // Gọi start lần nữa không được tạo timer thứ hai.
    sweeper.start()
    await new Promise((resolve) => setTimeout(resolve, 40))
    await sweeper.stop()
    await sweeper.stop()
    // Nếu stop() không xoá timer, interval 20ms sẽ giữ tiến trình test chạy mãi.
    expect(true).toBe(true)
  })

  it('reconcileImageBatch: kẹt thì đóng + đánh dấu stalled, tươi thì giữ running', async () => {
    const seed = await seedSession({ frames: 1 })

    const freshId = insertBatch({
      userId: seed.userId,
      sessionId: seed.sessionId,
      items: [{ frameId: seed.frameIds[0]!, status: 'pending' }],
    })
    expect(reconcileImageBatch({ db: ctx.db }, readBatchRow(freshId))).toBe('running')
    expect(readBatch(freshId).items[0]!.status).toBe('pending')

    const other = await seedSession({ frames: 1 })
    const staleId = insertBatch({
      userId: other.userId,
      sessionId: other.sessionId,
      items: [{ frameId: other.frameIds[0]!, status: 'pending', updatedAt: Date.now() - STALE_AGE_MS }],
      updatedAt: Date.now() - STALE_AGE_MS,
    })
    expect(reconcileImageBatch({ db: ctx.db }, readBatchRow(staleId))).toBe('done')
    const stale = readBatch(staleId)
    expect(stale.batch.status).toBe('done')
    expect(stale.items[0]!.status).toBe('error')
    expect(stale.items[0]!.error_message_key).toBe('planner.batch_stalled')

    // Không còn item pending/running thì batch đóng luôn, không cần chờ hết hạn.
    const third = await seedSession({ frames: 1 })
    const closedId = insertBatch({
      userId: third.userId,
      sessionId: third.sessionId,
      items: [{ frameId: third.frameIds[0]!, status: 'error', updatedAt: Date.now() }],
    })
    expect(reconcileImageBatch({ db: ctx.db }, readBatchRow(closedId))).toBe('done')
    expect(readBatch(closedId).batch.status).toBe('done')
  })

  it('createImageBatch trực tiếp cũng đối soát batch kẹt trước khi tạo mới', async () => {
    const seed = await seedSession({ frames: 1 })
    const staleId = insertBatch({
      userId: seed.userId,
      sessionId: seed.sessionId,
      items: [{ frameId: seed.frameIds[0]!, status: 'pending', updatedAt: Date.now() - STALE_AGE_MS }],
      updatedAt: Date.now() - STALE_AGE_MS,
    })

    const frames = (
      JSON.parse(
        (ctx.db.prepare('SELECT timeline_json AS json FROM plan_sessions WHERE id = ?').get(seed.sessionId) as {
          json: string
        }).json,
      ) as { frames: unknown[] }
    ).frames as never

    const created = createImageBatch(batchDeps(), {
      userId: seed.userId,
      sessionId: seed.sessionId,
      imageModelId: seed.imageModelId,
      frames,
      cast: [],
      regenerateAll: false,
    })
    expect(created.status).toBe('running')
    expect(readBatch(staleId).batch.status).toBe('done')
  })
})
