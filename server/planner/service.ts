import { randomUUID } from 'node:crypto'
import type { Database } from '../db/index'
import { badRequest, notFound } from '../lib/errors'
import type { LibraryCharacter, PlannerContext, VideoModel } from './prompts'

export type PlanKind = 'planner' | 'copilot'
export type PlanStatus =
  | 'chatting'
  | 'ideas_ready'
  | 'ideas_approved'
  | 'plan_ready'
  | 'applied'

export type PlanSessionRow = {
  id: string
  user_id: string
  kind: PlanKind
  llm_connection_id: string | null
  project_id: string | null
  title: string
  status: PlanStatus
  ideas_json: string | null
  plan_json: string | null
  created_at: number
  updated_at: number
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
  llmConnectionId: string | null
  projectId: string | null
  title: string
  status: PlanStatus
  ideas: unknown
  plan: unknown
  messageCount: number
  createdAt: number
  updatedAt: number
}

export function sessionPublic(row: PlanSessionRow, messageCount: number): PlanSessionPublic {
  return {
    id: row.id,
    kind: row.kind,
    llmConnectionId: row.llm_connection_id,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    ideas: row.ideas_json ? (JSON.parse(row.ideas_json) as unknown) : null,
    plan: row.plan_json ? (JSON.parse(row.plan_json) as unknown) : null,
    messageCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function messagePublic(row: PlanMessageRow) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  }
}

/** Phiên chat phải thuộc đúng người dùng; nếu không thì 404 để không lộ tồn tại. */
export function ownedSession(db: Database, userId: string, id: string): PlanSessionRow {
  const row = db
    .prepare('SELECT * FROM plan_sessions WHERE id = ? AND user_id = ?')
    .get(id, userId) as PlanSessionRow | undefined
  if (!row) throw notFound('Không tìm thấy phiên trò chuyện')
  return row
}

export function listSessions(
  db: Database,
  userId: string,
  projectId?: string,
): Array<{ session: PlanSessionRow; messageCount: number }> {
  const params: string[] = [userId]
  let sql = 'SELECT * FROM plan_sessions WHERE user_id = ?'
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

export function listMessages(db: Database, sessionId: string): PlanMessageRow[] {
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
  const row: PlanMessageRow = {
    id: randomUUID(),
    session_id: sessionId,
    role,
    content,
    created_at: Date.now(),
  }
  db.prepare(
    'INSERT INTO plan_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(row.id, row.session_id, row.role, row.content, row.created_at)
  return row
}

export function touchSession(db: Database, sessionId: string): void {
  db.prepare('UPDATE plan_sessions SET updated_at = ? WHERE id = ?').run(Date.now(), sessionId)
}

export function messageCount(db: Database, sessionId: string): number {
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
): void {
  if (!allowed.includes(session.status)) throw badRequest(message)
}

export function setStatus(
  db: Database,
  sessionId: string,
  status: PlanStatus,
  patch: { ideasJson?: string | null; planJson?: string | null; title?: string } = {},
): PlanSessionRow {
  const fields = ['status = ?', 'updated_at = ?']
  const values: Array<string | number | null> = [status, Date.now()]

  if (patch.ideasJson !== undefined) {
    fields.push('ideas_json = ?')
    values.push(patch.ideasJson)
  }
  if (patch.planJson !== undefined) {
    fields.push('plan_json = ?')
    values.push(patch.planJson)
  }
  if (patch.title !== undefined) {
    fields.push('title = ?')
    values.push(patch.title)
  }

  db.prepare(`UPDATE plan_sessions SET ${fields.join(', ')} WHERE id = ?`).run(...values, sessionId)
  return db.prepare('SELECT * FROM plan_sessions WHERE id = ?').get(sessionId) as unknown as PlanSessionRow
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
  const libraryCharacters = db
    .prepare(
      `SELECT id, name, appearance FROM characters
        WHERE user_id = ? AND project_id IS NULL
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
        'SELECT name, description, style, language FROM projects WHERE id = ? AND user_id = ?',
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
