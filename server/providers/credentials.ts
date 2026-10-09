/**
 * Pool API key đa khóa cho provider (multi-key foundation).
 *
 * Quan hệ với phần còn lại của hệ thống:
 *   - URL nằm ở `provider_connections` (dùng chung cho cả pool). Bảng
 *     `provider_credentials` chỉ giữ bí mật của từng key + trạng thái sức khỏe.
 *   - Bí mật mã hóa AES-256-GCM (dùng lại `server/crypto/providerKey.ts`).
 *     `fingerprint` = HMAC-SHA256(key gốc, khóa chủ) để phát hiện trùng lặp mà
 *     không lưu/không so sánh key thô. Bản ghi backfill từ dữ liệu cũ có
 *     fingerprint NULL (migration không có khóa chủ).
 *   - Cột legacy `api_key_*`/`key_hint` trên provider vẫn được giữ để rollback
 *     nhưng KHÔNG bao giờ là fallback lúc chạy: pool rỗng ⇒ lỗi rõ ràng.
 *
 * Tất cả hàm ở đây chạy đồng bộ trên node:sqlite. Các thao tác ghi nhiều bước
 * (chọn key + con trỏ round-robin, sắp xếp lại, thêm/xóa key) được bọc trong
 * transaction IMMEDIATE để hai vòng worker không chọn trùng hay ghi đè nhau.
 */
import { createHmac, randomUUID } from 'node:crypto'
import type { AppEnv } from '../env'
import type { Database } from '../db/index'
import type { ProviderTarget } from './client'
import {
  decodeMasterKey,
  decryptSecret,
  encryptSecret,
  keyHint,
  type EncryptedSecret,
} from '../crypto/providerKey'
import {
  badRequest,
  conflict,
  errorMeta,
  notFound,
  providerError,
  tooManyRequests,
  type ErrorMessageKey,
  type ErrorMessageParams,
} from '../lib/errors'
import { isErrorMessageKey } from '../../shared/errorCatalog'

/** Trần số key cho một provider. */
export const MAX_CREDENTIALS_PER_PROVIDER = 10
/** Thời gian nghỉ mặc định khi provider trả 429 mà không kèm Retry-After. */
export const CREDENTIAL_COOLDOWN_DEFAULT_SECONDS = 60
/** Trần thời gian nghỉ khi provider trả 429 (1 giờ). */
export const CREDENTIAL_COOLDOWN_MAX_SECONDS = 3600

export type ProviderSelectionMode = 'failover' | 'round_robin'
export type CredentialHealthStatus = 'ok' | 'auth_failed' | 'cooldown' | 'unknown'

/** Bản ghi thô trong `provider_credentials` (có cả cột bí mật). */
export type CredentialRow = {
  id: string
  provider_id: string
  label: string
  ciphertext: Uint8Array
  iv: Uint8Array
  tag: Uint8Array
  hint: string
  fingerprint: string | null
  position: number
  enabled: number
  health_status: string
  cooldown_until: number | null
  last_used_at: number | null
  last_error: string | null
  last_error_key: string | null
  last_error_params: string | null
  created_at: number
  updated_at: number
}

/** Mô hình đọc công khai: KHÔNG bao giờ chứa bí mật hay bản mã. */
export type ProviderCredential = {
  id: string
  providerId: string
  label: string
  hint: string
  position: number
  enabled: boolean
  healthStatus: CredentialHealthStatus
  cooldownUntil: number | null
  lastUsedAt: number | null
  lastError: string | null
  lastErrorKey: ErrorMessageKey
  lastErrorParams: ErrorMessageParams
  createdAt: number
  updatedAt: number
}

/** Đích gọi provider kèm key đã chọn — hợp đồng cho worker/adapter. */
export type SelectedProviderTarget = ProviderTarget & {
  credentialId: string
  keyHint: string
  /**
   * Vân tay HMAC của key tại ĐÚNG thời điểm chọn (nội bộ, không bao giờ trả ra
   * HTTP). `recordCredentialResult` so lại trước khi ghi: request bất đồng bộ
   * (LLM/GET/poll) có thể kết thúc sau khi người dùng xoay bí mật, khi đó kết
   * quả cũ không được phép "đầu độc" key mới.
   */
  expectedFingerprint?: string
}

