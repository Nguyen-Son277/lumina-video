import { api, assertResponseOk } from './client'
import type {
  CredentialPool,
  Generation,
  GenerationParamsInput,
  ImageApiStyle,
  ModelInfo,
  ModelKind,
  Provider,
  ProviderCredential,
  ProviderSelectionMode,
  User,
} from './types'
import type { CharacterInput, GeneratedCharacter, ProjectCharacter } from './projectTypes'

/** Thư viện nhân vật dùng chung: không gắn dự án, dùng được ở mọi nơi. */
export const characterApi = {
  list: () => api.get<{ characters: ProjectCharacter[] }>('/shared-characters'),
  create: (input: CharacterInput) =>
    api.post<{ character: ProjectCharacter }>('/shared-characters', input),
  update: (id: string, input: CharacterInput) =>
    api.patch<{ character: ProjectCharacter }>(`/shared-characters/${encodeURIComponent(id)}`, input),
  remove: (id: string) => api.delete<void>(`/shared-characters/${encodeURIComponent(id)}`),
  /** Tải ảnh tham chiếu dạng nhị phân thô; backend kiểm tra magic bytes. */
  uploadReference: async (id: string, file: File): Promise<{ character: ProjectCharacter }> => {
    const response = await fetch(`/api/shared-characters/${encodeURIComponent(id)}/reference`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    })
    await assertResponseOk(response)
    return (await response.json()) as { character: ProjectCharacter }
  },
  removeReference: (id: string) =>
    api.delete<{ character: ProjectCharacter }>(
      `/shared-characters/${encodeURIComponent(id)}/reference`,
    ),
  /**
   * Nhờ AI sinh vài nhân vật mẫu từ mô tả. Ứng viên chỉ được lưu khi người dùng
   * chọn và gọi `create`.
   */
  generate: (input: { description: string; count?: number; language?: string; modelId?: string }) =>
    api.post<{ candidates: GeneratedCharacter[]; modelId: string; model: string }>(
      '/shared-characters/generate',
      input,
    ),
  /**
   * Sinh ảnh tham chiếu dạng sheet (cận mặt + 4 góc nhìn) cho nhân vật mẫu.
   * Server tự dựng prompt nên ảnh luôn đúng chuẩn.
   */
  illustrate: (input: { modelId: string; name: string; appearance: string }) =>
    api.post<{ generation: Generation }>('/shared-characters/illustrations', input),
  /** Prompt hoàn chỉnh của nhân vật để mang sang công cụ khác. */
  prompt: (id: string) =>
    api.get<{ prompt: string; character: ProjectCharacter }>(
      `/shared-characters/${encodeURIComponent(id)}/prompt`,
    ),
  /** Gắn một ảnh đã tạo (generation) làm ảnh tham chiếu của nhân vật. */
  attachReferenceFromGeneration: (id: string, generationId: string) =>
    api.post<{ character: ProjectCharacter }>(
      `/shared-characters/${encodeURIComponent(id)}/reference/from-generation`,
      { generationId },
    ),
}

/** Kết nối LLM cho chat và tạo kịch bản. */
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

/** Dữ liệu tạo một API key mới; bí mật chỉ gửi lên một lần. */
export type ProviderCredentialInput = {
  apiKey: string
  label?: string
  enabled?: boolean
}

/** Dữ liệu sửa API key; bỏ trống `apiKey` nghĩa là giữ nguyên bí mật hiện tại. */
export type ProviderCredentialPatch = {
  label?: string
  enabled?: boolean
  position?: number
  apiKey?: string
}

export type ProviderUpdateInput = {
  name?: string
  baseUrl?: string
  apiKey?: string
  imageApiStyle?: ImageApiStyle
  selectionMode?: ProviderSelectionMode
}

export const providerApi = {
  list: () => api.get<{ providers: Provider[] }>('/providers'),
  create: (input: { name: string; baseUrl: string; apiKey: string; imageApiStyle?: ImageApiStyle }) =>
    api.post<{ provider: Provider }>('/providers', input),
  update: (id: string, input: ProviderUpdateInput) =>
    api.patch<{ provider: Provider }>(`/providers/${id}`, input),
  remove: (id: string) => api.delete<void>(`/providers/${id}`),
  test: (id: string) => api.post<{ ok: boolean; modelCount: number }>(`/providers/${id}/test`),
  syncModels: (id: string) =>
    api.post<{ added: number; skipped: number; total: number }>(`/providers/${id}/sync-models`),
  /**
   * Quản lý nhiều API key của một provider.
   * Mọi phản hồi chỉ chứa key ở dạng công khai (`hint` đã che), không bao giờ có bí mật.
   */
  credentials: {
    /** Bể key kèm cách chọn key hiện tại. */
    list: (id: string) => api.get<{ pool: CredentialPool }>(`/providers/${id}/credentials`),
    create: (id: string, input: ProviderCredentialInput) =>
      api.post<{ credential: ProviderCredential }>(`/providers/${id}/credentials`, input),
    update: (id: string, keyId: string, input: ProviderCredentialPatch) =>
      api.patch<{ credential: ProviderCredential }>(
        `/providers/${id}/credentials/${encodeURIComponent(keyId)}`,
        input,
      ),
    remove: (id: string, keyId: string) =>
      api.delete<void>(`/providers/${id}/credentials/${encodeURIComponent(keyId)}`),
    /** Gửi đủ danh sách id theo thứ tự mới; backend từ chối nếu thiếu/thừa id. */
    reorder: (id: string, ids: string[]) =>
      api.post<{ credentials: ProviderCredential[] }>(`/providers/${id}/credentials/reorder`, { ids }),
    /** Kiểm tra đúng một key; không tạo nội dung nên không tốn phí. */
    test: (id: string, keyId: string) =>
      api.post<{ ok: boolean; credential: ProviderCredential }>(
        `/providers/${id}/credentials/${encodeURIComponent(keyId)}/test`,
      ),
  },
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
    await assertResponseOk(response)
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
    /** Nhân vật dùng chung hoặc nhân vật của dự án để giữ nhất quán ngoại hình. */
    characterId?: string
    projectId?: string
  }) => api.post<{ generation: Generation }>('/generations', input),
  get: (id: string) => api.get<{ generation: Generation }>(`/generations/${id}`),
  retryDownload: (id: string) =>
    api.post<{ generation: Generation }>(`/generations/${id}/retry-download`),
  remove: (id: string) => api.delete<void>(`/generations/${id}`),
}
