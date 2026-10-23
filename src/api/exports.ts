import { api } from './client'
import type { CanvasExportPreview } from '../../shared/canvasExport'

export type ExportStatus = 'queued' | 'running' | 'succeeded' | 'failed'

export type ProjectExport = {
  id: string
  projectId: string | null
  quickSessionId?: string | null
  source?: string
  status: ExportStatus
  progress: number | null
  itemCount: number
  /** Có giá trị khi xuất đã thành công. */
  url: string | null
  downloadUrl: string | null
  mimeType: string | null
  byteSize: number | null
  /** `FFMPEG_MISSING` khi máy chủ chưa cài ffmpeg. */
  errorCode: string | null
  errorMessage: string | null
  errorMessageKey?: string | null
  errorMessageParams?: Record<string, string | number> | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export type ExportItem = { sceneId: string; generationId: string }

/** Xuất video: ghép các cảnh đã tạo thành một tệp hoàn chỉnh. */
export const exportApi = {
  list: (projectId: string) =>
    api.get<{ exports: ProjectExport[] }>(
      `/projects/${encodeURIComponent(projectId)}/exports`,
    ),
  /**
   * Tạo bản xuất. Bỏ `items` thì ghép mọi cảnh của dự án theo thứ tự timeline,
   * mỗi cảnh dùng bản đã chọn hoặc bản thành công mới nhất.
   */
  create: (projectId: string, items?: ExportItem[]) =>
    api.post<{ export: ProjectExport }>(
      `/projects/${encodeURIComponent(projectId)}/exports`,
      items ? { items } : {},
    ),
  get: (id: string) => api.get<{ export: ProjectExport }>(`/exports/${encodeURIComponent(id)}`),
  remove: (id: string) => api.delete<void>(`/exports/${encodeURIComponent(id)}`),
}

export function canvasExportApi(scope: { projectId?: string; quickSessionId?: string }) {
  const root = scope.projectId
    ? `/projects/${encodeURIComponent(scope.projectId)}/canvas/exports`
    : `/quick-sessions/${encodeURIComponent(scope.quickSessionId!)}/canvas/exports`
  return {
    list: () => api.get<{ exports: ProjectExport[] }>(root),
    preview: (nodeId: string, baseRevision: number) => api.post<{ preview: CanvasExportPreview }>(`${root}/preview`, { nodeId, baseRevision }),
    create: (nodeId: string, baseRevision: number, stamp: string) => api.post<{ export: ProjectExport }>(root, { nodeId, baseRevision, stamp }),
  }
}
