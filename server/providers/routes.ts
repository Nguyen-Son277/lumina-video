import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import type { AppEnv } from '../env'
import type { Database } from '../db/index'
import { decodeMasterKey, decryptSecret, encryptSecret, keyHint } from '../crypto/providerKey'
import { badRequest, notFound, providerError } from '../lib/errors'
import { listProviderModels } from './client'
import { guardProviderUrl } from './urlGuard'
import { requireUser } from '../auth/middleware'

const createSchema = z.object({
  name: z.string().trim().min(1, 'Vui lòng nhập tên hiển thị').max(80),
  baseUrl: z.string().trim().min(1, 'Vui lòng nhập Base URL').max(500),
  apiKey: z.string().trim().min(1, 'Vui lòng nhập API key').max(500),
})

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  baseUrl: z.string().trim().min(1).max(500).optional(),
  // Cho phép thay key mới để xử lý key hết hạn. Không bao giờ đọc lại key cũ.
  apiKey: z.string().trim().min(1).max(500).optional(),
})

export type ProviderPublic = {
  id: string
  name: string
  baseUrl: string
  keyHint: string
  status: string
  lastError: string | null
  modelCount: number
  createdAt: number
}

function toPublic(row: {
  id: string
  name: string
  base_url: string
  key_hint: string
  status: string
  last_error: string | null
  created_at: number
  model_count: number
}): ProviderPublic {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    keyHint: row.key_hint,
    status: row.status,
    lastError: row.last_error,
    modelCount: Number(row.model_count),
    createdAt: row.created_at,
  }
}