export type CredentialInput = {
  apiKey: string
  label?: string
  /** Vị trí ưu tiên mong muốn (0 = cao nhất); mặc định thêm vào cuối. */
  position?: number
  enabled?: boolean
}

export type CredentialUpdate = {
  label?: string
  enabled?: boolean
  /** Dời key tới vị trí này trong danh sách hiện tại (được phép cả khi đang ghim). */
  position?: number
  /** Đổi bí mật; bị chặn nếu key đang được tác vụ ghim. */
  apiKey?: string
}

export type SelectCredentialOptions = {
  /** Id key cần bỏ qua (ví dụ key vừa lỗi trong cùng một lần gửi). */
  exclude?: string[]
  /** Đích thay thế URL của provider (dùng khi trả lại snapshot cũ). */
  baseUrlOverride?: string
  /**
   * true (mặc định): ghi nhận key đã dùng (cập nhật con trỏ round-robin và
   * `last_used_at`). false: chỉ xem trước, không đổi trạng thái.
   */
  advance?: boolean
}

/** Kết quả một lần gọi provider, dùng để cập nhật sức khỏe của key. */
export type CredentialResultInput = {
  /** HTTP status; bỏ trống với lỗi mạng/cục bộ. */
  status?: number
  ok?: boolean
  /** Số giây lấy từ header Retry-After (đã quy đổi). */
  retryAfterSeconds?: number | null
  message?: string | null
  /**
   * true khi đây chỉ là QUAN SÁT từ một tác vụ đã ghim key (poll/tải lại dùng
   * đúng key đã gửi). Thành công của một lần quan sát KHÔNG được xóa
   * `auth_failed`/cooldown do tác vụ khác gây ra: key vẫn phải tiếp tục bị
   * tránh cho tới khi có bằng chứng từ một lần chọn mới.
   */
  observeOnly?: boolean
  /**
   * Vân tay HMAC của key lúc bắt đầu request (lấy từ `SelectedProviderTarget`).
   * Nếu key đã bị xoay/xóa trong lúc request đang bay, kết quả cũ bị bỏ qua.
   */
  expectedFingerprint?: string
}

export type CredentialPool = {
  providerId: string
  baseUrl: string
  selectionMode: ProviderSelectionMode
  rrCursor: number | null
  credentials: ProviderCredential[]
}

// ── Mã hóa & dấu vân tay ─────────────────────────────────────────────────────

/** Khóa chủ đã giải mã từ `env.APP_ENCRYPTION_KEY`. */
export function credentialMasterKey(env: AppEnv): Buffer {
  return decodeMasterKey(env.APP_ENCRYPTION_KEY)
}

/** Mã hóa bí mật của một key (AES-256-GCM, IV ngẫu nhiên mỗi lần). */
export function encryptCredentialSecret(env: AppEnv, apiKey: string): EncryptedSecret {
  return encryptSecret(apiKey, credentialMasterKey(env))
}

/** Giải mã bí mật của một key. */
export function decryptCredentialSecret(
  env: AppEnv,
  secret: { ciphertext: Uint8Array; iv: Uint8Array; tag: Uint8Array },
): string {
  try {
    return decryptSecret(
      {
        ciphertext: Buffer.from(secret.ciphertext),
        iv: Buffer.from(secret.iv),
        tag: Buffer.from(secret.tag),
      },
      credentialMasterKey(env),
    )
  } catch {
    throw providerError('Không giải mã được API key.', undefined, errorMeta('providers.credential_decrypt_failed'))
  }
}

/**
 * Dấu vân tay HMAC-SHA256 của key gốc. Có tách miền (domain separation) để
 * không trùng với HMAC dùng cho mục đích khác. Không thể khôi phục key từ đây.
 */
export function credentialFingerprint(env: AppEnv, apiKey: string): string {
  return createHmac('sha256', credentialMasterKey(env))
    .update('lumina.provider-credential.v1\0', 'utf8')
    .update(apiKey.trim(), 'utf8')
    .digest('hex')
}

// ── Tiện ích nội bộ ──────────────────────────────────────────────────────────

type OwnedProviderRow = {
  id: string
  base_url: string
  selection_mode: string | null
  rr_cursor: number | null
}

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

