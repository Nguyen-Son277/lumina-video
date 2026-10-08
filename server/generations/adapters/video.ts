import { randomUUID } from 'node:crypto'
import { insufficientStorage, providerIncompatible } from '../../lib/errors'
import { callProvider, readProviderError, type ProviderResponse } from '../../providers/client'
import { guardProviderUrl } from '../../providers/urlGuard'
import type { GenerationContext, GenerationParams } from '../types'

export type VideoJobState = 'queued' | 'in_progress' | 'completed' | 'failed'

export type VideoJobSnapshot = {
  id: string
  state: VideoJobState
  progress: number | null
  errorMessage: string | null
}

export function buildVideoRequestBody(
  modelId: string,
  prompt: string,
  params: GenerationParams,
  referenceDataUrl?: string | null,
) {
  const body: Record<string, unknown> = { model: modelId, prompt }

  if (typeof params.size === 'string' && params.size) body.size = params.size
  if (typeof params.seconds === 'string' && params.seconds) body.seconds = params.seconds
  if (typeof params.seconds === 'number') body.seconds = String(params.seconds)

  // Ảnh tham chiếu giúp model bám đúng ngoại hình nhân vật.
  // Người dùng có thể tắt bằng tham số useCharacterReference = false.
  if (referenceDataUrl && params.useCharacterReference !== false) {
    body.input_reference = { image_url: referenceDataUrl }
  }

  return body
}

/**
 * Đọc ảnh tham chiếu của nhân vật đang nói trong cảnh và dựng data URL.
 *
 * Chỉ đọc từ kho media riêng của chính người dùng. Trả null nếu cảnh không có
 * nhân vật, nhân vật chưa có ảnh, hoặc tệp vượt giới hạn cho phép.
 */
export function loadCharacterReference(context: GenerationContext): string | null {
  const { generation, db, mediaStore, env } = context
  if (!generation.scene_id) return null

  const row = db
    .prepare(
      `SELECT c.reference_path AS path, c.reference_mime AS mime
       FROM scenes s
       JOIN characters c ON c.id = s.character_id
       WHERE s.id = ?`,
    )
    .get(generation.scene_id) as { path: string | null; mime: string | null } | undefined

  if (!row?.path || !row.mime) return null
  if (!mediaStore.exists(row.path)) return null

  const bytes = mediaStore.readFile(row.path)
  if (bytes.byteLength === 0 || bytes.byteLength > env.MAX_REFERENCE_BYTES) return null

  return `data:${row.mime};base64,${Buffer.from(bytes).toString('base64')}`
}

/**
 * Đọc trạng thái job video. Chấp nhận cả `status` và `state` vì một số
 * provider tương thích dùng tên trường khác nhau.
 */
export function readVideoJob(payload: unknown): VideoJobSnapshot {
  if (typeof payload !== 'object' || payload === null) {
    throw providerIncompatible('Provider trả về dữ liệu job video không đúng định dạng')
  }

  const record = payload as {
    id?: unknown
    status?: unknown
    state?: unknown
    progress?: unknown
    error?: unknown
  }

  const id = typeof record.id === 'string' ? record.id : null
  if (!id) {
    throw providerIncompatible('Provider không trả về ID job video')
  }

  const rawState = typeof record.status === 'string' ? record.status : record.state
  const state = normalizeState(rawState)
  if (!state) {
    throw providerIncompatible(
      `Provider trả về trạng thái job video không được hỗ trợ: ${String(rawState)}`,
    )
  }

  let progress: number | null = null
  if (typeof record.progress === 'number' && Number.isFinite(record.progress)) {
    // Một số provider trả 0..1, số khác trả 0..100.
    progress = record.progress <= 1 ? Math.round(record.progress * 100) : Math.round(record.progress)
  }

  let errorMessage: string | null = null
  if (typeof record.error === 'string') {
    errorMessage = record.error
  } else if (typeof record.error === 'object' && record.error !== null) {
    const message = (record.error as { message?: unknown }).message
    if (typeof message === 'string') errorMessage = message
  }

  return { id, state, progress, errorMessage }
}

function normalizeState(value: unknown): VideoJobState | null {
  if (typeof value !== 'string') return null
  const normalized = value.toLowerCase().replace(/[\s-]+/g, '_')
  if (normalized === 'queued' || normalized === 'pending' || normalized === 'starting') return 'queued'
  if (normalized === 'in_progress' || normalized === 'processing' || normalized === 'running') {
    return 'in_progress'
  }
  if (normalized === 'completed' || normalized === 'succeeded' || normalized === 'success') {
    return 'completed'
  }
  if (normalized === 'failed' || normalized === 'error' || normalized === 'cancelled') return 'failed'
  return null
}

