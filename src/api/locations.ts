import { api, assertResponseOk } from './client'
import type { Generation } from './types'

/** Một ảnh tham chiếu bối cảnh theo một góc nhìn. */
export type LocationView = {
  id: string
  label: string
  uploadId: string
  /** Ảnh gộp nhiều góc trong một ảnh (mặc định khi tạo ảnh tham chiếu). */
  sheet: boolean
}

export type LocationReference = {
  id: string
  name: string
  stage: string
  description: string
  continuityNotes: string
  imagePrompt: string
  /** Ảnh đại diện (view đầu tiên) — giữ để tương thích với nơi chỉ cần một ảnh. */
  reference: { uploadId: string } | null
  /** Bộ ảnh nhiều góc; nguồn sự thật cho tham chiếu bối cảnh. */
  referenceViews: LocationView[]
  revision: number
}

/** Nhãn góc nhìn gợi ý khi tạo ảnh riêng cho từng góc. */
export const LOCATION_VIEW_LABELS = ['wide', 'left', 'right', 'behind', 'detail'] as const

export type LocationsResult = { locations: LocationReference[] }
export type LocationReferencesApi = {
  save: (locations: LocationReference[]) => Promise<LocationsResult>
  propose?: () => Promise<LocationsResult>
  generate: (locationId: string, modelId: string, options?: { requestKey: string; confirmNew?: boolean; viewLabel?: string }) => Promise<{ generation: Generation; task?: unknown }>
  getTask?: (locationId: string) => Promise<{ task: unknown | null; generation: Generation | null }>
  upload: (locationId: string, file: File) => Promise<LocationsResult>
  attach: (locationId: string, generationId: string, revision?: number, view?: { label?: string; sheet?: boolean }) => Promise<LocationsResult>
  removeReference: (locationId: string) => Promise<LocationsResult>
}

function locationApi(root: string, canPropose: boolean): LocationReferencesApi & { list: () => Promise<LocationsResult> } {
  const referencePath = (id: string) => `${root}/${encodeURIComponent(id)}/reference`
  return {
    list: () => api.get<LocationsResult>(root),
    save: (locations) => api.put<LocationsResult>(root, { locations }),
    ...(canPropose ? { propose: () => api.post<LocationsResult>(`${root}/propose`) } : {}),
    generate: (id, modelId, options) => api.post<{ generation: Generation; task?: unknown }>(`${referencePath(id)}/generate`, { modelId, ...options }),
    getTask: (id) => api.get<{ task: unknown | null; generation: Generation | null }>(`${referencePath(id)}/task`),
    upload: async (id, file) => {
      const response = await fetch(`/api${referencePath(id)}/upload`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file,
      })
      await assertResponseOk(response)
      return await response.json() as LocationsResult
    },
    attach: (id, generationId, revision, view) => api.post<LocationsResult>(`${referencePath(id)}/attach`, { generationId, ...(revision === undefined ? {} : { revision }), ...(view === undefined ? {} : { view }) }),
    removeReference: (id) => api.delete<LocationsResult>(referencePath(id)),
  }
}

/** Chấp nhận `{locations}` hoặc `{session:{locations}}` / `{project:{locations}}`. */
export function normalizeLocations(payload: unknown): LocationReference[] {
  if (!payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  const direct = record.locations
  if (Array.isArray(direct)) return direct as LocationReference[]
  const nested = (record.session ?? record.project) as Record<string, unknown> | undefined
  return Array.isArray(nested?.locations) ? nested.locations as LocationReference[] : []
}

export function locationPanelApi(adapter: LocationReferencesApi) {
  return {
    save: async (locations: LocationReference[]) => normalizeLocations(await adapter.save(locations)),
    ...(adapter.propose ? { propose: async () => normalizeLocations(await adapter.propose!()) } : {}),
    generate: async (id: string, modelId: string) => (await adapter.generate(id, modelId)).generation,
    upload: async (id: string, file: File) => normalizeLocations(await adapter.upload(id, file)),
    attach: async (id: string, generationId: string, revision?: number, view?: { label?: string; sheet?: boolean }) => normalizeLocations(await adapter.attach(id, generationId, revision, view)),
  }
}

export const planLocationsApi = (sessionId: string) => locationApi(`/plans/${encodeURIComponent(sessionId)}/locations`, true)
export const projectLocationsApi = (projectId: string) => locationApi(`/projects/${encodeURIComponent(projectId)}/locations`, false)
export const locationReferenceUrl = (location: LocationReference) => location.reference ? `/api/uploads/${encodeURIComponent(location.reference.uploadId)}` : ''
