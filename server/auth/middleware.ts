import type { NextFunction, Request, Response } from 'express'
import type { Database } from '../db/index'
import { AppError, forbidden, unauthorized } from '../lib/errors'
import { resolveSession, SESSION_COOKIE, type SessionUser } from './sessions'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser
    }
  }
}

/**
 * Gắn req.user nếu có session hợp lệ. Không chặn request.
 */
export function attachUser(db: Database) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined
    const user = resolveSession(db, token)
    if (user) req.user = user
    next()
  }
}

export function requireUser(req: Request): SessionUser {
  if (!req.user) throw unauthorized()
  return req.user
}

/**
 * Kiểm tra Origin cho các request thay đổi trạng thái (CSRF).
 * SameSite=Lax trên cookie là lớp bảo vệ thứ hai.
 */
export function requireTrustedOrigin(allowedOrigin: string) {
  const allowed = new Set(
    [allowedOrigin, allowedOrigin.replace('127.0.0.1', 'localhost')].map((value) =>
      value.replace(/\/$/, ''),
    ),
  )

  return (req: Request, _res: Response, next: NextFunction): void => {
    const method = req.method.toUpperCase()
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      next()
      return
    }

    const origin = req.get('origin')
    // Cho phép request không có Origin (ví dụ curl, test) nhưng vẫn cần session hợp lệ.
    if (!origin) {
      next()
      return
    }

    if (!allowed.has(origin.replace(/\/$/, ''))) {
      next(forbidden('Origin không được phép'))
      return
    }

    next()
  }
}

export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (error instanceof AppError) {
    res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details },
    })
    return
  }

  // Lỗi từ body-parser (ví dụ tải ảnh quá dung lượng) có mã lỗi riêng.
  const type = (error as { type?: unknown } | null)?.type
  if (type === 'entity.too.large') {
    res.status(413).json({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Tệp tải lên vượt giới hạn cho phép' },
    })
    return
  }
  if (type === 'entity.parse.failed') {
    res.status(400).json({
      error: { code: 'BAD_REQUEST', message: 'Dữ liệu gửi lên không đúng định dạng' },
    })
    return
  }

  const message = error instanceof Error ? error.message : 'Lỗi không xác định'
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: `Lỗi máy chủ: ${message}` },
  })
}
