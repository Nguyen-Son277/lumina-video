import type { Database } from '../db/index'
import { badRequest } from '../lib/errors'
import { ownedCharacterById, ownedProject, ownedUsableCharacter } from '../projects/service'
import type { Voice } from '../projects/schemas'

export const PROMPT_COMPOSER_VERSION = 'voice-consistency-v2' as const
export const MAX_EFFECTIVE_PROMPT_LENGTH = 16000
const voiceKeys = ['language', 'accent', 'pitch', 'timbre', 'pace', 'articulation', 'habits'] as const
export type PromptSnapshot = {
  version: typeof PROMPT_COMPOSER_VERSION
  kind: 'image' | 'video'
  /** Null khi tác vụ không thuộc dự án nào (Tạo nội dung đơn lẻ). */
  project: { id: string; name: string; description: string; style: string; language: string } | null
  character: { id: string; name: string; appearance: string; voice: Voice; hasReference: boolean } | null
  /** Các nhân vật khác xuất hiện trong cảnh, không phải người nói chính. */
  cast?: Array<{ id: string; name: string; appearance: string }>
  /** Bối cảnh của cảnh tại thời điểm tạo. */
  background?: string
  prompt: string
  dialogue: string
}
/** Pure local composition: captures exact persisted context, never infers missing voice attributes. */
export function composeForContext(
  db: Database, userId: string, projectId: string | null, characterId: string | null | undefined,
  kind: 'image' | 'video', prompt: string, dialogue = '',
  options: {
    hasSourceImages?: boolean
    hasCharacterReference?: boolean
    /** Nhân vật xuất hiện trong cảnh, người nói chính đứng đầu. */
    castIds?: string[]
    background?: string
  } = {},
): { effectivePrompt: string; snapshot: PromptSnapshot } {
  if (kind !== 'image' && kind !== 'video') throw badRequest('Loại nội dung không hợp lệ')
  if (typeof prompt !== 'string' || typeof dialogue !== 'string') throw badRequest('Mô tả không hợp lệ')
  const project = projectId ? ownedProject(db, userId, projectId, true) : null
  // Nhân vật có thể là nhân vật thư viện dùng chung (project_id IS NULL).
  const character = characterId
    ? project
      ? ownedUsableCharacter(db, userId, project.id, characterId)
      : ownedCharacterById(db, userId, characterId)
    : null
  const voice: Voice = {}
  let hasReference = false
  if (character) {
    const stored = JSON.parse(character.voice_json) as Voice
    for (const key of voiceKeys) if (stored[key]) voice[key] = stored[key]
    hasReference = Boolean(character.reference_path)
  }

  // Nhân vật phụ trong cảnh: chỉ lấy ngoại hình để mô tả, không gán lời thoại.
  const cast: Array<{ id: string; name: string; appearance: string }> = []
  for (const id of options.castIds ?? []) {
    if (!id || id === character?.id) continue
    if (cast.some((member) => member.id === id)) continue
    const row = project
      ? ownedUsableCharacter(db, userId, project.id, id)
      : ownedCharacterById(db, userId, id)
    cast.push({ id: row.id, name: row.name, appearance: row.appearance })
  }

  const background = (options.background ?? '').trim()

  const snapshot: PromptSnapshot = {
    version: PROMPT_COMPOSER_VERSION, kind,
    project: project ? { id: project.id, name: project.name, description: project.description, style: project.style, language: project.language } : null,
    character: character ? { id: character.id, name: character.name, appearance: character.appearance, voice, hasReference } : null,
    cast: cast.length ? cast : undefined,
    background: background || undefined,
    prompt, dialogue,
  }
  if (kind === 'video' && dialogue && !character) throw badRequest('Lời thoại cần có nhân vật được chọn')
  const hasSourceImages = options.hasSourceImages === true
  const hasCharacterReference = options.hasCharacterReference === true
  const lines = [`[${PROMPT_COMPOSER_VERSION}]`]
  if (kind === 'video') {
    lines.push(
      'Production rules: preserve the supplied character appearance and voice attributes consistently across scenes. Do not invent missing voice attributes.',
      'Speak only the supplied dialogue, exactly as written; do not translate it or add narration, speakers or unsolicited dialogue. If no dialogue is supplied, do not fabricate speech.',
      'Request natural mouth synchronization with the supplied dialogue on a best-effort basis; this is an instruction, not a guarantee of provider capability.',
    )
    // Chỉ nói có ảnh tham chiếu khi ảnh đó THỰC SỰ được gửi kèm: người dùng có
    // thể đã tắt "Gửi ảnh tham chiếu" hoặc ảnh không còn trong kho media.
    if (hasCharacterReference) {
      lines.push(
        'A reference image of the character is attached as input_reference. Use it as the canonical appearance of the character and keep that identity consistent for the whole scene.',
      )
    }
  }
  if (project) {
    lines.push(`Project: ${project.name}`)
    if (project.description) lines.push(`Project description: ${project.description}`)
    if (project.style) lines.push(`Visual style: ${project.style}`)
    if (kind === 'video' && project.language) lines.push(`Project language: ${project.language}`)
  }
  if (character) {
    lines.push(`Character: ${character.name}`, `Character continuity ID: ${character.id}`)
    if (character.appearance) lines.push(`Consistent appearance: ${character.appearance}`)
  }
  // Nhân vật phụ chỉ được mô tả ngoại hình; không gán lời thoại cho họ.
  for (const member of cast) {
    lines.push(`Also present: ${member.name}${member.appearance ? ` — ${member.appearance}` : ''}`)
  }
  if (kind === 'image' && hasCharacterReference) {
    lines.push(
      'A reference image of the character is attached as an input image. Use it as the canonical appearance of the character and keep that identity consistent, together with the described appearance and the visual style above.',
    )
  }
  if (kind === 'image' && hasSourceImages) {
    lines.push(
      'The source image(s) are attached as input references. Keep the subject and composition consistent with them while applying the requested change.',
    )
  }
  // Image prompts intentionally omit dialogue, voice and all audio instructions.
  if (kind === 'video' && Object.keys(voice).length) {
    lines.push('Stable voice metadata (supplied attributes only):')
    for (const key of voiceKeys) if (voice[key]) lines.push(`Voice ${key}: ${voice[key]}`)
  }
  if (background) lines.push(`Scene setting: ${background}`)
  lines.push(`Scene: ${prompt}`)
  if (kind === 'video' && dialogue) lines.push(`Dialogue for ${character!.name} (verbatim): ${dialogue}`)
  const effectivePrompt = lines.join('\n')
  if (effectivePrompt.length > MAX_EFFECTIVE_PROMPT_LENGTH) throw badRequest('Mô tả tổng hợp tối đa 16000 ký tự')
  return { effectivePrompt, snapshot }
}
