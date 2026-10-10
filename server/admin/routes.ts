/**
 * API quản trị tài khoản — chỉ dành cho super admin.
 *
 * Mọi route đi qua `requireAdmin`. Không route nào trả `password_hash`/`password_salt`
 * hay dữ liệu provider/model của người dùng; trang quản trị chỉ làm một việc: duyệt
 * hoặc từ chối tài khoản.
 */
import { Router } from 'express'
import { z } from 'zod'
import type { Database } from '../db/index'
import { badRequest, validationError } from '../lib/errors'
import { requireAdmin } from '../auth/middleware'
import {
  ACCOUNT_STATUSES,
  accountStatusCounts,
  isAccountStatus,
  listAccounts,
  setAccountStatus,
  type AccountStatus,
} from '../auth/accounts'

const listQuerySchema = z.object({
  status: z.enum([...ACCOUNT_STATUSES, 'all']).optional(),
  q: z.string().trim().max(254).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

const statusSchema = z.object({ status: z.enum(ACCOUNT_STATUSES) })

export function adminRoutes(db: Database): Router {
  const router = Router()

  /** Mọi thao tác quản trị đều yêu cầu tài khoản có vai trò admin. */
  router.use((req, _res, next) => {
    requireAdmin(req)
    next()
  })

  function payload(status?: AccountStatus, query?: string, limit?: number, offset?: number) {
    return {
      users: listAccounts(db, { status, query, limit, offset }),
      counts: accountStatusCounts(db),
    }
  }

  router.get('/users', (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query)
    if (!parsed.success) throw validationError(parsed.error)
    const { status, q, limit, offset } = parsed.data
    res.json(payload(status && status !== 'all' ? status : undefined, q, limit, offset))
  })

  /**
   * Đổi trạng thái duyệt. Dùng chung một handler cho cả ba quyết định để quy tắc
   * bảo vệ (không tự sửa mình, không sửa tài khoản admin) chỉ tồn tại một chỗ.
   */
  function reviewHandler(next: AccountStatus): import('express').RequestHandler {
    return (req, res) => {
      const admin = requireAdmin(req)
      const parsed = statusSchema.safeParse({ status: next })
      if (!parsed.success) throw validationError(parsed.error)
      if (!isAccountStatus(parsed.data.status)) {
        throw badRequest('Trạng thái tài khoản không hợp lệ')
      }
      const user = setAccountStatus(db, String(req.params.id), parsed.data.status, admin.id)
      res.json({ user, counts: accountStatusCounts(db) })
    }
  }

  router.post('/users/:id/approve', reviewHandler('approved'))
  router.post('/users/:id/reject', reviewHandler('rejected'))
  // Thu hồi quyết định: đưa tài khoản về hàng chờ, hủy mọi phiên đang sống.
  router.post('/users/:id/revoke', reviewHandler('pending'))

  return router
}
