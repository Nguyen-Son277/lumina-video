import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const KEY_LENGTH = 32

export type EncryptedSecret = {
  ciphertext: Buffer
  iv: Buffer
  tag: Buffer
}

/**
 * Giải mã khóa chủ từ biến môi trường. Phải là base64 của đúng 32 byte.
 */
export function decodeMasterKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64')
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Khóa mã hóa phải là ${KEY_LENGTH} byte, nhận được ${key.length} byte`)
  }
  return key
}

export function generateMasterKey(): string {
  return randomBytes(KEY_LENGTH).toString('base64')
}

/**
 * Mã hóa API key của provider bằng AES-256-GCM.
 * Mỗi lần mã hóa dùng IV ngẫu nhiên riêng.
 */
export function encryptSecret(plaintext: string, masterKey: Buffer): EncryptedSecret {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, masterKey, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return { ciphertext, iv, tag: cipher.getAuthTag() }
}

/**
 * Giải mã API key. Ném lỗi nếu dữ liệu bị sửa đổi hoặc khóa chủ sai.
 */
export function decryptSecret(secret: EncryptedSecret, masterKey: Buffer): string {
  const decipher = createDecipheriv(ALGORITHM, masterKey, secret.iv)
  decipher.setAuthTag(secret.tag)
  return Buffer.concat([decipher.update(secret.ciphertext), decipher.final()]).toString('utf8')
}

/**
 * Gợi ý hiển thị cho người dùng: 4 ký tự cuối của key.
 * Không đủ để khôi phục key.
 */
export function keyHint(apiKey: string): string {
  const trimmed = apiKey.trim()
  if (trimmed.length <= 4) return '••••'
  return `••••${trimmed.slice(-4)}`
}
