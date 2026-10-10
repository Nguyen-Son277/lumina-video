import type { Database } from '../db/index'

/**
 * Đọc nhật ký sử dụng cho người dùng (và cho quản trị viên).
 *
 * Ảnh/video suy trực tiếp từ `generations` — bảng đó đã là nguồn sự thật của nội
 * dung — nên lịch sử cũ hiện ra ngay và không có hai bản ghi lệch nhau. Chỉ LLM có
 * bảng riêng `llm_usage` vì trước đây không nơi nào lưu.
 *
 * Chi phí do người dùng tự nhập đơn giá; provider không trả giá trong API nên hệ
 * thống không đoán. Thiếu đơn giá hoặc thiếu token ⇒ `cost = null` và
 * `costUnknown = true`.
 */

export const USAGE_KINDS = ['image', 'video', 'llm'] as const
export type UsageKind = (typeof USAGE_KINDS)[number]

export const USAGE_OUTCOMES = ['ok', 'failed', 'unknown', 'pending'] as const
export type UsageOutcome = (typeof USAGE_OUTCOMES)[number]

/** Số ký tự preview trả ra cho giao diện. */
const EVENT_PREVIEW = 300

export type UsageEvent = {
  id: string
  kind: UsageKind
  /** Với LLM: nguồn gọi (planner_chat, character_ai…). Với media: chính loại nội dung. */
  source: string
  outcome: UsageOutcome
  /** Trạng thái thô trong database, để giao diện hiển thị chi tiết. */
  status: string
  createdAt: number
  userId: string
  userEmail?: string
  modelPk: string | null
  modelName: string | null
  providerName: string | null
  projectId: string | null
  projectName: string | null
  sceneId: string | null
  sceneTitle: string | null
  planSessionId: string | null
  sessionTitle: string | null
  messageId: string | null
  preview: string
  responsePreview: string
  promptChars: number
  responseChars: number
  promptTokens: number | null
  completionTokens: number | null
  latencyMs: number
  attemptCount: number
  byteSize: number
  priceUnit: number | null
  priceInput1k: number | null
  priceOutput1k: number | null
  /** Chi phí ước tính theo đơn giá; null khi chưa đủ dữ liệu. */
  cost: number | null
  costUnknown: boolean
}

export type UsageFilters = {
  /** Bỏ trống = mọi tài khoản (chỉ dùng cho route quản trị). */
  userId?: string
  kinds?: UsageKind[]
  outcomes?: UsageOutcome[]
  modelPk?: string
  /** Mốc thời gian (ms), bao gồm. */
  from?: number
  to?: number
  /** Tìm trong preview nội dung. */
  q?: string
  limit?: number
  offset?: number
  /** Kèm email người dùng (trang quản trị). */
  withUserEmail?: boolean
}

type RawEvent = Omit<UsageEvent, 'cost' | 'costUnknown'>

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000

/** Chi phí ước tính của một sự kiện; null khi thiếu đơn giá hoặc thiếu token. */
export function estimatedCost(event: Pick<UsageEvent, 'kind' | 'promptTokens' | 'completionTokens' | 'priceUnit' | 'priceInput1k' | 'priceOutput1k'>): number | null {
  if (event.kind === 'llm') {
    if (event.priceInput1k == null && event.priceOutput1k == null) return null
    if (event.promptTokens == null && event.completionTokens == null) return null
    const input = ((event.promptTokens ?? 0) / 1000) * (event.priceInput1k ?? 0)
    const output = ((event.completionTokens ?? 0) / 1000) * (event.priceOutput1k ?? 0)
    return round4(input + output)
  }
  // Ảnh/video: mỗi lượt gọi là một lần tính phí, kể cả lượt thất bại.
  if (event.priceUnit == null) return null
  return round4(event.priceUnit)
}

const outcomeExpression = (statusColumn: string, kind: 'media' | 'llm'): string =>
  kind === 'llm'
    ? `CASE WHEN ${statusColumn} = 'ok' THEN 'ok' ELSE 'failed' END`
    : `CASE ${statusColumn}
         WHEN 'succeeded' THEN 'ok'
         WHEN 'failed' THEN 'failed'
         WHEN 'unknown' THEN 'unknown'
         ELSE 'pending'
       END`

