import { Router } from 'express'
import { z } from 'zod'
import type { Database } from '../db/index'
import { badRequest, validationError } from '../lib/errors'
import { requireUser } from '../auth/middleware'
import {
  MAX_SESSION_CHARACTERS,
  createQuickSession,
  listQuickSessions,
  ownedQuickSession,
  quickSessionPublic,
  replaceSessionCharacters,
  validateQuickPromptDocument,
} from './service'

import type { PromptDocument } from '../../shared/promptMentions'

const characterIdsSchema = z.array(z.string().min(1)).max(MAX_SESSION_CHARACTERS).optional()
// Preserve the exact input, including UTF-16 offsets and whitespace. Drafts do
// not resolve entities by label or require them to still exist.
const promptDocumentSchema = z.custom<PromptDocument>(value => {
  validateQuickPromptDocument(value)
  return true
}).optional()

const createSchema = z.object({
  title: z.string().trim().max(120).optional(),
  characterIds: characterIdsSchema,
  promptDocument: promptDocumentSchema,
})

const updateSchema = z.object({
  title: z.string().trim().max(120).optional(),
  characterIds: characterIdsSchema,
  promptDocument: promptDocumentSchema,
})

/**
 * Phiên "Tạo nội dung đơn lẻ".
 *
 * Một phiên gom nhiều tác vụ tạo nội dung và giữ danh sách nhân vật dùng chung,
 * nên mở lại phiên vẫn tạo tiếp được đúng bộ nhận diện. Xoá phiên không xoá kết
 * quả: các tác vụ chỉ mất liên kết phiên và vẫn nằm trong Thư viện.
 */
export function quickSessionRoutes(db: Database): Router {
  const router = Router()

  router.get('/', (req, res) => {
    const user = requireUser(req)
    res.json({ sessions: listQuickSessions(db, user.id) })
  })

  router.post('/', (req, res) => {
    const user = requireUser(req)
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) throw validationError(parsed.error)

    const row = createQuickSession(db, user.id, parsed.data)
    res.status(201).json({ session: quickSessionPublic(db, row) })
  })

  router.get('/:id', (req, res) => {
    const user = requireUser(req)
    const row = ownedQuickSession(db, user.id, req.params.id)
    res.json({ session: quickSessionPublic(db, row) })
  })

  router.patch('/:id', (req, res) => {
    const user = requireUser(req)
    const existing = ownedQuickSession(db, user.id, req.params.id)

    const parsed = updateSchema.safeParse(req.body)
    if (!parsed.success) throw validationError(parsed.error)
    const { title, characterIds, promptDocument } = parsed.data
    if (title === undefined && characterIds === undefined && promptDocument === undefined) {
      throw badRequest('Không có thay đổi nào để lưu')
    }

    if (characterIds !== undefined) {
      replaceSessionCharacters(db, user.id, existing.id, characterIds)
    }
    if (promptDocument !== undefined) {
      db.prepare('UPDATE quick_sessions SET prompt_document_json = ? WHERE id = ? AND user_id = ?').run(
        JSON.stringify(promptDocument), existing.id, user.id,
      )
    }
    if (title !== undefined) {
      db.prepare('UPDATE quick_sessions SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(
        title,
        Date.now(),
        existing.id,
        user.id,
      )
    } else {
      db.prepare('UPDATE quick_sessions SET updated_at = ? WHERE id = ? AND user_id = ?').run(
        Date.now(),
        existing.id,
        user.id,
      )
    }

    res.json({ session: quickSessionPublic(db, ownedQuickSession(db, user.id, existing.id)) })
  })

  router.delete('/:id', (req, res) => {
    const user = requireUser(req)
    const existing = ownedQuickSession(db, user.id, req.params.id)
    // Kết quả giữ nguyên trong Thư viện: khoá ngoại ON DELETE SET NULL tự gỡ liên kết.
    db.prepare('DELETE FROM quick_sessions WHERE id = ? AND user_id = ?').run(existing.id, user.id)
    res.status(204).end()
  })

  return router
}
