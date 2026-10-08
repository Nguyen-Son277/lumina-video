import { createHash, randomBytes } from 'node:crypto'
import type { Database } from '../db/index'

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 ngày
export const SESSION_COOKIE = 'lumina_session'

export type SessionUser = {
  id: string
  email: string
}

/**
 * Chỉ lưu SHA-256 của token trong database. Token gốc chỉ nằm ở cookie,
 * nên rò rỉ database không cho phép mạo danh người dùng.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function createSession(
  db: Database,
  userId: string,
  userAgent: string | undefined,
): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = Date.now() + SESSION_TTL_MS

  db.prepare(
    'INSERT INTO sessions (id, user_id, expires_at, created_at, user_agent) VALUES (?, ?, ?, ?, ?)',
  ).run(hashToken(token), userId, expiresAt, Date.now(), userAgent ?? null)

  return { token, expiresAt }
}

export function resolveSession(db: Database, token: string | undefined): SessionUser | null {
  if (!token) return null

  const row = db
    .prepare(
      `SELECT s.expires_at AS expiresAt, u.id AS id, u.email AS email
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`,
    )
    .get(hashToken(token)) as { expiresAt: number; id: string; email: string } | undefined

  if (!row) return null

  if (row.expiresAt <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(hashToken(token))
    return null
  }

  return { id: row.id, email: row.email }
}

export function destroySession(db: Database, token: string | undefined): void {
  if (!token) return
  db.prepare('DELETE FROM sessions WHERE id = ?').run(hashToken(token))
}

export function destroyAllSessions(db: Database, userId: string): void {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
}

export function purgeExpiredSessions(db: Database): number {
  const result = db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now())
  return Number(result.changes ?? 0)
}

export function sessionCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    path: '/',
    maxAge: SESSION_TTL_MS,
  }
}
