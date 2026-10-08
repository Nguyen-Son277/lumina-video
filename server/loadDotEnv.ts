/**
 * Nạp biến môi trường từ file .env (không phụ thuộc dotenv).
 * Được import đầu tiên trong server/index.ts và trong test setup.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export function loadDotEnv(file = '.env'): void {
  const path = resolve(process.cwd(), file)
  if (!existsSync(path)) return

  const content = readFileSync(path, 'utf8')
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const separator = line.indexOf('=')
    if (separator === -1) continue

    const key = line.slice(0, separator).trim()
    if (!key || key in process.env) continue

    let value = line.slice(separator + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}
