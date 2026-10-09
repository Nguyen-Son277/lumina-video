import { api, assertResponseOk } from './client'
import type { Generation } from './types'

export type LocationReference = {
  id: string
  name: string
  stage: string
  description: string
  continuityNotes: string
  imagePrompt: string
  reference: { uploadId: string } | null
  revision: number
}

export type LocationsResult = { locations: LocationReference[] }
export type LocationReferencesApi = {
  save: (locations: LocationReference[]) => Promise<LocationsResult>
  propose?: () => Promise<LocationsResult>
  generate: (locationId: string, modelId: string) => Promise<{ generation: Generation }>
  upload: (locationId: string, file: File) => Promise<LocationsResult>
  attach: (locationId: string, generationId: string, revision?: number) => Promise<LocationsResult>
  removeReference: (locationId: string) => Promise<LocationsResult>
}

function locationApi(root: string, canPropose: boolean): LocationReferencesApi & { list: () => Promise<LocationsResult> } {
  const referencePath = (id: string) => `${root}/${encodeURIComponent(id)}/reference`
  return {
    list: () => api.get<LocationsResult>(root),
    save: (locations) => api.put<LocationsResult>(root, { locations }),
    ...(canPropose ? { propose: () => api.post<LocationsResult>(`${root}/propose`) } : {}),
    generate: (id, modelId) => api.post<{ generation: Generation }>(`${referencePath(id)}/generate`, { modelId }),
    upload: async (id, file) => {
      const response = await fetch(`/api${referencePath(id)}/upload`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file,
      })
      await assertResponseOk(response)
      return await response.json() as LocationsResult
    },
    attach: (id, generationId, revision) => api.post<LocationsResult>(`${referencePath(id)}/attach`, revision === undefined ? { generationId } : { generationId, revision }),
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
    attach: async (id: string, generationId: string, revision?: number) => normalizeLocations(await adapter.attach(id, generationId, revision)),
  }
}

export const planLocationsApi = (sessionId: string) => locationApi(`/plans/${encodeURIComponent(sessionId)}/locations`, true)
export const projectLocationsApi = (projectId: string) => locationApi(`/projects/${encodeURIComponent(projectId)}/locations`, false)
export const locationReferenceUrl = (location: LocationReference) => location.reference ? `/api/uploads/${encodeURIComponent(location.reference.uploadId)}` : ''
