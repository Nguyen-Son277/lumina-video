import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { ErrorMessageKey, ErrorMessageParams } from '../../shared/errorCatalog'

const KEY_LENGTH = 64
const SALT_LENGTH = 16
export const MIN_PASSWORD_LENGTH = 10
export const MAX_PASSWORD_LENGTH = 200

export type PasswordRecord = {
  hash: string
  salt: string
}

/**
 * Băm mật khẩu bằng scrypt với salt riêng cho từng người dùng.
 * Lưu dạng hex để đọc được trong database.
 */
export function hashPassword(password: string): PasswordRecord {
  const salt = randomBytes(SALT_LENGTH)
  const hash = scryptSync(password, salt, KEY_LENGTH)
  return { hash: hash.toString('hex'), salt: salt.toString('hex') }
}

/**
 * So sánh mật khẩu theo cách không rò rỉ thời gian.
 */
export function verifyPassword(password: string, record: PasswordRecord): boolean {
  const expected = Buffer.from(record.hash, 'hex')
  const actual = scryptSync(password, Buffer.from(record.salt, 'hex'), expected.length)
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

/** Lỗi chính sách mật khẩu kèm khoá ngữ nghĩa để client dịch được. */
export type PasswordPolicyIssue = {
  message: string
  messageKey: ErrorMessageKey
  messageParams: ErrorMessageParams
}

/**
 * Kiểm tra độ mạnh mật khẩu và trả về cả câu thông báo lẫn khoá ngữ nghĩa.
 * Trả null nếu mật khẩu hợp lệ.
 */
export function passwordPolicyIssue(password: string): PasswordPolicyIssue | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      message: `Mật khẩu phải có ít nhất ${MIN_PASSWORD_LENGTH} ký tự`,
      messageKey: 'auth.password_too_short',
      messageParams: { min: MIN_PASSWORD_LENGTH },
    }
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return {
      message: 'Mật khẩu quá dài',
      messageKey: 'auth.password_too_long',
      messageParams: { max: MAX_PASSWORD_LENGTH },
    }
  }
  return null
}

/** Giữ hợp đồng cũ: trả câu lỗi hoặc null. */
export function validatePasswordStrength(password: string): string | null {
  return passwordPolicyIssue(password)?.message ?? null
}
