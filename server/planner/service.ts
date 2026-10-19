import { randomUUID } from 'node:crypto'
import { withTimelineSync } from '../canvas/timelineSync'
import { plannerChatText, PLANNER_CHAT_FALLBACK } from '../../shared/plannerChat'
import type { Database } from '../db/index'
import { badRequest, errorMeta, notFound, type ErrorMeta } from '../lib/errors'
import type { LibraryCharacter, PlannerContext, VideoModel } from './prompts'
import {
  legacyCast,
  legacyScript,
  legacyTimeline,
  parseLocations,
  type LocationReference,
  parseCast,
  parseScript,
  parseTimeline,
  type CastMember,
  type ScriptDraft,
  type Timeline,
} from './artifacts'

export type PlanKind = 'planner' | 'copilot'
/**
 * Vòng đời của một phiên Tạo kịch bản AI.
 *
 * `setup` = chưa chọn đủ model; `scripting` = đang trao đổi/kịch bản nháp;
 * `script_ready` = có kịch bản nháp; `cast_ready` = có ý tưởng nhân vật;
 * `timeline_ready` = có timeline; `applied` = đã chốt thành dự án Studio.
 */
export type PlanStatus =
  | 'setup'
  | 'scripting'
  | 'script_ready'
  | 'cast_ready'
  | 'timeline_ready'
  | 'applied'

export type PlanSessionRow = {
  id: string
  user_id: string
  kind: PlanKind
  chat_model_id: string | null
  image_model_id: string | null
  video_model_id: string | null
  project_id: string | null
  canvas_linked?: number
  title: string
  status: PlanStatus
  script_json: string | null
  cast_json: string | null
  locations_json?: string | null
  timeline_json: string | null
  /** Cột legacy (trước migration 012): chỉ đọc để suy ra artifact. */
  ideas_json: string | null
  plan_json: string | null
  created_at: number
  updated_at: number
  deleted_at?: number | null
  purge_after?: number | null
}

export type PlanMessageRow = {
  id: string
  session_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: number
}

export type PlanSessionPublic = {
  id: string
  kind: PlanKind
  chatModelId: string | null
  imageModelId: string | null
  videoModelId: string | null
  projectId: string | null
  canvasLinked?: boolean
  title: string
  status: PlanStatus
  /** Kịch bản nháp của tab Chat. */
  script: ScriptDraft | null
  /** Ý tưởng nhân vật của tab Nhân vật. */
  cast: CastMember[]
  /** Timeline của tab Timeline. */
  locations: LocationReference[]
  timeline: Timeline | null
  messageCount: number
  createdAt: number
  updatedAt: number
}

