import type { CharacterRow } from '../projects/service'
import type { Voice } from '../projects/schemas'

const VOICE_LABELS: Array<{ key: keyof Voice; label: string }> = [
  { key: 'language', label: 'ngôn ngữ' },
  { key: 'accent', label: 'giọng vùng miền' },
  { key: 'pitch', label: 'cao độ' },
  { key: 'timbre', label: 'âm sắc' },
  { key: 'pace', label: 'tốc độ' },
  { key: 'articulation', label: 'phát âm' },
  { key: 'habits', label: 'thói quen nói' },
]

const CONSISTENCY_LINE =
  'Giữ nguyên ngoại hình và danh tính nhân vật này trong mọi khung hình.'

/** Đọc hồ sơ giọng an toàn: dữ liệu hỏng không được làm hỏng việc xuất prompt. */
function readVoice(voiceJson: string): Voice {
  try {
    const parsed: unknown = JSON.parse(voiceJson || '{}')
    if (typeof parsed !== 'object' || parsed === null) return {}
    return parsed as Voice
  } catch {
    return {}
  }
}

/**
 * Prompt nhân vật để người dùng mang sang công cụ khác.
 *
 * Chỉ ghép từ dữ liệu đã lưu của nhân vật, không suy diễn thêm, và bỏ qua phần
 * trống để prompt gọn và dùng được ngay.
 */
export function composeCharacterPrompt(character: CharacterRow): string {
  const voice = readVoice(character.voice_json)
  const voiceParts = VOICE_LABELS
    .filter(({ key }) => typeof voice[key] === 'string' && voice[key]!.trim())
    .map(({ key, label }) => `${label} ${voice[key]!.trim()}`)

  const segments = [character.name.trim()]
  if (character.appearance.trim()) segments.push(`Ngoại hình: ${character.appearance.trim()}`)
  if (voiceParts.length) segments.push(`Giọng nói: ${voiceParts.join(', ')}`)

  return `${segments.join('. ')}. ${CONSISTENCY_LINE}`
}
