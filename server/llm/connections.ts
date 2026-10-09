import type { AppEnv } from '../env'
import type { Database } from '../db/index'
import { badRequest, notFound } from '../lib/errors'

/**
 * Chọn model văn bản (kind = 'llm') để gọi chat.
 *
 * LLM dùng chung provider với ảnh/video: Base URL nằm ở `provider_connections`,
 * còn key nằm trong pool `provider_credentials`. Model chat là một dòng `models`
 * được phân loại thành "LLM & Chat" trong Model catalog. Nhờ vậy người dùng chỉ
 * quản lý key ở một nơi và chỉ có một chỗ phân loại model.
 */

/**
 * Model chat đã sẵn sàng để gọi.
 *
 * KHÔNG chứa bí mật: `chat.ts` tự chọn key từ pool ngay trước khi gọi (một lần
 * giải mã duy nhất, có failover an toàn và ghi nhận sức khỏe key). `db` được
 * mang theo để lời gọi chat dùng lại đúng kết nối mà không phải truyền thêm tham
 * số qua mọi lời gọi hiện có.
 */
export type LlmTarget = {
  /** id dòng `models`: dùng để ghi lại model đã chọn cho phiên chat. */
  modelPk: string
  /** Model ID gửi cho provider (ví dụ `gpt-4o-mini`). */
  modelId: string
  displayName: string
  providerId: string
  baseUrl: string
  /** Kết nối database để chọn key từ pool lúc gọi. */
  db: Database
}

type LlmModelRow = {
  id: string
  model_id: string
  display_name: string
  provider_id: string
  base_url: string
}

const LLM_MODEL_SELECT = `
  SELECT m.id, m.model_id, m.display_name, m.provider_id, p.base_url
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
  // Giữ tham số `env` để không phá vỡ lời gọi hiện có; việc chọn key giờ do
  // chat.ts thực hiện nên không cần giải mã ở đây nữa.
  _env: AppEnv,
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
    db,
  }
}
