import { randomUUID } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import type { AppEnv } from '../env'
import type { Database } from '../db/index'
import { decodeMasterKey, encryptSecret, keyHint } from '../crypto/providerKey'
import {
  AppError,
  badRequest,
  errorMeta,
  errorMetadataOf,
  notFound,
  providerError,
  tooManyRequests,
  validationError,
} from '../lib/errors'
import { createRateLimiter } from '../lib/rateLimit'
import { isErrorMessageKey, type ErrorMessageKey, type ErrorMessageParams } from '../../shared/errorCatalog'
import {
  callProvider,
  readProviderError,
  redactSecrets,
  type ProviderResponse,
  type RemoteModel,
} from './client'
import { guardProviderUrl } from './urlGuard'
import { requireUser } from '../auth/middleware'
import {
  MAX_CREDENTIALS_PER_PROVIDER,
  addCredential,
  getCredential,
  getCredentialPool,
  listCredentials,
  removeCredential,
  reorderCredentials,
  resolvePinnedCredential,
  setProviderSelectionMode,
  updateCredential,
  type CredentialPool,
  type ProviderCredential,
  type ProviderSelectionMode,
  type SelectedProviderTarget,
} from './credentials'
import { poolExhaustedError, readWithPool, type PoolReadOutcome } from './pool'

/** Kiểu gọi API tạo ảnh: chuẩn OpenAI hoặc ảnh nguồn trong extra_body. */
const IMAGE_API_STYLES = ['openai', 'extra_body'] as const

/** Nhãn mặc định cho key đầu tiên (trùng nhãn backfill của migration 016). */
const DEFAULT_CREDENTIAL_LABEL = 'Key mặc định'

/** Số lần gọi provider (test/sync) tối đa cho một người dùng trong một phút. */
const PROVIDER_OUTBOUND_PER_MINUTE = 20
/** Thời gian chờ tối đa cho một lần GET /models khi kiểm tra kết nối. */
const PROVIDER_MODELS_TIMEOUT_MS = 20_000

const createSchema = z.object({
  name: z.string().trim().min(1, 'Vui lòng nhập tên hiển thị').max(80),
  baseUrl: z.string().trim().min(1, 'Vui lòng nhập Base URL').max(500),
  apiKey: z.string().trim().min(1, 'Vui lòng nhập API key').max(500),
  imageApiStyle: z.enum(IMAGE_API_STYLES).default('openai'),
  /** Nhãn cho key đầu tiên trong pool; bỏ trống thì dùng nhãn mặc định. */
  label: z.string().trim().max(80).optional(),
})

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  baseUrl: z.string().trim().min(1).max(500).optional(),
  // Cho phép thay key mới để xử lý key hết hạn. Không bao giờ đọc lại key cũ.
  // Với pool nhiều key, key mới thay cho key ưu tiên cao nhất.
  apiKey: z.string().trim().min(1).max(500).optional(),
  imageApiStyle: z.enum(IMAGE_API_STYLES).optional(),
  selectionMode: z.enum(['failover', 'round_robin']).optional(),
})

const credentialCreateSchema = z.object({
  apiKey: z.string().trim().min(1, 'Vui lòng nhập API key').max(500),
  label: z.string().trim().max(80).optional(),
  position: z.number().int().min(0).max(MAX_CREDENTIALS_PER_PROVIDER).optional(),
  enabled: z.boolean().optional(),
})

const credentialUpdateSchema = z.object({
  apiKey: z.string().trim().min(1).max(500).optional(),
  label: z.string().trim().max(80).optional(),
  position: z.number().int().min(0).max(MAX_CREDENTIALS_PER_PROVIDER).optional(),
  enabled: z.boolean().optional(),
})

const reorderSchema = z.object({
  ids: z.array(z.string().trim().min(1)).max(MAX_CREDENTIALS_PER_PROVIDER),
})

export type ProviderPublic = {
  id: string
  name: string
  baseUrl: string
  keyHint: string
  imageApiStyle: string
  status: string
  lastError: string | null
  /** Khoá ngữ nghĩa cho lỗi kết nối gần nhất (nullable với dữ liệu cũ). */
  lastErrorKey: ErrorMessageKey
  lastErrorParams: ErrorMessageParams
  modelCount: number
  createdAt: number
  /** Cách chọn key giữa nhiều API key; backend mặc định `failover`. */
  selectionMode: ProviderSelectionMode
  /** Danh sách key công khai (không có bí mật) để giao diện hiển thị kèm provider. */
  credentials: ProviderCredential[]
}