/**
 * Danh sách sự kiện hợp nhất (ảnh + video + LLM), mới nhất trước.
 *
 * Hai bảng được `UNION ALL` với cùng bộ cột nên tầng gọi chỉ cần một truy vấn.
 */
export function listUsageEvents(db: Database, filters: UsageFilters = {}): { events: UsageEvent[]; total: number } {
  const built = buildUnion(filters)
  if (!built.sql) return { events: [], total: 0 }

  const modelFilter = filters.modelPk ? ' WHERE modelPk = ?' : ''
  const modelParams = filters.modelPk ? [filters.modelPk] : []
  const outcomeFilter = filters.outcomes?.length
    ? `${modelFilter ? ' AND' : ' WHERE'} outcome IN (${filters.outcomes.map(() => '?').join(', ')})`
    : ''
  const outcomeParams = filters.outcomes ?? []

  const rows = db
    .prepare(
      `SELECT * FROM (${built.sql})${modelFilter}${outcomeFilter} ORDER BY createdAt DESC, id ASC LIMIT ? OFFSET ?`,
    )
    .all(
      ...built.params,
      ...modelParams,
      ...outcomeParams,
      limitOf(filters.limit),
      Math.max(0, Math.trunc(filters.offset ?? 0)),
    ) as unknown as RawEvent[]

  const countRow = db
    .prepare(`SELECT COUNT(*) AS total FROM (${built.sql})${modelFilter}${outcomeFilter}`)
    .get(...built.params, ...modelParams, ...outcomeParams) as { total: number }

  const events = rows.map((row) => decorate(row, filters.withUserEmail === true, db))
  return { events, total: Number(countRow.total) }
}

const limitOf = (value: number | undefined): number => {
  const parsed = Number.isFinite(value) ? Math.trunc(value as number) : 30
  return Math.min(Math.max(parsed, 1), 200)
}

/** Dựng câu UNION kèm tham số đúng thứ tự. */
function buildUnion(filters: UsageFilters): { sql: string; params: Array<string | number> } {
  // Điều kiện chung phải gắn alias từng nhánh vì các bảng JOIN đều có user_id/created_at.
  const conditions = (alias: string): { where: string[]; params: Array<string | number> } => {
    const where: string[] = []
    const params: Array<string | number> = []
    if (filters.userId) {
      where.push(`${alias}.user_id = ?`)
      params.push(filters.userId)
    }
    if (filters.from !== undefined) {
      where.push(`${alias}.created_at >= ?`)
      params.push(filters.from)
    }
    if (filters.to !== undefined) {
      where.push(`${alias}.created_at <= ?`)
      params.push(filters.to)
    }
    return { where, params }
  }

  const kinds = filters.kinds?.length ? filters.kinds : [...USAGE_KINDS]
  const mediaKinds = kinds.filter((kind): kind is 'image' | 'video' => kind === 'image' || kind === 'video')
  const branches: string[] = []
  const params: Array<string | number> = []

  if (mediaKinds.length) {
    const base = conditions('g')
    const where = [...base.where, `g.kind IN (${mediaKinds.map(() => '?').join(', ')})`]
    branches.push(mediaSelect(where.join(' AND ')))
    params.push(...base.params, ...mediaKinds)
  }
  if (kinds.includes('llm')) {
    const base = conditions('u')
    const where = [...base.where]
    const extra: Array<string | number> = []
    if (filters.q) {
      where.push('(u.preview LIKE ? OR u.response_preview LIKE ?)')
      const like = `%${filters.q}%`
      extra.push(like, like)
    }
    branches.push(llmSelect(where.length ? where.join(' AND ') : '1 = 1'))
    params.push(...base.params, ...extra)
  }
  return { sql: branches.join(' UNION ALL '), params }
}

