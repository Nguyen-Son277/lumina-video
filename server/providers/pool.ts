/**
 * Định tuyến API key theo pool cho mọi lời gọi provider.
 *
 * Đây là "cổng vào" duy nhất cho phần chọn key lúc chạy. Nhờ tập trung ở một
 * chỗ, các quy tắc an toàn về chi phí chỉ được viết một lần:
 *
 *   - Chỉ đổi key sau một phản hồi HTTP rõ ràng 401/403/429 của lần GỬI mới.
 *     Timeout, mất kết nối, 5xx hoặc 2xx không đọc được ⇒ KHÔNG gửi lại (có thể
 *     đã bị tính phí); worker đánh dấu kết quả không xác định.
 *   - Request chỉ đọc (GET /models, kiểm tra kết nối) không tốn phí nên được thử
 *     key kế tiếp cả khi lỗi mạng/5xx.
 *   - Tác vụ đã gửi provider luôn dùng đúng key + URL đã ghim; poll/tải lại
 *     không bao giờ nhảy sang key khác, kể cả khi key đó đã bị tắt.
 *
 * Mọi thông báo lỗi lấy từ provider đều được rửa sạch key thô trước khi trả ra
 * hoặc lưu lại (xem `redactSecrets`).
 */
import type { AppEnv } from '../env'
import type { Database } from '../db/index'
import { AppError, errorMeta, providerError, tooManyRequests, uncertainOutcome } from '../lib/errors'
import {
  CREDENTIAL_COOLDOWN_DEFAULT_SECONDS,
  MAX_CREDENTIALS_PER_PROVIDER,
  recordCredentialResult,
  resolvePinnedCredential,
  selectCredential,
  type CredentialResultInput,
  type SelectCredentialOptions,
  type SelectedProviderTarget,
} from './credentials'
import {
  parseRetryAfterSeconds,
  redactSecrets,
  type ProviderResponse,
  type ProviderTarget,
} from './client'

/** Rửa sạch mọi bí mật xuất hiện nguyên văn trong chẩn đoán trước khi lưu/trả. */
export { redactSecrets }

/** HTTP status của lần gửi được phép đổi sang key khác (lỗi thuộc về key). */
const RETRYABLE_KEY_STATUSES = new Set([401, 403, 429])

/** Hàng `generations` tối thiểu để ghim/khôi phục key của tác vụ. */
export type PinnedGenerationRow = {
  id: string
  provider_id: string | null
  credential_id?: string | null
  snap_base_url?: string | null
  snap_credential_base_url?: string | null
}

/** Đích gọi provider có thể đã kèm key đã chọn; thiếu thì pool tự chọn. */
export type PoolInitialTarget = ProviderTarget & {
  credentialId?: string
  keyHint?: string
  /** Vân tay key lúc ghim, dùng cho guard chống xoay key (nội bộ). */
  expectedFingerprint?: string
}

export type PoolCall = (target: SelectedProviderTarget) => Promise<ProviderResponse>

export type PoolSubmitOptions = {
  db: Database
  env: AppEnv
  providerId: string
  /** Đích đã chọn sẵn (worker chọn trước khi ghim) hoặc chỉ có baseUrl. */
  initial: PoolInitialTarget
  call: PoolCall
  /** Gọi TRƯỚC mỗi lần gửi để ghim key/URL vào hàng tác vụ. */
  onAttempt?: (target: SelectedProviderTarget) => void
  /** Trần số key thử trong một lần gửi (mặc định và tối đa 10). */
  maxAttempts?: number
}

export type PoolSubmitOutcome = {
  response: ProviderResponse
  /** Key của lần gửi cuối cùng (đã ghim nếu có `onAttempt`). */
  target: SelectedProviderTarget
  attempts: number
  /** true khi đã thử hết key khả dụng mà vẫn bị từ chối vì lý do thuộc key. */
  exhausted: boolean
}

export type PoolReadOptions = {
  db: Database
  env: AppEnv
  providerId: string
  initial?: PoolInitialTarget
  call: PoolCall
  onAttempt?: (target: SelectedProviderTarget) => void
  maxAttempts?: number
}

export type PoolReadOutcome = {
  response: ProviderResponse
  target: SelectedProviderTarget
  attempts: number
  exhausted: boolean
}

function messageOf(error: unknown): string | undefined {
  return error instanceof Error ? error.message.slice(0, 500) : undefined
}

