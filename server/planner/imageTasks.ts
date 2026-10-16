import { createHash, randomUUID } from 'node:crypto'
import type { Database } from '../db/index'
import { conflict, notFound } from '../lib/errors'

export type ImageTaskScope = 'planner' | 'project'
export type ImageTaskTargetType = 'location' | 'frame'
export type ImageTaskStatus = 'queued' | 'running' | 'unknown' | 'succeeded' | 'failed' | 'abandoned'

export type ImageTaskRow = {
  id: string
  user_id: string
  scope: ImageTaskScope
  scope_id: string
  target_type: ImageTaskTargetType
  target_id: string
  revision: number | string | null
  fingerprint: string
  generation_id: string | null
  request_key: string | null
  status: ImageTaskStatus
  created_at: number
  updated_at: number
  trashed_at?: number | null
  detached_at: number | null
  attached_at: number | null
  attached_revision: number | string | null
}

export type ImageTaskPublic = {
  id: string
  scope: ImageTaskScope
  scopeId: string
  targetType: ImageTaskTargetType
  targetId: string
  revision: number | string | null
  fingerprint: string
  generationId: string | null
  requestKey: string | null
  status: ImageTaskStatus
  createdAt: number
  updatedAt: number
  trashedAt?: number | null
  detachedAt: number | null
  attachedAt: number | null
  attachedRevision: number | string | null
}

export type EnqueueImageTaskInput = {
  db: Database
  userId: string
  scope: ImageTaskScope
  scopeId: string
  targetType: ImageTaskTargetType
  targetId: string
  revision: number | string | null
  fingerprint: string
  requestKey?: string | null
  confirmNew?: boolean
  /** Called inside the reservation transaction; throw to roll everything back. */
  enqueue: (task: ImageTaskPublic) => string | { generationId: string; status?: ImageTaskStatus }
}

export type EnqueueImageTaskResult = { task: ImageTaskPublic; reused: boolean }

const now = (): number => Date.now()

