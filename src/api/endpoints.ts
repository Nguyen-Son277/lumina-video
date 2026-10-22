import { api } from './client'
import type { PromptDocument } from '../../shared/promptMentions'
import type { QuickPreferences, QuickSettings } from '../../shared/quickGenerationPreferences'
export type { QuickImageSettings, QuickVideoSettings, QuickSettings, QuickPreferences, QuickModel } from '../../shared/quickGenerationPreferences'

/** Account-scoped defaults for quick creation; contains only sanitized stable settings. */
export const quickGenerationPreferencesApi = {
  get: (signal?: AbortSignal) =>
    api.get<{ preferences: QuickPreferences }>('/quick-generation-preferences', signal),
  save: (mode: 'image' | 'video', settings: QuickSettings, signal?: AbortSignal) =>
    api.put<{ settings: QuickSettings }>(`/quick-generation-preferences/${mode}`, { version: 1, settings }, signal),
}

/** Original logo placement, normalized to the output dimensions. */
export type LogoOverlay = { entityId: string; x: number; y: number; width: number; opacity: number; anchor?: 'top-left' | 'top-center' | 'top-right' | 'middle-left' | 'center' | 'middle-right' | 'bottom-left' | 'bottom-center' | 'bottom-right' }

export type GenerationCreateInput = {
  modelId: string
  prompt: string
  promptDocument?: PromptDocument
  imagePurpose?: import('../../shared/imagePurpose').ImagePurpose
  logoOverlays?: LogoOverlay[]
  allowTemporaryMedia?: boolean
  params?: GenerationParamsInput
  idempotencyKey?: string
  sourceUploadIds?: string[]
  sourceAssetIds?: string[]
  videoInput?: { uploadId?: string; assetId?: string }
  characterId?: string
  characterIds?: string[]
  projectId?: string
  quickSessionId?: string
}

/** Preview is server-compiled; the backend owns additional provider-specific fields. */
export type GenerationPreview = {
  prompt: string
  entities: Array<{ id: string; kind: string; name: string; handle: string; revision: number; referenceMode: string }>
  referenceCount: number
  maxReferenceCount: number
  warnings: string[]
  overlays: LogoOverlay[]
}
import type {
  AdminAccount,
  AdminAccountCounts,
  AccountStatus,
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
  VideoReferenceStyle,
} from './types'
import type {
  CharacterDetachSummary,
  CharacterInput,
  GeneratedCharacter,
  ProjectCharacter,
} from './projectTypes'

/** Thư viện nhân vật dùng chung: không gắn dự án, dùng được ở mọi nơi. */
export const characterApi = {
  list: (signal?: AbortSignal) => api.get<{ characters: ProjectCharacter[] }>('/shared-characters', signal),
  get: (id: string, signal?: AbortSignal) => api.get<{ character: ProjectCharacter }>(`/shared-characters/${encodeURIComponent(id)}`, signal),
  create: (input: CharacterInput) =>
    api.post<{ character: ProjectCharacter }>('/shared-characters', input),
  update: (id: string, input: CharacterInput) =>
    api.patch<{ character: ProjectCharacter }>(`/shared-characters/${encodeURIComponent(id)}`, input),
  /**
   * Xoá nhân vật. `detach: true` là xác nhận gỡ khỏi mọi cảnh/Canvas đang dùng;
   * server trả về số tham chiếu đã gỡ khi có gỡ thật.
   */
  remove: (id: string, options: { detach?: boolean } = {}) =>
    api.delete<{ detached?: CharacterDetachSummary } | undefined>(
      `/shared-characters/${encodeURIComponent(id)}${options.detach ? '?detach=1' : ''}`,
    ),
  /** Tải ảnh tham chiếu dạng nhị phân thô; backend kiểm tra magic bytes. */
  uploadReference: (id: string, file: File, signal?: AbortSignal) =>
    api.upload<{ character: ProjectCharacter }>(`/shared-characters/${encodeURIComponent(id)}/reference`, file, signal),
  removeReference: (id: string) =>
    api.delete<{ character: ProjectCharacter }>(
      `/shared-characters/${encodeURIComponent(id)}/reference`,
    ),
  /**
   * Nhờ AI sinh vài nhân vật mẫu từ mô tả. Ứng viên chỉ được lưu khi người dùng
   * chọn và gọi `create`.
   */
  generate: (input: { description: string; count?: number; language?: string; modelId?: string; sourceUploadId?: string }, signal?: AbortSignal) =>
    api.post<{ candidates: GeneratedCharacter[]; modelId: string; model: string }>(
      '/shared-characters/generate',
      input,
      signal,
    ),
  /**
   * Sinh một sheet gồm toàn thân trước/sau và cận mặt đủ đầu, tóc, cổ.
   * Server dựng prompt dùng chung; kết quả hình ảnh còn phụ thuộc model.
   */
  illustrate: (input: { modelId: string; name: string; appearance: string; sourceUploadId?: string; idempotencyKey?: string; size?: string; quality?: string }, signal?: AbortSignal) =>
    api.post<{ generation: Generation }>('/shared-characters/illustrations', input, signal),
  analyzeReference: (file: File, modelId: string, language: string, signal?: AbortSignal) => {
    const query = new URLSearchParams({ modelId, language })
    return api.upload<{ suggestion: { name: string; appearance: string }; revision?: number }>(
      `/shared-characters/analyze-reference?${query}`, file, signal,
    )
  },
  analyzeExistingReference: (id: string, modelId: string, language: string, signal?: AbortSignal) =>
    api.post<{ suggestion: { name: string; appearance: string }; revision: number }>(`/shared-characters/${encodeURIComponent(id)}/analyze-reference`, { modelId, language }, signal),
  /** Prompt hoàn chỉnh của nhân vật để mang sang công cụ khác. */
  prompt: (id: string) =>
    api.get<{ prompt: string; character: ProjectCharacter }>(
      `/shared-characters/${encodeURIComponent(id)}/prompt`,
    ),
  attachReferenceFromUpload: (id: string, uploadId: string) =>
    api.post<{ character: ProjectCharacter }>(`/shared-characters/${encodeURIComponent(id)}/reference/from-upload`, { uploadId }),
  /** Gắn một ảnh đã tạo (generation) làm ảnh tham chiếu của nhân vật. */
  attachReferenceFromGeneration: (id: string, generationId: string, assetId?: string) =>
    api.post<{ character: ProjectCharacter }>(
      `/shared-characters/${encodeURIComponent(id)}/reference/from-generation`,
      { generationId, assetId },
    ),
}