function ownedProvider(db: Database, userId: string, providerId: string): OwnedProviderRow {
  const row = db
    .prepare('SELECT id, base_url, selection_mode, rr_cursor FROM provider_connections WHERE id = ? AND user_id = ?')
    .get(providerId, userId) as unknown as OwnedProviderRow | undefined
  if (!row) throw notFound('Không tìm thấy provider', errorMeta('providers.not_found'))
  return row
}

function listRows(db: Database, providerId: string): CredentialRow[] {
  return db
    .prepare(
      `SELECT * FROM provider_credentials
        WHERE provider_id = ?
        ORDER BY position ASC, created_at ASC, id ASC`,
    )
    .all(providerId) as unknown as CredentialRow[]
}

function rowById(db: Database, credentialId: string): CredentialRow | undefined {
  return db.prepare('SELECT * FROM provider_credentials WHERE id = ?').get(credentialId) as unknown as
    | CredentialRow
    | undefined
}

function rowForProvider(db: Database, providerId: string, credentialId: string): CredentialRow {
  const row = db
    .prepare('SELECT * FROM provider_credentials WHERE id = ? AND provider_id = ?')
    .get(credentialId, providerId) as unknown as CredentialRow | undefined
  if (!row) throw notFound('Không tìm thấy API key', errorMeta('errors.not_found'))
  return row
}

function normalizeHealth(value: string): CredentialHealthStatus {
  if (value === 'ok' || value === 'auth_failed' || value === 'cooldown') return value
  return 'unknown'
}

function normalizeMode(value: string | null): ProviderSelectionMode {
  return value === 'round_robin' ? 'round_robin' : 'failover'
}

function errorKeyOf(row: { last_error_key: string | null; last_error: string | null }): ErrorMessageKey {
  if (row.last_error_key && isErrorMessageKey(row.last_error_key)) return row.last_error_key
  return row.last_error ? 'providers.test_failed' : 'errors.provider_error'
}

function errorParamsOf(row: { last_error_params: string | null; last_error: string | null }): ErrorMessageParams {
  if (!row.last_error_params) return row.last_error ? { detail: row.last_error } : {}
  try {
    const parsed: unknown = JSON.parse(row.last_error_params)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as ErrorMessageParams
  } catch {
    // Dữ liệu hỏng: bỏ qua tham số.
  }
  return {}
}

