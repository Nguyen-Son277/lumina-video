/** Kiểu dữ liệu dùng chung giữa frontend và backend. */

export type Mode = 'image' | 'video'
export type ModelKind = Mode | 'unclassified'

export type User = {
  id: string
  email: string
}

export type Provider = {
  id: string
  name: string
  baseUrl: string
  keyHint: string
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
}
