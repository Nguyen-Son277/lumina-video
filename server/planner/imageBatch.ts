import { randomUUID } from 'node:crypto'
import type { AppEnv } from '../env'
import type { Database } from '../db/index'
import { badRequest, errorMeta, errorMetadataOf, notFound, type ErrorMessageParams } from '../lib/errors'
import {
  isErrorMessageKey,
  messageKeyForLegacyMessage,
  type ErrorMessageKey,
} from '../../shared/errorCatalog'
import type { MediaStore } from '../media/store'
import { ownedProject } from '../projects/service'
import { enqueueGeneration } from '../generations/enqueue'
import type { Worker } from '../generations/worker'
import { parseCast, parseLocations, parseTimeline, type CastMember, type TimelineFrame } from './artifacts'
import { adoptGenerationImage, storyboardInputs, type StoryboardInputs } from './storyboard'

/** Batch sinh ảnh storyboard cho cả timeline. */
export type ImageBatchStatus = 'running' | 'done' | 'stopped'
export type ImageBatchItemStatus = 'pending' | 'running' | 'done' | 'error' | 'stopped'

/** Nội dung chốt lúc tạo batch; sửa frame giữa chừng không đổi item đã xếp hàng. */
type ImageBatchSnapshot = StoryboardInputs & { title: string }

type BatchRow = {
  id: string
  user_id: string
  session_id: string
  status: ImageBatchStatus
  total: number
  created_at: number
  updated_at: number
}

/** Hàng batch thô dùng cho đối soát; export để tầng sweeper/test truyền vào reconcile. */
export type ImageBatchRow = BatchRow

type ItemRow = {
  id: string
  batch_id: string
  frame_id: string
  position: number
  status: ImageBatchItemStatus
  generation_id: string | null
  error: string | null
  /** Khoá ngữ nghĩa của lỗi item (nullable với dữ liệu cũ). */
  error_message_key?: string | null
  /** Tham số JSON cho khoá ngữ nghĩa. */
  error_message_params?: string | null
  retry_count: number
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
  errorMessageKey: ErrorMessageKey
  errorMessageParams: ErrorMessageParams
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

/**
 * Batch không còn item nào đang chạy mà cả 10 phút không có item nào đổi trạng
 * thái thì coi như kẹt: đóng batch và đánh dấu item còn lại để người dùng thử lại.
 */
const STALE_BATCH_MS = 10 * 60 * 1000

/** Thông báo lưu trên item khi batch bị đóng vì kẹt. */
const STALLED_MESSAGE = 'Batch đã dừng vì không có tiến triển. Hãy thử lại ảnh.'

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
      sourceRoles: Array.isArray(parsed.sourceRoles) ? parsed.sourceRoles : [],
      locationId: parsed.locationId ?? null,
      characterRevisions: parsed.characterRevisions,
      locationRevision: parsed.locationRevision ?? null,
      title: typeof parsed.title === 'string' ? parsed.title : '',
    }
  } catch {
    return { prompt: '', sourceUploadIds: [], sourceRoles: [], locationId: null, locationRevision: null, title: '' }
  }
}

/** Khoá ngữ nghĩa của lỗi item; dữ liệu cũ suy từ câu lỗi đã lưu. */
function itemErrorKey(item: ItemRow): ErrorMessageKey {
  if (item.error_message_key && isErrorMessageKey(item.error_message_key)) return item.error_message_key
  if (item.error) return messageKeyForLegacyMessage(item.error) ?? 'errors.unknown'
  return 'errors.unknown'
}

function itemErrorParams(item: ItemRow): ErrorMessageParams {
  if (!item.error_message_params) return {}
  try {
    const parsed: unknown = JSON.parse(item.error_message_params)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as ErrorMessageParams
  } catch {
    // Dữ liệu cũ hoặc hỏng: bỏ qua tham số.
  }
  return {}
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
      errorMessageKey: itemErrorKey(item),
      errorMessageParams: itemErrorParams(item),
    })),
    updatedAt: batch.updated_at,
  }
}