function assertOwnedScope(db: Database, userId: string, scope: ImageTaskScope, scopeId: string): void {
  const table = scope === 'planner' ? 'plan_sessions' : 'projects'
  if (!db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND user_id=? AND deleted_at IS NULL`).get(scopeId, userId)) {
    throw notFound('Không tìm thấy phạm vi tác vụ ảnh')
  }
}

function synchronizeTasks(db: Database, userId: string): void {
  // Recover pre-migration batch links only when an exact frame/generation identity exists.
  const legacy = db.prepare(`SELECT i.id, i.frame_id, i.generation_id, i.snapshot_json, i.created_at, b.session_id
    FROM plan_image_batch_items i JOIN plan_image_batches b ON b.id = i.batch_id
    JOIN generations g ON g.id = i.generation_id
    WHERE b.user_id = ? AND g.user_id = ? AND g.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM image_tasks t WHERE t.generation_id = i.generation_id AND t.user_id = ?)`)
    .all(userId, userId, userId) as Array<{ id: string; frame_id: string; generation_id: string; snapshot_json: string; created_at: number; session_id: string }>
  for (const item of legacy) {
    if (db.prepare("SELECT 1 FROM image_tasks WHERE user_id = ? AND scope_id = ? AND target_type = 'frame' AND target_id = ? AND status IN ('queued','running','unknown')").get(userId, item.session_id, item.frame_id)) continue
    let fingerprint = ''
    try {
      const source = JSON.parse(item.snapshot_json)
      fingerprint = fingerprintImageInput({ prompt: source.prompt, sourceUploadIds: source.sourceUploadIds,
        sourceRoles: source.sourceRoles, locationId: source.locationId, locationRevision: source.locationRevision,
        characterRevisions: source.characterRevisions })
    } catch { continue }
    db.prepare(`INSERT OR IGNORE INTO image_tasks
      (id,user_id,scope,scope_id,target_type,target_id,revision,fingerprint,generation_id,request_key,status,created_at,updated_at)
      VALUES(?,?,'planner',?,'frame',?,NULL,?,?,NULL,'abandoned',?,?)`)
      .run(`legacy-batch-${item.id}`, userId, item.session_id, item.frame_id, fingerprint, item.generation_id, item.created_at, item.created_at)
    // Derive state next; abandoned seed avoids violating the active index before reconciliation.
    db.prepare(`UPDATE image_tasks SET status = CASE WHEN (SELECT status FROM generations WHERE id=?)='downloading' THEN 'running'
      ELSE (SELECT status FROM generations WHERE id=?) END WHERE id=?`)
      .run(item.generation_id, item.generation_id, `legacy-batch-${item.id}`)
  }
  // Release completed targets before promoting historical rows to unresolved states.
  db.prepare(`UPDATE image_tasks SET status = (SELECT status FROM generations WHERE id = generation_id)
    WHERE user_id = ? AND status <> 'abandoned' AND generation_id IN (SELECT id FROM generations WHERE status IN ('succeeded','failed'))`).run(userId)
  db.prepare(`UPDATE image_tasks AS old SET status = 'abandoned' WHERE old.user_id = ? AND old.status <> 'abandoned'
    AND old.generation_id IN (SELECT id FROM generations WHERE status = 'unknown')
    AND EXISTS (SELECT 1 FROM image_tasks newer JOIN generations g ON g.id = newer.generation_id
      WHERE newer.user_id = old.user_id AND newer.scope = old.scope AND newer.scope_id = old.scope_id
      AND newer.target_type = old.target_type AND newer.target_id = old.target_id
      AND g.status = 'succeeded' AND newer.created_at > old.created_at)`).run(userId)
  db.prepare(`UPDATE image_tasks SET status = CASE
    WHEN (SELECT status FROM generations WHERE id = generation_id) = 'downloading' THEN 'running'
    ELSE (SELECT status FROM generations WHERE id = generation_id) END,
    updated_at = ?
    WHERE user_id = ? AND generation_id IS NOT NULL AND status <> 'abandoned'
      AND EXISTS (SELECT 1 FROM generations WHERE id = generation_id AND user_id = ?)`)
    .run(Date.now(), userId, userId)
  // A newer successful replacement supersedes historical uncertainty, not its provider result.
  db.prepare(`UPDATE image_tasks AS old SET status = 'abandoned', updated_at = ?
    WHERE old.user_id = ? AND old.status = 'unknown' AND EXISTS (
      SELECT 1 FROM image_tasks newer WHERE newer.user_id = old.user_id
        AND newer.scope = old.scope AND newer.scope_id = old.scope_id
        AND newer.target_type = old.target_type AND newer.target_id = old.target_id
        AND newer.status = 'succeeded' AND newer.created_at > old.created_at)`)
    .run(Date.now(), userId)
}

function publicTask(row: ImageTaskRow): ImageTaskPublic {
  return {
    id: row.id,
    scope: row.scope,
    scopeId: row.scope_id,
    targetType: row.target_type,
    targetId: row.target_id,
    revision: row.revision,
    fingerprint: row.fingerprint,
    generationId: row.generation_id,
    requestKey: row.request_key,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    trashedAt: row.trashed_at ?? null,
    detachedAt: row.detached_at,
    attachedAt: row.attached_at,
    attachedRevision: row.attached_revision,
  }
}

function withTransaction<T>(db: Database, fn: () => T): T {
  const ownTransaction = !db.isTransaction
  if (ownTransaction) db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    if (ownTransaction) db.exec('COMMIT')
    return result
  } catch (error) {
    if (ownTransaction) db.exec('ROLLBACK')
    throw error
  }
}

/** Stable JSON encoding: object keys are sorted recursively before SHA-256 hashing. */
export function fingerprintImageInput(input: unknown): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, normalize((value as Record<string, unknown>)[key])]))
    }
    if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
    return value
  }
  return createHash('sha256').update(JSON.stringify(normalize(input))).digest('hex')
}

function getById(db: Database, userId: string, taskId: string): ImageTaskRow {
  const row = db.prepare('SELECT * FROM image_tasks WHERE id = ? AND user_id = ?').get(taskId, userId) as ImageTaskRow | undefined
  if (!row) throw notFound('Không tìm thấy tác vụ ảnh')
  return row
}

/** Reserve a target and enqueue its generation in the same SQLite write transaction. */
export function enqueueImageTask(input: EnqueueImageTaskInput): EnqueueImageTaskResult {
  const { db, userId, scope, scopeId, targetType, targetId, revision, fingerprint } = input
  return withTransaction(db, () => {
    assertOwnedScope(db, userId, scope, scopeId)
    synchronizeTasks(db, userId)
    if (input.requestKey) {
      const repeated = db.prepare(`SELECT * FROM image_tasks WHERE user_id=? AND scope=? AND scope_id=? AND request_key=?`).get(userId, scope, scopeId, input.requestKey) as ImageTaskRow | undefined
      if (repeated) {
        if (repeated.target_type !== targetType || repeated.target_id !== targetId) throw conflict('Request key belongs to a different image target')
        return { task: publicTask(repeated), reused: true }
      }
    }
    const unresolved = db.prepare(`SELECT status FROM image_tasks WHERE user_id=? AND scope=? AND scope_id=? AND target_type=? AND target_id=? AND status IN ('queued','running','unknown')`).all(userId, scope, scopeId, targetType, targetId) as Array<{ status: string }>
    if (unresolved.some(task => task.status !== 'unknown')) throw conflict('Frame đang có tác vụ ảnh chạy. Hãy kiểm tra tác vụ trước khi tạo mới.')
    if (unresolved.length && !input.confirmNew) throw conflict('Kết quả tác vụ ảnh trước chưa rõ (unknown). Hãy xác nhận trước khi tạo yêu cầu mới.')
    if (input.confirmNew) {
      db.prepare("UPDATE image_tasks SET status='abandoned', updated_at=? WHERE user_id=? AND scope=? AND scope_id=? AND target_type=? AND target_id=? AND status='unknown'").run(now(), userId, scope, scopeId, targetType, targetId)
    }

    const timestamp = now()
    const taskId = randomUUID()
    db.prepare(`INSERT INTO image_tasks
      (id,user_id,scope,scope_id,target_type,target_id,revision,fingerprint,generation_id,request_key,status,created_at,updated_at,attached_at,attached_revision)
      VALUES(?,?,?,?,?,?,?,?,NULL,?,'queued',?,?,NULL,NULL)`)
      .run(taskId, userId, scope, scopeId, targetType, targetId, revision, fingerprint, input.requestKey ?? null, timestamp, timestamp)
    const seed = db.prepare('SELECT * FROM image_tasks WHERE id=?').get(taskId) as ImageTaskRow
    const created = publicTask(seed)
    const result = input.enqueue(created)
    const generationId = typeof result === 'string' ? result : result.generationId
    const status = typeof result === 'string' ? 'queued' : result.status ?? 'queued'
    db.prepare('UPDATE image_tasks SET generation_id=?, status=?, updated_at=? WHERE id=?').run(generationId, status, now(), taskId)
    const final = db.prepare('SELECT * FROM image_tasks WHERE id=?').get(taskId) as ImageTaskRow
    return { task: publicTask(final), reused: false }
  })
}

/** Latest task for a target, scoped to its owning user. */
export function getLatestImageTask(db: Database, userId: string, scope: ImageTaskScope, scopeId: string, targetType: ImageTaskTargetType, targetId: string): ImageTaskPublic | null {
  assertOwnedScope(db, userId, scope, scopeId)
  synchronizeTasks(db, userId)
  const row = db.prepare(`SELECT t.*, g.deleted_at AS trashed_at FROM image_tasks t LEFT JOIN generations g ON g.id=t.generation_id WHERE t.user_id=? AND t.scope=? AND t.scope_id=? AND t.target_type=? AND t.target_id=? ORDER BY t.created_at DESC, t.id DESC LIMIT 1`).get(userId, scope, scopeId, targetType, targetId) as ImageTaskRow | undefined
  return row ? publicTask(row) : null
}

/** List task history within one user-owned scope; never returns other users' rows. */
export function listImageTasks(db: Database, userId: string, scope: ImageTaskScope, scopeId: string, limit = 50): ImageTaskPublic[] {
  assertOwnedScope(db, userId, scope, scopeId)
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit) || 50))
  return (db.prepare(`SELECT * FROM image_tasks WHERE user_id=? AND scope=? AND scope_id=? ORDER BY created_at DESC, id DESC LIMIT ?`).all(userId, scope, scopeId, safeLimit) as ImageTaskRow[]).map(publicTask)
}

/** Update worker-observed status without allowing terminal task state to regress. */
export function updateImageTaskStatus(db: Database, userId: string, taskId: string, status: ImageTaskStatus): ImageTaskPublic {
  return withTransaction(db, () => {
    const row = getById(db, userId, taskId)
    if (row.status === 'succeeded' || row.status === 'failed' || row.status === 'abandoned') return publicTask(row)
    db.prepare('UPDATE image_tasks SET status=?, updated_at=? WHERE id=? AND user_id=?').run(status, now(), taskId, userId)
    return publicTask(getById(db, userId, taskId))
  })
}

/**
 * Call attach only if the current target still matches the captured revision and fingerprint.
 * Attachment is idempotent: an already attached matching task returns true without rerunning it.
 */
export function acknowledgeImageTaskAttachment(
  db: Database,
  userId: string,
  taskId: string,
  currentRevision: number | string | null,
  currentFingerprint: string,
  attach: (task: ImageTaskPublic) => void,
): boolean {
  return withTransaction(db, () => {
    const row = getById(db, userId, taskId)
    if (row.attached_at !== null) return row.attached_revision === currentRevision
    if (row.revision !== currentRevision || row.fingerprint !== currentFingerprint || row.status !== 'succeeded') return false
    attach(publicTask(row))
    db.prepare('UPDATE image_tasks SET attached_at=?, attached_revision=?, updated_at=? WHERE id=? AND user_id=? AND attached_at IS NULL')
      .run(now(), currentRevision, now(), taskId, userId)
    return true
  })
}

/** Alias useful to callers that need an ownership-checked task lookup. */
export function getImageTask(db: Database, userId: string, taskId: string): ImageTaskPublic {
  return publicTask(getById(db, userId, taskId))
}