/**
 * Bọc lỗi phát sinh khi chọn/giải mã key. Lỗi có kiểu (AppError) giữ nguyên để
 * giữ đúng HTTP status và khoá ngữ nghĩa; lỗi còn lại (giải mã/GCM hỏng) được
 * chuyển thành lỗi rõ ràng thay vì rò rỉ chi tiết mã hoá.
 */
function asPoolSelectionError(error: unknown): unknown {
  if (error instanceof AppError) return error
  const detail = messageOf(error)
  return providerError(
    'Không giải mã được API key của provider. Hãy thay key hoặc kiểm tra khoá mã hoá máy chủ.',
    detail ? { detail } : undefined,
    errorMeta('providers.credential_decrypt_failed', detail ? { detail } : undefined),
  )
}

/** Chọn một key khả dụng cho lần gửi mới (ghi nhận round-robin nếu có). */
export function selectPoolTarget(
  db: Database,
  env: AppEnv,
  providerId: string,
  options: SelectCredentialOptions = {},
): SelectedProviderTarget {
  try {
    return selectCredential(db, env, providerId, options)
  } catch (error) {
    throw asPoolSelectionError(error)
  }
}

/**
 * Ghi nhận kết quả cho chính target vừa dùng, kèm `expectedFingerprint` để kết
 * quả của request cũ không áp lên key đã bị xoay bí mật giữa chừng.
 */
function recordTargetResult(
  db: Database,
  target: SelectedProviderTarget,
  result: CredentialResultInput,
): void {
  recordCredentialResult(db, target.credentialId, {
    ...result,
    expectedFingerprint: result.expectedFingerprint ?? target.expectedFingerprint,
  })
}

/**
 * Ghi nhận kết quả của một lời gọi dùng key ĐÃ GHIM (poll/tải lại, LLM async).
 *
 * `observeOnly: true` bảo vệ key: thành công của một quan sát không xóa
 * `auth_failed`/cooldown do tác vụ khác gây ra. `expectedFingerprint` (nếu có)
 * khiến kết quả của request cũ bị bỏ qua sau khi key đã được xoay; key bị xóa
 * trong lúc request đang bay cũng tự động bị bỏ qua.
 */
export function recordPinnedCredentialResult(
  db: Database,
  credentialId: string | null | undefined,
  result: CredentialResultInput,
  expectedFingerprint?: string | null,
): void {
  if (!credentialId) return
  recordCredentialResult(db, credentialId, {
    ...result,
    observeOnly: true,
    expectedFingerprint: result.expectedFingerprint ?? expectedFingerprint ?? undefined,
  })
}

/** Số giây `Retry-After` của một phản hồi (null nếu không có/không hợp lệ). */
export function retryAfterFromResponse(response: ProviderResponse): number | null {
  return parseRetryAfterSeconds(response.headers)
}

/**
 * Lỗi khi đã thử hết key mà lần gửi vẫn bị từ chối vì lý do thuộc về key.
 * Đây là kết quả CHẮC CHẮN (provider đã trả lời rõ), không phải "không xác định".
 */
export function poolExhaustedError(
  response: ProviderResponse,
  target: SelectedProviderTarget,
): AppError {
  if (response.status === 429) {
    const retryAfter = retryAfterFromResponse(response) ?? CREDENTIAL_COOLDOWN_DEFAULT_SECONDS
    return tooManyRequests(
      `Tất cả API key của provider đang tạm nghỉ. Thử lại sau ${retryAfter} giây.`,
      errorMeta('providers.credentials_cooldown', { retryAfter }),
    )
  }

  if (response.status === 401 || response.status === 403) {
    return providerError(
      `API key "${target.keyHint}" bị từ chối xác thực. Hãy kiểm tra hoặc thay key khác.`,
      { status: response.status },
      errorMeta('providers.key_auth_failed'),
    )
  }

  return providerError(
    'Không còn API key nào dùng được cho provider này.',
    { status: response.status },
    errorMeta('providers.no_available_credentials'),
  )
}

/** Lỗi "không xác định" cho 5xx/bad-2xx của lần GỬI: có thể provider đã nhận. */
export function uncertainSubmitError(detail?: string): AppError {
  return uncertainOutcome(
    'Provider không trả về kết quả đọc được sau khi đã nhận yêu cầu. Không tự gửi lại để tránh tính phí hai lần — hãy kiểm tra ở provider trước.',
    detail ? { detail } : undefined,
    errorMeta('errors.outcome_unknown', detail ? { detail } : undefined),
  )
}

/**
 * Chọn một key từ pool khi chưa có đích cụ thể. Dùng cho provider đã có sẵn
 * `baseUrl` nhưng chưa chọn key (ví dụ route kiểm tra kết nối).
 */
