import type { AppEnv } from '../env'
import type { Database } from '../db/index'
import { chatContentText, chatTextWithUsage, type ChatMessage } from '../llm/chat'
import type { LlmTarget } from '../llm/connections'
import { errorMetadataOf } from '../lib/errors'
import { recordLlmUsage, type LlmSource } from './log'

export type LoggedLlmOptions = {
  db: Database
  env: AppEnv
  userId: string
  target: LlmTarget
  messages: ChatMessage[]
  source: LlmSource
  planSessionId?: string | null
  projectId?: string | null
  /** Tin nhắn chat đã phát sinh lần gọi này (nếu có). */
  messageId?: string | null
  now?: number
  maxTokens?: number
}

/**
 * Gọi model chữ và ghi nhật ký sử dụng trong cùng một chỗ.
 *
 * Mọi lần gọi LLM của ứng dụng đi qua đây để không sót chi phí token và để mọi
 * nguồn dùng đúng một cách đo `latency_ms`. Lỗi vẫn được ném lại nguyên vẹn cho
 * tầng gọi xử lý; nhật ký chỉ ghi thêm trạng thái lỗi.
 */
export async function runLoggedLlm(options: LoggedLlmOptions): Promise<string> {
  const startedAt = Date.now()
  // Nội dung gửi đi để đối chiếu: tin nhắn người dùng cuối cùng, kèm vai trò.
  const requestText = chatContentText([...options.messages]
    .reverse()
    .find((message) => message.role === 'user')?.content ?? options.messages.at(-1)?.content ?? '')

  try {
    const result = await chatTextWithUsage(options.env, options.target, options.messages, { maxTokens: options.maxTokens })
    recordLlmUsage(options.db, {
      userId: options.userId,
      source: options.source,
      modelPk: options.target.modelPk,
      providerId: options.target.providerId,
      planSessionId: options.planSessionId,
      projectId: options.projectId,
      messageId: options.messageId,
      requestText,
      responseText: options.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))
        ? result.text.replace(/[a-z0-9+/]{256,}={0,2}/gi, '[encoded data]')
        : result.text,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      status: 'ok',
      latencyMs: Date.now() - startedAt,
      now: options.now,
    })
    return result.text
  } catch (error) {
    recordLlmUsage(options.db, {
      userId: options.userId,
      source: options.source,
      modelPk: options.target.modelPk,
      providerId: options.target.providerId,
      planSessionId: options.planSessionId,
      projectId: options.projectId,
      messageId: options.messageId,
      requestText,
      status: 'error',
      errorCode: errorMetadataOf(error).messageKey,
      latencyMs: Date.now() - startedAt,
      now: options.now,
    })
    throw error
  }
}
