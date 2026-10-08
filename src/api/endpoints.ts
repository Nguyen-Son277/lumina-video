import { api } from './client'
import type { Generation, GenerationParamsInput, ImageApiStyle, ModelInfo, ModelKind, Provider, User } from './types'

export const authApi = {
  me: () => api.get<{ user: User | null }>('/auth/me'),
  register: (email: string, password: string) =>
    api.post<{ user: User }>('/auth/register', { email, password }),
  login: (email: string, password: string) =>
    api.post<{ user: User }>('/auth/login', { email, password }),
  logout: () => api.post<void>('/auth/logout'),
  changePassword: (currentPassword: string, newPassword: string) =>
    api.post<{ ok: true }>('/auth/change-password', { currentPassword, newPassword }),
}

export const providerApi = {
  list: () => api.get<{ providers: Provider[] }>('/providers'),
  create: (input: { name: string; baseUrl: string; apiKey: string; imageApiStyle?: ImageApiStyle }) =>
    api.post<{ provider: Provider }>('/providers', input),
  update: (id: string, input: { name?: string; baseUrl?: string; apiKey?: string; imageApiStyle?: ImageApiStyle }) =>
    api.patch<{ provider: Provider }>(`/providers/${id}`, input),
  remove: (id: string) => api.delete<void>(`/providers/${id}`),
  test: (id: string) => api.post<{ ok: boolean; modelCount: number }>(`/providers/${id}/test`),
  syncModels: (id: string) =>
    api.post<{ added: number; skipped: number; total: number }>(`/providers/${id}/sync-models`),
}

export const modelApi = {
  list: (kind?: ModelKind) =>
    api.get<{ models: ModelInfo[] }>(kind ? `/models?kind=${kind}` : '/models'),
  create: (input: { providerId: string; modelId: string; displayName?: string; kind: ModelKind }) =>
    api.post<{ model: ModelInfo }>('/models', input),
  update: (id: string, input: { displayName?: string; kind?: ModelKind; enabled?: boolean }) =>
    api.patch<{ model: ModelInfo }>(`/models/${id}`, input),
  remove: (id: string) => api.delete<void>(`/models/${id}`),
}

export type SourceUpload = { id: string; mimeType: string; byteSize: number; url: string }

export const uploadApi = {
  /** Tải ảnh nguồn lên trước, sau đó truyền id vào yêu cầu tạo ảnh. */
  upload: async (file: File): Promise<SourceUpload> => {
    const response = await fetch('/api/uploads', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    })
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null
      throw new Error(payload?.error?.message ?? `Tải ảnh thất bại (mã ${response.status})`)
    }
    const body = (await response.json()) as { upload: SourceUpload }
    return body.upload
  },
  remove: (id: string) => api.delete<void>(`/uploads/${id}`),
}

export const generationApi = {
  list: (kind?: 'image' | 'video') =>
    api.get<{ generations: Generation[] }>(kind ? `/generations?kind=${kind}` : '/generations'),
  create: (input: {
    modelId: string
    prompt: string
    params?: GenerationParamsInput
    idempotencyKey?: string
    sourceUploadIds?: string[]
  }) => api.post<{ generation: Generation }>('/generations', input),
  get: (id: string) => api.get<{ generation: Generation }>(`/generations/${id}`),
  retryDownload: (id: string) =>
    api.post<{ generation: Generation }>(`/generations/${id}/retry-download`),
  remove: (id: string) => api.delete<void>(`/generations/${id}`),
}
