import type { AppEnv } from '../env'
import { badRequest, isUncertain, providerError } from '../lib/errors'
import { callProvider, readProviderError } from '../providers/client'
import type { LlmTarget } from './connections'

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

const DEFAULT_TIMEOUT_MS = 120_000

/**
 * Gọi chat completion trên kết nối LLM của người dùng.
 *
 * Không gửi `response_format`: nhiều gateway tương thích OpenAI từ chối trường
 * này, nên yêu cầu JSON nằm trong prompt và kết quả được bóc ở `parseJsonLoose`.
 */
export async function chatText(
  env: AppEnv,
  target: LlmTarget,
  messages: ChatMessage[],
  options: { timeoutMs?: number; maxTokens?: number } = {},
): Promise<string> {
  if (env.PROVIDER_MODE === 'mock') {
    const { mockChatCompletion } = await import('../generations/adapters/mock')
    return mockChatCompletion(messages)
  }

  const body: Record<string, unknown> = {
    model: target.modelId,
    messages,
  }
  if (typeof options.maxTokens === 'number') body.max_tokens = options.maxTokens

  let response
  try {
    response = await callProvider(
      { baseUrl: target.baseUrl, apiKey: target.apiKey, allowPrivate: env.ALLOW_PRIVATE_PROVIDER_URLS },
      'chat/completions',
      { method: 'POST', body, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    )
  } catch (error) {
    // callProvider coi timeout/mất kết nối của POST là "kết quả không xác định"
    // (đúng cho tạo media). Với văn bản, người dùng bấm lại là an toàn nên trả
    // thông báo dễ hiểu thay vì để lộ ngữ nghĩa tính phí hai lần.
    if (isUncertain(error)) {
      throw providerError('AI phản hồi quá lâu. Hãy thử lại.')
    }
    throw error
  }

  if (response.status === 401 || response.status === 403) {
    throw badRequest('API key không hợp lệ hoặc không có quyền truy cập')
  }
  if (response.status === 404) {
    throw badRequest(
      `Provider không tìm thấy endpoint chat/completions hoặc model "${target.modelId}". Kiểm tra lại Base URL và model đã chọn.`,
    )
  }
  if (!response.ok) {
    throw providerError(`AI từ chối yêu cầu: ${await readProviderError(response)}`)
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>
  }
  const content = payload.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    throw providerError('AI trả về nội dung rỗng')
  }
  return content
}

/**
 * Bóc JSON từ câu trả lời của model.
 *
 * Model thường bọc JSON trong rào markdown hoặc thêm lời dẫn, nên phải chấp
 * nhận cả hai trường hợp. Trả null khi không tìm được JSON hợp lệ.
 */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim()

  const candidates: string[] = [trimmed]

  // Bỏ rào ```json ... ``` hoặc ``` ... ```.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]) candidates.push(fence[1].trim())

  // Lấy đoạn từ dấu { hoặc [ đầu tiên tới dấu đóng tương ứng cuối cùng.
  const firstBrace = trimmed.indexOf('{')
  const firstBracket = trimmed.indexOf('[')
  const start = [firstBrace, firstBracket].filter((index) => index >= 0).sort((a, b) => a - b)[0]
  if (start !== undefined) {
    const lastBrace = trimmed.lastIndexOf('}')
    const lastBracket = trimmed.lastIndexOf(']')
    const end = Math.max(lastBrace, lastBracket)
    if (end > start) candidates.push(trimmed.slice(start, end + 1))
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // Thử ứng viên kế tiếp.
    }
  }
  return null
}