function setItem(
  db: Database,
  itemId: string,
  patch: {
    status?: ImageBatchItemStatus
    generationId?: string | null
    error?: string | null
    errorMessageKey?: string | null
    errorMessageParams?: string | null
  },
): void {
  const current = db
    .prepare('SELECT * FROM plan_image_batch_items WHERE id = ?')
    .get(itemId) as ItemRow | undefined
  if (!current) return
  const error = patch.error === undefined ? current.error : patch.error
  // Xoá lỗi (error = null) thì xoá luôn metadata để không còn khoá cũ.
  const errorKey =
    patch.errorMessageKey !== undefined
      ? patch.errorMessageKey
      : error === null
        ? null
        : current.error_message_key ?? null
  const errorParams =
    patch.errorMessageParams !== undefined
      ? patch.errorMessageParams
      : error === null
        ? null
        : current.error_message_params ?? null
  db.prepare(
    `UPDATE plan_image_batch_items
        SET status = ?, generation_id = ?, error = ?, error_message_key = ?, error_message_params = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    patch.status ?? current.status,
    patch.generationId === undefined ? current.generation_id : patch.generationId,
    error,
    errorKey,
    errorParams,
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

/** Tham số tối thiểu để đối soát batch; sweeper truyền đủ `ImageBatchDeps` cũng hợp lệ. */
export type BatchReconcileDeps = Pick<ImageBatchDeps, 'db'>

/** Đánh dấu mọi item chưa kết thúc là lỗi với cùng một khoá ngữ nghĩa. */
function markUnfinishedItemsError(
  db: Database,
  batchId: string,
  statuses: ImageBatchItemStatus[],
  messageKey: ErrorMessageKey,
  message: string,
): void {
  if (!statuses.length) return
  const placeholders = statuses.map(() => '?').join(', ')
  db.prepare(
    `UPDATE plan_image_batch_items
        SET status = 'error', error = ?, error_message_key = ?, error_message_params = NULL, updated_at = ?
      WHERE batch_id = ? AND status IN (${placeholders})`,
  ).run(message, messageKey, now(), batchId, ...statuses)
}

/**
 * Đối soát một batch đang chạy và đóng lại nếu nó không thể tiến tiếp.
 *
 * Đóng batch (status `done`) khi:
 *   - phiên sở hữu đã bị xoá;
 *   - dự án của phiên đã bị xoá hoặc lưu trữ (trạng thái không còn hợp lệ để tạo ảnh);
 *   - không còn item nào ở trạng thái `pending`/`running`;
 *   - không có item `running` và item mới nhất đã quá `STALE_BATCH_MS` (batch kẹt):
 *     item `pending` còn lại bị đánh dấu lỗi `planner.batch_stalled` để người dùng thử lại.
 *
 * Trả về trạng thái sau đối soát. Hàm không xếp hàng tác vụ mới, nên gọi được ở cả
 * đường đọc (đối soát trước khi trả trạng thái) lẫn sweeper.
 */
export function reconcileImageBatch(deps: BatchReconcileDeps, batchRow: ImageBatchRow): ImageBatchStatus {
  const { db } = deps
  if (batchRow.status !== 'running') return batchRow.status

  const session = db
    .prepare('SELECT project_id FROM plan_sessions WHERE id = ?')
    .get(batchRow.session_id) as { project_id: string | null } | undefined
  if (!session) {
    markUnfinishedItemsError(
      db,
      batchRow.id,
      ['pending', 'running'],
      'planner.batch_session_deleted',
      'Phiên đã bị xoá; ảnh vẫn nằm trong Thư viện.',
    )
    touchBatch(db, batchRow.id, 'done')
    return 'done'
  }

  if (session.project_id) {
    const project = db
      .prepare('SELECT deleted_at, archived FROM projects WHERE id = ?')
      .get(session.project_id) as { deleted_at: number | null; archived: number } | undefined
    if (!project || project.deleted_at != null || Number(project.archived) === 1) {
      markUnfinishedItemsError(db, batchRow.id, ['pending', 'running'], 'planner.batch_stalled', STALLED_MESSAGE)
      touchBatch(db, batchRow.id, 'done')
      return 'done'
    }
  }

  const items = itemsOf(db, batchRow.id)
  const unfinished = items.filter((item) => item.status === 'pending' || item.status === 'running')
  if (!unfinished.length) {
    touchBatch(db, batchRow.id, 'done')
    return 'done'
  }

  // Chỉ đánh dấu kẹt khi không còn item nào đang chạy: còn `running` nghĩa là provider
  // vẫn có thể trả kết quả, việc chờ đã có `MAX_ITEM_MS` lo.
  if (!unfinished.some((item) => item.status === 'running')) {
    const newest = Math.max(...items.map((item) => item.updated_at))
    if (now() - newest > STALE_BATCH_MS) {
      markUnfinishedItemsError(db, batchRow.id, ['pending'], 'planner.batch_stalled', STALLED_MESSAGE)
      touchBatch(db, batchRow.id, 'done')
      return 'done'
    }
  }

  return 'running'
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
  if (!row) return null
  // Đối soát trước khi trả: batch kẹt tự đóng mà không cần giao diện poll thêm.
  reconcileImageBatch({ db }, row)
  const refreshed = db.prepare('SELECT * FROM plan_image_batches WHERE id = ?').get(row.id) as BatchRow
  return batchPublic(db, refreshed)
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

  // Đối soát batch đang chạy TRƯỚC mọi việc khác: batch kẹt (hoặc phiên/dự án đã
  // mất) phải được đóng trước, nếu không chỉ mục duy nhất "một batch chạy mỗi
  // phiên" sẽ chặn mãi và người dùng không tạo lại được.
  const running = db
    .prepare("SELECT * FROM plan_image_batches WHERE session_id = ? AND status = 'running' ORDER BY created_at DESC")
    .all(options.sessionId) as BatchRow[]
  for (const row of running) reconcileImageBatch({ db }, row)
  const stillRunning = db
    .prepare("SELECT id FROM plan_image_batches WHERE session_id = ? AND status = 'running' LIMIT 1")
    .get(options.sessionId) as { id: string } | undefined
  if (stillRunning) {
    throw badRequest(
      'Đang có batch sinh ảnh chạy cho phiên này. Hãy dừng hoặc đợi xong.',
      undefined,
      errorMeta('planner.image_batch_running'),
    )
  }

  const session = db.prepare('SELECT project_id, locations_json FROM plan_sessions WHERE id = ? AND user_id = ?').get(options.sessionId, options.userId) as { project_id: string | null; locations_json: string | null } | undefined
  if (session?.project_id) ownedProject(db, options.userId, session.project_id)
  if (!options.imageModelId) {
    throw badRequest('Chưa chọn model ảnh cho phiên này. Hãy chọn model ảnh trước.')
  }

  const targets = options.regenerateAll
    ? options.frames
    : options.frames.filter((frame) => !frame.background)
  if (!targets.length) {
    throw badRequest('Mọi frame đã có ảnh. Bật “Tạo lại cả ảnh đã có” nếu muốn làm mới.')
  }

  const locations = parseLocations(session?.locations_json)
  const snapshots = targets.map(frame => ({
    ...storyboardInputs(frame, options.cast, locations, deps.env.MAX_SOURCE_IMAGES), title: frame.title,
  }))
  // Xác thực ảnh tham chiếu TRƯỚC khi tạo batch: không xếp hàng item rồi mới lỗi.
  const ownedUpload = db.prepare('SELECT 1 FROM uploads WHERE id = ? AND user_id = ?')
  for (const snapshot of snapshots) {
    for (const uploadId of snapshot.sourceUploadIds) {
      if (!ownedUpload.get(uploadId, options.userId)) {
        throw badRequest('Ảnh tham chiếu của bối cảnh hoặc nhân vật không tồn tại.', undefined, errorMeta('locations.reference_not_owned'))
      }
    }
  }
  const batchId = randomUUID()
  const timestamp = now()
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      'INSERT INTO plan_image_batches (id, user_id, session_id, status, total, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(batchId, options.userId, options.sessionId, 'running', targets.length, timestamp, timestamp)

    const insertItem = db.prepare(
      `INSERT INTO plan_image_batch_items
         (id, batch_id, frame_id, position, status, generation_id, error, snapshot_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, ?)`,
    )
    targets.forEach((frame, index) => {
      const snapshot = snapshots[index]!
      insertItem.run(randomUUID(), batchId, frame.id, index, JSON.stringify(snapshot), timestamp, timestamp)
    })
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

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
    setItem(deps.db, next.id, {
      status: 'error',
      error: 'Phiên chưa chọn model ảnh.',
      errorMessageKey: 'planner.batch_image_model_missing',
      errorMessageParams: null,
    })
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
          idempotencyKey: `plan-batch-${next.id}${next.retry_count ? `-retry-${next.retry_count}` : ''}`,
        },
        scene: null,
      },
    })
    setItem(deps.db, next.id, { status: 'running', generationId: outcome.generation.id, error: null })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Không xếp được hàng tác vụ ảnh'
    // Chạm trần tác vụ đồng thời: để nguyên pending, lần poll sau thử lại.
    if (errorMetadataOf(cause).messageKey === 'generations.too_many_active_jobs') return false
    const meta = errorMetadataOf(cause)
    setItem(deps.db, next.id, {
      status: 'error',
      error: message,
      errorMessageKey: meta.messageKey,
      errorMessageParams: JSON.stringify(meta.messageParams),
    })
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
    setItem(db, item.id, {
      status: 'error',
      error: 'Phiên đã bị xoá; ảnh vẫn nằm trong Thư viện.',
      errorMessageKey: 'planner.batch_session_deleted',
      errorMessageParams: null,
    })
    return
  }

  const timeline = parseTimeline(fresh.timeline_json)
  if (!timeline || !timeline.frames.some((frame) => frame.id === item.frame_id)) {
    setItem(db, item.id, {
      status: 'error',
      error: 'Frame đã bị xoá khỏi timeline; ảnh vẫn nằm trong Thư viện.',
      errorMessageKey: 'planner.batch_frame_deleted',
      errorMessageParams: null,
    })
    return
  }

  let uploadId = ''
  try {
    uploadId = adoptGenerationImage(deps, batch.user_id, generationId)
  } catch (cause) {
    const meta = errorMetadataOf(cause)
    setItem(db, item.id, {
      status: 'error',
      error: cause instanceof Error ? cause.message : 'Không gắn được ảnh vào frame',
      errorMessageKey: meta.messageKey,
      errorMessageParams: JSON.stringify(meta.messageParams),
    })
    return
  }

  const locationRow = db.prepare('SELECT locations_json, cast_json FROM plan_sessions WHERE id = ?').get(batch.session_id) as { locations_json: string | null; cast_json: string | null }
  const snapshot = snapshotOf(item)
  const currentLocation = parseLocations(locationRow.locations_json).find(location => location.id === snapshot.locationId)
  const frames = timeline.frames.map((frame) =>
    frame.id === item.frame_id ? {
      ...frame, background: { uploadId }, backgroundLocationRevision: snapshot.locationRevision,
      backgroundStale: Boolean(snapshot.locationId && (frame.locationId !== snapshot.locationId || currentLocation?.revision !== snapshot.locationRevision)) || Object.entries(snapshot.characterRevisions ?? {}).some(([id, revision]) => parseCast(locationRow.cast_json).find(x => x.id === id)?.revision !== revision),
    } : frame,
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

  // Đối soát trước: phiên/dự án đã mất hoặc batch kẹt thì đóng ngay thay vì treo.
  if (batch.status === 'done' || (batch.status === 'running' && reconcileImageBatch(deps, batch) !== 'running')) {
    const closed = db.prepare('SELECT * FROM plan_image_batches WHERE id = ?').get(batch.id) as BatchRow
    return batchPublic(db, closed)
  }

  let items = itemsOf(db, batch.id)
  const runningItem = items.find((item) => item.status === 'running')

  if (runningItem) {
    if (!runningItem.generation_id) {
      setItem(db, runningItem.id, {
        status: 'error',
        error: 'Không có tác vụ ảnh cho frame này.',
        errorMessageKey: 'planner.batch_generation_missing_for_frame',
        errorMessageParams: null,
      })
    } else {
      const generation = db
        .prepare('SELECT status, error_message, error_message_key, error_message_params FROM generations WHERE id = ?')
        .get(runningItem.generation_id) as
        | {
            status: string
            error_message: string | null
            error_message_key: string | null
            error_message_params: string | null
          }
        | undefined
      if (!generation) {
        setItem(db, runningItem.id, {
          status: 'error',
          error: 'Tác vụ ảnh không còn tồn tại.',
          errorMessageKey: 'planner.batch_generation_gone',
          errorMessageParams: null,
        })
      } else if (generation.status === 'succeeded') {
        attachItemImage(deps, batch, runningItem, runningItem.generation_id)
      } else if (generation.status === 'failed' || generation.status === 'unknown') {
        setItem(db, runningItem.id, {
          status: 'error',
          error: generation.error_message ?? 'Tác vụ tạo ảnh thất bại.',
          errorMessageKey: generation.error_message_key ?? 'planner.batch_generation_failed',
          errorMessageParams: generation.error_message_params ?? null,
        })
      } else if (now() - runningItem.updated_at > MAX_ITEM_MS) {
        setItem(db, runningItem.id, {
          status: 'error',
          error: 'Tạo ảnh quá lâu. Hãy thử lại.',
          errorMessageKey: 'planner.batch_timeout',
          errorMessageParams: null,
        })
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
  db.exec('BEGIN IMMEDIATE')
  try {
    if (db.prepare("SELECT 1 FROM plan_image_batches WHERE session_id = ? AND status = 'running' AND id <> ?")
      .get(sessionId, batchId)) {
      throw badRequest('Đang có batch sinh ảnh chạy cho phiên này. Hãy dừng hoặc đợi xong.', undefined,
        errorMeta('planner.image_batch_running'))
    }
    for (const item of itemsOf(db, batch.id).filter(item => item.status === 'error' || item.status === 'stopped')) {
      const generation = item.generation_id
        ? db.prepare('SELECT status FROM generations WHERE id = ?').get(item.generation_id) as { status: string } | undefined
        : undefined
      const resume = generation && ['queued', 'running', 'downloading', 'succeeded'].includes(generation.status)
      db.prepare(`UPDATE plan_image_batch_items
        SET status = ?, generation_id = ?, retry_count = retry_count + ?,
            error = NULL, error_message_key = NULL, error_message_params = NULL, updated_at = ? WHERE id = ?`)
        .run(resume ? 'running' : 'pending', resume ? item.generation_id : null,
          resume ? 0 : 1, now(), item.id)
    }
    touchBatch(db, batch.id, 'running')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return advanceImageBatch(deps, userId, sessionId, batchId)
}
