import type { AppEnv } from '../env'
import type { Database } from '../db/index'
import { decodeMasterKey, decryptSecret } from '../crypto/providerKey'
import { badRequest, notFound } from '../lib/errors'

/**
 * Chọn model văn bản (kind = 'llm') để gọi chat.
 *
 * LLM dùng chung provider với ảnh/video: Base URL và API key nằm ở
 * `provider_connections`, còn model chat là một dòng `models` được phân loại
 * thành "LLM & Chat" trong Model catalog. Nhờ vậy người dùng chỉ quản lý key ở
 * một nơi và chỉ có một chỗ phân loại model.
 */

/** Model chat đã sẵn sàng để gọi, kèm key của provider đã giải mã. */
export type LlmTarget = {
  /** id dòng `models`: dùng để ghi lại model đã chọn cho phiên chat. */
  modelPk: string
  /** Model ID gửi cho provider (ví dụ `gpt-4o-mini`). */
  modelId: string
  displayName: string
  providerId: string
  baseUrl: string
  apiKey: string
}

type LlmModelRow = {
  id: string
  model_id: string
  display_name: string
  provider_id: string
  base_url: string
  api_key_ciphertext: Uint8Array
  api_key_iv: Uint8Array
  api_key_tag: Uint8Array
}

const LLM_MODEL_SELECT = `
  SELECT m.id, m.model_id, m.display_name, m.provider_id,
         p.base_url, p.api_key_ciphertext, p.api_key_iv, p.api_key_tag
    FROM models m
    JOIN provider_connections p ON p.id = m.provider_id
   WHERE m.user_id = ? AND m.kind = 'llm' AND m.enabled = 1`

/** Model LLM phải thuộc đúng người dùng; nếu không thì 404 để không lộ sự tồn tại. */
export function ownedLlmModel(db: Database, userId: string, id: string): { id: string } {
  const row = db
    .prepare("SELECT id FROM models WHERE id = ? AND user_id = ? AND kind = 'llm'")
    .get(id, userId) as { id: string } | undefined
  if (!row) throw notFound('Không tìm thấy model LLM & Chat')
  return row
}

/**
 * Chọn model chat để gọi.
 *
 * Có `modelId` thì dùng đúng model đó; không có thì lấy model LLM đang bật đầu
 * tiên. Lỗi được nêu rõ để người dùng biết cần làm gì trong API & Models.
 */
export function resolveLlmTarget(
  db: Database,
  env: AppEnv,
  userId: string,
  modelId?: string,
): LlmTarget {
  const row = (modelId
    ? db.prepare(`${LLM_MODEL_SELECT} AND m.id = ?`).get(userId, modelId)
    : db
        .prepare(`${LLM_MODEL_SELECT} ORDER BY m.created_at ASC, m.id ASC LIMIT 1`)
        .get(userId)) as LlmModelRow | undefined

  if (!row && modelId) {
    const existing = db
      .prepare('SELECT kind, enabled FROM models WHERE id = ? AND user_id = ?')
      .get(modelId, userId) as { kind: string; enabled: number } | undefined

    if (!existing) throw notFound('Không tìm thấy model LLM & Chat')
    if (existing.kind !== 'llm') {
      throw badRequest(
        'Model đã chọn chưa được phân loại thành "LLM & Chat". Vào API & Models để phân loại lại.',
      )
    }
    throw badRequest('Model chat này đang bị tắt. Vào API & Models để bật lại.')
  }

  if (!row) {
    throw badRequest(
      'Chưa có model LLM & Chat. Vào API & Models, thêm provider rồi phân loại một model thành "LLM & Chat".',
    )
  }

  return {
    modelPk: row.id,
    modelId: row.model_id,
    displayName: row.display_name,
    providerId: row.provider_id,
    baseUrl: row.base_url,
    apiKey: decryptSecret(
      {
        ciphertext: Buffer.from(row.api_key_ciphertext),
        iv: Buffer.from(row.api_key_iv),
        tag: Buffer.from(row.api_key_tag),
      },
      decodeMasterKey(env.APP_ENCRYPTION_KEY),
    ),
  }
}