/** Kết nối LLM cho chat và tạo kịch bản. */
export const authApi = {
  me: () => api.get<{ user: User | null }>('/auth/me'),
  /**
   * Tài khoản mới mặc định chờ duyệt: `approvalRequired: true` nghĩa là CHƯA có
   * phiên đăng nhập và người dùng phải đợi quản trị viên duyệt.
   */
  register: (email: string, password: string, name: string) =>
    api.post<{ user: User; approvalRequired: boolean }>('/auth/register', { email, password, name }),
  login: (email: string, password: string) =>
    api.post<{ user: User }>('/auth/login', { email, password }),
  logout: () => api.post<void>('/auth/logout'),
  changePassword: (currentPassword: string, newPassword: string) =>
    api.post<{ ok: true }>('/auth/change-password', { currentPassword, newPassword }),
}

/** Quản trị tài khoản: chỉ tài khoản có vai trò admin gọi được. */
export const adminApi = {
  users: (params: { status?: AccountStatus | 'all'; q?: string; limit?: number; offset?: number } = {}) => {
    const query = new URLSearchParams()
    if (params.status && params.status !== 'all') query.set('status', params.status)
    if (params.q) query.set('q', params.q)
    if (params.limit !== undefined) query.set('limit', String(params.limit))
    if (params.offset !== undefined) query.set('offset', String(params.offset))
    const suffix = query.toString()
    return api.get<{ users: AdminAccount[]; counts: AdminAccountCounts }>(
      `/admin/users${suffix ? `?${suffix}` : ''}`,
    )
  },
  approve: (id: string) =>
    api.post<{ user: AdminAccount; counts: AdminAccountCounts }>(
      `/admin/users/${encodeURIComponent(id)}/approve`,
    ),
  reject: (id: string) =>
    api.post<{ user: AdminAccount; counts: AdminAccountCounts }>(
      `/admin/users/${encodeURIComponent(id)}/reject`,
    ),
  /** Thu hồi quyết định: đưa tài khoản về hàng chờ duyệt. */
  revoke: (id: string) =>
    api.post<{ user: AdminAccount; counts: AdminAccountCounts }>(
      `/admin/users/${encodeURIComponent(id)}/revoke`,
    ),
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
  videoReferenceStyle?: VideoReferenceStyle
  selectionMode?: ProviderSelectionMode
}

export const providerApi = {
  list: (signal?: AbortSignal) => api.get<{ providers: Provider[] }>('/providers', signal),
  create: (input: { name: string; baseUrl: string; apiKey: string; imageApiStyle?: ImageApiStyle; videoReferenceStyle?: VideoReferenceStyle; authScheme?: 'bearer' | 'higgsfield' }) =>
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
  list: (kind?: ModelKind, signal?: AbortSignal) =>
    api.get<{ models: ModelInfo[] }>(kind ? `/models?kind=${kind}` : '/models', signal),
  create: (input: { providerId: string; modelId: string; displayName?: string; kind: ModelKind }) =>
    api.post<{ model: ModelInfo }>('/models', input),
  update: (id: string, input: {
    displayName?: string
    kind?: ModelKind
    videoApiStyle?: 'openai' | 'agnes' | 'higgsfield'
    enabled?: boolean
    /** Đơn giá để ước tính chi phí; số không âm hoặc `null` để xoá. */
    priceUnit?: number | null
    priceInput1k?: number | null
    priceOutput1k?: number | null
    priceCurrency?: string
    imageSize?: string | null
    imageReferenceSupport?: 'unknown' | 'yes' | 'no'
    imageMaskSupport?: 'unknown' | 'yes' | 'no'
    imageTransparentBackgroundSupport?: 'unknown' | 'yes' | 'no'
    imageReferenceTransport?: 'provider_default' | 'generations_images'
    imageMaxReferences?: number | null
  }) =>
    api.patch<{ model: ModelInfo }>(`/models/${id}`, input),
  remove: (id: string) => api.delete<void>(`/models/${id}`),
}

