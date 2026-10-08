import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const KEY_LENGTH = 64
const SALT_LENGTH = 16
export const MIN_PASSWORD_LENGTH = 10

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

export function validatePasswordStrength(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Mật khẩu phải có ít nhất ${MIN_PASSWORD_LENGTH} ký tự`
  }
  if (password.length > 200) {
    return 'Mật khẩu quá dài'
  }
  return null
}
