import { randomUUID } from 'node:crypto'
import type { Database } from '../db/index'
import { logger } from '../lib/logger'

/**
 * Nguồn của một lần gọi model chữ. Giữ cố định để giao diện lọc được và để báo
 * cáo chi phí không phụ thuộc vào câu prompt.
 */
export const LLM_SOURCES = [
  'planner_chat',
  'planner_script',
  'planner_cast',
  'planner_timeline',
  'planner_arrange',
  'planner_locations',
  'planner_variant',
  'planner_profile',
  'planner_propose_timeline',
  'planner_propose_locations',
  'character_ai',
] as const
export type LlmSource = (typeof LLM_SOURCES)[number]

/** Số ký tự preview giữ lại trong log; toàn văn nằm ở bảng gốc. */
export const PREVIEW_CHARS = 500
/** Token tối đa nhận từ provider để một phản hồi lạ không ghi số vô lý. */
const MAX_TOKENS = 10_000_000

export type LlmUsageEvent = {
  userId: string
  source: LlmSource
  modelPk?: string | null
  providerId?: string | null
  planSessionId?: string | null
  projectId?: string | null
  messageId?: string | null
  /** Nội dung gửi đi (tin nhắn/ngữ cảnh) — sẽ được cắt thành preview. */
  requestText?: string
  /** Phản hồi của model — sẽ được cắt thành preview. */
  responseText?: string
  promptTokens?: number | null
  completionTokens?: number | null
  status: 'ok' | 'error'
  errorCode?: string | null
  latencyMs: number
  now?: number
}

const previewOf = (value: string | undefined): string =>
  typeof value === 'string' ? value.trim().slice(0, PREVIEW_CHARS) : ''

const tokenOf = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const rounded = Math.trunc(value)
  if (rounded < 0 || rounded > MAX_TOKENS) return null
  return rounded
}

/** `usage` của provider tương thích OpenAI; chấp nhận cả tên trường kiểu Anthropic. */
export function readTokenUsage(payload: unknown): {
  promptTokens: number | null
  completionTokens: number | null
} {
  const usage = (payload && typeof payload === 'object' ? (payload as { usage?: unknown }).usage : null) as
    | Record<string, unknown>
    | null
  if (!usage || typeof usage !== 'object') return { promptTokens: null, completionTokens: null }
  const prompt = tokenOf(usage.prompt_tokens ?? usage.input_tokens)
  const completion = tokenOf(usage.completion_tokens ?? usage.output_tokens)
  return { promptTokens: prompt, completionTokens: completion }
}

/**
 * Ghi một dòng nhật ký sử dụng.
 *
 * Không bao giờ ném lỗi: log là tính năng phụ trợ, hỏng log không được làm hỏng
 * việc tạo nội dung của người dùng. Lỗi chỉ được ghi cảnh báo.
 */
export function recordLlmUsage(db: Database, event: LlmUsageEvent): void {
  try {
    const request = typeof event.requestText === 'string' ? event.requestText : ''
    const response = typeof event.responseText === 'string' ? event.responseText : ''
    db.prepare(
      `INSERT INTO llm_usage
         (id, user_id, model_pk, provider_id, source, plan_session_id, project_id, message_id,
          preview, response_preview, prompt_chars, response_chars, prompt_tokens, completion_tokens,
          status, error_code, latency_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      event.userId,
      event.modelPk ?? null,
      event.providerId ?? null,
      event.source,
      event.planSessionId ?? null,
      event.projectId ?? null,
      event.messageId ?? null,
      previewOf(request),
      previewOf(response),
      request.length,
      response.length,
      tokenOf(event.promptTokens),
      tokenOf(event.completionTokens),
      event.status,
      event.errorCode ?? null,
      Math.max(0, Math.trunc(event.latencyMs)),
      event.now ?? Date.now(),
    )
  } catch (error) {
    logger.warn('Không ghi được nhật ký sử dụng LLM', { source: event.source, error })
  }
}