type ProviderRow = {
  id: string
  name: string
  base_url: string
  key_hint: string
  image_api_style: string
  status: string
  last_error: string | null
  last_error_key?: string | null
  last_error_params?: string | null
  selection_mode?: string | null
  created_at: number
  model_count: number
}

/** Khoá ngữ nghĩa của lỗi kết nối; dữ liệu cũ suy ra từ `last_error` thô. */
function providerErrorKey(row: ProviderRow): ErrorMessageKey {
  if (row.last_error_key && isErrorMessageKey(row.last_error_key)) return row.last_error_key
  if (row.last_error) return 'providers.test_failed'
  return 'errors.provider_error'
}

function providerErrorParams(row: ProviderRow): ErrorMessageParams {
  if (!row.last_error_params) {
    return row.last_error ? { detail: row.last_error } : {}
  }
  try {
    const parsed: unknown = JSON.parse(row.last_error_params)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ErrorMessageParams
    }
  } catch {
    // Dữ liệu cũ hoặc hỏng: bỏ qua tham số.
  }
  return {}
}

/**
 * Trạng thái hiển thị của provider, suy ra từ sức khỏe của CẢ pool thay vì tin
 * cột `status` cũ (vốn chỉ phản ánh một key/một lần kiểm tra):
 *   - chưa có key nào ⇒ `untested` (không có gì để kiểm tra);
 *   - không còn key DÙNG ĐƯỢC (tắt, `auth_failed` hoặc đang cooldown) ⇒ `error`;
 *   - lần kiểm tra gần nhất của provider thất bại ⇒ `error`;
 *   - có ít nhất một key dùng được với health `ok` ⇒ `connected`;
 *   - còn lại (key dùng được nhưng chưa xác nhận) ⇒ `untested`.
 *
 * Nhờ vậy `connected` cũ không bị giữ lại khi mọi key đã hỏng, và không bao giờ
 * báo `connected` chỉ vì cột `status` cũ — phải có bằng chứng `ok` từ chính pool.
 * Đổi Base URL sẽ xoá health của pool (xem PATCH) nên trạng thái tự về `untested`.
 */
function deriveProviderStatus(row: ProviderRow, credentials: ProviderCredential[]): string {
  if (credentials.length === 0) return 'untested'

  const now = Date.now()
  const usable = credentials.filter(
    (item) =>
      item.enabled &&
      item.healthStatus !== 'auth_failed' &&
      (item.cooldownUntil === null || item.cooldownUntil <= now),
  )

  if (usable.length === 0) return 'error'
  if (row.status === 'error') return 'error'
  if (usable.some((item) => item.healthStatus === 'ok')) return 'connected'
  return 'untested'
}

/**
 * Chuyển một hàng provider + pool công khai thành mô hình trả về client.
 * `keyHint` lấy từ key ưu tiên cao nhất của pool — cột legacy `key_hint` KHÔNG
 * được dùng làm giá trị hiển thị vì nó có thể trỏ tới key đã bị xóa.
 */
function toPublic(row: ProviderRow, pool: CredentialPool): ProviderPublic {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    keyHint: pool.credentials[0]?.hint ?? '',
    imageApiStyle: row.image_api_style,
    status: deriveProviderStatus(row, pool.credentials),
    lastError: row.last_error,
    lastErrorKey: providerErrorKey(row),
    lastErrorParams: providerErrorParams(row),
    modelCount: Number(row.model_count),
    createdAt: row.created_at,
    selectionMode: pool.selectionMode,
    credentials: pool.credentials,
  }
}

// ── Transaction & đọc model qua pool ────────────────────────────────────────

/** Bọc một khối ghi trong transaction IMMEDIATE; lồng nhau thì dùng lại transaction ngoài. */
function inTransaction<T>(db: Database, fn: () => T): T {
  if (db.isTransaction) return fn()
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // Transaction đã tự hủy; không che lỗi gốc.
    }
    throw error
  }
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function parseRemoteModels(payload: unknown): RemoteModel[] | null {
  if (!payload || typeof payload !== 'object') return null
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data)) return null
  return data
    .map((item) => {
      if (typeof item !== 'object' || item === null) return null
      const record = item as { id?: unknown; name?: unknown }
      if (typeof record.id !== 'string' || !record.id) return null
      return {
        id: record.id,
        displayName: typeof record.name === 'string' && record.name ? record.name : record.id,
      }
    })
    .filter((item): item is RemoteModel => item !== null)
}

