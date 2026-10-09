import { randomUUID } from 'node:crypto'
import type { AppEnv } from '../env'
import type { Database } from '../db/index'
import { badRequest, notFound } from '../lib/errors'
import type { MediaStore } from '../media/store'
import { ownedProject } from '../projects/service'
import { enqueueGeneration } from '../generations/enqueue'
import type { Worker } from '../generations/worker'
import { parseTimeline, type CastMember, type TimelineFrame } from './artifacts'
import { adoptGenerationImage, portraitUploadIds, storyboardPrompt } from './storyboard'

/** Batch sinh ảnh storyboard cho cả timeline. */
export type ImageBatchStatus = 'running' | 'done' | 'stopped'
export type ImageBatchItemStatus = 'pending' | 'running' | 'done' | 'error' | 'stopped'

/** Nội dung chốt lúc tạo batch; sửa frame giữa chừng không đổi item đã xếp hàng. */
type ImageBatchSnapshot = { prompt: string; sourceUploadIds: string[]; title: string }

type BatchRow = {
  id: string
  user_id: string
  session_id: string
  status: ImageBatchStatus
  total: number
  created_at: number
  updated_at: number
}

type ItemRow = {
  id: string
  batch_id: string
  frame_id: string
  position: number
  status: ImageBatchItemStatus
  generation_id: string | null
  error: string | null
  snapshot_json: string | null
  created_at: number
  updated_at: number
}

export type ImageBatchItemPublic = {
  id: string
  frameId: string
  position: number
  status: ImageBatchItemStatus
  title: string
  error: string | null
}

export type ImageBatchPublic = {
  id: string
  sessionId: string
  status: ImageBatchStatus
  total: number
  done: number
  failed: number
  pending: number
  items: ImageBatchItemPublic[]
  updatedAt: number
}

export type ImageBatchDeps = {
  db: Database
  env: AppEnv
  mediaStore: MediaStore
  worker: Worker
}

/** Một item không xong sau ngần này thì coi như lỗi để người dùng thử lại. */
const MAX_ITEM_MS = 6 * 60 * 1000

const now = (): number => Date.now()

function itemsOf(db: Database, batchId: string): ItemRow[] {
  return db
    .prepare('SELECT * FROM plan_image_batch_items WHERE batch_id = ? ORDER BY position ASC')
    .all(batchId) as ItemRow[]
}

function snapshotOf(row: ItemRow): ImageBatchSnapshot {
  try {
    const parsed = JSON.parse(row.snapshot_json ?? '') as Partial<ImageBatchSnapshot>
    return {
      prompt: typeof parsed.prompt === 'string' ? parsed.prompt : '',
      sourceUploadIds: Array.isArray(parsed.sourceUploadIds) ? parsed.sourceUploadIds : [],
      title: typeof parsed.title === 'string' ? parsed.title : '',
    }
  } catch {
    return { prompt: '', sourceUploadIds: [], title: '' }
  }
}

function batchPublic(db: Database, batch: BatchRow): ImageBatchPublic {
  const items = itemsOf(db, batch.id)
  return {
    id: batch.id,
    sessionId: batch.session_id,
    status: batch.status,
    total: items.length,
    done: items.filter((item) => item.status === 'done').length,
    failed: items.filter((item) => item.status === 'error').length,
    pending: items.filter((item) => item.status === 'pending').length,
    items: items.map((item) => ({
      id: item.id,
      frameId: item.frame_id,
      position: item.position,
      status: item.status,
      title: snapshotOf(item).title,
      error: item.error,
    })),
    updatedAt: batch.updated_at,
  }
}

