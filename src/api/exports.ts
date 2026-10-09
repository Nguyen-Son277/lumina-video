import { api } from './client'

export type ExportStatus = 'queued' | 'running' | 'succeeded' | 'failed'

export type ProjectExport = {
  id: string
  projectId: string
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
