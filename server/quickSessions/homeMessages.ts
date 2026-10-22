import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import type { Database } from '../db/index'
import { requireUser } from '../auth/middleware'
import { validationError } from '../lib/errors'

const messageSchema = z.object({ content: z.string().trim().min(1).max(8000) }).strict()

type MessageRow = { id: string; content: string; created_at: number }
const publicMessage = (row: MessageRow) => ({ id: row.id, content: row.content, createdAt: row.created_at })

/** Tin nhắn Quick home thuộc tài khoản, không tạo phiên hoặc gọi AI ngầm. */
export function quickHomeMessageRoutes(db: Database): Router {
  const router = Router()

  router.get('/messages', (req, res) => {
    const user = requireUser(req)
    const rows = db.prepare(`SELECT id, content, created_at FROM quick_home_messages
      WHERE user_id = ? ORDER BY created_at ASC, rowid ASC`)
      .all(user.id) as unknown as MessageRow[]
    res.json({ messages: rows.map(publicMessage) })
  })

  router.post('/messages', (req, res) => {
    const user = requireUser(req)
    const parsed = messageSchema.safeParse(req.body)
    if (!parsed.success) throw validationError(parsed.error)

    const id = randomUUID()
    const createdAt = Date.now()
    db.prepare('INSERT INTO quick_home_messages (id, user_id, content, created_at) VALUES (?, ?, ?, ?)')
      .run(id, user.id, parsed.data.content, createdAt)
    res.status(201).json({ message: { id, content: parsed.data.content, createdAt } })
  })

  return router
}
