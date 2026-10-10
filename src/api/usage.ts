/**
 * Client + kiểu dữ liệu cho "Nhật ký sử dụng".
 *
 * Hợp đồng backend nằm ở `server/usage/service.ts`; các kiểu dưới đây khai báo lại
 * cho phía trình duyệt, không import code server. Đơn giá model do người dùng tự
 * nhập (`PATCH /api/models/:id`) vì provider không trả giá trong API.
 */

import { api } from './client'
import { modelApi } from './endpoints'
import type { ModelInfo } from './types'

export const USAGE_KINDS = ['image', 'video', 'llm'] as const
export type UsageKind = (typeof USAGE_KINDS)[number]

export const USAGE_OUTCOMES = ['ok', 'failed', 'unknown', 'pending'] as const
export type UsageOutcome = (typeof USAGE_OUTCOMES)[number]

/** Một dòng nhật ký đã hợp nhất (ảnh/video suy từ `generations`, LLM từ `llm_usage`). */
export type UsageEvent = {
  id: string
  kind: UsageKind
  /** Với LLM: nguồn gọi (`planner_chat`, `character_ai`…). Với media: chính loại nội dung. */
  source: string
  outcome: UsageOutcome
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
  daily: Array<{ date: string; kind: UsageKind; count: number; cost: number }>
  byModel: Array<{ modelPk: string | null; modelName: string; kind: UsageKind; count: number; cost: number }>
  waste: {
    failedCount: number
    failedCost: number
    retriedCount: number
    duplicateSceneGenerations: number
  }
  currency: string
  mediaBytes: number
}

export type UsageSettings = { monthlyBudget: number | null; currency: string }

export type UsageMessage = {
  id: string
  sessionId: string
  sessionTitle: string
  role: 'user' | 'assistant'
  preview: string
  chars: number
  createdAt: number
  llmCalls: number
  cost: number
  costUnknown: number
}

/** Bộ lọc dùng chung cho `/usage` và `/admin/usage`. */
export type UsageFilters = {
  from?: number
  to?: number
  kind?: UsageKind[]
  outcome?: UsageOutcome[]
  modelPk?: string
  q?: string
  limit?: number
  offset?: number
}

export type UsageListResponse = {
  summary: UsageSummary
  events: UsageEvent[]
  total: number
  settings: UsageSettings
  retentionDays: number
}

/** Trang quản trị không trả `settings`/`retentionDays` (toàn hệ thống, không có ngân sách chung). */
export type AdminUsageResponse = {
  summary: UsageSummary
  events: UsageEvent[]
  total: number
}

export type UsageMessageQuery = {
  from?: number
  to?: number
  sessionId?: string
  q?: string
  limit?: number
  offset?: number
}

/** Model kèm 4 trường đơn giá mới của `GET /api/models`. */
export type UsageModel = ModelInfo & {
  priceUnit: number | null
  priceInput1k: number | null
  priceOutput1k: number | null
  priceCurrency: string
}

/** `PATCH /api/models/:id`: số không âm, hoặc null để xoá đơn giá. */
export type ModelPricePatch = {
  priceUnit?: number | null
  priceInput1k?: number | null
  priceOutput1k?: number | null
  priceCurrency?: string
}

/** Nối tham số thành query string; bỏ hết giá trị rỗng/undefined. */
function buildQuery(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    query.set(key, String(value))
  }
  const suffix = query.toString()
  return suffix ? `?${suffix}` : ''
}

/** csv theo hợp đồng: `kind=image,llm`, `outcome=ok,failed`. */
const csv = <T extends string>(values: T[] | undefined): string | undefined =>
  values && values.length ? values.join(',') : undefined

export const usageApi = {
  list: (filters: UsageFilters = {}, signal?: AbortSignal) =>
    api.get<UsageListResponse>(
      `/usage${buildQuery({
        from: filters.from,
        to: filters.to,
        kind: csv(filters.kind),
        outcome: csv(filters.outcome),
        modelPk: filters.modelPk,
        q: filters.q,
        limit: filters.limit,
        offset: filters.offset,
      })}`,
      signal,
    ),
  messages: (query: UsageMessageQuery = {}, signal?: AbortSignal) =>
    api.get<{ messages: UsageMessage[]; total: number }>(
      `/usage/messages${buildQuery({
        from: query.from,
        to: query.to,
        sessionId: query.sessionId,
        q: query.q,
        limit: query.limit,
        offset: query.offset,
      })}`,
      signal,
    ),
  saveSettings: (input: UsageSettings) =>
    api.put<{ settings: UsageSettings }>('/usage/settings', input),
  /** Xoá log LLM của chính mình; ảnh/video không bị đụng tới. */
  clearLogs: () => api.delete<{ deleted: number }>('/usage/logs'),
  /** Dọn log cũ hơn 90 ngày ngay lập tức (job dọn cũng chạy theo lịch). */
  purgeLogs: () => api.post<{ deleted: number }>('/usage/logs/purge'),
}

export const adminUsageApi = {
  list: (filters: UsageFilters & { userId?: string } = {}, signal?: AbortSignal) =>
    api.get<AdminUsageResponse>(
      `/admin/usage${buildQuery({
        userId: filters.userId,
        from: filters.from,
        to: filters.to,
        kind: csv(filters.kind),
        outcome: csv(filters.outcome),
        modelPk: filters.modelPk,
        q: filters.q,
        limit: filters.limit,
        offset: filters.offset,
      })}`,
      signal,
    ),
}

/**
 * Đọc model kèm đơn giá và lưu đơn giá.
 *
 * `ModelInfo` trong `src/api/types.ts` chưa khai báo 4 trường giá (ngoài phạm vi
 * được phép sửa), nên lớp này bổ sung kiểu và gọi `modelApi` sẵn có.
 */
export const usageModelApi = {
  list: async (): Promise<UsageModel[]> => {
    const result = await modelApi.list()
    return result.models as UsageModel[]
  },
  update: async (id: string, patch: ModelPricePatch): Promise<UsageModel> => {
    const result = await modelApi.update(id, patch)
    return result.model as UsageModel
  },
}