/**
 * Ở chế độ mock không có request nào ra mạng: trả phản hồi giả lập đúng định dạng
 * `GET /models` để luồng chọn key/sức khỏe vẫn chạy y như thật.
 */
async function mockModelsResponse(): Promise<ProviderResponse> {
  const { mockModelList } = await import('../generations/adapters/mock')
  const payload = mockModelList()
  const text = JSON.stringify(payload)
  return {
    status: 200,
    ok: true,
    headers: new Headers(),
    json: async () => payload,
    text: async () => text,
    body: null,
  }
}

/**
 * Gọi `GET /models` qua pool (helper chuẩn `readWithPool`): thử lần lượt các key
 * khả dụng, tối đa bằng trần pool; key bị 401/403/429 hoặc lỗi mạng/5xx được ghi
 * sức khỏe rồi bỏ qua. Request chỉ đọc nên không tạo nội dung, không tốn phí.
 *
 * `initial` + `maxAttempts: 1` dùng cho "kiểm tra đúng một key, không failover".
 *
 * Lỗi mạng thô (fetch failed/ECONNRESET…) không phải `AppError` nên được bọc
 * thành 502 có khoá ngữ nghĩa trước khi ra route, thay vì rơi vào 500 chung.
 */
async function readModels(
  db: Database,
  env: AppEnv,
  providerId: string,
  options: { initial?: SelectedProviderTarget; maxAttempts?: number } = {},
): Promise<PoolReadOutcome> {
  try {
    return await readWithPool({
      db,
      env,
      providerId,
      initial: options.initial,
      maxAttempts: options.maxAttempts,
      call: async (target) =>
        env.PROVIDER_MODE === 'mock'
          ? mockModelsResponse()
          : callProvider(target, 'models', { timeoutMs: PROVIDER_MODELS_TIMEOUT_MS }),
    })
  } catch (error) {
    // Lỗi có kiểu (SSRF, pool rỗng, cooldown, 401/403/429…) giữ nguyên status và
    // khoá ngữ nghĩa. Chỉ bọc lỗi thô không xác định được nguồn.
    if (error instanceof AppError) throw error

    const secrets = options.initial?.apiKey ? [options.initial.apiKey] : []
    const detail = redactSecrets(messageOf(error, 'Không kết nối được provider'), secrets).slice(0, 500)
    throw providerError(
      `Kết nối provider thất bại: ${detail}`,
      { detail },
      errorMeta('providers.test_failed', { detail }),
    )
  }
}

/** Đọc danh sách model từ kết quả pool; ném lỗi có khoá ngữ nghĩa khi thất bại. */
async function modelsFromOutcome(outcome: PoolReadOutcome): Promise<RemoteModel[]> {
  const { response, target } = outcome

  if (response.status === 404 || response.status === 405) {
    throw badRequest(
      'Provider này không hỗ trợ endpoint /models. Bạn vẫn có thể thêm model thủ công.',
      undefined,
      errorMeta('providers.models_endpoint_unsupported'),
    )
  }

  if (outcome.exhausted && [401, 403, 429].includes(response.status)) {
    // Chỉ từ chối xác thực / hạn mức mới là lỗi hết key. 5xx vẫn là lỗi upstream.
    throw poolExhaustedError(response, target)
  }

  if (!response.ok) {
    const detail = await readProviderError(response, [target.apiKey])
    throw providerError(
      `Không lấy được danh sách model: ${detail}`,
      undefined,
      errorMeta('providers.models_list_failed', { detail }),
    )
  }

  const models = parseRemoteModels(await response.json())
  if (!models) {
    throw providerError(
      'Provider trả về danh sách model không đúng định dạng mong đợi',
      undefined,
      errorMeta('providers.models_payload_invalid'),
    )
  }
  return models
}

