import type { Generation } from './types'

export type Project = { id: string; name: string; description: string; style: string; language: string; archived: boolean; createdAt?: number; updatedAt?: number }
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
export type ProjectScene = { id: string; projectId: string; title: string; prompt: string; characterId: string | null; dialogue: string; modelId: string; params: Record<string, unknown>; position: number; selectedGenerationId: string | null }
export type SceneInput = Pick<ProjectScene, 'title' | 'prompt' | 'characterId' | 'dialogue' | 'modelId' | 'params' | 'position'>
export type PromptPreview = { effectivePrompt: string; snapshot?: unknown; warnings?: string[] }
export type ProjectGeneration = Generation & { projectId?: string | null; characterId?: string | null; sceneId?: string | null }
