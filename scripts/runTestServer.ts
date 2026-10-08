/**
 * Chạy backend cho kiểm thử E2E.
 *
 * Luôn dùng PROVIDER_MODE=mock (không gọi provider thật, không tốn phí) và
 * database/thư mục media riêng, không đụng vào dữ liệu dùng thật trong data/.
 *
 * Dùng: tsx scripts/runTestServer.ts
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const testDir = resolve(process.cwd(), 'data/test-e2e')
mkdirSync(testDir, { recursive: true })

process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString('base64')
process.env.PORT = process.env.TEST_PORT ?? '8787'
process.env.DATABASE_PATH = resolve(testDir, 'app.db')
process.env.MEDIA_DIR = resolve(testDir, 'media')
process.env.APP_ORIGIN = process.env.BASE_URL ?? 'http://127.0.0.1:5173'
process.env.PROVIDER_MODE = 'mock'
process.env.COOKIE_SECURE = 'false'
process.env.NODE_ENV = 'test'
process.env.ALLOW_PRIVATE_PROVIDER_URLS = 'false'
// Nhiều bài test tạo tài khoản riêng nên cần tắt giới hạn tần suất.
process.env.RATE_LIMIT_REGISTER_PER_HOUR = '0'
process.env.RATE_LIMIT_LOGIN_PER_10MIN = '0'
process.env.RATE_LIMIT_GENERATE_PER_MIN = '0'

// Nạp sau khi đã đặt biến môi trường để .env không ghi đè.
await import('../server/index')