function setItem(
  db: Database,
  itemId: string,
  patch: { status?: ImageBatchItemStatus; generationId?: string | null; error?: string | null },
): void {
  const current = db
    .prepare('SELECT * FROM plan_image_batch_items WHERE id = ?')
    .get(itemId) as ItemRow | undefined
  if (!current) return
  db.prepare(
    `UPDATE plan_image_batch_items
        SET status = ?, generation_id = ?, error = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    patch.status ?? current.status,
    patch.generationId === undefined ? current.generation_id : patch.generationId,
    patch.error === undefined ? current.error : patch.error,
    now(),
    itemId,
  )
}

function touchBatch(db: Database, batchId: string, status?: ImageBatchStatus): void {
  if (status) {
    db.prepare('UPDATE plan_image_batches SET status = ?, updated_at = ? WHERE id = ?').run(
      status,
      now(),
      batchId,
    )
    return
  }
  db.prepare('UPDATE plan_image_batches SET updated_at = ? WHERE id = ?').run(now(), batchId)
}

function ownedBatch(db: Database, userId: string, sessionId: string, batchId: string): BatchRow {
  const row = db
    .prepare('SELECT * FROM plan_image_batches WHERE id = ? AND session_id = ? AND user_id = ?')
    .get(batchId, sessionId, userId) as BatchRow | undefined
  if (!row) throw notFound('Không tìm thấy batch sinh ảnh')
  return row
}

/** Batch gần nhất của phiên (kể cả đã xong) để giao diện theo dõi lại sau khi tải trang. */
export function latestImageBatch(
  db: Database,
  userId: string,
  sessionId: string,
): ImageBatchPublic | null {
  const row = db
    .prepare(
      'SELECT * FROM plan_image_batches WHERE session_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1',
    )
    .get(sessionId, userId) as BatchRow | undefined
  return row ? batchPublic(db, row) : null
}

/**
 * Tạo batch cho các frame cần ảnh.
 *
 * Prompt và ảnh chân dung được chốt ngay lúc này (snapshot) nên sửa frame giữa chừng
 * không làm đổi nội dung item đã xếp hàng.
 */
export function createImageBatch(
  deps: ImageBatchDeps,
  options: {
    userId: string
    sessionId: string
    imageModelId: string | null
    frames: TimelineFrame[]
    cast: CastMember[]
    /** true: làm mới cả frame đã có ảnh. */
    regenerateAll: boolean
  },
): ImageBatchPublic {
  const { db } = deps
  const session = db.prepare('SELECT project_id FROM plan_sessions WHERE id = ? AND user_id = ?').get(options.sessionId, options.userId) as { project_id: string | null } | undefined
  if (session?.project_id) ownedProject(db, options.userId, session.project_id)
  if (!options.imageModelId) {
    throw badRequest('Chưa chọn model ảnh cho phiên này. Hãy chọn model ảnh trước.')
  }

  const running = db
    .prepare("SELECT id FROM plan_image_batches WHERE session_id = ? AND status = 'running'")
    .get(options.sessionId) as { id: string } | undefined
  if (running) {
    throw badRequest('Đang có batch sinh ảnh chạy cho phiên này. Hãy dừng hoặc đợi xong.')
  }

  const targets = options.regenerateAll
    ? options.frames
    : options.frames.filter((frame) => !frame.background)
  if (!targets.length) {
    throw badRequest('Mọi frame đã có ảnh. Bật “Tạo lại cả ảnh đã có” nếu muốn làm mới.')
  }

  const batchId = randomUUID()
  const timestamp = now()
  db.prepare(
    'INSERT INTO plan_image_batches (id, user_id, session_id, status, total, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(batchId, options.userId, options.sessionId, 'running', targets.length, timestamp, timestamp)

  const insertItem = db.prepare(
    `INSERT INTO plan_image_batch_items
       (id, batch_id, frame_id, position, status, generation_id, error, snapshot_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, ?)`,
  )
  targets.forEach((frame, index) => {
    const snapshot: ImageBatchSnapshot = {
      prompt: storyboardPrompt(frame, options.cast),
      sourceUploadIds: portraitUploadIds(frame, options.cast),
      title: frame.title,
    }
    insertItem.run(randomUUID(), batchId, frame.id, index, JSON.stringify(snapshot), timestamp, timestamp)
  })

  // Chạy ngay item đầu để người dùng thấy tiến trình mà không phải chờ lần poll đầu.
  return advanceImageBatch(deps, options.userId, options.sessionId, batchId)
}

/** Xếp hàng item kế tiếp khi chưa có item nào đang chạy. */
function startNextItem(deps: ImageBatchDeps, batch: BatchRow, items: ItemRow[]): boolean {
  const next = items.find((item) => item.status === 'pending')
  if (!next) return false

  const session = deps.db
    .prepare('SELECT image_model_id, project_id FROM plan_sessions WHERE id = ?')
    .get(batch.session_id) as { image_model_id: string | null; project_id: string | null } | undefined
  if (session?.project_id && !deps.db.prepare('SELECT 1 FROM projects WHERE id = ? AND deleted_at IS NULL').get(session.project_id)) return false
  if (!session?.image_model_id) {
    setItem(deps.db, next.id, { status: 'error', error: 'Phiên chưa chọn model ảnh.' })
    return true
  }

  const snapshot = snapshotOf(next)
  try {
    const outcome = enqueueGeneration({
      db: deps.db,
      env: deps.env,
      worker: deps.worker,
      userId: batch.user_id,
      request: {
        data: {
          modelId: session.image_model_id,
          prompt: snapshot.prompt.slice(0, 8000),
          params: { size: '1280x720' },
          ...(snapshot.sourceUploadIds.length ? { sourceUploadIds: snapshot.sourceUploadIds } : {}),
          // Khoá ổn định theo item: chạy lại sau restart không tạo tác vụ trùng.
          idempotencyKey: `plan-batch-${next.id}`,
        },
        scene: null,
      },
    })
    setItem(deps.db, next.id, { status: 'running', generationId: outcome.generation.id, error: null })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Không xếp được hàng tác vụ ảnh'
    // Chạm trần tác vụ đồng thời: để nguyên pending, lần poll sau thử lại.
    if (/đang có \d+ tác vụ/i.test(message)) return false
    setItem(deps.db, next.id, { status: 'error', error: message })
  }
  return true
}

/** Gắn ảnh của một item đã xong vào đúng frame, đọc timeline mới nhất để không ghi đè item khác. */
function attachItemImage(deps: ImageBatchDeps, batch: BatchRow, item: ItemRow, generationId: string): void {
  const { db } = deps
  const fresh = db
    .prepare('SELECT timeline_json FROM plan_sessions WHERE id = ? AND user_id = ?')
    .get(batch.session_id, batch.user_id) as { timeline_json: string | null } | undefined
  if (!fresh) {
    setItem(db, item.id, { status: 'error', error: 'Phiên đã bị xoá; ảnh vẫn nằm trong Thư viện.' })
    return
  }

  const timeline = parseTimeline(fresh.timeline_json)
  if (!timeline || !timeline.frames.some((frame) => frame.id === item.frame_id)) {
    setItem(db, item.id, {
      status: 'error',
      error: 'Frame đã bị xoá khỏi timeline; ảnh vẫn nằm trong Thư viện.',
    })
    return
  }

  let uploadId = ''
  try {
    uploadId = adoptGenerationImage(deps, batch.user_id, generationId)
  } catch (cause) {
    setItem(db, item.id, {
      status: 'error',
      error: cause instanceof Error ? cause.message : 'Không gắn được ảnh vào frame',
    })
    return
  }

  const frames = timeline.frames.map((frame) =>
    frame.id === item.frame_id ? { ...frame, background: { uploadId } } : frame,
  )
  db.prepare('UPDATE plan_sessions SET timeline_json = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify({ frames }),
    now(),
    batch.session_id,
  )
  setItem(db, item.id, { status: 'done', error: null })
}

/**
 * Tiến batch thêm một nhịp rồi trả trạng thái mới.
 *
 * Một nhịp: đối soát item đang chạy (xong thì gắn ảnh, lỗi thì ghi lỗi) rồi xếp hàng
 * item kế tiếp. Nhờ trạng thái nằm trong DB, tải lại trang hay restart server vẫn
 * theo dõi tiếp và không gửi lại tác vụ đã có.
 */
export function advanceImageBatch(
  deps: ImageBatchDeps,
  userId: string,
  sessionId: string,
  batchId: string,
): ImageBatchPublic {
  const { db } = deps
  const batch = ownedBatch(db, userId, sessionId, batchId)

  let items = itemsOf(db, batch.id)
  const runningItem = items.find((item) => item.status === 'running')

  if (runningItem) {
    if (!runningItem.generation_id) {
      setItem(db, runningItem.id, { status: 'error', error: 'Không có tác vụ ảnh cho frame này.' })
    } else {
      const generation = db
        .prepare('SELECT status, error_message FROM generations WHERE id = ?')
        .get(runningItem.generation_id) as { status: string; error_message: string | null } | undefined
      if (!generation) {
        setItem(db, runningItem.id, { status: 'error', error: 'Tác vụ ảnh không còn tồn tại.' })
      } else if (generation.status === 'succeeded') {
        attachItemImage(deps, batch, runningItem, runningItem.generation_id)
      } else if (generation.status === 'failed' || generation.status === 'unknown') {
        setItem(db, runningItem.id, {
          status: 'error',
          error: generation.error_message ?? 'Tác vụ tạo ảnh thất bại.',
        })
      } else if (now() - runningItem.updated_at > MAX_ITEM_MS) {
        setItem(db, runningItem.id, { status: 'error', error: 'Tạo ảnh quá lâu. Hãy thử lại.' })
      }
    }
  }

  items = itemsOf(db, batch.id)

  if (batch.status === 'running') {
    // Còn item đang chạy thì chờ; nếu không thì xếp hàng item kế tiếp.
    if (!items.some((item) => item.status === 'running')) {
      const started = startNextItem(deps, batch, items)
      if (!started && !items.some((item) => item.status === 'pending')) {
        touchBatch(db, batch.id, 'done')
      }
    }
    touchBatch(db, batch.id)
  } else if (batch.status === 'stopped' && !items.some((item) => item.status === 'running')) {
    touchBatch(db, batch.id)
  }

  const refreshed = db
    .prepare('SELECT * FROM plan_image_batches WHERE id = ?')
    .get(batch.id) as BatchRow
  return batchPublic(db, refreshed)
}

export function getImageBatch(
  deps: ImageBatchDeps,
  userId: string,
  sessionId: string,
  batchId: string,
): ImageBatchPublic {
  return advanceImageBatch(deps, userId, sessionId, batchId)
}

/** Dừng batch: không xếp thêm tác vụ mới; item đang chạy ở provider vẫn có thể xong. */
export function stopImageBatch(
  deps: ImageBatchDeps,
  userId: string,
  sessionId: string,
  batchId: string,
): ImageBatchPublic {
  const { db } = deps
  const batch = ownedBatch(db, userId, sessionId, batchId)
  db.prepare(
    "UPDATE plan_image_batch_items SET status = 'stopped', updated_at = ? WHERE batch_id = ? AND status = 'pending'",
  ).run(now(), batch.id)
  touchBatch(db, batch.id, 'stopped')
  return advanceImageBatch(deps, userId, sessionId, batchId)
}

/** Thử lại các frame lỗi (và frame bị dừng) trong cùng batch. */
export function retryImageBatch(
  deps: ImageBatchDeps,
  userId: string,
  sessionId: string,
  batchId: string,
): ImageBatchPublic {
  const { db } = deps
  const batch = ownedBatch(db, userId, sessionId, batchId)
  db.prepare(
    "UPDATE plan_image_batch_items SET status = 'pending', error = NULL, updated_at = ? WHERE batch_id = ? AND status IN ('error', 'stopped')",
  ).run(now(), batch.id)
  touchBatch(db, batch.id, 'running')
  return advanceImageBatch(deps, userId, sessionId, batchId)
}