function toPublic(row: CredentialRow): ProviderCredential {
  return {
    id: row.id,
    providerId: row.provider_id,
    label: row.label,
    hint: row.hint,
    position: Number(row.position),
    enabled: Number(row.enabled) === 1,
    healthStatus: normalizeHealth(row.health_status),
    cooldownUntil: row.cooldown_until === null ? null : Number(row.cooldown_until),
    lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
    lastError: row.last_error,
    lastErrorKey: errorKeyOf(row),
    lastErrorParams: errorParamsOf(row),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function normalizeApiKey(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw badRequest('Vui lòng nhập API key')
  if (trimmed.length > 500) throw badRequest('API key tối đa 500 ký tự')
  return trimmed
}

function normalizeLabel(value: string | undefined): string {
  const trimmed = (value ?? '').trim()
  if (trimmed.length > 80) throw badRequest('Nhãn API key tối đa 80 ký tự')
  return trimmed
}

function clampPosition(value: number, max: number): number {
  if (!Number.isFinite(value)) return max
  return Math.min(Math.max(0, Math.trunc(value)), max)
}

/** Ghi lại thứ tự 0..n-1 cho toàn bộ danh sách id (đã đúng thứ tự mong muốn). */
function writePositions(db: Database, orderedIds: string[]): void {
  const now = Date.now()
  const update = db.prepare('UPDATE provider_credentials SET position = ?, updated_at = ? WHERE id = ?')
  orderedIds.forEach((id, index) => update.run(index, now, id))
}

function normalizePositions(db: Database, providerId: string): void {
  writePositions(
    db,
    listRows(db, providerId).map((row) => row.id),
  )
}

/**
 * Đặt lại con trỏ round-robin về NULL.
 *
 * `rr_cursor` ghi theo `position`; mọi thao tác làm đổi thứ tự/vị trí key
 * (sắp xếp lại, dời key, thêm key vào giữa, xóa key) đều khiến con trỏ cũ trỏ
 * sai chỗ. Đặt lại để lần chọn kế tiếp bắt đầu từ thứ tự ưu tiên đã lưu.
 */
function resetRoundRobinCursor(db: Database, providerId: string): void {
  db.prepare(
    'UPDATE provider_connections SET rr_cursor = NULL, updated_at = ? WHERE id = ? AND rr_cursor IS NOT NULL',
  ).run(Date.now(), providerId)
}

/** Dời một key tới vị trí mong muốn rồi chuẩn hóa lại toàn bộ vị trí. */
function moveCredential(db: Database, providerId: string, credentialId: string, position: number): void {
  const rows = listRows(db, providerId)
  const ids = rows.map((row) => row.id)
  const from = ids.indexOf(credentialId)
  if (from === -1) throw notFound('Không tìm thấy API key', errorMeta('errors.not_found'))
  const others = ids.filter((id) => id !== credentialId)
  const target = clampPosition(position, others.length)
  const next = [...others.slice(0, target), credentialId, ...others.slice(target)]
  writePositions(db, next)
  resetRoundRobinCursor(db, providerId)
}

/**
 * Key có đang bị tác vụ ghim hay không.
 *
 * Bị ghim khi: `running`/`downloading`/`unknown`, `failed` nhưng đã có
 * `provider_job_id` (có thể thử tải lại), hoặc bản ghi `queued` cũ đã ghim key
 * từ lần gửi trước. Những trạng thái này không cho đổi bí mật hay xóa key để
 * tác vụ đang dở không mất quyền truy cập.
 */
export function isCredentialPinned(db: Database, credentialId: string): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total FROM generations
        WHERE credential_id = ?
          AND (status IN ('queued', 'running', 'downloading', 'unknown')
               OR (status = 'failed' AND provider_job_id IS NOT NULL))`,
    )
    .get(credentialId) as unknown as { total: number }
  return Number(row.total) > 0
}

function assertCredentialUnpinned(db: Database, credentialId: string): void {
  if (!isCredentialPinned(db, credentialId)) return
  throw conflict(
    'API key này đang được dùng cho tác vụ chưa kết thúc. Hãy đợi hoàn tất hoặc xóa tác vụ trước.',
    errorMeta('providers.credential_in_use'),
  )
}

// ── Đọc ──────────────────────────────────────────────────────────────────────

/** Danh sách key của provider, đã sắp theo thứ tự ưu tiên. */
export function listCredentials(db: Database, userId: string, providerId: string): ProviderCredential[] {
  ownedProvider(db, userId, providerId)
  return listRows(db, providerId).map(toPublic)
}

/** Một key công khai (không có bí mật). */
export function getCredential(
  db: Database,
  userId: string,
  providerId: string,
  credentialId: string,
): ProviderCredential {
  ownedProvider(db, userId, providerId)
  return toPublic(rowForProvider(db, providerId, credentialId))
}

/** Thông tin pool cho giao diện: URL, chế độ chọn, con trỏ và danh sách key. */
export function getCredentialPool(db: Database, userId: string, providerId: string): CredentialPool {
  const provider = ownedProvider(db, userId, providerId)
  return {
    providerId: provider.id,
    baseUrl: provider.base_url,
    selectionMode: normalizeMode(provider.selection_mode),
    rrCursor: provider.rr_cursor === null ? null : Number(provider.rr_cursor),
    credentials: listRows(db, providerId).map(toPublic),
  }
}

// ── Ghi (CRUD, có kiểm tra quyền sở hữu) ────────────────────────────────────

/**
 * Thêm một key vào pool. Từ chối khi vượt trần 10 key hoặc khi key đã tồn tại
 * trong cùng provider (so theo fingerprint HMAC).
 */
function fingerprintForRow(db: Database, env: AppEnv, row: CredentialRow): string | null {
  if (row.fingerprint) return row.fingerprint
  let secret: string
  try {
    secret = decryptCredentialSecret(env, row)
  } catch {
    // A corrupted legacy secret must not block adding a replacement key.
    return null
  }
  const fingerprint = credentialFingerprint(env, secret)
  db.prepare('UPDATE provider_credentials SET fingerprint = ? WHERE id = ? AND fingerprint IS NULL').run(fingerprint, row.id)
  return fingerprint
}

export function addCredential(
  db: Database,
  env: AppEnv,
  userId: string,
  providerId: string,
  input: CredentialInput,
): ProviderCredential {
  const apiKey = normalizeApiKey(input.apiKey)
  const label = normalizeLabel(input.label)
  const fingerprint = credentialFingerprint(env, apiKey)

  return inTransaction(db, () => {
    ownedProvider(db, userId, providerId)
    const rows = listRows(db, providerId)

    if (rows.length >= MAX_CREDENTIALS_PER_PROVIDER) {
      throw conflict(
        `Mỗi provider chỉ hỗ trợ tối đa ${MAX_CREDENTIALS_PER_PROVIDER} API key.`,
        errorMeta('providers.credential_limit', { max: MAX_CREDENTIALS_PER_PROVIDER }),
      )
    }
    if (rows.some((row) => fingerprintForRow(db, env, row) === fingerprint)) {
      throw conflict('API key này đã tồn tại trong provider.', errorMeta('providers.credential_duplicate'))
    }

    const encrypted = encryptSecret(apiKey, credentialMasterKey(env))
    const id = randomUUID()
    const now = Date.now()

    db.prepare(
      `INSERT INTO provider_credentials
         (id, provider_id, label, ciphertext, iv, tag, hint, fingerprint, position, enabled,
          health_status, cooldown_until, last_used_at, last_error, last_error_key, last_error_params,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    ).run(
      id,
      providerId,
      label,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.tag,
      keyHint(apiKey),
      fingerprint,
      rows.length,
      input.enabled === false ? 0 : 1,
      now,
      now,
    )

    if (input.position !== undefined) {
      moveCredential(db, providerId, id, input.position)
    } else {
      normalizePositions(db, providerId)
    }

    return toPublic(rowById(db, id)!)
  })
}

