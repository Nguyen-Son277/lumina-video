import type { AppEnv } from '../env'
import type { Database } from '../db/index'
import { providerError } from '../lib/errors'
import { characterSchema, type Voice } from '../projects/schemas'
import { resolveLlmTarget } from '../llm/connections'
import { chatText, parseJsonLoose, type ChatMessage } from '../llm/chat'

export const MAX_GENERATE_COUNT = 6
export const DEFAULT_GENERATE_COUNT = 3
export const MAX_DESCRIPTION_LENGTH = 2000

const VOICE_KEYS = [
  'language',
  'accent',
  'pitch',
  'timbre',
  'pace',
  'articulation',
  'habits',
] as const

const VOICE_LIMITS: Record<(typeof VOICE_KEYS)[number], number> = {
  language: 200,
  accent: 200,
  pitch: 200,
  timbre: 500,
  pace: 200,
  articulation: 500,
  habits: 1000,
}

export type GeneratedCharacter = { name: string; appearance: string; voice: Voice }

/**
 * Prompt yêu cầu model trả JSON thuần.
 *
 * Không dùng `response_format` vì nhiều gateway tương thích OpenAI từ chối
 * trường đó; thay vào đó hợp đồng JSON được nêu rõ trong chỉ dẫn.
 */
export function buildCharacterMessages(input: {
  description: string
  count: number
  language: string
  existingNames: string[]
}): ChatMessage[] {
  const system = [
    'Bạn là trợ lý thiết kế nhân vật cho một studio làm phim bằng AI.',
    'Nhiệm vụ: tạo hồ sơ nhân vật mới dựa trên mô tả của người dùng.',
    '',
    'CHỈ trả về duy nhất một đối tượng JSON, không thêm chữ nào khác, đúng định dạng:',
    '{"characters":[{"name":"...","appearance":"...","voice":{"language":"...","accent":"...","pitch":"...","timbre":"...","pace":"...","articulation":"...","habits":"..."}}]}',
    '',
    'Quy tắc:',
    `- Tạo đúng ${input.count} nhân vật, mỗi nhân vật một tên riêng khác nhau.`,
    '- Không dùng lại tên đã có trong danh sách người dùng cung cấp.',
    '- appearance: mô tả ngoại hình cụ thể, ngắn gọn (tuổi, tóc, trang phục, dáng vẻ).',
    '- voice: điền đủ 7 trường bằng tiếng Việt, mô tả giọng nói đặc trưng.',
    '- Bám sát mô tả của người dùng; không thêm bối cảnh hay thông tin ngoài mô tả.',
  ].join('\n')

  const lines = [
    `Mô tả của người dùng: ${input.description}`,
    `Số lượng cần tạo: ${input.count}`,
    `Ngôn ngữ: ${input.language}`,
  ]
  if (input.existingNames.length) {
    lines.push(`Tên nhân vật đã có (không được trùng): ${input.existingNames.join(', ')}`)
  }

  return [
    { role: 'system', content: system },
    { role: 'user', content: lines.join('\n') },
  ]
}

function asText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, maxLength)
}

/**
 * Chuẩn hóa câu trả lời của model thành danh sách nhân vật hợp lệ.
 *
 * Chấp nhận cả `{characters:[...]}` lẫn mảng trần, cắt độ dài theo giới hạn của
 * `characterSchema`, bỏ ứng viên thiếu tên hoặc trùng tên, và giới hạn số lượng.
 */
export function normalizeCandidates(
  raw: unknown,
  options: { count: number; language: string; existingNames?: string[] },
): GeneratedCharacter[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { characters?: unknown }).characters)
      ? ((raw as { characters: unknown[] }).characters)
      : []

  const taken = new Set((options.existingNames ?? []).map((name) => name.trim().toLowerCase()))
  const candidates: GeneratedCharacter[] = []

  for (const item of list) {
    if (candidates.length >= options.count) break
    if (typeof item !== 'object' || item === null) continue

    const record = item as Record<string, unknown>
    const name = asText(record.name, 200)
    if (!name || taken.has(name.toLowerCase())) continue

    const voiceRecord =
      record.voice && typeof record.voice === 'object'
        ? (record.voice as Record<string, unknown>)
        : {}
    const voice: Record<string, string> = {}
    for (const key of VOICE_KEYS) {
      const value = asText(voiceRecord[key], VOICE_LIMITS[key])
      // Ngôn ngữ mặc định theo yêu cầu khi model bỏ trống.
      voice[key] = value || (key === 'language' ? options.language : '')
    }

    // Dùng đúng schema của API tạo nhân vật để ứng viên luôn lưu được.
    const parsed = characterSchema.safeParse({
      name,
      appearance: asText(record.appearance, 4000),
      voice,
    })
    if (!parsed.success) continue

    taken.add(name.toLowerCase())
    candidates.push(parsed.data)
  }

  return candidates
}

/**
 * Sinh nhân vật mẫu bằng kết nối LLM của người dùng.
 *
 * Không ghi database: ứng viên chỉ được lưu khi người dùng chọn và bấm thêm.
 */
export async function generateCharacterCandidates(options: {
  db: Database
  env: AppEnv
  userId: string
  description: string
  count: number
  language: string
  connectionId?: string
}): Promise<{ candidates: GeneratedCharacter[]; connectionId: string; model: string }> {
  const { db, env, userId, description, count, language, connectionId } = options

  const existingNames = (
    db.prepare('SELECT name FROM characters WHERE user_id = ?').all(userId) as unknown as Array<{
      name: string
    }>
  ).map((row) => row.name)

  const target = resolveLlmTarget(db, env, userId, connectionId)

  const content = await chatText(env, target, buildCharacterMessages({
    description,
    count,
    language,
    existingNames,
  }))

  const candidates = normalizeCandidates(parseJsonLoose(content), {
    count,
    language,
    existingNames,
  })

  if (!candidates.length) {
    throw providerError('AI trả về dữ liệu không đọc được. Hãy thử lại.')
  }

  return { candidates, connectionId: target.connection.id, model: target.modelId }
}
