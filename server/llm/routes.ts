import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import type { AppEnv } from '../env'
import type { Database } from '../db/index'
import { decodeMasterKey, decryptSecret, encryptSecret, keyHint } from '../crypto/providerKey'
import { badRequest, notFound, providerError } from '../lib/errors'
import { createRateLimiter } from '../lib/rateLimit'
import { callProvider, readProviderError } from '../providers/client'
import { guardProviderUrl } from '../providers/urlGuard'
import { requireUser } from '../auth/middleware'

const createSchema = z.object({
  /** Không bắt buộc: để trống thì suy ra từ tên miền của Base URL. */
  name: z.string().trim().min(1).max(80).optional(),
  baseUrl: z.string().trim().min(1, 'Vui lòng nhập Base URL').max(500),
  modelId: z.string().trim().min(1, 'Vui lòng chọn model chat').max(200),
  apiKey: z.string().trim().min(1, 'Vui lòng nhập API key').max(500),
})

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  baseUrl: z.string().trim().min(1).max(500).optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
  /** Cho phép xoay key mà không bao giờ đọc lại key cũ. */
  apiKey: z.string().trim().min(1).max(500).optional(),
})

/** Dò danh sách model bằng credential chưa lưu (chỉ dùng cho request này). */
const discoverSchema = z.object({
  baseUrl: z.string().trim().min(1, 'Vui lòng nhập Base URL').max(500),
  apiKey: z.string().trim().min(1, 'Vui lòng nhập API key').max(500),
})

export type LlmConnectionPublic = {
  id: string
  name: string
  baseUrl: string
  modelId: string
  keyHint: string
  status: 'untested' | 'connected' | 'error'
  lastError: string | null
  createdAt: number
  updatedAt: number
}

type LlmRow = {
  id: string
  user_id: string
  name: string
  base_url: string
  model_id: string
  api_key_ciphertext: Uint8Array
  api_key_iv: Uint8Array
  api_key_tag: Uint8Array
  key_hint: string
  status: LlmConnectionPublic['status']
  last_error: string | null
  created_at: number
  updated_at: number
}