/**
 * Cập nhật key. `label`/`enabled`/`position` luôn được phép (kể cả khi key đang
 * bị ghim); đổi `apiKey` bị chặn khi key đang ghim.
 */
export function updateCredential(
  db: Database,
  env: AppEnv,
  userId: string,
  providerId: string,
  credentialId: string,
  patch: CredentialUpdate,
): ProviderCredential {
  return inTransaction(db, () => {
    ownedProvider(db, userId, providerId)
    rowForProvider(db, providerId, credentialId)

    const updates: string[] = []
    const values: Array<string | number | Uint8Array | null> = []

    if (patch.apiKey !== undefined) {
      assertCredentialUnpinned(db, credentialId)
      const apiKey = normalizeApiKey(patch.apiKey)
      const fingerprint = credentialFingerprint(env, apiKey)
      const duplicate = listRows(db, providerId).find(
        (row) => row.id !== credentialId && fingerprintForRow(db, env, row) === fingerprint,
      )
      if (duplicate) throw conflict('API key này đã tồn tại trong provider.', errorMeta('providers.credential_duplicate'))

      const encrypted = encryptSecret(apiKey, credentialMasterKey(env))
      updates.push(
        'ciphertext = ?', 'iv = ?', 'tag = ?', 'hint = ?', 'fingerprint = ?',
        "health_status = 'unknown'", 'cooldown_until = NULL', 'last_error = NULL',
        'last_error_key = NULL', 'last_error_params = NULL',
      )
      values.push(encrypted.ciphertext, encrypted.iv, encrypted.tag, keyHint(apiKey), fingerprint)
    }

    if (patch.label !== undefined) {
      updates.push('label = ?')
      values.push(normalizeLabel(patch.label))
    }

    if (patch.enabled !== undefined) {
      updates.push('enabled = ?')
      values.push(patch.enabled ? 1 : 0)
    }

    if (updates.length === 0 && patch.position === undefined) {
      throw badRequest('Không có thay đổi nào để lưu', undefined, errorMeta('validation.invalid_payload'))
    }

    if (updates.length > 0) {
      updates.push('updated_at = ?')
      values.push(Date.now())
      db.prepare(
        `UPDATE provider_credentials SET ${updates.join(', ')} WHERE id = ? AND provider_id = ?`,
      ).run(...values, credentialId, providerId)
    }

    if (patch.position !== undefined) {
      moveCredential(db, providerId, credentialId, patch.position)
    }

    return toPublic(rowById(db, credentialId)!)
  })
}

/** Xóa key. Bị chặn khi key đang được tác vụ ghim. */
export function removeCredential(
  db: Database,
  userId: string,
  providerId: string,
  credentialId: string,
): void {
  inTransaction(db, () => {
    ownedProvider(db, userId, providerId)
    rowForProvider(db, providerId, credentialId)
    assertCredentialUnpinned(db, credentialId)
    db.prepare('DELETE FROM provider_credentials WHERE id = ? AND provider_id = ?').run(credentialId, providerId)
    normalizePositions(db, providerId)
    resetRoundRobinCursor(db, providerId)
  })
}

