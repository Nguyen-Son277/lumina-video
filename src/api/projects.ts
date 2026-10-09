import { api } from './client'
import type { Generation } from './types'
import type { CharacterInput, Project, ProjectCharacter, ProjectGeneration, ProjectInput, ProjectScene, PromptPreview, SceneInput } from './projectTypes'
export type { Project, ProjectCharacter, ProjectScene, CharacterVoice } from './projectTypes'

const projectPath = (id: string) => `/projects/${encodeURIComponent(id)}`
const scenePath = (id: string) => `/scenes/${encodeURIComponent(id)}`
export const projectsApi = {
  list: (trash = false) => api.get<{ projects: Project[] }>(trash ? '/projects?trash=true' : '/projects'),
  trash: (id: string, deleteResults = false) => api.post<{ project: Project }>(`${projectPath(id)}/trash`, { deleteResults }),
  restore: (id: string) => api.post<{ project: Project }>(`${projectPath(id)}/restore`),
  create: (input: ProjectInput) => api.post<{ project: Project }>('/projects', input),
  update: (id: string, input: Partial<ProjectInput>) => api.patch<{ project: Project }>(projectPath(id), input),
  characters: (id: string) => api.get<{ characters: ProjectCharacter[] }>(`${projectPath(id)}/characters`),
  createCharacter: (id: string, input: CharacterInput) => api.post<{ character: ProjectCharacter }>(`${projectPath(id)}/characters`, input),
  updateCharacter: (id: string, characterId: string, input: CharacterInput) => api.patch<{ character: ProjectCharacter }>(`${projectPath(id)}/characters/${encodeURIComponent(characterId)}`, input),
  /** Tải ảnh tham chiếu lên dạng nhị phân thô; backend kiểm tra magic bytes. */
  uploadCharacterReference: async (id: string, characterId: string, file: File) => {
    const response = await fetch(
      `/api/projects/${encodeURIComponent(id)}/characters/${encodeURIComponent(characterId)}/reference`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      },
    )
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null
      throw new Error(payload?.error?.message ?? `Tải ảnh thất bại (mã ${response.status})`)
    }
    return (await response.json()) as { character: ProjectCharacter }
  },
  removeCharacterReference: (id: string, characterId: string) =>
    api.delete<{ character: ProjectCharacter }>(
      `${projectPath(id)}/characters/${encodeURIComponent(characterId)}/reference`,
    ),
  scenes: (id: string) => api.get<{ scenes: ProjectScene[] }>(`${projectPath(id)}/scenes`),
  createScene: (id: string, input: SceneInput) => api.post<{ scene: ProjectScene }>(`${projectPath(id)}/scenes`, input),
  updateScene: (id: string, sceneId: string, input: Partial<SceneInput>) => api.patch<{ scene: ProjectScene }>(`${projectPath(id)}/scenes/${encodeURIComponent(sceneId)}`, input),
  reorder: (id: string, sceneIds: string[]) => api.post<{ scenes: ProjectScene[] }>(`${projectPath(id)}/scenes/reorder`, { sceneIds }),
  preview: (id: string) => api.post<PromptPreview>(`${scenePath(id)}/preview-prompt`),
  generateScene: (id: string, idempotencyKey: string) => api.post<{ generation: Generation }>(`${scenePath(id)}/generate`, { idempotencyKey }),
  selectGeneration: (id: string, generationId: string) => api.post<{ scene: ProjectScene }>(`${scenePath(id)}/select-generation`, { generationId }),
  versions: (sceneId: string) => api.get<{ generations: ProjectGeneration[] }>(`/generations?sceneId=${encodeURIComponent(sceneId)}`),
  results: (projectId: string) => api.get<{ generations: ProjectGeneration[] }>(`/generations?projectId=${encodeURIComponent(projectId)}`),
  generateImage: (input: { projectId: string; characterId?: string; modelId: string; prompt: string; params: Record<string, unknown>; idempotencyKey?: string }) => api.post<{ generation: Generation }>('/generations', input),
}