const mediaSelect = (where: string): string => `
  SELECT g.id AS id, g.kind AS kind, g.kind AS source,
    ${outcomeExpression('g.status', 'media')} AS outcome, g.status AS status, g.created_at AS createdAt,
    g.user_id AS userId, g.model_pk AS modelPk, m.display_name AS modelName, p.name AS providerName,
    g.project_id AS projectId, pr.name AS projectName, g.scene_id AS sceneId, s.title AS sceneTitle,
    NULL AS planSessionId, NULL AS sessionTitle, NULL AS messageId,
    substr(g.prompt, 1, ${EVENT_PREVIEW}) AS preview, '' AS responsePreview,
    length(g.prompt) AS promptChars, 0 AS responseChars, NULL AS promptTokens, NULL AS completionTokens,
    0 AS latencyMs, g.attempt_count AS attemptCount,
    COALESCE((SELECT SUM(a.byte_size) FROM assets a WHERE a.generation_id = g.id), 0) AS byteSize,
    m.price_unit AS priceUnit, m.price_input_1k AS priceInput1k, m.price_output_1k AS priceOutput1k
  FROM generations g
  LEFT JOIN models m ON m.id = g.model_pk
  LEFT JOIN provider_connections p ON p.id = g.provider_id
  LEFT JOIN projects pr ON pr.id = g.project_id
  LEFT JOIN scenes s ON s.id = g.scene_id
  WHERE ${where}`.replace(/\s+/g, ' ')

const llmSelect = (where: string): string => `
  SELECT u.id AS id, 'llm' AS kind, u.source AS source,
    ${outcomeExpression('u.status', 'llm')} AS outcome, u.status AS status, u.created_at AS createdAt,
    u.user_id AS userId, u.model_pk AS modelPk, m.display_name AS modelName, p.name AS providerName,
    u.project_id AS projectId, pr.name AS projectName, NULL AS sceneId, NULL AS sceneTitle,
    u.plan_session_id AS planSessionId, ps.title AS sessionTitle, u.message_id AS messageId,
    substr(u.preview, 1, ${EVENT_PREVIEW}) AS preview, substr(u.response_preview, 1, ${EVENT_PREVIEW}) AS responsePreview,
    u.prompt_chars AS promptChars, u.response_chars AS responseChars,
    u.prompt_tokens AS promptTokens, u.completion_tokens AS completionTokens,
    u.latency_ms AS latencyMs, 0 AS attemptCount, 0 AS byteSize,
    m.price_unit AS priceUnit, m.price_input_1k AS priceInput1k, m.price_output_1k AS priceOutput1k
  FROM llm_usage u
  LEFT JOIN models m ON m.id = u.model_pk
  LEFT JOIN provider_connections p ON p.id = u.provider_id
  LEFT JOIN projects pr ON pr.id = u.project_id
  LEFT JOIN plan_sessions ps ON ps.id = u.plan_session_id
  WHERE ${where}`.replace(/\s+/g, ' ')

const emailCache = new Map<string, string>()

/** Bổ sung email người dùng (trang quản trị) và chi phí ước tính. */
function decorate(row: RawEvent, withEmail: boolean, db: Database): UsageEvent {
  const cost = estimatedCost(row)
  return {
    ...row,
    preview: String(row.preview ?? ''),
    responsePreview: String(row.responsePreview ?? ''),
    promptChars: Number(row.promptChars ?? 0),
    responseChars: Number(row.responseChars ?? 0),
    promptTokens: row.promptTokens == null ? null : Number(row.promptTokens),
    completionTokens: row.completionTokens == null ? null : Number(row.completionTokens),
    latencyMs: Number(row.latencyMs ?? 0),
    attemptCount: Number(row.attemptCount ?? 0),
    byteSize: Number(row.byteSize ?? 0),
    priceUnit: row.priceUnit == null ? null : Number(row.priceUnit),
    priceInput1k: row.priceInput1k == null ? null : Number(row.priceInput1k),
    priceOutput1k: row.priceOutput1k == null ? null : Number(row.priceOutput1k),
    cost,
    costUnknown: cost === null,
    ...(withEmail ? { userEmail: lookupEmail(db, row.userId) } : {}),
  }
}

