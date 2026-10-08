import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

// Fresh data and key for every run: encrypted provider keys can never outlive
// their encryption key, nor can tests mutate a developer's database/media.
const testDir = mkdtempSync(resolve(process.cwd(), 'data/e2e-isolated-'))
process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString('base64')
process.env.PORT = process.env.TEST_PORT ?? '8790'
process.env.DATABASE_PATH = resolve(testDir, 'app.db')
process.env.MEDIA_DIR = resolve(testDir, 'media')
process.env.APP_ORIGIN = process.env.BASE_URL ?? 'http://127.0.0.1:5180'
process.env.PROVIDER_MODE = 'mock'
process.env.COOKIE_SECURE = 'false'
process.env.NODE_ENV = 'test'
process.env.ALLOW_PRIVATE_PROVIDER_URLS = 'false'
process.env.RATE_LIMIT_REGISTER_PER_HOUR = '0'
process.env.RATE_LIMIT_LOGIN_PER_10MIN = '0'
process.env.RATE_LIMIT_GENERATE_PER_MIN = '0'
process.env.RATE_LIMIT_LLM_MODELS_PER_MIN = '0'
process.on('exit', () => rmSync(testDir, { recursive: true, force: true }))
await import('../../server/index')
