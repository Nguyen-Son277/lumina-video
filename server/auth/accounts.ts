/**
 * Trạng thái duyệt và vai trò tài khoản.
 *
 * Quy tắc cốt lõi:
 *   - Tài khoản đăng ký mới ở trạng thái `pending`: không có phiên, không gọi
 *     được API nào cho tới khi super admin duyệt.
 *   - Hàng `users` cũ (tạo trước tính năng này) mặc định `approved` nhờ DEFAULT
 *     của migration 020, nên không cần backfill.
 *   - Quyền `admin` chỉ đến từ danh sách email cấu hình (`SUPER_ADMIN_EMAILS`).
 *     Đồng bộ là promote-only: bỏ email khỏi danh sách KHÔNG giáng quyền tài
 *     khoản đã thành admin, tránh tự khóa mình khỏi hệ thống ngoài ý muốn.
 */
import type { Database } from '../db/index'
import { badRequest, errorMeta, forbidden, notFound } from '../lib/errors'
import { destroyAllSessions } from './sessions'

export type AccountStatus = 'pending' | 'approved' | 'rejected'
export type AccountRole = 'user' | 'admin'

export const ACCOUNT_STATUSES: readonly AccountStatus[] = ['pending', 'approved', 'rejected']

export function isAccountStatus(value: unknown): value is AccountStatus {
  return typeof value === 'string' && (ACCOUNT_STATUSES as readonly string[]).includes(value)
}

export function isAccountRole(value: unknown): value is AccountRole {
  return value === 'user' || value === 'admin'
}

/** Tài khoản ở dạng công khai cho trang quản trị: không có hash/salt mật khẩu. */
export type AccountPublic = {
  id: string
  email: string
  status: AccountStatus
  role: AccountRole
  createdAt: number
  approvedAt: number | null
}

export type AccountCounts = {
  pending: number
  approved: number
  rejected: number
  total: number
}

type AccountDbRow = {
  id: string
  email: string
  status: string
  role: string
  created_at: number
  approved_at: number | null
}

/** Chuẩn hóa cột trong DB (TEXT tự do) về kiểu đã kiểm; giá trị lạ rơi về mặc định an toàn. */
function toPublic(row: AccountDbRow): AccountPublic {
  return {
    id: row.id,
    email: row.email,
    status: isAccountStatus(row.status) ? row.status : 'pending',
    role: isAccountRole(row.role) ? row.role : 'user',
    createdAt: row.created_at,
    approvedAt: row.approved_at ?? null,
  }
}

/**
 * Tách danh sách email super admin từ biến môi trường: phân tách bằng dấu phẩy,
 * trim, chuyển chữ thường và bỏ giá trị rỗng/trùng.
 */
export function parseAdminEmails(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? '')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  ]
}

/**
 * Đồng bộ danh sách email super admin vào database (promote-only).
 *
 * Chạy lúc khởi động ứng dụng để đổi `.env` là có hiệu lực ngay sau khi restart,
 * kể cả với tài khoản đã tồn tại từ trước. Trả về số hàng được cập nhật.
 */
export function syncAdminAllowlist(db: Database, emails: string[], now = Date.now()): number {
  if (emails.length === 0) return 0
  const placeholders = emails.map(() => '?').join(', ')
  const result = db
    .prepare(
      `UPDATE users
          SET role = 'admin', status = 'approved',
              approved_at = COALESCE(approved_at, ?), approved_by = COALESCE(approved_by, 'system')
        WHERE email IN (${placeholders}) AND (role <> 'admin' OR status <> 'approved')`,
    )
    .run(now, ...emails)
  return Number(result.changes ?? 0)
}

export function accountStatusCounts(db: Database): AccountCounts {
  const counts: AccountCounts = { pending: 0, approved: 0, rejected: 0, total: 0 }
  const rows = db
    .prepare('SELECT status, COUNT(*) AS total FROM users GROUP BY status')
    .all() as unknown as Array<{ status: string; total: number }>
  for (const row of rows) {
    const total = Number(row.total)
    counts.total += total
    if (isAccountStatus(row.status)) counts[row.status] += total
  }
  return counts
}

/**
 * Danh sách tài khoản cho trang quản trị, mới nhất trước.
 *
 * Lọc theo email bằng `instr` trên chữ thường để ký tự `%`/`_` của người dùng
 * không bị hiểu là ký tự đại diện của LIKE.
 */
export function listAccounts(
  db: Database,
  options: { status?: AccountStatus; query?: string; limit?: number; offset?: number } = {},
): AccountPublic[] {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 100)
  const offset = Math.max(Math.trunc(options.offset ?? 0), 0)
  const conditions: string[] = []
  const params: Array<string | number> = []

  if (options.status) {
    conditions.push('status = ?')
    params.push(options.status)
  }
  const query = (options.query ?? '').trim().toLowerCase()
  if (query) {
    conditions.push('instr(lower(email), ?) > 0')
    params.push(query)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const rows = db
    .prepare(
      `SELECT id, email, status, role, created_at, approved_at
         FROM users ${where}
        ORDER BY created_at DESC, id
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as unknown as AccountDbRow[]

  return rows.map(toPublic)
}

function findAccount(db: Database, id: string): AccountDbRow | undefined {
  return db
    .prepare('SELECT id, email, status, role, created_at, approved_at FROM users WHERE id = ?')
    .get(id) as AccountDbRow | undefined
}

/**
 * Đổi trạng thái duyệt của một tài khoản và trả về bản ghi sau khi cập nhật.
 *
 * Thu hồi khỏi `approved` sẽ hủy mọi phiên đang sống của tài khoản đó; ngoài ra
 * `resolveSession` cũng chỉ chấp nhận tài khoản `approved`, nên hiệu lực là tức thì.
 *
 * Chặn hai trường hợp nguy hiểm: tự đổi trạng thái chính mình và đổi trạng thái
 * một tài khoản admin khác (quyền admin đến từ cấu hình, không sửa ở đây).
 */
export function setAccountStatus(
  db: Database,
  targetId: string,
  status: AccountStatus,
  reviewerId: string,
  now = Date.now(),
): AccountPublic {
  if (!isAccountStatus(status)) {
    throw badRequest('Trạng thái tài khoản không hợp lệ', undefined, errorMeta('admin.invalid_status'))
  }

  const row = findAccount(db, targetId)
  if (!row) throw notFound('Không tìm thấy tài khoản', errorMeta('admin.user_not_found'))

  if (row.id === reviewerId) {
    throw forbidden('Bạn không thể tự đổi trạng thái tài khoản của mình.', errorMeta('admin.self_review_forbidden'))
  }
  if (isAccountRole(row.role) && row.role === 'admin') {
    throw forbidden(
      'Tài khoản quản trị viên không đổi trạng thái ở đây. Hãy sửa danh sách SUPER_ADMIN_EMAILS.',
      errorMeta('admin.protected_account'),
    )
  }

  db.prepare(
    'UPDATE users SET status = ?, approved_at = ?, approved_by = ? WHERE id = ?',
  ).run(status, status === 'approved' ? now : null, status === 'approved' ? reviewerId : null, row.id)

  if (status !== 'approved') destroyAllSessions(db, row.id)

  const updated = findAccount(db, row.id)!
  return toPublic(updated)
}