function lookupEmail(db: Database, userId: string): string {
  const cached = emailCache.get(userId)
  if (cached) return cached
  const row = db.prepare('SELECT email FROM users WHERE id = ?').get(userId) as { email: string } | undefined
  const email = row?.email ?? ''
  if (emailCache.size > 500) emailCache.clear()
  emailCache.set(userId, email)
  return email
}

export type UsageTotals = {
  count: number
  ok: number
  failed: number
  unknown: number
  pending: number
  cost: number
  costUnknownCount: number
  promptTokens: number
  completionTokens: number
  byteSize: number
}

export type UsageSummary = {
  totals: Record<UsageKind, UsageTotals>
  overall: UsageTotals
  /** Chuỗi theo ngày để vẽ xu hướng; ngày dạng YYYY-MM-DD. */
  daily: Array<{ date: string; kind: UsageKind; count: number; cost: number }>
  byModel: Array<{ modelPk: string | null; modelName: string; kind: UsageKind; count: number; cost: number }>
  waste: {
    /** Lượt lỗi/không xác định — có thể provider đã tính phí. */
    failedCount: number
    failedCost: number
    /** Lượt có thể đã gửi provider nhiều lần (attempt_count > 1). */
    retriedCount: number
    /** Số lần cùng một cảnh được tạo trong 24 giờ. */
    duplicateSceneGenerations: number
  }
  currency: string
  mediaBytes: number
}

const emptyTotals = (): UsageTotals => ({
  count: 0,
  ok: 0,
  failed: 0,
  unknown: 0,
  pending: 0,
  cost: 0,
  costUnknownCount: 0,
  promptTokens: 0,
  completionTokens: 0,
  byteSize: 0,
})

/** Tổng hợp theo loại, theo ngày, theo model + chỉ số lãng phí. */
export function usageSummary(db: Database, filters: UsageFilters = {}): UsageSummary {
  // Báo cáo cần đủ dữ liệu trong khoảng lọc nên đọc phân trang nội bộ (trần 20.000 dòng).
  const all = collectAll(db, filters)

  const totals: Record<UsageKind, UsageTotals> = { image: emptyTotals(), video: emptyTotals(), llm: emptyTotals() }
  const overall = emptyTotals()
  const dailyKey = new Map<string, { date: string; kind: UsageKind; count: number; cost: number }>()
  const modelKey = new Map<string, { modelPk: string | null; modelName: string; kind: UsageKind; count: number; cost: number }>()
  const sceneDay = new Map<string, number>()
  const waste = { failedCount: 0, failedCost: 0, retriedCount: 0, duplicateSceneGenerations: 0 }

  for (const event of all) {
    const bucket = totals[event.kind]
    bucket.count += 1
    overall.count += 1
    bucket[event.outcome] += 1
    overall[event.outcome] += 1
    if (event.cost != null) {
      bucket.cost += event.cost
      overall.cost += event.cost
      if (event.outcome !== 'ok') waste.failedCost += event.cost
    } else {
      bucket.costUnknownCount += 1
      overall.costUnknownCount += 1
    }
    bucket.promptTokens += event.promptTokens ?? 0
    overall.promptTokens += event.promptTokens ?? 0
    bucket.completionTokens += event.completionTokens ?? 0
    overall.completionTokens += event.completionTokens ?? 0
    bucket.byteSize += event.byteSize
    overall.byteSize += event.byteSize

    if (event.outcome !== 'ok') waste.failedCount += 1
    if (event.kind !== 'llm' && event.attemptCount > 1) waste.retriedCount += 1

    const date = new Date(event.createdAt).toISOString().slice(0, 10)
    const dayId = `${date}|${event.kind}`
    const day = dailyKey.get(dayId) ?? { date, kind: event.kind, count: 0, cost: 0 }
    day.count += 1
    day.cost += event.cost ?? 0
    dailyKey.set(dayId, day)

    const modelId = `${event.modelPk ?? ''}|${event.kind}`
    const model = modelKey.get(modelId) ?? {
      modelPk: event.modelPk,
      modelName: event.modelName ?? '',
      kind: event.kind,
      count: 0,
      cost: 0,
    }
    model.count += 1
    model.cost += event.cost ?? 0
    modelKey.set(modelId, model)

    if (event.kind !== 'llm' && event.sceneId) {
      const bucketKey = `${event.sceneId}|${date}`
      sceneDay.set(bucketKey, (sceneDay.get(bucketKey) ?? 0) + 1)
    }
  }

  for (const count of sceneDay.values()) if (count > 1) waste.duplicateSceneGenerations += count - 1

  const settings = getUsageSettings(db, filters.userId ?? '')

  return {
    totals,
    overall,
    daily: [...dailyKey.values()].sort((a, b) => a.date.localeCompare(b.date)),
    byModel: [...modelKey.values()].sort((a, b) => b.cost - a.cost || b.count - a.count),
    waste,
    currency: settings.currency,
    mediaBytes: mediaBytesFor(db, filters.userId),
  }
}

