import { api } from './client'

export type TrashKind = 'project' | 'character' | 'generation' | 'plan_session'

export interface TrashItem {
  kind: TrashKind
  id: string
  title: string
  subtitle: string
  thumbnailUrl: string | null
  deletedAt: number
  purgeAfter: number
  meta?: Record<string, unknown>
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
  restore: (kind: TrashKind, id: string) =>
    api.post<{ restored: { kind: TrashKind; id: string } }>(`${itemPath(kind, id)}/restore`),
  purge: (kind: TrashKind, id: string) =>
    api.delete<{ purged: number }>(itemPath(kind, id)),
  empty: () => api.delete<{ purged: number; blocked: number; failed: number }>('/trash'),
}