/**
 * Sắp xếp lại TOÀN BỘ key theo đúng thứ tự gửi lên. Từ chối nếu danh sách
 * không khớp chính xác tập key hiện có (thiếu, thừa hoặc trùng).
 */
export function reorderCredentials(
  db: Database,
  userId: string,
  providerId: string,
  orderedIds: string[],
): ProviderCredential[] {
  return inTransaction(db, () => {
    ownedProvider(db, userId, providerId)
    const current = listRows(db, providerId)
    const currentIds = new Set(current.map((row) => row.id))
    const nextIds = new Set(orderedIds)

    const exact =
      orderedIds.length === current.length &&
      nextIds.size === orderedIds.length &&
      orderedIds.every((id) => currentIds.has(id))

    if (!exact) {
      throw badRequest(
        'Danh sách sắp xếp phải bao gồm đúng toàn bộ API key của provider.',
        undefined,
        errorMeta('validation.invalid_payload'),
      )
    }

    writePositions(db, orderedIds)
    resetRoundRobinCursor(db, providerId)
    return listRows(db, providerId).map(toPublic)
  })
}

/** Đổi chế độ chọn key của provider; đặt lại con trỏ round-robin. */
export function setProviderSelectionMode(
  db: Database,
  userId: string,
  providerId: string,
  mode: ProviderSelectionMode,
): void {
  if (mode !== 'failover' && mode !== 'round_robin') {
    throw badRequest('Chế độ chọn API key không hợp lệ', undefined, errorMeta('validation.invalid_payload'))
  }
  ownedProvider(db, userId, providerId)
  db.prepare(
    'UPDATE provider_connections SET selection_mode = ?, rr_cursor = NULL, updated_at = ? WHERE id = ? AND user_id = ?',
  ).run(mode, Date.now(), providerId, userId)
}

// ── Chọn key lúc chạy ────────────────────────────────────────────────────────

function isEligible(row: CredentialRow, now: number): boolean {
  if (Number(row.enabled) !== 1) return false
  if (row.health_status === 'auth_failed') return false
  const until = row.cooldown_until === null ? null : Number(row.cooldown_until)
  return until === null || until <= now
}

function isCoolingDown(row: CredentialRow, now: number): boolean {
  if (Number(row.enabled) !== 1) return false
  if (row.health_status === 'auth_failed') return false
  const until = row.cooldown_until === null ? null : Number(row.cooldown_until)
  return until !== null && until > now
}

function noAvailableCredentialError(
  roots: CredentialRow[],
  excluded: Set<string>,
  now: number,
): Error {
  const cooling = roots.filter((row) => isCoolingDown(row, now) && !excluded.has(row.id))
  if (cooling.length > 0) {
    const soonest = Math.min(...cooling.map((row) => Number(row.cooldown_until)))
    const retryAfter = Math.max(1, Math.ceil((soonest - now) / 1000))
    return tooManyRequests(
      `Tất cả API key của provider đang tạm nghỉ. Thử lại sau ${retryAfter} giây.`,
      errorMeta('providers.credentials_cooldown', { retryAfter }),
    )
  }

  if (roots.length === 0) {
    return providerError(
      'Provider chưa có API key khả dụng. Hãy thêm key trong API & Models.',
      undefined,
      errorMeta('providers.no_available_credentials'),
    )
  }

  return providerError(
    excluded.size > 0
      ? 'Không còn API key nào để thử cho tác vụ này.'
      : 'Không có API key khả dụng (đang tắt, sai quyền hoặc đang nghỉ).',
    undefined,
    errorMeta('providers.no_available_credentials'),
  )
}

/**
 * Chọn một key khả dụng và trả đích gọi provider.
 *
 * Trong MỘT transaction IMMEDIATE (đồng bộ):
 *   - bỏ qua key đã tắt, `auth_failed`, đang trong thời gian nghỉ, hoặc nằm
 *     trong `options.exclude`;
 *   - `failover`: lấy key ưu tiên cao nhất (position nhỏ nhất);
 *   - `round_robin`: lấy key kế tiếp theo con trỏ đã lưu (`rr_cursor`) trong
 *     thứ tự position, quay vòng khi hết;
 *   - ghi `last_used_at` (và `rr_cursor` nếu round-robin) khi `advance !== false`.
 *
 * Pool rỗng ⇒ ném lỗi, KHÔNG fallback về cột `api_key_*` legacy. Tất cả key
 * đang nghỉ ⇒ lỗi 429 kèm `messageParams.retryAfter` (giây).
 */