function initialOrSelected(
  db: Database,
  env: AppEnv,
  providerId: string,
  initial: PoolInitialTarget | undefined,
): SelectedProviderTarget {
  if (initial?.credentialId) return initial as SelectedProviderTarget
  return selectPoolTarget(db, env, providerId)
}

/**
 * GỬI một yêu cầu tạo nội dung với cơ chế đổi key an toàn.
 *
 * Chỉ đổi key khi provider trả về 401/403/429 (lỗi thuộc key và chắc chắn request
 * chưa được xử lý thành công). Mọi lỗi khác — timeout/mất kết nối (callProvider
 * ném lỗi), 5xx, 4xx khác, 2xx — được trả nguyên về cho adapter quyết định.
 * Mỗi key chỉ thử tối đa một lần, tổng không quá `MAX_CREDENTIALS_PER_PROVIDER`.
 */
export async function submitWithPool(options: PoolSubmitOptions): Promise<PoolSubmitOutcome> {
  const { db, env, providerId, call, onAttempt } = options
  const limit = Math.min(
    Math.max(1, options.maxAttempts ?? MAX_CREDENTIALS_PER_PROVIDER),
    MAX_CREDENTIALS_PER_PROVIDER,
  )

  let target = initialOrSelected(db, env, providerId, options.initial)
  // Đóng băng URL trong suốt "logical operation": đổi key an toàn (401/403/429)
  // không được âm thầm đổi luôn đích đến nếu provider đổi base_url giữa chừng.
  const frozenBaseUrl = target.baseUrl
  const tried: string[] = []
  let attempts = 0
  let last: ProviderResponse | null = null

  while (attempts < limit) {
    tried.push(target.credentialId)
    attempts += 1
    // Ghim trước khi gửi: nếu tiến trình chết giữa chừng, tác vụ vẫn biết key nào
    // có thể đã nhận yêu cầu.
    onAttempt?.(target)

    // Lỗi mạng/timeout: ném thẳng ra ngoài, KHÔNG đổi key (có thể đã tính phí).
    const response = await call(target)
    last = response

    if (!RETRYABLE_KEY_STATUSES.has(response.status)) {
      recordTargetResult(db, target, {
        status: response.status,
        ok: response.ok,
        retryAfterSeconds: retryAfterFromResponse(response),
      })
      return { response, target, attempts, exhausted: false }
    }

    // Từ chối rõ ràng vì key: cập nhật sức khỏe rồi thử key khác.
    recordTargetResult(db, target, {
      status: response.status,
      retryAfterSeconds: retryAfterFromResponse(response),
    })

    if (attempts >= limit) break

    try {
      target = selectPoolTarget(db, env, providerId, {
        exclude: tried,
        advance: false,
        baseUrlOverride: frozenBaseUrl,
      })
    } catch {
      // Hết key khả dụng: trả phản hồi từ chối cuối cùng để báo lỗi chắc chắn.
      return { response, target, attempts, exhausted: true }
    }
  }

  if (!last) {
    throw providerError(
      'Không có API key khả dụng cho provider này.',
      undefined,
      errorMeta('providers.no_available_credentials'),
    )
  }

  return { response: last, target, attempts, exhausted: true }
}

/**
 * GỌI MỘT ENDPOINT CHỈ ĐỌC (ví dụ GET /models) với cơ chế đổi key.
 *
 * Request chỉ đọc không tạo chi phí nên được phép thử key kế tiếp cả khi lỗi
 * mạng, timeout hay 5xx. Route kiểm tra kết nối / đồng bộ model có thể dùng hàm
 * này để không "chết" vì một key hỏng.
 */