export function providerRoutes(db: Database, env: AppEnv): Router {
  const router = Router()
  const masterKey = decodeMasterKey(env.APP_ENCRYPTION_KEY)

  /**
   * Tham số kiểm tra URL. Ở chế độ mock không có kết nối mạng nào được thực hiện
   * nên bỏ qua phân giải DNS; mọi kiểm tra giao thức và IP nội bộ vẫn giữ nguyên.
   */
  const guardOptions = {
    allowPrivate: env.ALLOW_PRIVATE_PROVIDER_URLS,
    skipDnsCheck: env.PROVIDER_MODE === 'mock',
  }

  function listForUser(userId: string): ProviderPublic[] {
    const rows = db
      .prepare(
        `SELECT p.id, p.name, p.base_url, p.key_hint, p.status, p.last_error, p.created_at,
                (SELECT COUNT(*) FROM models m WHERE m.provider_id = p.id) AS model_count
         FROM provider_connections p
         WHERE p.user_id = ?
         ORDER BY p.created_at ASC`,
      )
      .all(userId) as unknown as Array<{
      id: string
      name: string
      base_url: string
      key_hint: string
      status: string
      last_error: string | null
      created_at: number
      model_count: number
    }>
    return rows.map(toPublic)
  }

  /** Lấy provider thuộc đúng người dùng; nếu không thì trả 404 để không lộ sự tồn tại. */
  function ownedProvider(userId: string, id: string) {
    const row = db
      .prepare('SELECT * FROM provider_connections WHERE id = ? AND user_id = ?')
      .get(id, userId) as
      | {
          id: string
          user_id: string
          name: string
          base_url: string
          api_key_ciphertext: Uint8Array
          api_key_iv: Uint8Array
          api_key_tag: Uint8Array
          key_hint: string
          status: string
          last_error: string | null
          created_at: number
        }
      | undefined
    if (!row) throw notFound('Không tìm thấy provider')
    return row
  }

  router.get('/', (req, res) => {
    const user = requireUser(req)
    res.json({ providers: listForUser(user.id) })
  })

  router.post('/', async (req, res) => {
    const user = requireUser(req)

    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Dữ liệu không hợp lệ')
    }

    // Kiểm tra SSRF ngay khi lưu để phát hiện sớm Base URL nguy hiểm.
    await guardProviderUrl(parsed.data.baseUrl, guardOptions)

    const id = randomUUID()
    const now = Date.now()
    const encrypted = encryptSecret(parsed.data.apiKey, masterKey)

    db.prepare(
      `INSERT INTO provider_connections
         (id, user_id, name, base_url, api_key_ciphertext, api_key_iv, api_key_tag, key_hint, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'untested', ?, ?)`,
    ).run(
      id,
      user.id,
      parsed.data.name,
      parsed.data.baseUrl,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.tag,
      keyHint(parsed.data.apiKey),
      now,
      now,
    )

    const created = listForUser(user.id).find((item) => item.id === id)!
    res.status(201).json({ provider: created })
  })

  router.patch('/:id', async (req, res) => {
    const user = requireUser(req)
    const existing = ownedProvider(user.id, req.params.id)

    const parsed = updateSchema.safeParse(req.body)
    if (!parsed.success) throw badRequest('Dữ liệu không hợp lệ')

    const updates: string[] = []
    const values: Array<string | number | Uint8Array> = []

    if (parsed.data.name !== undefined) {
      updates.push('name = ?')
      values.push(parsed.data.name)
    }

    if (parsed.data.baseUrl !== undefined) {
      await guardProviderUrl(parsed.data.baseUrl, guardOptions)
      updates.push('base_url = ?')
      values.push(parsed.data.baseUrl)
      // Đổi đích thì trạng thái kiểm tra cũ không còn giá trị.
      updates.push("status = 'untested'")
    }

    if (parsed.data.apiKey !== undefined) {
      const encrypted = encryptSecret(parsed.data.apiKey, masterKey)
      updates.push('api_key_ciphertext = ?', 'api_key_iv = ?', 'api_key_tag = ?', 'key_hint = ?')
      values.push(encrypted.ciphertext, encrypted.iv, encrypted.tag, keyHint(parsed.data.apiKey))
      updates.push("status = 'untested'")
    }

    if (updates.length === 0) throw badRequest('Không có thay đổi nào để lưu')

    updates.push('updated_at = ?')
    values.push(Date.now())

    db.prepare(`UPDATE provider_connections SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).run(
      ...values,
      existing.id,
      user.id,
    )

    const updated = listForUser(user.id).find((item) => item.id === existing.id)!
    res.json({ provider: updated })
  })

  router.delete('/:id', (req, res) => {
    const user = requireUser(req)
    const existing = ownedProvider(user.id, req.params.id)

    // Không cho xóa khi còn tác vụ đang chạy để tránh bỏ dở job đã gửi provider.
    const active = db
      .prepare(
        "SELECT COUNT(*) AS total FROM generations WHERE provider_id = ? AND status IN ('queued','running','downloading')",
      )
      .get(existing.id) as { total: number }

    if (Number(active.total) > 0) {
      throw badRequest(
        'Provider này còn tác vụ đang chạy. Hãy đợi hoàn tất hoặc xóa tác vụ trước.',
      )
    }

    db.prepare('DELETE FROM provider_connections WHERE id = ? AND user_id = ?').run(
      existing.id,
      user.id,
    )
    res.status(204).end()
  })

  /** Kiểm tra kết nối bằng GET /models — không tạo nội dung nên không tốn phí. */
  router.post('/:id/test', async (req, res) => {
    const user = requireUser(req)
    const existing = ownedProvider(user.id, req.params.id)

    const apiKey = decryptOwnedKey(existing, masterKey)

    try {
      const models = await listProviderModels(
        {
          baseUrl: existing.base_url,
          apiKey,
          allowPrivate: env.ALLOW_PRIVATE_PROVIDER_URLS,
        },
        env.PROVIDER_MODE,
      )

      db.prepare(
        "UPDATE provider_connections SET status = 'connected', last_error = NULL, updated_at = ? WHERE id = ?",
      ).run(Date.now(), existing.id)

      res.json({ ok: true, modelCount: models.length })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Không kết nối được provider'
      db.prepare(
        "UPDATE provider_connections SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?",
      ).run(message.slice(0, 500), Date.now(), existing.id)

      throw providerError(message)
    }
  })

  /** Đồng bộ model: chỉ thêm model mới ở dạng chưa phân loại, không ghi đè phân loại đã có. */
  router.post('/:id/sync-models', async (req, res) => {
    const user = requireUser(req)
    const existing = ownedProvider(user.id, req.params.id)

    const apiKey = decryptOwnedKey(existing, masterKey)

    const remote = await listProviderModels(
      {
        baseUrl: existing.base_url,
        apiKey,
        allowPrivate: env.ALLOW_PRIVATE_PROVIDER_URLS,
      },
      env.PROVIDER_MODE,
    )

    const now = Date.now()
    let added = 0
    let skipped = 0

    const insert = db.prepare(
      `INSERT INTO models (id, user_id, provider_id, model_id, display_name, kind, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'unclassified', 1, ?, ?)
       ON CONFLICT (provider_id, model_id) DO NOTHING`,
    )

    for (const model of remote) {
      const result = insert.run(
        randomUUID(),
        user.id,
        existing.id,
        model.id,
        model.displayName,
        now,
        now,
      )
      if (Number(result.changes ?? 0) > 0) added += 1
      else skipped += 1
    }

    db.prepare(
      "UPDATE provider_connections SET status = 'connected', last_error = NULL, updated_at = ? WHERE id = ?",
    ).run(now, existing.id)

    res.json({ added, skipped, total: remote.length })
  })

  return router
}

function decryptOwnedKey(
  row: { api_key_ciphertext: Uint8Array; api_key_iv: Uint8Array; api_key_tag: Uint8Array },
  masterKey: Buffer,
): string {
  return decryptSecret(
    {
      ciphertext: Buffer.from(row.api_key_ciphertext),
      iv: Buffer.from(row.api_key_iv),
      tag: Buffer.from(row.api_key_tag),
    },
    masterKey,
  )
}