function toPublic(row: LlmRow): LlmConnectionPublic {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    modelId: row.model_id,
    keyHint: row.key_hint,
    status: row.status,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Tên hiển thị suy ra từ Base URL khi người dùng để trống. */
export function nameFromBaseUrl(baseUrl: string): string {
  try {
    const hostname = new URL(baseUrl).hostname
    return hostname || 'LLM'
  } catch {
    return 'LLM'
  }
}

/**
 * Kết nối LLM dùng cho tính năng văn bản (chat, tạo kịch bản).
 *
 * Key được mã hóa AES-256-GCM bằng cùng khóa chủ với provider ảnh/video và chỉ
 * được giải mã ở server khi gọi LLM. Endpoint ở đây mới dừng ở quản lý kết nối:
 * chưa gọi sinh văn bản, nhưng đã kiểm tra được kết nối và liệt kê model chat.
 */
export function llmRoutes(db: Database, env: AppEnv): Router {
  const router = Router()
  const masterKey = decodeMasterKey(env.APP_ENCRYPTION_KEY)

  // Ở chế độ mock không gọi mạng nên bỏ qua phân giải DNS khi kiểm tra URL.
  const guardOptions = {
    allowPrivate: env.ALLOW_PRIVATE_PROVIDER_URLS,
    skipDnsCheck: env.PROVIDER_MODE === 'mock',
  }

  function listForUser(userId: string): LlmConnectionPublic[] {
    const rows = db
      .prepare('SELECT * FROM llm_connections WHERE user_id = ? ORDER BY created_at ASC, id')
      .all(userId) as unknown as LlmRow[]
    return rows.map(toPublic)
  }

  function ownedConnection(userId: string, id: string): LlmRow {
    const row = db
      .prepare('SELECT * FROM llm_connections WHERE id = ? AND user_id = ?')
      .get(id, userId) as LlmRow | undefined
    if (!row) throw notFound('Không tìm thấy kết nối LLM')
    return row
  }

  function decryptKey(row: LlmRow): string {
    return decryptSecret(
      {
        ciphertext: Buffer.from(row.api_key_ciphertext),
        iv: Buffer.from(row.api_key_iv),
        tag: Buffer.from(row.api_key_tag),
      },
      masterKey,
    )
  }

  /**
   * Danh sách model chat của provider; ở chế độ mock trả dữ liệu giả lập.
   *
   * Danh sách được loại trùng và sắp xếp để dropdown trong giao diện ổn định
   * giữa các lần tải.
   */
  async function listChatModels(target: { baseUrl: string; apiKey: string }): Promise<string[]> {
    if (env.PROVIDER_MODE === 'mock') {
      const { mockChatModelList } = await import('../generations/adapters/mock')
      return normalizeModels(mockChatModelList().data.map((item) => item.id))
    }

    const response = await callProvider(
      {
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
        allowPrivate: env.ALLOW_PRIVATE_PROVIDER_URLS,
      },
      'models',
      { timeoutMs: 20_000 },
    )

    if (response.status === 401 || response.status === 403) {
      throw badRequest('API key không hợp lệ hoặc không có quyền truy cập')
    }
    if (response.status === 404 || response.status === 405) {
      throw badRequest(
        'Provider này không hỗ trợ endpoint /models. Hãy nhập model chat thủ công.',
      )
    }
    if (!response.ok) {
      throw providerError(`Không lấy được danh sách model: ${await readProviderError(response)}`)
    }

    const payload = (await response.json()) as { data?: unknown }
    if (!Array.isArray(payload.data)) {
      throw providerError('Provider trả về danh sách model không đúng định dạng mong đợi')
    }

    return normalizeModels(
      payload.data.map((item) => {
        if (typeof item !== 'object' || item === null) return null
        const record = item as { id?: unknown }
        return typeof record.id === 'string' && record.id ? record.id : null
      }),
    )
  }

  /** Loại trùng, sắp xếp và giới hạn số model trả về cho giao diện. */
  function normalizeModels(ids: Array<string | null>): string[] {
    const unique = new Set<string>()
    for (const id of ids) if (id) unique.add(id)
    return [...unique].sort((a, b) => a.localeCompare(b)).slice(0, 200)
  }

  // Endpoint dò model gọi ra mạng bằng credential người dùng nhập, nên cần
  // giới hạn tần suất để không thành công cụ dò quét tùy ý.
  const discoverLimiter = createRateLimiter({
    windowMs: 60_000,
    max: env.RATE_LIMIT_LLM_MODELS_PER_MIN || Number.MAX_SAFE_INTEGER,
  })

  router.get('/', (req, res) => {
    const user = requireUser(req)
    res.json({ connections: listForUser(user.id) })
  })

  /**
   * Dò danh sách model bằng Base URL + API key **chưa lưu**.
   *
   * Nhờ vậy người dùng chọn model từ dropdown ngay khi thêm kết nối, không phải
   * gõ tay model ID. Không ghi gì vào database và không trả key về client.
   */
  router.post('/models', async (req, res) => {
    const user = requireUser(req)

    if (!discoverLimiter.check(`llm-models:${user.id}`)) {
      throw badRequest('Bạn thử quá nhanh. Vui lòng đợi một lát rồi tải lại danh sách.')
    }

    const parsed = discoverSchema.safeParse(req.body)
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Dữ liệu không hợp lệ')
    }

    await guardProviderUrl(parsed.data.baseUrl, guardOptions)
    res.json({ models: await listChatModels(parsed.data) })
  })

  router.post('/', async (req, res) => {
    const user = requireUser(req)

    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Dữ liệu không hợp lệ')
    }

    await guardProviderUrl(parsed.data.baseUrl, guardOptions)

    const id = randomUUID()
    const now = Date.now()
    const encrypted = encryptSecret(parsed.data.apiKey, masterKey)

    db.prepare(
      `INSERT INTO llm_connections
         (id, user_id, name, base_url, model_id, api_key_ciphertext, api_key_iv, api_key_tag,
          key_hint, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'untested', ?, ?)`,
    ).run(
      id,
      user.id,
      parsed.data.name ?? nameFromBaseUrl(parsed.data.baseUrl),
      parsed.data.baseUrl,
      parsed.data.modelId,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.tag,
      keyHint(parsed.data.apiKey),
      now,
      now,
    )

    res.status(201).json({ connection: toPublic(ownedConnection(user.id, id)) })
  })

  router.patch('/:id', async (req, res) => {
    const user = requireUser(req)
    const existing = ownedConnection(user.id, req.params.id)

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
      // Đổi đích thì kết quả kiểm tra cũ không còn giá trị.
      updates.push("status = 'untested'")
    }
    if (parsed.data.modelId !== undefined) {
      updates.push('model_id = ?')
      values.push(parsed.data.modelId)
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

    db.prepare(`UPDATE llm_connections SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).run(
      ...values,
      existing.id,
      user.id,
    )

    res.json({ connection: toPublic(ownedConnection(user.id, existing.id)) })
  })

  router.delete('/:id', (req, res) => {
    const user = requireUser(req)
    const existing = ownedConnection(user.id, req.params.id)
    db.prepare('DELETE FROM llm_connections WHERE id = ? AND user_id = ?').run(existing.id, user.id)
    res.status(204).end()
  })

  /** Kiểm tra kết nối bằng GET /models — không sinh văn bản nên không tốn phí. */
  router.post('/:id/test', async (req, res) => {
    const user = requireUser(req)
    const existing = ownedConnection(user.id, req.params.id)

    try {
      const models = await listChatModels({ baseUrl: existing.base_url, apiKey: decryptKey(existing) })
      db.prepare(
        "UPDATE llm_connections SET status = 'connected', last_error = NULL, updated_at = ? WHERE id = ?",
      ).run(Date.now(), existing.id)
      res.json({ ok: true, modelCount: models.length, models })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Không kết nối được LLM'
      db.prepare(
        "UPDATE llm_connections SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?",
      ).run(message.slice(0, 500), Date.now(), existing.id)
      throw providerError(message)
    }
  })

  /** Liệt kê model chat của kết nối đã lưu; không lưu danh sách vào database. */
  router.post('/:id/models', async (req, res) => {
    const user = requireUser(req)
    const existing = ownedConnection(user.id, req.params.id)
    const models = await listChatModels({ baseUrl: existing.base_url, apiKey: decryptKey(existing) })
    res.json({ models })
  })

  return router
}
