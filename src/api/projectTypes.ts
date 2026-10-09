import type { Generation } from './types'

export type Project = { id: string; name: string; description: string; style: string; language: string; archived: boolean; deletedAt?: number | null; purgeAfter?: number | null; deleteResults?: boolean; createdAt?: number; updatedAt?: number }
export type ProjectInput = Pick<Project, 'name' | 'description' | 'style' | 'language' | 'archived'>
export type CharacterVoice = { language: string; accent: string; pitch: string; timbre: string; pace: string; articulation: string; habits: string }
export type ProjectCharacter = {
  id: string
  /** Null khi nhân vật thuộc thư viện dùng chung, không gắn dự án nào. */
  projectId: string | null
  name: string
  appearance: string
  voice: CharacterVoice
  /** Đường dẫn có xác thực tới ảnh tham chiếu, null nếu chưa có. */
  referenceUrl: string | null
  referenceMime: string | null
  referenceBytes: number | null
}
export type CharacterInput = Pick<ProjectCharacter, 'name' | 'appearance' | 'voice'>
/** Nhân vật mẫu do AI sinh ra, chưa lưu vào thư viện. */
export type GeneratedCharacter = CharacterInput
export type ProjectScene = {
  id: string
  projectId: string
  title: string
  prompt: string
  characterId: string | null
  dialogue: string
  modelId: string
  params: Record<string, unknown>
  position: number
  selectedGenerationId: string | null
  background: string
  locationId?: string | null
  /** Ảnh minh hoạ storyboard của cảnh (bảng uploads); null khi chưa có. */
  backgroundUploadId?: string | null
  /** URL có xác thực để tải ảnh minh hoạ; null khi chưa có. */
  backgroundUrl?: string | null
  /** Cảnh đã được duyệt để xếp hàng tạo video. */
  approved?: boolean
  /** Cảnh được đánh dấu để worker tự xếp hàng tạo video sau khi duyệt. */
  autoGenerate?: boolean
}
export type ProjectLocation = { id: string; name: string; stage: string; description: string; continuityNotes: string; imagePrompt: string; reference: { uploadId: string } | null; revision: number }
export type ProjectLocationInput = Omit<ProjectLocation, 'id' | 'revision'> & { id?: string }
export type SceneInput = Pick<ProjectScene, 'title' | 'prompt' | 'characterId' | 'dialogue' | 'modelId' | 'params' | 'position' | 'background' | 'backgroundUploadId'>
/** Thao tác hàng loạt trên cảnh; server không tự xếp hàng tạo nội dung. */
export type SceneBulkInput = {
  ids?: string[]
  approved?: boolean
  autoGenerate?: boolean
  modelId?: string | null
}
export type PromptPreview = { effectivePrompt: string; snapshot?: unknown; warnings?: string[] }
export type ProjectGeneration = Generation & { projectId?: string | null; characterId?: string | null; sceneId?: string | null }
