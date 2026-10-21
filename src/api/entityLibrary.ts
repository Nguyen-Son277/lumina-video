import { api } from './client'
import type { AssetGenerateInput, AssetGenerateResult, AssetIllustrationInput } from '../../shared/entityCreation'
import type { Generation } from './types'
import type { CharacterVoice } from './projectTypes'
export type { AssetGenerateInput, AssetGenerateResult, AssetIllustrationInput, LibraryCandidate } from '../../shared/entityCreation'

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
  /** Always provided by current API; optional for older cached catalog entries. */
  createdAt?: number
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
  get: (id: string, signal?: AbortSignal) => api.get<{ asset: EntityLibraryEntity }>(assetPath(id), signal),
  conversionData: (kind: EntityKind, id: string, signal?: AbortSignal) => api.get<{ revision: number; voice: CharacterVoice; continuityNotes: string; referenceViews: NonNullable<EntityLibraryEntity['referenceViews']> }>(`/entity-library/${kind}/${encodeURIComponent(id)}/conversion-data`, signal),
  convert: (kind: EntityKind, id: string, input: { targetKind: EntityKind; expectedRevision: number; name: string; description: string; continuityNotes?: string; voice?: CharacterVoice }) =>
    api.post<{ entity: EntityLibraryEntity }>(`/entity-library/${kind}/${encodeURIComponent(id)}/convert`, input),
  generate: (input: AssetGenerateInput, signal?: AbortSignal) => api.post<AssetGenerateResult>('/entity-library/generate', input, signal),
  illustrate: (input: AssetIllustrationInput, signal?: AbortSignal) => api.post<{ generation: Generation }>('/entity-library/illustrations', input, signal),
  attachReferenceFromGeneration: (id: string, generationId: string, assetId?: string) =>
    api.post<{ asset: EntityLibraryEntity }>(`${assetPath(id)}/reference/from-generation`, { generationId, assetId }),
  create: (input: LibraryAssetInput) => api.post<{ asset: EntityLibraryEntity }>('/entity-library/assets', input),
  update: (id: string, input: LibraryAssetPatch) => api.patch<{ asset: EntityLibraryEntity }>(assetPath(id), input),
  remove: (id: string) => api.delete<void>(assetPath(id)),
  updateHandle: (kind: EntityKind, id: string, handle: string) =>
    api.patch<{ entity: EntityLibraryEntity }>(`/entity-library/${kind}/${encodeURIComponent(id)}/handle`, { handle }),
  uploadReference: (id: string, file: File, signal?: AbortSignal) =>
    api.upload<{ asset: EntityLibraryEntity }>(`${assetPath(id)}/reference`, file, signal),
  analyzeReference: (file: File, kind: LibraryAssetKind, modelId: string, signal?: AbortSignal): Promise<LibraryReferenceAnalysis> => {
    const query = new URLSearchParams({ kind, modelId })
    return api.upload<LibraryReferenceAnalysis>(`/entity-library/analyze-reference?${query}`, file, signal)
  },
  analyzeExistingReference: (id: string, modelId: string, signal?: AbortSignal): Promise<LibraryReferenceAnalysis> =>
    api.post<LibraryReferenceAnalysis>(`${assetPath(id)}/analyze-reference`, { modelId }, signal),
  removeReference: (id: string) => api.delete<{ asset: EntityLibraryEntity }>(`${assetPath(id)}/reference`),
}
