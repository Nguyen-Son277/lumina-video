import { api, assertResponseOk } from './client'

export type EntityKind = 'character' | 'item' | 'logo' | 'location'
export type LibraryAssetKind = Exclude<EntityKind, 'character'>

/** Public catalog metadata only. Server-side filesystem paths are not part of the client DTO. */
export interface EntityLibraryEntity {
  id: string
  kind: EntityKind
  name: string
  handle: string
  description: string
  continuityNotes: string
  revision: number
  reference: { mime?: string; uploadId?: string; url?: string } | null
  projectId?: string
  source?: { kind: 'timeline' | 'project'; scopeId: string; entityId: string; revision: number }
  referenceViews?: Array<{ id: string; label: string; uploadId: string; sheet: boolean }>
}

export interface LibraryAssetInput {
  kind: LibraryAssetKind
  name: string
  handle?: string
  autoHandle?: boolean
  description?: string
  continuityNotes?: string
}

export type LibraryAssetPatch = Partial<Omit<LibraryAssetInput, 'kind' | 'handle' | 'autoHandle'>> & { revision?: number }

export interface LibraryReferenceAnalysis {
  suggestion: { name: string; handle: string; description: string; continuityNotes: string }
  revision?: number
  referenceUploadId?: string
}

const assetPath = (id: string) => `/entity-library/assets/${encodeURIComponent(id)}`

/** Always use authenticated reference endpoints; never render a private storage path or arbitrary URL. */
export function entityReferenceUrl(entity: EntityLibraryEntity): string | null {
  if (!entity.reference) return null
  const path = entity.kind === 'character'
    ? `/api/characters/${encodeURIComponent(entity.id)}/reference`
    : `/api${assetPath(entity.id)}/reference`
  return `${path}?revision=${encodeURIComponent(String(entity.revision))}`
}

export const entityLibraryApi = {
  list: (options: { projectId?: string } = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams()
    if (options.projectId) params.set('projectId', options.projectId)
    const query = params.size ? `?${params}` : ''
    return api.get<{ entities: EntityLibraryEntity[] }>(`/entity-library${query}`, signal)
  },
  listAssets: (options: { kind?: LibraryAssetKind; search?: string; limit?: number; offset?: number } = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams()
    if (options.kind) params.set('kind', options.kind)
    if (options.search) params.set('search', options.search)
    params.set('limit', String(options.limit ?? 30))
    params.set('offset', String(options.offset ?? 0))
    return api.get<{ assets: EntityLibraryEntity[]; total: number; limit: number; offset: number }>(`/entity-library/assets?${params}`, signal)
  },
  create: (input: LibraryAssetInput) => api.post<{ asset: EntityLibraryEntity }>('/entity-library/assets', input),
  update: (id: string, input: LibraryAssetPatch) => api.patch<{ asset: EntityLibraryEntity }>(assetPath(id), input),
  remove: (id: string) => api.delete<void>(assetPath(id)),
  updateHandle: (kind: EntityKind, id: string, handle: string) =>
    api.patch<{ entity: EntityLibraryEntity }>(`/entity-library/${kind}/${encodeURIComponent(id)}/handle`, { handle }),
  uploadReference: async (id: string, file: File): Promise<{ asset: EntityLibraryEntity }> => {
    const response = await fetch(`/api${assetPath(id)}/reference`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    })
    await assertResponseOk(response)
    return await response.json() as { asset: EntityLibraryEntity }
  },
  analyzeReference: async (file: File, kind: LibraryAssetKind, modelId: string, signal?: AbortSignal): Promise<LibraryReferenceAnalysis> => {
    const query = new URLSearchParams({ kind, modelId })
    const response = await fetch(`/api/entity-library/analyze-reference?${query}`, {
      method: 'POST', credentials: 'include', signal,
      headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file,
    })
    await assertResponseOk(response)
    return await response.json() as LibraryReferenceAnalysis
  },
  analyzeExistingReference: async (id: string, modelId: string, signal?: AbortSignal): Promise<LibraryReferenceAnalysis> => {
    const response = await fetch(`/api${assetPath(id)}/analyze-reference`, {
      method: 'POST', credentials: 'include', signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modelId }),
    })
    await assertResponseOk(response)
    return await response.json() as LibraryReferenceAnalysis
  },
  removeReference: (id: string) => api.delete<{ asset: EntityLibraryEntity }>(`${assetPath(id)}/reference`),
}
