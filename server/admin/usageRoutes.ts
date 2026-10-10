import { Router, type Request } from 'express'
import { z } from 'zod'
import type { Database } from '../db/index'
import { requireAdmin } from '../auth/middleware'
import { badRequest, validationError } from '../lib/errors'
import {
  USAGE_KINDS,
  USAGE_OUTCOMES,
  listUsageEvents,
  usageSummary,
  type UsageFilters,
  type UsageKind,
  type UsageOutcome,
} from '../usage/service'

const querySchema = z
  .object({
    userId: z.string().trim().min(1).max(100).optional(),
    from: z.coerce.number().int().nonnegative().optional(),
    to: z.coerce.number().int().nonnegative().optional(),
    kind: z.string().trim().max(100).optional(),
    outcome: z.string().trim().max(100).optional(),
    modelPk: z.string().trim().min(1).max(100).optional(),
    q: z.string().trim().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict()

const csv = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

function parseFilters(req: Request): UsageFilters {
  const parsed = querySchema.safeParse(req.query)
  if (!parsed.success) throw validationError(parsed.error)
  const data = parsed.data
  const kinds = csv(data.kind) as UsageKind[]
  for (const kind of kinds) if (!USAGE_KINDS.includes(kind)) throw badRequest('Loại sử dụng không hợp lệ')
  const outcomes = csv(data.outcome) as UsageOutcome[]
  for (const outcome of outcomes) {
    if (!USAGE_OUTCOMES.includes(outcome)) throw badRequest('Trạng thái sử dụng không hợp lệ')
  }
  if (data.from !== undefined && data.to !== undefined && data.from > data.to) {
    throw badRequest('Khoảng thời gian không hợp lệ')
  }
  return {
    ...(data.userId ? { userId: data.userId } : {}),
    ...(kinds.length ? { kinds } : {}),
    ...(outcomes.length ? { outcomes } : {}),
    ...(data.modelPk ? { modelPk: data.modelPk } : {}),
    ...(data.from !== undefined ? { from: data.from } : {}),
    ...(data.to !== undefined ? { to: data.to } : {}),
    ...(data.q ? { q: data.q } : {}),
    ...(data.limit !== undefined ? { limit: data.limit } : {}),
    ...(data.offset !== undefined ? { offset: data.offset } : {}),
  }
}

/**
 * Nhật ký sử dụng toàn hệ thống — chỉ super admin.
 *
 * Không giới hạn `userId` nên trả được cả email người dùng để đối chiếu; mọi route
 * đều đi qua `requireAdmin`.
 */
export function adminUsageRoutes(db: Database): Router {
  const router = Router()

  router.use((req, _res, next) => {
    requireAdmin(req)
    next()
  })

  router.get('/', (req, res) => {
    const filters = parseFilters(req)
    const { events, total } = listUsageEvents(db, { ...filters, withUserEmail: true })
    res.json({ summary: usageSummary(db, filters), events, total })
  })

  return router
}
