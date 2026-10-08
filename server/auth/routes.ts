import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import type { Database } from '../db/index'
import { hashPassword, validatePasswordStrength, verifyPassword } from '../crypto/password'
import { badRequest, conflict, tooManyRequests, unauthorized } from '../lib/errors'
import { clientIp, createRateLimiter } from '../lib/rateLimit'
import { requireUser } from './middleware'
import { isAllowedEmail, domainRejectionMessage } from './emailPolicy'
import {
  createSession,
  destroyAllSessions,
  destroySession,
  SESSION_COOKIE,
  sessionCookieOptions,
} from './sessions'

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email('Email không hợp lệ').max(254),
  password: z.string().min(1, 'Vui lòng nhập mật khẩu').max(200),
})

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
})

export function authRoutes(
  db: Database,
  options: {
    cookieSecure: boolean
    registerPerHour: number
    loginPer10Min: number
  },
): Router {
  const router = Router()

  // Giới hạn thử đăng nhập để chống dò mật khẩu. Đặt 0 để tắt trong test.
  const loginLimiter = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: options.loginPer10Min || Number.MAX_SAFE_INTEGER,
  })
  const registerLimiter = createRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: options.registerPerHour || Number.MAX_SAFE_INTEGER,
  })

  router.post('/register', (req, res) => {
    const ip = clientIp(req)
    if (!registerLimiter.check(`register:${ip}`)) {
      throw tooManyRequests('Bạn đã tạo quá nhiều tài khoản. Vui lòng thử lại sau.')
    }

    const parsed = credentialsSchema.safeParse(req.body)
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Dữ liệu không hợp lệ')
    }
    const { email, password } = parsed.data

    if (!isAllowedEmail(email, ['gigone.com'])) {
      throw badRequest(domainRejectionMessage(['gigone.com']))
    }

    const strengthError = validatePasswordStrength(password)
    if (strengthError) throw badRequest(strengthError)

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email)
    if (existing) throw conflict('Email này đã được đăng ký')

    const { hash, salt } = hashPassword(password)
    const userId = randomUUID()

    db.prepare(
      'INSERT INTO users (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(userId, email, hash, salt, Date.now())

    const { token } = createSession(db, userId, req.get('user-agent'))
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions(options.cookieSecure))
    res.status(201).json({ user: { id: userId, email } })
  })

  router.post('/login', (req, res) => {
    const ip = clientIp(req)
    if (!loginLimiter.check(`login:${ip}`)) {
      throw tooManyRequests('Quá nhiều lần đăng nhập thất bại. Vui lòng thử lại sau.')
    }

    const parsed = credentialsSchema.safeParse(req.body)
    if (!parsed.success) throw badRequest('Email hoặc mật khẩu không hợp lệ')
    const { email, password } = parsed.data

    const row = db
      .prepare('SELECT id, email, password_hash AS hash, password_salt AS salt FROM users WHERE email = ?')
      .get(email) as { id: string; email: string; hash: string; salt: string } | undefined

    // Thông báo giống nhau cho cả hai trường hợp để không lộ email nào tồn tại.
    if (!row || !verifyPassword(password, { hash: row.hash, salt: row.salt })) {
      throw unauthorized('Email hoặc mật khẩu không đúng')
    }

    const { token } = createSession(db, row.id, req.get('user-agent'))
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions(options.cookieSecure))
    res.json({ user: { id: row.id, email: row.email } })
  })

  router.post('/logout', (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined
    destroySession(db, token)
    res.clearCookie(SESSION_COOKIE, { path: '/' })
    res.status(204).end()
  })

  router.get('/me', (req, res) => {
    if (!req.user) {
      res.status(200).json({ user: null })
      return
    }
    res.json({ user: req.user })
  })

  router.post('/change-password', (req, res) => {
    const user = requireUser(req)

    const parsed = changePasswordSchema.safeParse(req.body)
    if (!parsed.success) throw badRequest('Dữ liệu không hợp lệ')

    const strengthError = validatePasswordStrength(parsed.data.newPassword)
    if (strengthError) throw badRequest(strengthError)

    const row = db
      .prepare('SELECT password_hash AS hash, password_salt AS salt FROM users WHERE id = ?')
      .get(user.id) as { hash: string; salt: string } | undefined
    if (!row) throw unauthorized()

    if (!verifyPassword(parsed.data.currentPassword, { hash: row.hash, salt: row.salt })) {
      throw unauthorized('Mật khẩu hiện tại không đúng')
    }

    const { hash, salt } = hashPassword(parsed.data.newPassword)
    db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').run(
      hash,
      salt,
      user.id,
    )

    // Thu hồi mọi session cũ, sau đó cấp session mới cho thiết bị hiện tại.
    destroyAllSessions(db, user.id)
    const { token } = createSession(db, user.id, req.get('user-agent'))
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions(options.cookieSecure))
    res.json({ ok: true })
  })

  return router
}
