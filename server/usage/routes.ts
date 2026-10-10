import { Router, type Request } from 'express'
import { z } from 'zod'
import type { Database } from '../db/index'
import { requireUser } from '../auth/middleware'
import { badRequest, validationError } from '../lib/errors'
import {
  USAGE_KINDS,
  USAGE_OUTCOMES,
  getUsageSettings,
  listUsageEvents,
  listUsageMessages,
  purgeExpiredUsageLogs,
  saveUsageSettings,
  usageSummary,
  type UsageFilters,
  type UsageKind,
  type UsageOutcome,
} from './service'

/** Số ngày log LLM được giữ trước khi job dọn tự xoá. */
export const USAGE_RETENTION_DAYS = 90

const querySchema = z
  .object({
    userId: z.string().trim().min(1).max(100).optional(),
    from: z.coerce.number().int().nonnegative().optional(),
    to: z.coerce.number().int().nonnegative().optional(),
    /** Danh sách ngăn cách bởi dấu phẩy: image,video,llm và ok,failed,unknown,pending. */
    kind: z.string().trim().max(100).optional(),
    outcome: z.string().trim().max(100).optional(),
    modelPk: z.string().trim().min(1).max(100).optional(),
    q: z.string().trim().max(200).optional(),
    sessionId: z.string().trim().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict()

const settingsSchema = z
  .object({
    monthlyBudget: z.number().nonnegative().max(1_000_000).nullable(),
    currency: z.string().trim().min(1).max(10),
  })
  .strict()

const csv = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

function parseQuery(req: Request, allowUserId: boolean): { filters: UsageFilters; sessionId?: string } {
  const parsed = querySchema.safeParse(req.query)
  if (!parsed.success) throw validationError(parsed.error)
  const data = parsed.data

  const kinds = csv(data.kind) as UsageKind[]
  for (const kind of kinds) {
    if (!USAGE_KINDS.includes(kind)) throw badRequest('Loại sử dụng không hợp lệ')
  }
  const outcomes = csv(data.outcome) as UsageOutcome[]
  for (const outcome of outcomes) {
    if (!USAGE_OUTCOMES.includes(outcome)) throw badRequest('Trạng thái sử dụng không hợp lệ')
  }
  if (data.from !== undefined && data.to !== undefined && data.from > data.to) {
    throw badRequest('Khoảng thời gian không hợp lệ')
  }

  return {
    filters: {
      ...(allowUserId && data.userId ? { userId: data.userId } : {}),
      ...(kinds.length ? { kinds } : {}),
      ...(outcomes.length ? { outcomes } : {}),
      ...(data.modelPk ? { modelPk: data.modelPk } : {}),
      ...(data.from !== undefined ? { from: data.from } : {}),
      ...(data.to !== undefined ? { to: data.to } : {}),
      ...(data.q ? { q: data.q } : {}),
      ...(data.limit !== undefined ? { limit: data.limit } : {}),
      ...(data.offset !== undefined ? { offset: data.offset } : {}),
    },
    sessionId: data.sessionId,
  }
}

/**
 * Nhật ký sử dụng của chính người dùng đang đăng nhập.
 *
 * `listUsageEvents` giới hạn `userId` ở đây nên không có đường đọc dữ liệu người
 * khác. Trang quản trị dùng router riêng (`adminUsageRoutes`) bỏ giới hạn này.
 */
export function usageRoutes(db: Database): Router {
  const router = Router()

  router.get('/', (req, res) => {
    const user = requireUser(req)
    const { filters } = parseQuery(req, false)
    const scoped = { ...filters, userId: user.id }
    const { events, total } = listUsageEvents(db, { ...scoped, withUserEmail: false })
    res.json({
      summary: usageSummary(db, scoped),
      events,
      total,
      settings: getUsageSettings(db, user.id),
      retentionDays: USAGE_RETENTION_DAYS,
    })
  })

  /** Tin nhắn chat đã dùng, kèm chi phí của những lần gọi phát sinh từ tin nhắn đó. */
  router.get('/messages', (req, res) => {
    const user = requireUser(req)
    const { filters, sessionId } = parseQuery(req, false)
    const result = listUsageMessages(db, {
      userId: user.id,
      ...(filters.from !== undefined ? { from: filters.from } : {}),
      ...(filters.to !== undefined ? { to: filters.to } : {}),
      ...(sessionId ? { planSessionId: sessionId } : {}),
      ...(filters.q ? { q: filters.q } : {}),
      ...(filters.limit !== undefined ? { limit: filters.limit } : {}),
      ...(filters.offset !== undefined ? { offset: filters.offset } : {}),
    })
    res.json(result)
  })

  router.put('/settings', (req, res) => {
    const user = requireUser(req)
    const parsed = settingsSchema.safeParse(req.body)
    if (!parsed.success) throw validationError(parsed.error)
    res.json({ settings: saveUsageSettings(db, user.id, parsed.data) })
  })

  /** Xoá log LLM của chính mình; nội dung ảnh/video không bị đụng tới. */
  router.delete('/logs', (req, res) => {
    const user = requireUser(req)
    const result = db.prepare('DELETE FROM llm_usage WHERE user_id = ?').run(user.id)
    res.json({ deleted: Number(result.changes ?? 0) })
  })

  /** Job dọn chạy theo lịch; endpoint này để chủ động dọn ngay khi cần. */
  router.post('/logs/purge', (req, res) => {
    requireUser(req)
    res.json({ deleted: purgeExpiredUsageLogs(db, { days: USAGE_RETENTION_DAYS }) })
  })

  return router
}
