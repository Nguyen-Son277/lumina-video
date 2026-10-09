import { api, assertResponseOk } from './client'
import type { Generation } from './types'
import type { CharacterInput, Project, ProjectCharacter, ProjectGeneration, ProjectInput, ProjectLocation, ProjectLocationInput, ProjectScene, PromptPreview, SceneBulkInput, SceneInput } from './projectTypes'
export type { Project, ProjectCharacter, ProjectScene, ProjectLocation, CharacterVoice } from './projectTypes'

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
    await assertResponseOk(response)
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
  /** Duyệt / gán model hàng loạt; KHÔNG xếp hàng tạo nội dung. */
  bulkScenes: (id: string, input: SceneBulkInput) =>
    api.post<{ scenes: ProjectScene[] }>(`${projectPath(id)}/scenes/bulk`, input),
  preview: (id: string) => api.post<PromptPreview>(`${scenePath(id)}/preview-prompt`),
  generateScene: (id: string, idempotencyKey: string) => api.post<{ generation: Generation }>(`${scenePath(id)}/generate`, { idempotencyKey }),
  selectGeneration: (id: string, generationId: string) => api.post<{ scene: ProjectScene }>(`${scenePath(id)}/select-generation`, { generationId }),
  versions: (sceneId: string) => api.get<{ generations: ProjectGeneration[] }>(`/generations?sceneId=${encodeURIComponent(sceneId)}`),
  results: (projectId: string) => api.get<{ generations: ProjectGeneration[] }>(`/generations?projectId=${encodeURIComponent(projectId)}`),
  locations: (id: string) => api.get<{ locations: ProjectLocation[] }>(`${projectPath(id)}/locations`),
  createLocation: (id: string, input: ProjectLocationInput) => api.post<{ location: ProjectLocation }>(`${projectPath(id)}/locations`, input),
  updateLocation: (id: string, locationId: string, input: Partial<ProjectLocationInput>) => api.patch<{ location: ProjectLocation }>(`${projectPath(id)}/locations/${encodeURIComponent(locationId)}`, input),
  removeLocation: (id: string, locationId: string) => api.delete<{ locations: ProjectLocation[] }>(`${projectPath(id)}/locations/${encodeURIComponent(locationId)}`),
  assignLocation: (id: string, locationId: string | null, sceneIds: string[]) => api.post<{ locations: ProjectLocation[] }>(`${projectPath(id)}/locations/assign`, { locationId, sceneIds }),
  generateLocationReference: (id: string, locationId: string, modelId: string) => api.post<{ generation: Generation }>(`${projectPath(id)}/locations/${encodeURIComponent(locationId)}/reference`, { modelId }),
  uploadLocationReference: async (id: string, locationId: string, file: File) => {
    const response = await fetch(`/api/projects/${encodeURIComponent(id)}/locations/${encodeURIComponent(locationId)}/reference/upload`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file,
    })
    await assertResponseOk(response)
    return (await response.json()) as { locations: ProjectLocation[] }
  },
  attachLocationReference: (id: string, locationId: string, input: { generationId: string; assetId?: string; revision?: number }) => api.post<{ locations: ProjectLocation[] }>(`${projectPath(id)}/locations/${encodeURIComponent(locationId)}/reference/attach`, input),
  removeLocationReference: (id: string, locationId: string) => api.delete<{ locations: ProjectLocation[] }>(`${projectPath(id)}/locations/${encodeURIComponent(locationId)}/reference`),
  generateImage: (input: { projectId: string; locationId?: string | null; characterId?: string; modelId: string; prompt: string; params: Record<string, unknown>; idempotencyKey?: string }) => api.post<{ generation: Generation }>('/generations', input),
}
