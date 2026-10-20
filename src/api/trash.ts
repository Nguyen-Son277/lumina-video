import { api } from './client'

export type TrashKind = 'project' | 'character' | 'generation' | 'plan_session' | 'library_asset'

export interface TrashItem {
  kind: TrashKind
  id: string
  title: string
  subtitle: string
  thumbnailUrl: string | null
  deletedAt: number
  purgeAfter: number
  description?: string
  entityKind?: 'character' | 'item' | 'logo' | 'location'
  handle?: string
  meta?: Record<string, unknown>
}

export interface TrashDetail extends TrashItem {
  createdAt: number | null
  updatedAt: number | null
  prompt?: string
  appearance?: string
  voice?: Partial<Record<'language' | 'accent' | 'pitch' | 'timbre' | 'pace' | 'articulation' | 'habits', string>>
  continuityNotes?: string
  referenceViews?: Array<{ id: string; label: string; url: string; sheet: boolean }>
}

export interface TrashListResult {
  items: TrashItem[]
  counts: Record<TrashKind, number>
  total: number
  retentionDays: 30
}

function itemPath(kind: TrashKind, id: string): string {
  return `/trash/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`
}

export const trashApi = {
  list: (options: { kind?: TrashKind; limit?: number; offset?: number } = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams()
    if (options.kind) params.set('kind', options.kind)
    params.set('limit', String(options.limit ?? 24))
    params.set('offset', String(options.offset ?? 0))
    return api.get<TrashListResult>(`/trash?${params}`, signal)
  },
  detail: (kind: TrashKind, id: string, signal?: AbortSignal) =>
    api.get<{ item: TrashDetail }>(itemPath(kind, id), signal),
  restore: (kind: TrashKind, id: string) =>
    api.post<{ restored: { kind: TrashKind; id: string } }>(`${itemPath(kind, id)}/restore`),
  purge: (kind: TrashKind, id: string) =>
    api.delete<{ purged: number }>(itemPath(kind, id)),
  empty: () => api.delete<{ purged: number; blocked: number; failed: number }>('/trash'),
}