export async function readWithPool(options: PoolReadOptions): Promise<PoolReadOutcome> {
  const { db, env, providerId, call, onAttempt } = options
  const limit = Math.min(
    Math.max(1, options.maxAttempts ?? MAX_CREDENTIALS_PER_PROVIDER),
    MAX_CREDENTIALS_PER_PROVIDER,
  )

  let target = initialOrSelected(db, env, providerId, options.initial)
  // Xem `submitWithPool`: URL được đóng băng trong suốt lần gọi chỉ đọc.
  const frozenBaseUrl = target.baseUrl
  const tried: string[] = []
  let attempts = 0
  let last: { response: ProviderResponse; target: SelectedProviderTarget } | null = null
  let lastError: unknown = null

  while (attempts < limit) {
    tried.push(target.credentialId)
    attempts += 1
    onAttempt?.(target)

    let response: ProviderResponse
    try {
      response = await call(target)
    } catch (error) {
      lastError = error
      recordTargetResult(db, target, { message: messageOf(error) })
      if (attempts >= limit) throw error
      try {
        target = selectPoolTarget(db, env, providerId, {
          exclude: tried,
          advance: false,
          baseUrlOverride: frozenBaseUrl,
        })
      } catch {
        throw error
      }
      continue
    }

    last = { response, target }
    const retryable = RETRYABLE_KEY_STATUSES.has(response.status) || response.status >= 500

    recordTargetResult(db, target, {
      status: response.status,
      ok: retryable ? false : response.ok,
      retryAfterSeconds: retryAfterFromResponse(response),
    })

    if (!retryable) return { response, target, attempts, exhausted: false }
    if (attempts >= limit) break

    try {
      target = selectPoolTarget(db, env, providerId, {
        exclude: tried,
        advance: false,
        baseUrlOverride: frozenBaseUrl,
      })
    } catch {
      return { response, target, attempts, exhausted: true }
    }
  }

  if (last) return { ...last, attempts, exhausted: true }
  throw lastError ?? providerError('Không gọi được provider', undefined, errorMeta('errors.provider_error'))
}

/** Lưu key + URL đang dùng vào hàng tác vụ TRƯỚC khi gửi provider. */
export function pinGenerationTarget(
  db: Database,
  generationId: string,
  target: Pick<SelectedProviderTarget, 'credentialId' | 'keyHint' | 'baseUrl'>,
): void {
  db.prepare(
    `UPDATE generations
        SET credential_id = ?, snap_credential_hint = ?, snap_credential_base_url = ?, updated_at = ?
      WHERE id = ?`,
  ).run(target.credentialId, target.keyHint, target.baseUrl, Date.now(), generationId)
}

/**
 * Key dự phòng cho tác vụ CŨ chưa có `credential_id`.
 *
 * Migration 016 đã ghim mọi tác vụ cũ vào key tất định `cred_<provider_id>` —
 * chính là bản ghi chứa nguyên key legacy, nên không phải "đoán" key khác.
 * Nếu provider chỉ có đúng một key trong pool thì đó cũng là lựa chọn duy nhất,
 * không mơ hồ. Nhiều key mà không rõ key nào ⇒ từ chối thay vì đoán bừa.
 */
function repairCredentialId(db: Database, providerId: string): string | null {
  const deterministic = `cred_${providerId}`
  const exact = db.prepare('SELECT id FROM provider_credentials WHERE id = ?').get(deterministic) as
    | { id: string }
    | undefined
  if (exact) return exact.id

  const rows = db
    .prepare(
      'SELECT id FROM provider_credentials WHERE provider_id = ? ORDER BY position ASC, created_at ASC',
    )
    .all(providerId) as unknown as Array<{ id: string }>
  return rows.length === 1 ? rows[0]!.id : null
}

/**
 * Đích gọi ĐÃ GHIM của một tác vụ đã gửi provider.
 *
 * Trả `null` khi provider không còn tồn tại (hàng tác vụ sẽ báo lỗi rõ). Ném lỗi
 * khi provider còn nhưng không xác định được key đã ghim — không bao giờ tự
 * chuyển sang key khác cho tác vụ đang dở.
 */
export function pinnedTargetForRow(
  db: Database,
  env: AppEnv,
  row: PinnedGenerationRow,
): SelectedProviderTarget | null {
  if (!row.provider_id) return null

  const provider = db.prepare('SELECT 1 AS ok FROM provider_connections WHERE id = ?').get(row.provider_id)
  if (!provider) return null

  const credentialId = row.credential_id ?? repairCredentialId(db, row.provider_id)
  if (!credentialId) {
    throw providerError(
      'Tác vụ này không xác định được API key đã dùng. Hãy thêm lại đúng key vào provider hoặc tạo tác vụ mới.',
      undefined,
      errorMeta('providers.no_available_credentials'),
    )
  }

  const baseUrl = (row.snap_credential_base_url || row.snap_base_url || '').trim()
  let target: SelectedProviderTarget
  try {
    target = resolvePinnedCredential(db, env, credentialId, baseUrl)
  } catch (error) {
    throw asPoolSelectionError(error)
  }

  // Sửa luôn dấu ghim còn thiếu để các vòng poll sau và thao tác xoá key thấy đúng.
  if (!row.credential_id) pinGenerationTarget(db, row.id, target)
  return target
}