export type SourceUpload = { id: string; mimeType: string; byteSize: number; url: string }

export const uploadApi = {
  /** Tải ảnh nguồn lên trước, sau đó truyền id vào yêu cầu tạo ảnh. */
  upload: async (file: File, signal?: AbortSignal): Promise<SourceUpload> =>
    (await api.upload<{ upload: SourceUpload }>('/uploads', file, signal)).upload,
  remove: (id: string) => api.delete<void>(`/uploads/${id}`),
}

export const generationApi = {
  list: (params: { kind?: 'image' | 'video'; quickSessionId?: string; projectId?: string; limit?: number; scope?: 'quick'; cursor?: string; q?: string } = {}, signal?: AbortSignal) => {
    const query = new URLSearchParams()
    if (params.kind) query.set('kind', params.kind)
    if (params.quickSessionId) query.set('quickSessionId', params.quickSessionId)
    if (params.projectId) query.set('projectId', params.projectId)
    if (params.limit !== undefined) query.set('limit', String(params.limit))
    if (params.scope) query.set('scope', params.scope)
    if (params.cursor !== undefined) query.set('cursor', params.cursor)
    if (params.q !== undefined) query.set('q', params.q)
    const suffix = query.toString()
    return api.get<{ generations: Generation[]; nextCursor?: string | null }>(`/generations${suffix ? `?${suffix}` : ''}`, signal)
  },
  create: (input: GenerationCreateInput) => api.post<{ generation: Generation }>('/generations', input),
  preview: (input: GenerationCreateInput) => api.post<{ preview: GenerationPreview }>('/generations/preview', input),
  get: (id: string, signal?: AbortSignal) =>
    api.get<{ generation: Generation }>(`/generations/${encodeURIComponent(id)}`, signal),
  cancel: (id: string, signal?: AbortSignal) =>
    api.post<{ generation: Generation }>(`/generations/${encodeURIComponent(id)}/cancel`, undefined, signal),
  retryLibraryPublication: (id: string) =>
    api.post<{ generation: Generation }>(`/generations/${encodeURIComponent(id)}/retry-library-publication`),
  retryDownload: (id: string) =>
    api.post<{ generation: Generation }>(`/generations/${id}/retry-download`),
  /** Retry local logo compositing only; never creates another provider generation. */
  retryOverlay: (id: string, signal?: AbortSignal) =>
    api.post<{ generation: Generation }>(`/generations/${encodeURIComponent(id)}/retry-overlay`, undefined, signal),
  revokeMedia: (id: string) =>
    api.post<{ revoked: number }>(`/generations/${encodeURIComponent(id)}/revoke-media`),
  remove: (id: string, options: { acknowledgeUnknown?: boolean } = {}) =>
    api.delete<void>(`/generations/${encodeURIComponent(id)}${options.acknowledgeUnknown ? '?acknowledgeUnknown=true' : ''}`),
}

/** Tin nhắn trang Quick home, độc lập phiên; hiện chỉ lưu lời người dùng. */
export type QuickHomeMessage = { id: string; content: string; createdAt: number }

export const quickHomeChatApi = {
  list: () => api.get<{ messages: QuickHomeMessage[] }>('/quick-home/messages'),
  send: (content: string) => api.post<{ message: QuickHomeMessage }>('/quick-home/messages', { content }),
}

/** Phiên "Tạo nội dung đơn lẻ": gom nhiều nội dung và giữ nhân vật dùng chung. */
export type QuickSession = {
  id: string
  title: string
  characterIds: string[]
  promptDocument: PromptDocument | null
  generationCount: number
  activeCount: number
  /** Asset đầu ra mới nhất dùng làm ảnh/video đại diện của phiên. */
  coverAssetId: string | null
  coverMimeType: string | null
  createdAt: number
  updatedAt: number
}

export const quickSessionApi = {
  list: () => api.get<{ sessions: QuickSession[] }>('/quick-sessions'),
  create: (input: { title?: string; characterIds?: string[]; promptDocument?: PromptDocument }) =>
    api.post<{ session: QuickSession }>('/quick-sessions', input),
  get: (id: string) =>
    api.get<{ session: QuickSession }>(`/quick-sessions/${encodeURIComponent(id)}`),
  update: (id: string, input: { title?: string; characterIds?: string[]; promptDocument?: PromptDocument }) =>
    api.patch<{ session: QuickSession }>(`/quick-sessions/${encodeURIComponent(id)}`, input),
  remove: (id: string) => api.delete<void>(`/quick-sessions/${encodeURIComponent(id)}`),
}
