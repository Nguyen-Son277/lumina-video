import { api } from './client'
import type { Generation } from './types'
import type { ImageEditorCapabilities, ImageEditorPreparedSource, ImageEditorPreview, ImageEditorRequest, ImageEditorSource } from '../../shared/imageEditor'

export type { ImageEditorSource, ImageEditorPreparedSource } from '../../shared/imageEditor'
export const imageEditorApi = {
  capabilities: (signal?: AbortSignal) => api.get<ImageEditorCapabilities>('/image-editor/capabilities', signal),
  prepare: (source: ImageEditorSource, signal?: AbortSignal) => api.post<{ source: ImageEditorPreparedSource }>('/image-editor/sources', { source }, signal),
  preview: (request: ImageEditorRequest, signal?: AbortSignal) => api.post<ImageEditorPreview>('/image-editor/preview', request, signal),
  submit: (request: ImageEditorRequest) => api.post<{ generation: Generation; reused: boolean }>('/image-editor/jobs', request),
  job: (id: string, signal?: AbortSignal) => api.get<{ generation: Generation }>(`/image-editor/jobs/${encodeURIComponent(id)}`, signal),
}
