/** Kiểu dữ liệu dùng chung giữa frontend và backend. */

export type Mode = 'image' | 'video'
export type ModelKind = Mode | 'llm' | 'unclassified'

export type ImageApiStyle = 'openai' | 'extra_body'

export type User = {
  id: string
  email: string
}

/** Cách chọn API key khi một provider có nhiều key. */
export type ProviderSelectionMode = 'failover' | 'round_robin'

/** Sức khoẻ của một API key, do backend cập nhật sau mỗi lần gọi provider. */
export type CredentialHealthStatus = 'ok' | 'auth_failed' | 'cooldown' | 'unknown'

/**
 * Một API key của provider ở dạng công khai: KHÔNG bao giờ chứa bí mật.
 * `hint` là gợi ý đã che do backend tạo, dùng để nhận diện key.
 */
export type ProviderCredential = {
  id: string
  providerId: string
  label: string
  hint: string
  fingerprint: string | null
  position: number
  enabled: boolean
  healthStatus: CredentialHealthStatus
  cooldownUntil: number | null
  lastUsedAt: number | null
  lastError: string | null
  lastErrorKey?: string | null
  lastErrorParams?: Record<string, string | number> | null
  createdAt: number
  updatedAt: number
}

/** Bể key của một provider: danh sách key + cách chọn key. */
export type CredentialPool = {
  providerId: string
  baseUrl: string
  selectionMode: ProviderSelectionMode
  rrCursor: number | null
  credentials: ProviderCredential[]
}

export type Provider = {
  id: string
  name: string
  baseUrl: string
  keyHint: string
  /** Cách gọi API tạo ảnh của provider này. */
  imageApiStyle: ImageApiStyle
  status: 'untested' | 'connected' | 'error'
  lastError: string | null
  lastErrorKey?: string | null
  lastErrorParams?: Record<string, string | number> | null
  modelCount: number
  createdAt: number
  /** Cách chọn key giữa nhiều API key; backend mặc định `failover`. */
  selectionMode?: ProviderSelectionMode
  /** Danh sách key công khai (không có bí mật) khi backend trả kèm provider. */
  credentials?: ProviderCredential[]
}

export type ModelInfo = {
  id: string
  providerId: string
  providerName: string
  modelId: string
  displayName: string
  kind: ModelKind
  enabled: boolean
  createdAt: number
}

export type Asset = {
  id: string
  mimeType: string
  byteSize: number
  url: string
}

export type GenerationStatus =
  | 'queued'
  | 'running'
  | 'downloading'
  | 'succeeded'
  | 'failed'
  | 'unknown'

export type Generation = {
  id: string
  kind: Mode
  prompt: string
  projectId?: string | null
  sceneId?: string | null
  effectivePrompt?: string
  promptSnapshot?: unknown
  /** Số ảnh nguồn đã dùng để tạo ảnh này. */
  sourceImageCount?: number
  status: GenerationStatus
  progress: number | null
  provider: string
  model: string
  params: Record<string, unknown>
  errorCode: string | null
  errorMessage: string | null
  errorMessageKey?: string | null
  errorMessageParams?: Record<string, string | number> | null
  providerJobId: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
  assets: Asset[]
}

export type GenerationParamsInput = {
  size?: string
  quality?: string
  seconds?: string | number
  n?: number
  background?: string
  /** Tắt gửi ảnh tham chiếu nhân vật khi provider không hỗ trợ. */
  useCharacterReference?: boolean
}

