import { describe, expect, it } from 'vitest'
import {
  decodeMasterKey,
  decryptSecret,
  encryptSecret,
  generateMasterKey,
  keyHint,
} from '../../server/crypto/providerKey'
import { hashPassword, validatePasswordStrength, verifyPassword } from '../../server/crypto/password'
import { isBlockedAddress, joinUrl } from '../../server/providers/urlGuard'
import { createRateLimiter } from '../../server/lib/rateLimit'
import { redact } from '../../server/lib/logger'
import { loadEnv } from '../../server/env'

describe('Mã hóa API key', () => {
  const masterKey = decodeMasterKey(generateMasterKey())

  it('mã hóa rồi giải mã trả lại đúng giá trị', () => {
    const secret = 'sk-mot-api-key-rat-dai-1234567890'
    const encrypted = encryptSecret(secret, masterKey)
    expect(decryptSecret(encrypted, masterKey)).toBe(secret)
  })

  it('mỗi lần mã hóa cho ra bản mã khác nhau', () => {
    const secret = 'sk-cung-mot-key'
    const first = encryptSecret(secret, masterKey)
    const second = encryptSecret(secret, masterKey)

    // IV ngẫu nhiên nên bản mã phải khác nhau.
    expect(first.iv.equals(second.iv)).toBe(false)
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false)
    // Nhưng giải mã vẫn ra cùng giá trị.
    expect(decryptSecret(first, masterKey)).toBe(decryptSecret(second, masterKey))
  })

  it('không giải mã được khi dữ liệu bị sửa đổi', () => {
    const encrypted = encryptSecret('sk-bi-sua', masterKey)
    encrypted.ciphertext[0] = encrypted.ciphertext[0]! ^ 0xff
    expect(() => decryptSecret(encrypted, masterKey)).toThrow()
  })

  it('không giải mã được bằng khóa chủ khác', () => {
    const otherKey = decodeMasterKey(generateMasterKey())
    const encrypted = encryptSecret('sk-bi-mat', masterKey)
    expect(() => decryptSecret(encrypted, otherKey)).toThrow()
  })

  it('từ chối khóa chủ sai độ dài', () => {
    expect(() => decodeMasterKey('a2hva2hvbmc=')).toThrow()
    expect(() => decodeMasterKey('')).toThrow()
  })

  it('gợi ý key chỉ lộ 4 ký tự cuối', () => {
    expect(keyHint('sk-abcdefgh1234')).toBe('••••1234')
    expect(keyHint('abc')).toBe('••••')
  })
})

describe('Băm mật khẩu', () => {
  it('băm rồi xác minh đúng mật khẩu', () => {
    const record = hashPassword('mat-khau-rat-dai-123')
    expect(verifyPassword('mat-khau-rat-dai-123', record)).toBe(true)
    expect(verifyPassword('mat-khau-sai', record)).toBe(false)
  })

  it('hai lần băm cùng mật khẩu cho salt khác nhau', () => {
    const first = hashPassword('cung-mot-mat-khau')
    const second = hashPassword('cung-mot-mat-khau')
    expect(first.salt).not.toBe(second.salt)
    expect(first.hash).not.toBe(second.hash)
  })

  it('không lưu mật khẩu dạng bản rõ', () => {
    const password = 'mat-khau-khong-duoc-lo'
    const record = hashPassword(password)
    expect(record.hash).not.toContain(password)
    expect(record.salt).not.toContain(password)
  })

  it('kiểm tra độ mạnh mật khẩu', () => {
    expect(validatePasswordStrength('ngan')).not.toBeNull()
    expect(validatePasswordStrength('a'.repeat(201))).not.toBeNull()
    expect(validatePasswordStrength('mat-khau-du-dai-123')).toBeNull()
  })
})

