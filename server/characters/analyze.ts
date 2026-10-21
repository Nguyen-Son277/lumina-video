import type { Database } from '../db/index'
import type { AppEnv } from '../env'
import type { MediaStore } from '../media/store'
import { badRequest, conflict, notFound, providerError } from '../lib/errors'
import { ownedCharacterById, type CharacterRow } from '../projects/service'
import { prepareAnalysisImage } from '../entityLibrary/analyze'
import { resolveLlmTarget } from '../llm/connections'
import { parseJsonLoose } from '../llm/chat'
import { runLoggedLlm } from '../usage/llm'
import { buildImageCharacterMessages, normalizeCandidates, validateImageCharacterResponse } from './generate'

export type CharacterReferenceSuggestion = { name: string; appearance: string }
type AnalyzeOptions = { db: Database; env: AppEnv; userId: string; modelId: string; language?: string; bytes: Uint8Array }

/** Reuse the vision rules/normalizer, without excluding existing character names or returning voice. */
export async function analyzeCharacterReference(options: AnalyzeOptions): Promise<{ suggestion: CharacterReferenceSuggestion }> {
  if (!options.modelId.trim()) throw badRequest('Cần chọn model LLM để phân tích ảnh')
  const target = resolveLlmTarget(options.db, options.env, options.userId, options.modelId)
  const image = await prepareAnalysisImage(options.bytes, options.env.MAX_REFERENCE_BYTES)
  const language = options.language ?? 'vi'
  const text = await runLoggedLlm({
    db: options.db, env: options.env, userId: options.userId, target, source: 'character_ai', maxTokens: 2500,
    messages: buildImageCharacterMessages({ description: '', language, existingNames: [], image, suggestionOnly: true }),
  })
  const raw = parseJsonLoose(text)
  validateImageCharacterResponse(raw)
  const candidate = normalizeCandidates(raw, { count: 1, language })[0]
  if (!candidate) throw providerError('AI trả về đề xuất không hợp lệ. Vui lòng thử lại.')
  return { suggestion: { name: candidate.name, appearance: candidate.appearance } }
}

export async function analyzeExistingCharacterReference(options: Omit<AnalyzeOptions, 'bytes'> & { mediaStore: MediaStore; characterId: string }) {
  const character = ownedCharacterById(options.db, options.userId, options.characterId)
  if (!character.reference_path) throw notFound('Nhân vật chưa có ảnh tham chiếu')
  let size: number
  try { size = options.mediaStore.stat(character.reference_path).size }
  catch { throw notFound('Ảnh tham chiếu không còn trên máy chủ') }
  if (size > options.env.MAX_REFERENCE_BYTES || (character.reference_bytes ?? 0) > options.env.MAX_REFERENCE_BYTES) {
    throw badRequest('Ảnh tham chiếu vượt giới hạn cho phép')
  }
  let bytes: Uint8Array
  try { bytes = options.mediaStore.readFile(character.reference_path) }
  catch { throw notFound('Ảnh tham chiếu không còn trên máy chủ') }
  const result = await analyzeCharacterReference({ ...options, bytes })
  // Never allow a late vision response to describe an edited/replaced/deleted row.
  const current = options.db.prepare('SELECT * FROM characters WHERE id=? AND user_id=? AND deleted_at IS NULL')
    .get(character.id, options.userId) as CharacterRow | undefined
  if (!current || current.updated_at !== character.updated_at || current.reference_path !== character.reference_path ||
    current.reference_mime !== character.reference_mime || current.reference_bytes !== character.reference_bytes) {
    throw conflict('Nhân vật hoặc ảnh tham chiếu đã thay đổi trong khi phân tích. Vui lòng thử lại.')
  }
  return { ...result, revision: character.updated_at }
}