export function selectCredential(
  db: Database,
  env: AppEnv,
  providerId: string,
  options: SelectCredentialOptions = {},
): SelectedProviderTarget {
  const excluded = new Set(options.exclude ?? [])
  const advance = options.advance !== false

  return inTransaction(db, () => {
    const now = Date.now()
    const provider = db
      .prepare('SELECT id, base_url, selection_mode, rr_cursor FROM provider_connections WHERE id = ?')
      .get(providerId) as unknown as OwnedProviderRow | undefined
    if (!provider) throw notFound('Không tìm thấy provider', errorMeta('providers.not_found'))

    const roots = listRows(db, providerId)
    const eligible = roots
      .filter((row) => isEligible(row, now) && !excluded.has(row.id))
      .slice(0, MAX_CREDENTIALS_PER_PROVIDER)

    if (eligible.length === 0) {
      throw noAvailableCredentialError(roots, excluded, now)
    }

    const mode = normalizeMode(provider.selection_mode)
    let chosen = eligible[0]!

    if (mode === 'round_robin') {
      const cursor = provider.rr_cursor === null ? null : Number(provider.rr_cursor)
      if (cursor !== null) {
        chosen = eligible.find((row) => Number(row.position) > cursor) ?? eligible[0]!
      }
    }

    if (advance) {
      if (mode === 'round_robin') {
        db.prepare('UPDATE provider_connections SET rr_cursor = ?, updated_at = ? WHERE id = ?').run(
          chosen.position,
          now,
          providerId,
        )
      }
      db.prepare('UPDATE provider_credentials SET last_used_at = ?, updated_at = ? WHERE id = ?').run(
        now,
        now,
        chosen.id,
      )
    }

    const apiKey = decryptCredentialSecret(env, chosen)
    // Bản ghi backfill từ migration có fingerprint NULL: băm lười ngay từ bí mật
    // vừa giải mã (và lưu lại) để guard chống xoay key ở `recordCredentialResult`
    // luôn có mốc so sánh.
    const expectedFingerprint =
      chosen.fingerprint ?? fingerprintForRow(db, env, chosen) ?? credentialFingerprint(env, apiKey)

    return {
      baseUrl: options.baseUrlOverride ?? provider.base_url,
      apiKey,
      allowPrivate: env.ALLOW_PRIVATE_PROVIDER_URLS,
      credentialId: chosen.id,
      keyHint: chosen.hint,
      expectedFingerprint,
    }
  })
}

/**
 * Giải mã đúng key đã ghim của một tác vụ, BỎ QUA `enabled`/`health_status`/
 * cooldown — tác vụ đã gửi provider phải tiếp tục bằng chính key đó. `baseUrl`
 * là URL đã chụp lúc ghim (`generations.snap_credential_base_url`).
 */
export function resolvePinnedCredential(
  db: Database,
  env: AppEnv,
  credentialId: string,
  baseUrl: string,
): SelectedProviderTarget {
  const row = rowById(db, credentialId)
  if (!row) {
    throw notFound('Không tìm thấy API key đã ghim cho tác vụ', errorMeta('providers.not_found'))
  }

  const apiKey = decryptCredentialSecret(env, row)
  const expectedFingerprint =
    row.fingerprint ?? fingerprintForRow(db, env, row) ?? credentialFingerprint(env, apiKey)

  return {
    baseUrl,
    apiKey,
    allowPrivate: env.ALLOW_PRIVATE_PROVIDER_URLS,
    credentialId: row.id,
    keyHint: row.hint,
    expectedFingerprint,
  }
}

function clampRetryAfterSeconds(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return CREDENTIAL_COOLDOWN_DEFAULT_SECONDS
  }
  return Math.min(CREDENTIAL_COOLDOWN_MAX_SECONDS, Math.max(1, Math.round(value)))
}