/** Bắt đầu tạo video: POST /videos, lưu ID job để theo dõi sau. */
export async function startVideoGeneration(context: GenerationContext): Promise<{
  providerJobId: string
  progress: number | null
}> {
  const { generation, provider } = context
  const params = JSON.parse(generation.params_json) as GenerationParams

  if (context.env.PROVIDER_MODE === 'mock') {
    const { createMockVideoJob } = await import('./mock')
    const job = createMockVideoJob()
    return { providerJobId: job.id, progress: 0 }
  }

  const response = await callProvider(provider, 'videos', {
    method: 'POST',
    body: buildVideoRequestBody(
      generation.snap_model_id,
      generation.effective_prompt ?? generation.prompt,
      params,
      loadCharacterReference(context),
    ),
    timeoutMs: 120_000,
  })

  if (!response.ok) {
    throw providerIncompatible(
      `Provider từ chối yêu cầu tạo video: ${await readProviderError(response)}`,
      { status: response.status },
    )
  }

  const snapshot = readVideoJob(await response.json())
  if (snapshot.state === 'failed') {
    throw providerIncompatible(snapshot.errorMessage ?? 'Provider báo tác vụ tạo video thất bại')
  }

  return { providerJobId: snapshot.id, progress: snapshot.progress }
}

/** Kiểm tra tiến trình: GET /videos/{id} */
export async function pollVideoGeneration(context: GenerationContext): Promise<VideoJobSnapshot> {
  const { generation, provider } = context
  const jobId = generation.provider_job_id
  if (!jobId) {
    throw providerIncompatible('Tác vụ video không có ID job để theo dõi')
  }

  if (context.env.PROVIDER_MODE === 'mock') {
    const { pollMockVideoJob } = await import('./mock')
    const job = pollMockVideoJob(jobId)
    return {
      id: job.id,
      state: job.status as VideoJobState,
      progress: job.progress,
      errorMessage: job.error?.message ?? null,
    }
  }

  const response = await callProvider(provider, `videos/${encodeURIComponent(jobId)}`, {
    timeoutMs: 30_000,
  })

  if (response.status === 404) {
    throw providerIncompatible('Provider không còn tìm thấy job video này')
  }
  if (!response.ok) {
    throw providerIncompatible(
      `Không kiểm tra được tiến trình video: ${await readProviderError(response)}`,
      { status: response.status },
    )
  }

  return readVideoJob(await response.json())
}

/**
 * Tải nội dung video đã hoàn tất: GET /videos/{id}/content
 * Chỉ gửi API key khi tới đúng origin của provider.
 */
export async function downloadVideoContent(context: GenerationContext): Promise<Uint8Array> {
  const { generation, provider, mediaStore, db, env } = context
  const jobId = generation.provider_job_id
  if (!jobId) throw providerIncompatible('Tác vụ video không có ID job để tải')

  if (env.PROVIDER_MODE === 'mock') {
    const { mockVideoContent } = await import('./mock')
    const bytes = mockVideoContent()
    const usage = mediaStore.userUsageBytes(db, generation.user_id)
    if (usage + bytes.byteLength > env.MAX_USER_MEDIA_BYTES) {
      throw insufficientStorage('Bạn đã dùng hết dung lượng media cho phép. Hãy xóa bớt kết quả cũ.')
    }
    return new Uint8Array(bytes)
  }

  const response: ProviderResponse = await callProvider(
    provider,
    `videos/${encodeURIComponent(jobId)}/content`,
    { timeoutMs: 300_000, headers: { Accept: '*/*' } },
  )

  if (response.status === 404) {
    throw providerIncompatible('Provider chưa có nội dung video để tải')
  }
  if (!response.ok) {
    throw providerIncompatible(
      `Không tải được video từ provider: ${await readProviderError(response)}`,
      { status: response.status },
    )
  }

  const declaredLength = Number(response.headers.get('content-length') ?? '0')
  if (declaredLength > env.MAX_VIDEO_BYTES) {
    throw insufficientStorage('Video vượt giới hạn dung lượng cho phép')
  }

  const usage = mediaStore.userUsageBytes(db, generation.user_id)
  if (usage + declaredLength > env.MAX_USER_MEDIA_BYTES) {
    throw insufficientStorage('Bạn đã dùng hết dung lượng media cho phép. Hãy xóa bớt kết quả cũ.')
  }

  if (!response.body) {
    throw providerIncompatible('Provider không trả về nội dung video')
  }

  const chunks: Uint8Array[] = []
  let total = 0
  const reader = response.body.getReader()

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > env.MAX_VIDEO_BYTES) {
        throw insufficientStorage('Video vượt giới hạn dung lượng cho phép')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  if (total === 0) {
    throw providerIncompatible('Provider trả về video rỗng')
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

export function saveVideoAsset(
  context: GenerationContext,
  bytes: Uint8Array,
): { relativePath: string; mimeType: string; byteSize: number } {
  const saved = context.mediaStore.save({
    userId: context.generation.user_id,
    generationId: context.generation.id,
    bytes,
  })

  context.db
    .prepare(
      'INSERT INTO assets (id, generation_id, user_id, relative_path, mime_type, byte_size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      randomUUID(),
      context.generation.id,
      context.generation.user_id,
      saved.relativePath,
      saved.mimeType,
      saved.byteSize,
      Date.now(),
    )

  return saved
}

export { guardProviderUrl }