describe('Chống SSRF', () => {
  it('chặn địa chỉ nội bộ và metadata', () => {
    const blocked = [
      '127.0.0.1',
      '127.1.2.3',
      '10.0.0.5',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '0.0.0.0',
      '100.64.0.1',
      '::1',
      'fe80::1',
      'fc00::1',
      'fd00:ec2::254',
      // IPv4-mapped IPv6 cũng phải bị chặn.
      '::ffff:127.0.0.1',
      '::ffff:192.168.0.1',
    ]
    for (const address of blocked) {
      expect(isBlockedAddress(address), `phải chặn ${address}`).toBe(true)
    }
  })

  it('cho qua địa chỉ công khai', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700::1111']) {
      expect(isBlockedAddress(address), `phải cho qua ${address}`).toBe(false)
    }
  })

  it('chặn giá trị không phải địa chỉ IP', () => {
    expect(isBlockedAddress('khong-phai-ip')).toBe(true)
    expect(isBlockedAddress('')).toBe(true)
  })

  it('ghép URL không tạo dấu gạch chéo thừa và giữ nguyên /v1', () => {
    expect(joinUrl('https://api.example.com/v1', 'images/generations')).toBe(
      'https://api.example.com/v1/images/generations',
    )
    expect(joinUrl('https://api.example.com/v1/', '/images/generations')).toBe(
      'https://api.example.com/v1/images/generations',
    )
    // Không tự thêm hay bỏ /v1.
    expect(joinUrl('https://api.example.com', 'models')).toBe('https://api.example.com/models')
  })
})

describe('Cấu hình môi trường', () => {
  it('từ chối khi thiếu khóa mã hóa', () => {
    expect(() => loadEnv({} as NodeJS.ProcessEnv)).toThrow(/APP_ENCRYPTION_KEY/)
  })

  it('từ chối khóa sai độ dài', () => {
    expect(() => loadEnv({ APP_ENCRYPTION_KEY: 'a2hva2hvbmc=' } as NodeJS.ProcessEnv)).toThrow(
      /32 byte/,
    )
  })

  it('nhận cấu hình hợp lệ và áp giá trị mặc định', () => {
    const env = loadEnv({ APP_ENCRYPTION_KEY: generateMasterKey() } as NodeJS.ProcessEnv)
    expect(env.PORT).toBe(8787)
    expect(env.PROVIDER_MODE).toBe('live')
    expect(env.ALLOW_PRIVATE_PROVIDER_URLS).toBe(false)
    expect(env.MAX_CONCURRENT_JOBS_PER_USER).toBe(2)
  })

  it('mặc định chặn Base URL nội bộ', () => {
    const env = loadEnv({ APP_ENCRYPTION_KEY: generateMasterKey() } as NodeJS.ProcessEnv)
    expect(env.ALLOW_PRIVATE_PROVIDER_URLS).toBe(false)
  })
})

describe('Giới hạn tần suất', () => {
  it('chặn khi vượt số lần cho phép', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 3 })
    expect(limiter.check('a')).toBe(true)
    expect(limiter.check('a')).toBe(true)
    expect(limiter.check('a')).toBe(true)
    expect(limiter.check('a')).toBe(false)
    // Khóa khác không bị ảnh hưởng.
    expect(limiter.check('b')).toBe(true)
  })

  it('reset xóa bộ đếm', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 1 })
    expect(limiter.check('a')).toBe(true)
    expect(limiter.check('a')).toBe(false)
    limiter.reset('a')
    expect(limiter.check('a')).toBe(true)
  })

  it('hết cửa sổ thời gian thì cho phép lại', async () => {
    const limiter = createRateLimiter({ windowMs: 40, max: 1 })
    expect(limiter.check('a')).toBe(true)
    expect(limiter.check('a')).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(limiter.check('a')).toBe(true)
  })
})

describe('Che thông tin nhạy cảm trong log', () => {
  it('che Authorization, api key và token', () => {
    expect(redact('Authorization: Bearer sk-bi-mat-1234567890')).not.toContain('sk-bi-mat')
    expect(redact('api_key=sk-khong-duoc-lo-abcdef')).not.toContain('sk-khong-duoc-lo')
    expect(redact('token: sk-token-abcdefghij')).not.toContain('sk-token')
    expect(redact({ apiKey: 'sk-trong-json-1234567' })).not.toContain('sk-trong-json')
  })

  it('giữ nguyên dữ liệu không nhạy cảm', () => {
    const output = redact({ id: 'gen-123', status: 'running' })
    expect(output).toContain('gen-123')
    expect(output).toContain('running')
  })
})
