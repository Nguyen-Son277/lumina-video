import { randomUUID } from 'node:crypto'
import { badRequest, notFound } from '../lib/errors'
import type { Database } from '../db/index'
import { ownedCharacterById, transaction } from '../projects/service'
import { validatePromptDocument, type PromptDocument } from '../../shared/promptMentions'

/**
 * Trần số nhân vật của một phiên tạo nội dung.
 *
 * Con số này chỉ chặn danh sách lưu ở phiên; số ẢNH tham chiếu thực sự gửi cho
 * model vẫn bị giới hạn bởi `MAX_SOURCE_IMAGES` như trước.
 */
export const MAX_SESSION_CHARACTERS = 6

export type QuickSessionRow = {
  id: string
  user_id: string
  title: string
  prompt_document_json: string | null
  created_at: number
  updated_at: number
}

export type QuickSessionPublic = {
  id: string
  title: string
  /** Exact text and ID-bound mentions; null for sessions created before documents. */
  promptDocument: PromptDocument | null
  /** Nhân vật dùng chung cho cả phiên, theo đúng thứ tự người dùng chọn. */
  characterIds: string[]
  generationCount: number
  activeCount: number
  /** Media đầu ra mới nhất của một tác vụ thành công trong phiên. */
  coverAssetId: string | null
  coverMimeType: string | null
  createdAt: number
  updatedAt: number
}

/** Drafts may contain unbound/deleted references: only structure is checked here. */
export function validateQuickPromptDocument(value: unknown): asserts value is PromptDocument {
  const issues = validatePromptDocument(value)
  if (issues.length) throw badRequest('Tài liệu mô tả không hợp lệ', { issues })
  if ((value as PromptDocument).text.length > 8000) throw badRequest('Mô tả vượt giới hạn 8000 ký tự')
}

/** Phiên thuộc đúng người dùng; ném 404 khi không thấy (không lộ dữ liệu người khác). */
export function ownedQuickSession(db: Database, userId: string, id: string): QuickSessionRow {
  const row = db
    .prepare('SELECT * FROM quick_sessions WHERE id = ? AND user_id = ?')
    .get(id, userId) as unknown as QuickSessionRow | undefined
  if (!row) throw notFound('Không tìm thấy phiên tạo nội dung')
  return row
}

export function sessionCharacterIds(db: Database, sessionId: string): string[] {
  const rows = db
    .prepare(
      'SELECT q.character_id AS id FROM quick_session_characters q JOIN characters c ON c.id = q.character_id WHERE q.session_id = ? AND c.deleted_at IS NULL ORDER BY q.position ASC, q.character_id ASC',
    )
    .all(sessionId) as unknown as Array<{ id: string }>
  return rows.map((row) => row.id)
}

/**
 * Thay TOÀN BỘ dàn nhân vật của phiên.
 *
 * Mọi id đều phải thuộc tài khoản (nhân vật dự án hoặc thư viện đều hợp lệ, giống
 * lối vào tạo nội dung hiện có), và thứ tự trong mảng là thứ tự gửi cho model:
 * nhân vật đầu tiên là nhân vật chính.
 */
export function replaceSessionCharacters(
  db: Database,
  userId: string,
  sessionId: string,
  characterIds: readonly string[],
): void {
  const unique = [...new Set(characterIds)]
  if (unique.length !== characterIds.length) throw badRequest('Danh sách nhân vật bị trùng')
  if (unique.length > MAX_SESSION_CHARACTERS) {
    throw badRequest(`Mỗi phiên tối đa ${MAX_SESSION_CHARACTERS} nhân vật`)
  }
  for (const id of unique) ownedCharacterById(db, userId, id)

  const insert = db.prepare(
    'INSERT INTO quick_session_characters (session_id, character_id, position) VALUES (?, ?, ?)',
  )
  transaction(db, () => {
    db.prepare('DELETE FROM quick_session_characters WHERE session_id = ?').run(sessionId)
    unique.forEach((id, position) => insert.run(sessionId, id, position))
  })
}

/** Dựng payload công khai cho một hàng phiên; đếm và ảnh bìa tính bằng SQL. */
export function quickSessionPublic(db: Database, row: QuickSessionRow): QuickSessionPublic {
  const counts = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status IN ('queued','running','downloading') THEN 1 ELSE 0 END) AS active
         FROM generations WHERE quick_session_id = ? AND user_id = ? AND deleted_at IS NULL`,
    )
    .get(row.id, row.user_id) as { total: number; active: number | null }

  const cover = db
    .prepare(
      `SELECT a.id AS id, a.mime_type AS mime_type
         FROM generations g
         JOIN assets a ON a.generation_id = g.id
        WHERE g.quick_session_id = ? AND g.user_id = ? AND g.status = 'succeeded' AND g.deleted_at IS NULL
        ORDER BY g.created_at DESC, a.created_at ASC
        LIMIT 1`,
    )
    .get(row.id, row.user_id) as { id: string; mime_type: string } | undefined

  return {
    id: row.id,
    title: row.title,
    promptDocument: row.prompt_document_json ? JSON.parse(row.prompt_document_json) as PromptDocument : null,
    characterIds: sessionCharacterIds(db, row.id),
    generationCount: Number(counts.total),
    activeCount: Number(counts.active ?? 0),
    coverAssetId: cover?.id ?? null,
    coverMimeType: cover?.mime_type ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Tạo phiên mới; `characterIds` được kiểm tra quyền sở hữu như khi cập nhật. */
export function createQuickSession(
  db: Database,
  userId: string,
  input: { title?: string; characterIds?: readonly string[]; promptDocument?: PromptDocument },
): QuickSessionRow {
  if (input.promptDocument !== undefined) validateQuickPromptDocument(input.promptDocument)
  const id = randomUUID()
  const now = Date.now()
  transaction(db, () => {
    db.prepare(
      'INSERT INTO quick_sessions (id, user_id, title, prompt_document_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, userId, input.title?.trim() ?? '', input.promptDocument === undefined ? null : JSON.stringify(input.promptDocument), now, now)
    if (input.characterIds?.length) {
      const ids = input.characterIds
      if (new Set(ids).size !== ids.length) throw badRequest('Danh sách nhân vật bị trùng')
      if (ids.length > MAX_SESSION_CHARACTERS) throw badRequest(`Mỗi phiên tối đa ${MAX_SESSION_CHARACTERS} nhân vật`)
      ids.forEach(characterId => ownedCharacterById(db, userId, characterId))
      const insert = db.prepare('INSERT INTO quick_session_characters (session_id, character_id, position) VALUES (?, ?, ?)')
      ids.forEach((characterId, position) => insert.run(id, characterId, position))
    }
  })
  return ownedQuickSession(db, userId, id)
}

/** Danh sách phiên của người dùng, mới cập nhật nhất đứng đầu. */
export function listQuickSessions(db: Database, userId: string, limit = 50): QuickSessionPublic[] {
  const rows = db
    .prepare(
      'SELECT * FROM quick_sessions WHERE user_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT ?',
    )
    .all(userId, limit) as unknown as QuickSessionRow[]
  return rows.map((row) => quickSessionPublic(db, row))
}