export function providerRoutes(db: Database, env: AppEnv): Router {
  const router = Router()
  const masterKey = decodeMasterKey(env.APP_ENCRYPTION_KEY)

  // Giới hạn các lần gọi provider ra ngoài (test/sync/kiểm tra key) theo người dùng.
  const outboundLimiter = createRateLimiter({
    windowMs: 60_000,
    max: PROVIDER_OUTBOUND_PER_MINUTE,
  })

  function enforceOutboundLimit(userId: string): void {
    if (outboundLimiter.check(`provider-outbound:${userId}`)) return
    throw tooManyRequests(
      'Quá nhiều lần kiểm tra kết nối. Hãy thử lại sau.',
      errorMeta('providers.test_rate_limited'),
    )
  }

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
        `SELECT p.id, p.name, p.base_url, p.key_hint, p.image_api_style, p.status, p.last_error,
                p.last_error_key, p.last_error_params, p.selection_mode, p.created_at,
                (SELECT COUNT(*) FROM models m WHERE m.provider_id = p.id) AS model_count
         FROM provider_connections p
         WHERE p.user_id = ?
         ORDER BY p.created_at ASC`,
      )
      .all(userId) as unknown as ProviderRow[]
    return rows.map((row) => toPublic(row, getCredentialPool(db, userId, row.id)))
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
          image_api_style: string
          status: string
          last_error: string | null
          last_error_key?: string | null
          last_error_params?: string | null
          created_at: number
        }
      | undefined
    if (!row) throw notFound('Không tìm thấy provider', errorMeta('providers.not_found'))
    return row
  }

  /** Ghi lại lỗi kết nối gần nhất của provider kèm khoá ngữ nghĩa (không chứa key). */
  function recordProviderFailure(providerId: string, error: unknown): void {
    const meta = errorMetadataOf(error)
    const message = messageOf(error, 'Không kết nối được provider').slice(0, 500)
    db.prepare(
      `UPDATE provider_connections
          SET status = 'error', last_error = ?, last_error_key = ?, last_error_params = ?, updated_at = ?
        WHERE id = ?`,
    ).run(message, meta.messageKey, JSON.stringify(meta.messageParams), Date.now(), providerId)
  }

  function recordProviderSuccess(providerId: string): void {
    db.prepare(
      `UPDATE provider_connections
          SET status = 'connected', last_error = NULL, last_error_key = NULL,
              last_error_params = NULL, updated_at = ?
        WHERE id = ?`,
    ).run(Date.now(), providerId)
  }

  router.get('/', (req, res) => {
    const user = requireUser(req)
    res.json({ providers: listForUser(user.id) })
  })

  router.post('/', async (req, res) => {
    const user = requireUser(req)

    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) {
      throw validationError(parsed.error)
    }

    // Kiểm tra SSRF ngay khi lưu để phát hiện sớm Base URL nguy hiểm.
    await guardProviderUrl(parsed.data.baseUrl, guardOptions)

    const id = randomUUID()
    const now = Date.now()
    const encrypted = encryptSecret(parsed.data.apiKey, masterKey)

    // Provider và key đầu tiên phải được tạo cùng nhau: nếu một bước lỗi thì
    // không được để lại provider không có key nào (pool rỗng làm mọi tác vụ hỏng).
    inTransaction(db, () => {
      db.prepare(
        `INSERT INTO provider_connections
           (id, user_id, name, base_url, api_key_ciphertext, api_key_iv, api_key_tag, key_hint,
            image_api_style, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'untested', ?, ?)`,
      ).run(
        id,
        user.id,
        parsed.data.name,
        parsed.data.baseUrl,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.tag,
        keyHint(parsed.data.apiKey),
        parsed.data.imageApiStyle,
        now,
        now,
      )

      addCredential(db, env, user.id, id, {
        apiKey: parsed.data.apiKey,
        label: parsed.data.label || DEFAULT_CREDENTIAL_LABEL,
      })
    })

    const created = listForUser(user.id).find((item) => item.id === id)!
    res.status(201).json({ provider: created })
  })

  router.patch('/:id', async (req, res) => {
    const user = requireUser(req)
    const existing = ownedProvider(user.id, req.params.id)

    const parsed = updateSchema.safeParse(req.body)
    if (!parsed.success) throw validationError(parsed.error)

    const updates: string[] = []
    const values: Array<string | number | Uint8Array> = []
    /** Đổi đích gọi: health của pool đo theo URL cũ nên phải bị xoá. */
    let baseUrlChanged = false

    if (parsed.data.name !== undefined) {
      updates.push('name = ?')
      values.push(parsed.data.name)
    }

    if (parsed.data.baseUrl !== undefined) {
      await guardProviderUrl(parsed.data.baseUrl, guardOptions)
      updates.push('base_url = ?')
      values.push(parsed.data.baseUrl)
      // Đổi đích thì trạng thái kiểm tra cũ không còn giá trị. Các tác vụ đã ghim
      // key vẫn dùng URL đã chụp trong `generations.snap_credential_base_url`.
      updates.push("status = 'untested'")
      baseUrlChanged = true
    }

    if (parsed.data.imageApiStyle !== undefined) {
      updates.push('image_api_style = ?')
      values.push(parsed.data.imageApiStyle)
    }

    const newApiKey = parsed.data.apiKey
    if (newApiKey !== undefined) {
      const encrypted = encryptSecret(newApiKey, masterKey)
      updates.push('api_key_ciphertext = ?', 'api_key_iv = ?', 'api_key_tag = ?', 'key_hint = ?')
      values.push(encrypted.ciphertext, encrypted.iv, encrypted.tag, keyHint(newApiKey))
      updates.push("status = 'untested'")
    }

    const selectionMode = parsed.data.selectionMode
    if (updates.length === 0 && selectionMode === undefined) {
      throw badRequest('Không có thay đổi nào để lưu', undefined, errorMeta('validation.invalid_payload'))
    }

    const now = Date.now()

    inTransaction(db, () => {
      if (newApiKey !== undefined) {
        // Thay bí mật cho key ưu tiên cao nhất (không đọc lại key cũ). Nếu key đó
        // đang bị tác vụ ghim, `updateCredential` ném 409 và không đổi gì.
        const first = listCredentials(db, user.id, existing.id)[0]
        if (first) {
          updateCredential(db, env, user.id, existing.id, first.id, { apiKey: newApiKey })
        } else {
          addCredential(db, env, user.id, existing.id, {
            apiKey: newApiKey,
            label: DEFAULT_CREDENTIAL_LABEL,
          })
        }
      }

      if (selectionMode !== undefined) {
        setProviderSelectionMode(db, user.id, existing.id, selectionMode)
      }

      if (updates.length > 0) {
        updates.push('updated_at = ?')
        values.push(now)
        db.prepare(
          `UPDATE provider_connections SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`,
        ).run(...values, existing.id, user.id)
      }

      if (baseUrlChanged) {
        // Sức khỏe key đã đo theo URL CŨ: xoá để trạng thái tổng hợp trở về
        // `untested` thay vì giữ `connected` nhờ một key từng `ok` ở đích cũ.
        // Không ảnh hưởng tác vụ đã ghim: `resolvePinnedCredential` bỏ qua health
        // và luôn dùng URL đã chụp.
        db.prepare(
          `UPDATE provider_credentials
              SET health_status = 'unknown', cooldown_until = NULL, last_error = NULL,
                  last_error_key = NULL, last_error_params = NULL, updated_at = ?
            WHERE provider_id = ?`,
        ).run(now, existing.id)
      }
    })

    const updated = listForUser(user.id).find((item) => item.id === existing.id)!
    res.json({ provider: updated })
  })

  router.delete('/:id', (req, res) => {
    const user = requireUser(req)
    const existing = ownedProvider(user.id, req.params.id)

    // Không cho xóa khi còn tác vụ đang chạy HOẶC tác vụ có thể phục hồi (đã ghim
    // key lúc gửi provider). Xóa provider sẽ cascade key và bỏ ghim của tác vụ, nên
    // phải giữ lại những tác vụ còn có thể poll/tải tiếp.
    const active = db
      .prepare(
        `SELECT COUNT(*) AS total FROM generations
          WHERE provider_id = ?
            AND (status IN ('queued', 'running', 'downloading', 'unknown')
                 OR (status = 'failed' AND provider_job_id IS NOT NULL))`,
      )
      .get(existing.id) as { total: number }

    if (Number(active.total) > 0) {
      throw badRequest(
        'Provider này còn tác vụ đang chạy. Hãy đợi hoàn tất hoặc xóa tác vụ trước.',
        undefined,
        errorMeta('providers.has_active_jobs'),
      )
    }

    db.prepare('DELETE FROM provider_connections WHERE id = ? AND user_id = ?').run(
      existing.id,
      user.id,
    )
    res.status(204).end()
  })

  // ── Pool API key: CRUD lồng dưới provider ──────────────────────────────────
  // `reorder` phải đăng ký TRƯỚC `/:credentialId` để không bị nuốt thành id.

  router.get('/:id/credentials', (req, res) => {
    const user = requireUser(req)
    const pool = getCredentialPool(db, user.id, req.params.id)
    res.json({ pool, credentials: pool.credentials, selectionMode: pool.selectionMode })
  })

  router.post('/:id/credentials', (req, res) => {
    const user = requireUser(req)
    const parsed = credentialCreateSchema.safeParse(req.body)
    if (!parsed.success) throw validationError(parsed.error)
    const credential = addCredential(db, env, user.id, req.params.id, parsed.data)
    res.status(201).json({ credential })
  })

  function reorderHandler(req: Request<{ id: string }>, res: Response): void {
    const user = requireUser(req)
    const parsed = reorderSchema.safeParse(req.body)
    if (!parsed.success) throw validationError(parsed.error)
    const credentials = reorderCredentials(db, user.id, req.params.id, parsed.data.ids)
    res.json({ credentials })
  }

  // Frontend dùng POST; giữ thêm PATCH cho tương thích với hợp đồng HTTP đã chốt.
  router.post('/:id/credentials/reorder', reorderHandler)
  router.patch('/:id/credentials/reorder', reorderHandler)

  router.get('/:id/credentials/:credentialId', (req, res) => {
    const user = requireUser(req)
    res.json({ credential: getCredential(db, user.id, req.params.id, req.params.credentialId) })
  })

  router.patch('/:id/credentials/:credentialId', (req, res) => {
    const user = requireUser(req)
    const parsed = credentialUpdateSchema.safeParse(req.body)
    if (!parsed.success) throw validationError(parsed.error)
    const credential = updateCredential(
      db,
      env,
      user.id,
      req.params.id,
      req.params.credentialId,
      parsed.data,
    )
    res.json({ credential })
  })

  router.delete('/:id/credentials/:credentialId', (req, res) => {
    const user = requireUser(req)
    removeCredential(db, user.id, req.params.id, req.params.credentialId)
    res.status(204).end()
  })

  /**
   * Kiểm tra ĐÚNG một key (không failover sang key khác), kể cả key đang tắt hay
   * đang nghỉ: người dùng cần biết chính xác key này còn dùng được hay không.
   */
  router.post('/:id/credentials/:credentialId/test', async (req, res) => {
    const user = requireUser(req)
    enforceOutboundLimit(user.id)
    const existing = ownedProvider(user.id, req.params.id)
    const credentialId = req.params.credentialId
    // Xác nhận key thuộc provider của chính người dùng trước khi giải mã.
    getCredential(db, user.id, existing.id, credentialId)

    const target = resolvePinnedCredential(db, env, credentialId, existing.base_url)
    // maxAttempts = 1: dùng đúng key này, không nhảy sang key khác.
    const models = await modelsFromOutcome(
      await readModels(db, env, existing.id, { initial: target, maxAttempts: 1 }),
    )

    res.json({
      ok: true,
      modelCount: models.length,
      credential: getCredential(db, user.id, existing.id, credentialId),
    })
  })

  /** Kiểm tra kết nối bằng GET /models — không tạo nội dung nên không tốn phí. */
  router.post('/:id/test', async (req, res) => {
    const user = requireUser(req)
    enforceOutboundLimit(user.id)
    const existing = ownedProvider(user.id, req.params.id)

    try {
      const models = await modelsFromOutcome(await readModels(db, env, existing.id))
      recordProviderSuccess(existing.id)
      res.json({ ok: true, modelCount: models.length })
    } catch (error) {
      recordProviderFailure(existing.id, error)
      throw error
    }
  })

  /** Đồng bộ model: chỉ thêm model mới ở dạng chưa phân loại, không ghi đè phân loại đã có. */
  router.post('/:id/sync-models', async (req, res) => {
    const user = requireUser(req)
    enforceOutboundLimit(user.id)
    const existing = ownedProvider(user.id, req.params.id)

    let remote: RemoteModel[]
    try {
      remote = await modelsFromOutcome(await readModels(db, env, existing.id))
    } catch (error) {
      recordProviderFailure(existing.id, error)
      throw error
    }

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

    recordProviderSuccess(existing.id)

    res.json({ added, skipped, total: remote.length })
  })

  return router
}