/** Đọc hết sự kiện trong khoảng lọc (phân trang 200/lần) cho báo cáo tổng hợp. */
function collectAll(db: Database, filters: UsageFilters): UsageEvent[] {
  const out: UsageEvent[] = []
  const pageSize = 200
  for (let offset = 0; offset < 20_000; offset += pageSize) {
    const { events } = listUsageEvents(db, { ...filters, limit: pageSize, offset })
    out.push(...events)
    if (events.length < pageSize) break
  }
  return out
}

function mediaBytesFor(db: Database, userId?: string): number {
  const row = userId
    ? (db
        .prepare('SELECT COALESCE(SUM(byte_size), 0) AS total FROM assets WHERE user_id = ?')
        .get(userId) as { total: number })
    : (db.prepare('SELECT COALESCE(SUM(byte_size), 0) AS total FROM assets').get() as { total: number })
  return Number(row.total)
}

export type UsageSettings = { monthlyBudget: number | null; currency: string }

export function getUsageSettings(db: Database, userId: string): UsageSettings {
  if (!userId) return { monthlyBudget: null, currency: 'USD' }
  const row = db
    .prepare('SELECT monthly_budget AS budget, currency FROM usage_settings WHERE user_id = ?')
    .get(userId) as { budget: number | null; currency: string } | undefined
  return { monthlyBudget: row?.budget ?? null, currency: row?.currency ?? 'USD' }
}

export function saveUsageSettings(
  db: Database,
  userId: string,
  input: { monthlyBudget: number | null; currency: string },
): UsageSettings {
  db.prepare(
    `INSERT INTO usage_settings (user_id, monthly_budget, currency, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET monthly_budget = excluded.monthly_budget,
       currency = excluded.currency, updated_at = excluded.updated_at`,
  ).run(userId, input.monthlyBudget, input.currency, Date.now())
  return getUsageSettings(db, userId)
}

export type UsageMessage = {
  id: string
  sessionId: string
  sessionTitle: string
  role: 'user' | 'assistant'
  preview: string
  chars: number
  createdAt: number
  /** Lần gọi LLM đã phát sinh từ tin nhắn này (nếu còn trong log). */
  llmCalls: number
  cost: number
  costUnknown: number
}

