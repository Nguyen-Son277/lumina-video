import type { Database } from '../db/index'
import { badRequest } from '../lib/errors'
import { ownedCharacter, ownedProject } from '../projects/service'
import type { Voice } from '../projects/schemas'

export const PROMPT_COMPOSER_VERSION = 'voice-consistency-v1' as const
export const MAX_EFFECTIVE_PROMPT_LENGTH = 16000
const voiceKeys = ['language', 'accent', 'pitch', 'timbre', 'pace', 'articulation', 'habits'] as const
export type PromptSnapshot = {
  version: typeof PROMPT_COMPOSER_VERSION
  kind: 'image' | 'video'
  project: { id: string; name: string; description: string; style: string; language: string }
  character: { id: string; name: string; appearance: string; voice: Voice; hasReference: boolean } | null
  prompt: string
  dialogue: string
}
/** Pure local composition: captures exact persisted context, never infers missing voice attributes. */
export function composeForContext(
  db: Database, userId: string, projectId: string, characterId: string | null | undefined,
  kind: 'image' | 'video', prompt: string, dialogue = '',
  options: { hasSourceImages?: boolean } = {},
): { effectivePrompt: string; snapshot: PromptSnapshot } {
  if (kind !== 'image' && kind !== 'video') throw badRequest('Loại nội dung không hợp lệ')
  if (typeof prompt !== 'string' || typeof dialogue !== 'string') throw badRequest('Mô tả không hợp lệ')
  const project = ownedProject(db, userId, projectId, true)
  const character = characterId ? ownedCharacter(db, userId, projectId, characterId) : null
  const voice: Voice = {}
  let hasReference = false
  if (character) {
    const stored = JSON.parse(character.voice_json) as Voice
    for (const key of voiceKeys) if (stored[key]) voice[key] = stored[key]
    hasReference = Boolean(character.reference_path)
  }
  const snapshot: PromptSnapshot = {
    version: PROMPT_COMPOSER_VERSION, kind,
    project: { id: project.id, name: project.name, description: project.description, style: project.style, language: project.language },
    character: character ? { id: character.id, name: character.name, appearance: character.appearance, voice, hasReference } : null,
    prompt, dialogue,
  }
  if (kind === 'video' && dialogue && !character) throw badRequest('Lời thoại cần có nhân vật được chọn')
  const hasSourceImages = options.hasSourceImages === true
  const lines = [`[${PROMPT_COMPOSER_VERSION}]`]
  if (kind === 'video') {
    lines.push(
      'Production rules: preserve the supplied character appearance and voice attributes consistently across scenes. Do not invent missing voice attributes.',
      'Speak only the supplied dialogue, exactly as written; do not translate it or add narration, speakers or unsolicited dialogue. If no dialogue is supplied, do not fabricate speech.',
      'Request natural mouth synchronization with the supplied dialogue on a best-effort basis; this is an instruction, not a guarantee of provider capability.',
    )
    if (hasReference) {
      lines.push(
        'A reference image of the character is attached as input_reference. Use it as the canonical appearance of the character and keep that identity consistent for the whole scene.',
      )
    }
  }
  lines.push(`Project: ${project.name}`)
  if (project.description) lines.push(`Project description: ${project.description}`)
  if (project.style) lines.push(`Visual style: ${project.style}`)
  if (kind === 'video' && project.language) lines.push(`Project language: ${project.language}`)
  if (character) {
    lines.push(`Character: ${character.name}`, `Character continuity ID: ${character.id}`)
    if (character.appearance) lines.push(`Consistent appearance: ${character.appearance}`)
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
  lines.push(`Scene: ${prompt}`)
  if (kind === 'video' && dialogue) lines.push(`Dialogue for ${character!.name} (verbatim): ${dialogue}`)
  const effectivePrompt = lines.join('\n')
  if (effectivePrompt.length > MAX_EFFECTIVE_PROMPT_LENGTH) throw badRequest('Mô tả tổng hợp tối đa 16000 ký tự')
  return { effectivePrompt, snapshot }
}