export function sessionPublic(row: PlanSessionRow, messageCount: number): PlanSessionPublic {
  return {
    id: row.id,
    kind: row.kind,
    chatModelId: row.chat_model_id,
    imageModelId: row.image_model_id,
    videoModelId: row.video_model_id,
    projectId: row.project_id,
    canvasLinked: Boolean(row.canvas_linked),
    title: row.title,
    status: row.status,
    // Phiên tạo trước migration 012 chỉ có plan_json/ideas_json: suy ra tại chỗ.
    script: parseScript(row.script_json) ?? legacyScript(row),
    cast: parseCast(row.cast_json).length ? parseCast(row.cast_json) : legacyCast(row),
    locations: parseLocations(row.locations_json),
    timeline: parseTimeline(row.timeline_json) ?? legacyTimeline(row),
    messageCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function messagePublic(row: PlanMessageRow) {
  return {
    id: row.id,
    role: row.role,
    content: row.role === 'assistant' ? plannerChatText(row.content, PLANNER_CHAT_FALLBACK) : row.content,
    createdAt: row.created_at,
  }
}

/** Phiên chat phải thuộc đúng người dùng; nếu không thì 404 để không lộ tồn tại. */
export function ownedSession(db: Database, userId: string, id: string): PlanSessionRow {
  const row = db
    .prepare('SELECT *, EXISTS(SELECT 1 FROM timeline_canvas_sessions c WHERE c.session_id = plan_sessions.id) AS canvas_linked FROM plan_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(id, userId) as PlanSessionRow | undefined
  if (!row) throw notFound('Không tìm thấy phiên trò chuyện', errorMeta('planner.session_not_found'))
  return row
}

export function listSessions(
  db: Database,
  userId: string,
  projectId?: string,
): Array<{ session: PlanSessionRow; messageCount: number }> {
  const params: string[] = [userId]
  let sql = 'SELECT *, EXISTS(SELECT 1 FROM timeline_canvas_sessions c WHERE c.session_id = plan_sessions.id) AS canvas_linked FROM plan_sessions WHERE user_id = ? AND deleted_at IS NULL'
  if (projectId !== undefined) {
    sql += ' AND project_id = ?'
    params.push(projectId)
  }
  sql += ' ORDER BY updated_at DESC, created_at DESC'
  const rows = db.prepare(sql).all(...params) as unknown as PlanSessionRow[]

  return rows.map((session) => ({
    session,
    messageCount: messageCount(db, session.id),
  }))
}

/** Re-read after AI awaits; stale session snapshots must never write into the trash. */
function activeSession(db: Database, sessionId: string): PlanSessionRow {
  const row = db.prepare('SELECT *, EXISTS(SELECT 1 FROM timeline_canvas_sessions c WHERE c.session_id = plan_sessions.id) AS canvas_linked FROM plan_sessions WHERE id = ? AND deleted_at IS NULL').get(sessionId) as PlanSessionRow | undefined
  if (!row) throw notFound('Không tìm thấy phiên trò chuyện', errorMeta('planner.session_not_found'))
  return row
}

export function listMessages(db: Database, sessionId: string): PlanMessageRow[] {
  activeSession(db, sessionId)
  // Sắp theo rowid (thứ tự chèn) chứ không theo created_at: tin nhắn của người
  // dùng và câu trả lời của model thường cùng một mili-giây, nên created_at làm
  // khoá sắp xếp sẽ cho thứ tự ngẫu nhiên.
  return db
    .prepare('SELECT * FROM plan_messages WHERE session_id = ? ORDER BY rowid ASC')
    .all(sessionId) as unknown as PlanMessageRow[]
}

/** Lịch sử hội thoại để gửi cho model: lấy N lượt gần nhất rồi đảo lại đúng thứ tự. */
export function historyFor(
  db: Database,
  sessionId: string,
  limit = 20,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  activeSession(db, sessionId)
  const rows = db
    .prepare(
      `SELECT role, content FROM plan_messages
        WHERE session_id = ? ORDER BY rowid DESC LIMIT ?`,
    )
    .all(sessionId, limit) as unknown as Array<{ role: 'user' | 'assistant'; content: string }>
  return rows.reverse()
}

export function appendMessage(
  db: Database,
  sessionId: string,
  role: 'user' | 'assistant',
  content: string,
): PlanMessageRow {
  activeSession(db, sessionId)
  const row: PlanMessageRow = {
    id: randomUUID(),
    session_id: sessionId,
    role,
    content,
    created_at: Date.now(),
  }
  const inserted = db.prepare(
    `INSERT INTO plan_messages (id, session_id, role, content, created_at)
      SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM plan_sessions WHERE id = ? AND deleted_at IS NULL)`,
  ).run(row.id, row.session_id, row.role, row.content, row.created_at, sessionId)
  if (!Number(inserted.changes)) throw notFound('Không tìm thấy phiên trò chuyện', errorMeta('planner.session_not_found'))
  return row
}

export function touchSession(db: Database, sessionId: string): void {
  activeSession(db, sessionId)
  const updated = db.prepare('UPDATE plan_sessions SET updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(Date.now(), sessionId)
  if (!Number(updated.changes)) throw notFound('Không tìm thấy phiên trò chuyện', errorMeta('planner.session_not_found'))
}

export function messageCount(db: Database, sessionId: string): number {
  activeSession(db, sessionId)
  const row = db
    .prepare('SELECT COUNT(*) AS total FROM plan_messages WHERE session_id = ?')
    .get(sessionId) as { total: number }
  return Number(row.total)
}

/**
 * Ép đúng thứ tự trạng thái trước khi cho phép bước tiếp theo.
 *
 * Cổng duyệt nằm ở server chứ không tin trạng thái client gửi lên, nên không thể
 * sinh kịch bản khi ý kiến chưa được duyệt.
 */
export function requireStatus(
  session: PlanSessionRow,
  allowed: PlanStatus[],
  message: string,
  meta?: ErrorMeta,
): void {
  if (!allowed.includes(session.status)) throw badRequest(message, undefined, meta)
}

export function setStatus(
  db: Database,
  sessionId: string,
  status: PlanStatus,
  patch: {
    scriptJson?: string | null
    castJson?: string | null
    timelineJson?: string | null
    title?: string
    /** Sinh lại kịch bản thì bỏ liên kết dự án đã chốt trước đó. */
    clearProject?: boolean
  } = {},
): PlanSessionRow {
  activeSession(db, sessionId)
  const fields = ['status = ?', 'updated_at = ?']
  const values: Array<string | number | null> = [status, Date.now()]

  // A linked timeline keeps its synchronization destination even after AI edits.
  const linkedCanvas = patch.clearProject && db.prepare('SELECT 1 FROM timeline_canvas_sessions WHERE session_id = ?').get(sessionId)
  if (patch.clearProject && !linkedCanvas) {
    fields.push('project_id = NULL')
  }
  if (patch.scriptJson !== undefined) {
    fields.push('script_json = ?')
    values.push(patch.scriptJson)
  }
  if (patch.castJson !== undefined) {
    fields.push('cast_json = ?')
    values.push(patch.castJson)
  }
  if (patch.timelineJson !== undefined) {
    fields.push('timeline_json = ?')
    values.push(patch.timelineJson)
  }
  if (patch.title !== undefined) {
    fields.push('title = ?')
    values.push(patch.title)
  }

  return withTimelineSync(db, sessionId, () => {
    db.prepare(`UPDATE plan_sessions SET ${fields.join(', ')} WHERE id = ? AND deleted_at IS NULL`).run(...values, sessionId)
    return activeSession(db, sessionId)
  })
}

/** Ghi một trường đơn lẻ của phiên (artifact, model đã chọn, tiêu đề). */
export function updateSessionFields(
  db: Database,
  sessionId: string,
  patch: {
    chatModelId?: string | null
    imageModelId?: string | null
    videoModelId?: string | null
    title?: string
    scriptJson?: string | null
    castJson?: string | null
    timelineJson?: string | null
  },
): PlanSessionRow {
  activeSession(db, sessionId)
  const fields: string[] = []
  const values: Array<string | number | null> = []

  const columns: Array<[keyof typeof patch, string]> = [
    ['chatModelId', 'chat_model_id'],
    ['imageModelId', 'image_model_id'],
    ['videoModelId', 'video_model_id'],
    ['title', 'title'],
    ['scriptJson', 'script_json'],
    ['castJson', 'cast_json'],
    ['timelineJson', 'timeline_json'],
  ]
  for (const [key, column] of columns) {
    const value = patch[key]
    if (value === undefined) continue
    fields.push(`${column} = ?`)
    values.push(value)
  }

  if (!fields.length) {
    return activeSession(db, sessionId)
  }

  fields.push('updated_at = ?')
  values.push(Date.now())
  return withTimelineSync(db, sessionId, () => {
    db.prepare(`UPDATE plan_sessions SET ${fields.join(', ')} WHERE id = ? AND deleted_at IS NULL`).run(...values, sessionId)
    return activeSession(db, sessionId)
  })
}

/**
 * Gom bối cảnh cho model: nhân vật thư viện, model video kèm giới hạn thời lượng,
 * thông tin dự án và các cảnh đã có. Chỉ đọc dữ liệu đã lưu, không gọi mạng.
 */
export function gatherContext(
  db: Database,
  userId: string,
  session: PlanSessionRow,
): PlannerContext {
  ownedSession(db, userId, session.id)
  const libraryCharacters = db
    .prepare(
      `SELECT id, name, appearance FROM characters
        WHERE user_id = ? AND project_id IS NULL AND deleted_at IS NULL
        ORDER BY created_at ASC, id`,
    )
    .all(userId) as unknown as LibraryCharacter[]

  // Chỉ model video đang bật mới dùng được cho cảnh.
  const videoModels = db
    .prepare(
      `SELECT id, display_name AS name, min_seconds AS minSeconds, max_seconds AS maxSeconds
         FROM models
        WHERE user_id = ? AND kind = 'video' AND enabled = 1
        ORDER BY created_at ASC, id`,
    )
    .all(userId) as unknown as VideoModel[]

  let project: PlannerContext['project'] = null
  let existingSceneTitles: string[] = []
  let language = 'vi'

  if (session.project_id) {
    const row = db
      .prepare(
        'SELECT name, description, style, language FROM projects WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
      )
      .get(session.project_id, userId) as
      | { name: string; description: string; style: string; language: string }
      | undefined
    if (!row) throw notFound('Không tìm thấy dự án của phiên trò chuyện')

    project = { name: row.name, description: row.description, style: row.style }
    language = row.language || 'vi'

    existingSceneTitles = (
      db
        .prepare('SELECT title FROM scenes WHERE project_id = ? ORDER BY position, id')
        .all(session.project_id) as unknown as Array<{ title: string }>
    ).map((scene) => scene.title)
  }

  return {
    project,
    language,
    // Giới hạn số mục để prompt không phình theo thời gian sử dụng.
    libraryCharacters: libraryCharacters.slice(0, 40),
    videoModels: videoModels.slice(0, 20),
    existingSceneTitles: existingSceneTitles.slice(0, 60),
  }
}