/**
 * Key đang ở trạng thái mà một QUAN SÁT thành công không được phép xóa:
 * `auth_failed`, hoặc còn trong thời gian cooldown (kể cả khi cột trạng thái
 * chưa kịp đổi). Dùng cho `observeOnly`.
 */
function pinnedKeyIsUnhealthy(row: CredentialRow, now: number): boolean {
  if (row.health_status === 'auth_failed' || row.health_status === 'cooldown') return true
  const until = row.cooldown_until === null ? null : Number(row.cooldown_until)
  return until !== null && until > now
}

/**
 * Ghi nhận kết quả một lần gọi provider cho key:
 *   - thành công (ok/2xx): xóa cooldown + lỗi, đặt `health_status = 'ok'` — trừ
 *     khi `observeOnly` và key đang `auth_failed`/cooldown (xem bên dưới);
 *   - 401/403: `auth_failed` (key sai quyền, không tự dùng lại);
 *   - 429: `cooldown` tới `retryAfterSeconds` (mặc định 60, trần 3600 giây);
 *   - còn lại: chỉ ghi `last_error`, giữ nguyên trạng thái sức khỏe.
 *
 * Guard chống đua: nếu `result.expectedFingerprint` được truyền (từ
 * `SelectedProviderTarget`) và không khớp fingerprint hiện tại của key — key đã
 * bị xoay bí mật giữa chừng — thì bỏ qua toàn bộ kết quả. Key bị xóa trong lúc
 * request đang bay cũng bị bỏ qua (không có hàng để ghi).
 */
export function recordCredentialResult(
  db: Database,
  credentialId: string,
  result: CredentialResultInput,
): void {
  const now = Date.now()
  const row = rowById(db, credentialId)
  if (!row) return

  // Request bất đồng bộ (LLM/GET/poll) không có ghim bền: bí mật có thể đã bị
  // xoay trong lúc chờ. Kết quả của request cũ không được áp lên key mới.
  if (result.expectedFingerprint && row.fingerprint !== result.expectedFingerprint) return

  const status = result.status
  const success =
    result.ok === true ||
    (result.ok !== false && typeof status === 'number' && status >= 200 && status < 300)

  if (success) {
    // Quan sát từ tác vụ đã ghim: không "hồi sinh" key mà tác vụ khác đã đánh
    // dấu sai quyền hoặc đang nghỉ. Chỉ cập nhật dấu thời gian sử dụng.
    if (result.observeOnly) {
      db.prepare('UPDATE provider_credentials SET last_used_at = ?, updated_at = ? WHERE id = ?').run(
        now,
        now,
        credentialId,
      )
      return
    }

    db.prepare(
      `UPDATE provider_credentials
          SET health_status = 'ok', cooldown_until = NULL, last_error = NULL,
              last_error_key = NULL, last_error_params = NULL,
              last_used_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(now, now, credentialId)
    return
  }

  if (status === 401 || status === 403) {
    const message = (result.message ?? 'API key không hợp lệ hoặc không có quyền truy cập').slice(0, 500)
    db.prepare(
      `UPDATE provider_credentials
          SET health_status = 'auth_failed', cooldown_until = NULL, last_error = ?,
              last_error_key = 'providers.api_key_invalid', last_error_params = ?,
              last_used_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(message, JSON.stringify({ detail: message }), now, now, credentialId)
    return
  }

  if (status === 429) {
    const seconds = clampRetryAfterSeconds(result.retryAfterSeconds)
    const message = (result.message ?? `Provider yêu cầu chờ ${seconds} giây`).slice(0, 500)
    db.prepare(
      `UPDATE provider_credentials
          SET health_status = 'cooldown', cooldown_until = ?, last_error = ?,
              last_error_key = 'errors.rate_limited', last_error_params = ?,
              last_used_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      Math.max(row.cooldown_until ?? 0, now + seconds * 1000),
      message,
      JSON.stringify({ retryAfter: seconds }),
      now,
      now,
      credentialId,
    )
    return
  }

  const message = (
    result.message ?? (status !== undefined ? `Provider trả về mã ${status}` : 'Lỗi không xác định từ provider')
  ).slice(0, 500)
  db.prepare(
    `UPDATE provider_credentials
        SET last_error = ?, last_error_key = 'errors.provider_error', last_error_params = ?,
            last_used_at = ?, updated_at = ?
      WHERE id = ?`,
  ).run(message, JSON.stringify({ detail: message }), now, now, credentialId)
}
