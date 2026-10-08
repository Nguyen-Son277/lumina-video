/** Kiểu dữ liệu dùng chung giữa frontend và backend. */

export type Mode = 'image' | 'video'
export type ModelKind = Mode | 'unclassified'

export type ImageApiStyle = 'openai' | 'extra_body'

export type User = {
  id: string
  email: string
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
  modelCount: number
  createdAt: number
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

/** Kết nối LLM dùng cho tính năng văn bản như tạo kịch bản. */
export type LlmConnection = {
  id: string
  name: string
  baseUrl: string
  modelId: string
  keyHint: string
  status: 'untested' | 'connected' | 'error'
  lastError: string | null
  createdAt: number
  updatedAt: number
}
