import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import type { Database } from '../db/index'
import { badRequest, conflict, notFound, validationError } from '../lib/errors'
import { requireUser } from '../auth/middleware'

/**
 * Phân loại model theo khả năng thật của provider.
 *
 * `llm` là model văn bản dùng cho Trợ lý AI và tạo nhân vật bằng AI; nó dùng
 * chung Base URL + API key của provider, không có bảng key riêng.
 */
const MODEL_KINDS = ['image', 'video', 'llm', 'unclassified'] as const

const createSchema = z.object({
  providerId: z.string().min(1, 'Vui lòng chọn provider'),
  modelId: z.string().trim().min(1, 'Vui lòng nhập model ID').max(200),
  displayName: z.string().trim().max(200).optional(),
  kind: z.enum(MODEL_KINDS).default('unclassified'),
})

const updateSchema = z.object({
  displayName: z.string().trim().min(1).max(200).optional(),
  kind: z.enum(MODEL_KINDS).optional(),
  enabled: z.boolean().optional(),
  /**
   * Đơn giá để ước tính chi phí. Provider không trả giá trong API nên người dùng
   * tự nhập; `null` = xoá đơn giá.
   */
  priceUnit: z.number().nonnegative().max(1_000_000).nullable().optional(),
  priceInput1k: z.number().nonnegative().max(1_000_000).nullable().optional(),
  priceOutput1k: z.number().nonnegative().max(1_000_000).nullable().optional(),
  priceCurrency: z.string().trim().min(1).max(10).optional(),
})

export type ModelPublic = {
  id: string
  providerId: string
  providerName: string
  modelId: string
  displayName: string
  kind: (typeof MODEL_KINDS)[number]
  enabled: boolean
  createdAt: number
  /** Đơn giá do người dùng nhập để ước tính chi phí (null = chưa đặt). */
  priceUnit: number | null
  priceInput1k: number | null
  priceOutput1k: number | null
  priceCurrency: string
}

export function modelRoutes(db: Database): Router {
  const router = Router()

  function listForUser(userId: string, kind?: string): ModelPublic[] {
    const params: Array<string> = [userId]
    let sql = `
      SELECT m.id, m.provider_id AS providerId, p.name AS providerName, m.model_id AS modelId,
             m.display_name AS displayName, m.kind, m.enabled, m.created_at AS createdAt,
             m.price_unit AS priceUnit, m.price_input_1k AS priceInput1k,
             m.price_output_1k AS priceOutput1k,
             COALESCE(m.price_currency, 'USD') AS priceCurrency
      FROM models m
      JOIN provider_connections p ON p.id = m.provider_id
      WHERE m.user_id = ?`
    if (kind) {
      sql += ' AND m.kind = ?'
      params.push(kind)
    }
    sql += ' ORDER BY m.created_at ASC'

    const rows = db.prepare(sql).all(...params) as unknown as Array<{
      id: string
      providerId: string
      providerName: string
      modelId: string
      displayName: string
      kind: ModelPublic['kind']
      enabled: number
      createdAt: number
      priceUnit: number | null
      priceInput1k: number | null
      priceOutput1k: number | null
      priceCurrency: string
    }>

    return rows.map((row) => ({ ...row, enabled: row.enabled === 1 }))
  }

  function ownedModel(userId: string, id: string) {
    const row = db
      .prepare('SELECT id, provider_id AS providerId FROM models WHERE id = ? AND user_id = ?')
      .get(id, userId) as { id: string; providerId: string } | undefined
    if (!row) throw notFound('Không tìm thấy model')
    return row
  }

  router.get('/', (req, res) => {
    const user = requireUser(req)
    const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined
    if (kind && !MODEL_KINDS.includes(kind as (typeof MODEL_KINDS)[number])) {
      throw badRequest('Loại model không hợp lệ')
    }
    res.json({ models: listForUser(user.id, kind) })
  })

  router.post('/', (req, res) => {
    const user = requireUser(req)

    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) {
      throw validationError(parsed.error)
    }

    // Provider phải thuộc đúng người dùng.
    const provider = db
      .prepare('SELECT id FROM provider_connections WHERE id = ? AND user_id = ?')
      .get(parsed.data.providerId, user.id)
    if (!provider) throw badRequest('Provider không tồn tại hoặc không thuộc tài khoản của bạn')

    const duplicate = db
      .prepare('SELECT id FROM models WHERE provider_id = ? AND model_id = ?')
      .get(parsed.data.providerId, parsed.data.modelId)
    if (duplicate) throw conflict('Model ID này đã tồn tại trong provider đã chọn')

    const id = randomUUID()
    const now = Date.now()

    db.prepare(
      `INSERT INTO models (id, user_id, provider_id, model_id, display_name, kind, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      id,
      user.id,
      parsed.data.providerId,
      parsed.data.modelId,
      parsed.data.displayName?.trim() || parsed.data.modelId,
      parsed.data.kind,
      now,
      now,
    )

    const created = listForUser(user.id).find((item) => item.id === id)!
    res.status(201).json({ model: created })
  })

  router.patch('/:id', (req, res) => {
    const user = requireUser(req)
    const existing = ownedModel(user.id, req.params.id)

    const parsed = updateSchema.safeParse(req.body)
    if (!parsed.success) throw badRequest('Dữ liệu không hợp lệ')

    const updates: string[] = []
    const values: Array<string | number> = []

    if (parsed.data.displayName !== undefined) {
      updates.push('display_name = ?')
      values.push(parsed.data.displayName)
    }
    if (parsed.data.kind !== undefined) {
      updates.push('kind = ?')
      values.push(parsed.data.kind)
    }
    if (parsed.data.enabled !== undefined) {
      updates.push('enabled = ?')
      values.push(parsed.data.enabled ? 1 : 0)
    }
    for (const [field, column] of [
      ['priceUnit', 'price_unit'],
      ['priceInput1k', 'price_input_1k'],
      ['priceOutput1k', 'price_output_1k'],
      ['priceCurrency', 'price_currency'],
    ] as const) {
      const value = parsed.data[field]
      if (value !== undefined) {
        updates.push(`${column} = ?`)
        values.push(value as string | number)
      }
    }

    if (updates.length === 0) throw badRequest('Không có thay đổi nào để lưu')

    updates.push('updated_at = ?')
    values.push(Date.now())

    db.prepare(`UPDATE models SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).run(
      ...values,
      existing.id,
      user.id,
    )

    const updated = listForUser(user.id).find((item) => item.id === existing.id)!
    res.json({ model: updated })
  })

  router.delete('/:id', (req, res) => {
    const user = requireUser(req)
    const existing = ownedModel(user.id, req.params.id)

    const active = db
      .prepare(
        "SELECT COUNT(*) AS total FROM generations WHERE model_pk = ? AND status IN ('queued','running','downloading')",
      )
      .get(existing.id) as { total: number }

    if (Number(active.total) > 0) {
      throw badRequest('Model này còn tác vụ đang chạy. Hãy đợi hoàn tất trước khi xóa.')
    }

    db.prepare('DELETE FROM models WHERE id = ? AND user_id = ?').run(existing.id, user.id)
    res.status(204).end()
  })

  return router
}
