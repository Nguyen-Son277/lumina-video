import type { AppEnv } from '../env'
import type { Database } from '../db/index'
import { decodeMasterKey, decryptSecret } from '../crypto/providerKey'
import { badRequest, notFound } from '../lib/errors'

export type LlmConnectionStatus = 'untested' | 'connected' | 'error'

export type LlmRow = {
  id: string
  user_id: string
  name: string
  base_url: string
  model_id: string
  api_key_ciphertext: Uint8Array
  api_key_iv: Uint8Array
  api_key_tag: Uint8Array
  key_hint: string
  status: LlmConnectionStatus
  last_error: string | null
  created_at: number
  updated_at: number
}

export type LlmConnectionPublic = {
  id: string
  name: string
  baseUrl: string
  modelId: string
  keyHint: string
  status: LlmConnectionStatus
  lastError: string | null
  createdAt: number
  updatedAt: number
}

/** Kết nối LLM đã sẵn sàng để gọi, kèm key đã giải mã. Chỉ dùng ở phía server. */
export type LlmTarget = {
  connection: LlmRow
  baseUrl: string
  modelId: string
  apiKey: string
}

export function toPublic(row: LlmRow): LlmConnectionPublic {
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

export function listLlmForUser(db: Database, userId: string): LlmConnectionPublic[] {
  const rows = db
    .prepare('SELECT * FROM llm_connections WHERE user_id = ? ORDER BY created_at ASC, id')
    .all(userId) as unknown as LlmRow[]
  return rows.map(toPublic)
}

/** Kết nối phải thuộc đúng người dùng; nếu không thì 404 để không lộ sự tồn tại. */
export function ownedLlmConnection(db: Database, userId: string, id: string): LlmRow {
  const row = db
    .prepare('SELECT * FROM llm_connections WHERE id = ? AND user_id = ?')
    .get(id, userId) as LlmRow | undefined
  if (!row) throw notFound('Không tìm thấy kết nối LLM')
  return row
}

export function decryptLlmKey(row: LlmRow, masterKey: Buffer): string {
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
 * Chọn kết nối LLM để gọi.
 *
 * Có `connectionId` thì dùng đúng kết nối đó (kiểm tra quyền sở hữu); không có
 * thì lấy kết nối đầu tiên, ưu tiên kết nối đã kiểm tra thành công.
 */
export function resolveLlmTarget(
  db: Database,
  env: AppEnv,
  userId: string,
  connectionId?: string,
): LlmTarget {
  const row = connectionId
    ? ownedLlmConnection(db, userId, connectionId)
    : (db
        .prepare(
          `SELECT * FROM llm_connections
           WHERE user_id = ?
           ORDER BY
             -- Ưu tiên kết nối đã chọn model để không báo lỗi khi vẫn còn lựa chọn dùng được.
             CASE WHEN model_id IS NULL OR model_id = '' THEN 1 ELSE 0 END,
             CASE status WHEN 'connected' THEN 0 ELSE 1 END,
             created_at ASC, id
           LIMIT 1`,
        )
        .get(userId) as LlmRow | undefined)

  if (!row) {
    throw badRequest('Chưa có kết nối LLM. Hãy thêm trong API & Models.')
  }

  // Kết nối mới chỉ lưu URL + key; chưa chọn model thì không gọi được chat.
  if (!row.model_id) {
    throw badRequest(
      `Kết nối "${row.name}" chưa chọn model chat. Vào API & Models, bấm "Tải model" rồi chọn model.`,
    )
  }

  return {
    connection: row,
    baseUrl: row.base_url,
    modelId: row.model_id,
    apiKey: decryptLlmKey(row, decodeMasterKey(env.APP_ENCRYPTION_KEY)),
  }
}
