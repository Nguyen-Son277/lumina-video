export const CHARACTER_PROFILE_KEYS = ['nationality', 'age', 'gender', 'skinTone', 'face', 'eyes', 'hairColor', 'hairStyle', 'heightCm', 'build', 'posture', 'clothing', 'footwear', 'accessories', 'distinctiveFeatures', 'contextNotes'] as const
export type CharacterProfile = Record<(typeof CHARACTER_PROFILE_KEYS)[number], string>
export type CharacterVariant = {
  id: string
  label: string
  profile: CharacterProfile
  sourceAppearance?: string
  appearance: string
  rationale: string
  assumptions: string[]
  portrait: { uploadId: string } | null
  revision: number
  portraitRevision: number | null
  generationId: string | null
}
export const CHARACTER_PROFILE_LABELS: Record<keyof CharacterProfile, string> = {
  nationality: 'Quốc tịch / xuất thân văn hóa', age: 'Tuổi', gender: 'Giới tính / thể hiện giới', skinTone: 'Màu da', face: 'Khuôn mặt', eyes: 'Mắt', hairColor: 'Màu tóc', hairStyle: 'Kiểu và độ dài tóc', heightCm: 'Chiều cao (cm)', build: 'Vóc dáng', posture: 'Tư thế / dáng đi', clothing: 'Trang phục (món đồ, màu, chất liệu, kiểu dáng)', footwear: 'Giày dép', accessories: 'Phụ kiện', distinctiveFeatures: 'Đặc điểm nhận diện', contextNotes: 'Ghi chú bối cảnh',
}
export function profileAppearance(profile: CharacterProfile): string {
  return CHARACTER_PROFILE_KEYS.flatMap(key => profile[key]?.trim() ? [`${CHARACTER_PROFILE_LABELS[key]}: ${profile[key].trim()}`] : []).join('; ').slice(0, 4000)
}