/** Tin nhắn chat đã dùng: đọc từ `plan_messages`, chi phí nối sang `llm_usage`. */
export function listUsageMessages(
  db: Database,
  options: { userId: string; from?: number; to?: number; planSessionId?: string; q?: string; limit?: number; offset?: number },
): { messages: UsageMessage[]; total: number } {
  const where = ['ps.user_id = ?']
  const params: Array<string | number> = [options.userId]
  if (options.from !== undefined) {
    where.push('pm.created_at >= ?')
    params.push(options.from)
  }
  if (options.to !== undefined) {
    where.push('pm.created_at <= ?')
    params.push(options.to)
  }
  if (options.planSessionId) {
    where.push('pm.session_id = ?')
    params.push(options.planSessionId)
  }
  if (options.q) {
    where.push('pm.content LIKE ?')
    params.push(`%${options.q}%`)
  }
  const clause = where.join(' AND ')
  const limit = limitOf(options.limit)
  const offset = Math.max(0, Math.trunc(options.offset ?? 0))

  const rows = db
    .prepare(
      `SELECT pm.id AS id, pm.session_id AS sessionId, ps.title AS sessionTitle, pm.role AS role,
              substr(pm.content, 1, 500) AS preview, length(pm.content) AS chars, pm.created_at AS createdAt
         FROM plan_messages pm
         JOIN plan_sessions ps ON ps.id = pm.session_id
        WHERE ${clause}
        ORDER BY pm.created_at DESC, pm.id ASC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as unknown as Array<Omit<UsageMessage, 'llmCalls' | 'cost' | 'costUnknown'>>

  const total = Number(
    (
      db.prepare(
        `SELECT COUNT(*) AS total FROM plan_messages pm JOIN plan_sessions ps ON ps.id = pm.session_id WHERE ${clause}`,
      ).get(...params) as { total: number }
    ).total,
  )

  const attribution = buildAttribution(db, [...new Set(rows.map((row) => row.sessionId))])
  const callCache = new Map<string, MessageCall[]>()
  const callsFor = (attributedUserId: string): MessageCall[] => {
    const cached = callCache.get(attributedUserId)
    if (cached) return cached
    const calls = db
      .prepare(
        `SELECT prompt_tokens AS promptTokens, completion_tokens AS completionTokens,
                m.price_input_1k AS priceInput1k, m.price_output_1k AS priceOutput1k
           FROM llm_usage u LEFT JOIN models m ON m.id = u.model_pk
          WHERE u.message_id = ?`,
      )
      .all(attributedUserId) as unknown as MessageCall[]
    callCache.set(attributedUserId, calls)
    return calls
  }

  const messages = rows.map((row) => {
    const calls = callsFor(attribution.get(row.id) ?? row.id)
    let cost = 0
    let costUnknown = 0
    for (const call of calls) {
      const value = estimatedCost({ kind: 'llm', priceUnit: null, ...call })
      if (value == null) costUnknown += 1
      else cost += value
    }
    return { ...row, chars: Number(row.chars), llmCalls: calls.length, cost: round4(cost), costUnknown }
  })

  return { messages, total }
}

type MessageCall = {
  promptTokens: number | null
  completionTokens: number | null
  priceInput1k: number | null
  priceOutput1k: number | null
}

/**
 * Lần gọi LLM được ghi theo tin nhắn NGƯỜI DÙNG đã kích hoạt nó, nhưng người dùng
 * đọc chi phí ở câu trả lời, nên tin nhắn assistant của cùng nhịp được gán chi phí
 * của tin nhắn người dùng ngay trước nó.
 */
function buildAttribution(db: Database, sessionIds: string[]): Map<string, string> {
  const map = new Map<string, string>()
  if (!sessionIds.length) return map
  const placeholders = sessionIds.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT id, session_id AS sessionId, role, created_at AS createdAt
         FROM plan_messages WHERE session_id IN (${placeholders})
        ORDER BY session_id ASC, created_at ASC, rowid ASC`,
    )
    .all(...sessionIds) as unknown as Array<{ id: string; sessionId: string; role: string; createdAt: number }>
  let lastUserBySession = new Map<string, string>()
  for (const row of rows) {
    if (row.role === 'user') {
      lastUserBySession.set(row.sessionId, row.id)
      map.set(row.id, row.id)
    } else {
      const userId = lastUserBySession.get(row.sessionId)
      if (userId) map.set(row.id, userId)
    }
  }
  return map
}

/**
 * Xoá log LLM cũ hơn `days` ngày.
 *
 * Chỉ `llm_usage`: ảnh/video là nội dung thật của người dùng (bảng `generations`,
 * `assets`) nên không được job này xoá.
 */
export function purgeExpiredUsageLogs(
  db: Database,
  options: { days?: number; now?: number } = {},
): number {
  const days = options.days ?? 90
  const cutoff = (options.now ?? Date.now()) - days * 24 * 60 * 60 * 1000
  const result = db.prepare('DELETE FROM llm_usage WHERE created_at < ?').run(cutoff)
  return Number(result.changes ?? 0)
}
