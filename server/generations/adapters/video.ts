import { randomUUID } from 'node:crypto'
import { insufficientStorage, errorMeta, providerIncompatible, uncertainOutcome } from '../../lib/errors'
import {
  callProvider,
  parseRetryAfterSeconds,
  readProviderError,
  redactSecrets,
  type ProviderResponse,
} from '../../providers/client'
import type { CredentialResultInput } from '../../providers/credentials'
import {
  pinGenerationTarget,
  poolExhaustedError,
  recordPinnedCredentialResult,
  submitWithPool,
} from '../../providers/pool'
import { guardProviderUrl } from '../../providers/urlGuard'
import { readCharacterReferences, type SourceImage } from './image'
import type { GenerationContext, GenerationParams } from '../types'

export type VideoJobState = 'queued' | 'in_progress' | 'completed' | 'failed'

export type VideoJobSnapshot = {
  id: string
  state: VideoJobState
  progress: number | null
  errorMessage: string | null
}

/**
 * Chuẩn hoá chẩn đoán lấy từ provider trước khi lưu/trả: rửa sạch mọi bí mật
 * xuất hiện nguyên văn rồi cắt còn 500 ký tự. Provider có thể dội lại chính API
 * key trong `error`/`status`, hoặc trả về chuỗi khổng lồ; cả hai đều không được
 * lọt vào phản hồi, metadata lỗi hay cột `last_error`.
 */
function sanitizeDiagnostic(text: string, secrets: Array<string | null | undefined>): string {
  return redactSecrets(text, secrets).slice(0, 500)
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
 * Ưu tiên snapshot lưu cùng tác vụ (nhờ đó tác vụ đang chạy không đổi đầu vào
 * khi người dùng thay ảnh). Với tác vụ cũ chưa có snapshot, tra theo cảnh.
 *
 * Chỉ đọc từ kho media riêng của chính người dùng. Trả null nếu cảnh không có
 * nhân vật, nhân vật chưa có ảnh, hoặc tệp vượt giới hạn cho phép.
 */
export function loadCharacterReference(context: GenerationContext): string | null {
  const { generation, db, mediaStore, env } = context

  // API video chỉ nhận MỘT ảnh tham chiếu, nên dùng ảnh của người nói chính —
  // phần tử đầu của cột mảng. Nhân vật phụ vẫn được mô tả trong prompt.
  const references = readCharacterReferences(
    generation.character_references_json,
    generation.character_reference_json,
  )
  const stored = references[0] ?? legacyCharacterReference(db, generation.scene_id ?? null)
  if (!stored) return null
  if (!mediaStore.exists(stored.path)) return null

  const bytes = mediaStore.readFile(stored.path)
  if (bytes.byteLength === 0 || bytes.byteLength > env.MAX_REFERENCE_BYTES) return null

  return `data:${stored.mime};base64,${Buffer.from(bytes).toString('base64')}`
}

/** Đường dẫn ảnh tham chiếu của nhân vật gắn với cảnh, dùng cho tác vụ cũ. */
function legacyCharacterReference(db: GenerationContext['db'], sceneId: string | null): SourceImage | null {
  if (!sceneId) return null

  const row = db
    .prepare(
      `SELECT c.reference_path AS path, c.reference_mime AS mime
       FROM scenes s
       JOIN characters c ON c.id = s.character_id
       WHERE s.id = ?`,
    )
    .get(sceneId) as { path: string | null; mime: string | null } | undefined

  if (!row?.path || !row.mime) return null
  return { path: row.path, mime: row.mime }
}

/**
 * Đọc trạng thái job video. Chấp nhận cả `status` và `state` vì một số
 * provider tương thích dùng tên trường khác nhau.
 *
 * `secrets` là (các) API key đã dùng để gọi provider: provider có thể dội lại
 * chính key đó trong `status`/`error`, nên mọi chuỗi chẩn đoán đều được rửa sạch
 * và cắt còn 500 ký tự TRƯỚC khi trả về hoặc ném lỗi.
 */
export function readVideoJob(
  payload: unknown,
  secrets: Array<string | null | undefined> = [],
): VideoJobSnapshot {
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

  // Cắt trần ngay từ đầu: `status` có thể là chuỗi khổng lồ do provider lỗi.
  const rawState =
    typeof record.status === 'string'
      ? record.status.slice(0, 500)
      : typeof record.state === 'string'
        ? record.state.slice(0, 500)
        : record.state
  const state = normalizeState(rawState)
  if (!state) {
    const shown = sanitizeDiagnostic(
      typeof rawState === 'string' ? rawState : String(rawState),
      secrets,
    )
    throw providerIncompatible(
      `Provider trả về trạng thái job video không được hỗ trợ: ${shown}`,
      undefined,
      errorMeta('generations.video_state_unsupported', { state: shown }),
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
  if (errorMessage !== null) errorMessage = sanitizeDiagnostic(errorMessage, secrets)

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

/**
 * Cập nhật sức khỏe của ĐÚNG key đã ghim cho tác vụ.
 *
 * Poll/tải lại không bao giờ đổi key, nhưng kết quả vẫn được ghi nhận để key đó
 * được tạm nghỉ hoặc đánh dấu sai quyền cho các tác vụ MỚI. Vì đây chỉ là QUAN
 * SÁT trên key đã ghim, `recordPinnedCredentialResult` ghi với `observeOnly`:
 * một lần poll/tải thành công KHÔNG được xoá `auth_failed`/cooldown do tác vụ
 * khác gây ra. `expectedFingerprint` (khi pool cung cấp) khiến kết quả của
 * request cũ bị bỏ qua nếu bí mật đã bị xoay giữa chừng. `credentialId` có thể
 * vắng trong context dựng thủ công ở test.
 */
function recordPinnedResult(context: GenerationContext, result: CredentialResultInput): void {
  recordPinnedCredentialResult(
    context.db,
    context.provider.credentialId,
    result,
    pinnedExpectedFingerprint(context),
  )
}

/**
 * Vân tay HMAC của key đã ghim. `GenerationProviderTarget` (types.ts) chưa khai
 * báo trường tuỳ chọn này của hợp đồng pool; đọc qua kiểu hẹp để không phải sửa
 * tệp ngoài phạm vi.
 */
function pinnedExpectedFingerprint(context: GenerationContext): string | undefined {
  return (context.provider as { expectedFingerprint?: string }).expectedFingerprint
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

  if (!generation.provider_id) {
    throw providerIncompatible('Tác vụ này không có provider để gửi yêu cầu tạo video')
  }

  // Chỉ đổi key khi provider trả 401/403/429. Timeout/mất kết nối/5xx không được
  // gửi lại vì job có thể đã được tạo và tính phí.
  const outcome = await submitWithPool({
    db: context.db,
    env: context.env,
    providerId: generation.provider_id,
    initial: provider,
    call: (target) =>
      callProvider(target, 'videos', {
        method: 'POST',
        body: buildVideoRequestBody(
          generation.snap_model_id,
          generation.effective_prompt ?? generation.prompt,
          params,
          loadCharacterReference(context),
        ),
        timeoutMs: 120_000,
      }),
    onAttempt: (target) => pinGenerationTarget(context.db, generation.id, target),
  })

  const response = outcome.response

  if (!response.ok) {
    if (outcome.exhausted) throw poolExhaustedError(response, outcome.target)

    if (response.status >= 500) {
      throw uncertainOutcome(
        `Provider gặp lỗi máy chủ (mã ${response.status}) sau khi nhận yêu cầu tạo video. Không tự gửi lại để tránh tính phí hai lần — hãy kiểm tra ở provider trước.`,
        { status: response.status },
        errorMeta('errors.outcome_unknown', { status: response.status }),
      )
    }

    const detail = await readProviderError(response, [outcome.target.apiKey])
    throw providerIncompatible(
      `Provider từ chối yêu cầu tạo video: ${detail}`,
      { status: response.status },
      errorMeta('generations.video_request_rejected', { detail }),
    )
  }

  let snapshot: VideoJobSnapshot
  try {
    snapshot = readVideoJob(await response.json(), [outcome.target.apiKey, provider.apiKey])
  } catch (error) {
    // 2xx nhưng thân không đọc được hoặc thiếu ID job: request đã tới provider.
    // Lỗi JSON có thể chứa nguyên văn một đoạn thân phản hồi (kể cả key), nên
    // chẩn đoán phải được rửa sạch và cắt ngắn.
    throw uncertainOutcome(
      'Provider báo thành công nhưng trả về dữ liệu job video không đọc được. Không tự gửi lại để tránh tính phí hai lần — hãy kiểm tra ở provider trước.',
      {
        detail: sanitizeDiagnostic(
          error instanceof Error ? error.message : 'Dữ liệu job video không đọc được',
          [outcome.target.apiKey, provider.apiKey],
        ),
      },
      errorMeta('errors.outcome_unknown'),
    )
  }

  if (snapshot.state === 'failed') {
    // Provider đã xử lý và nói rõ thất bại: đây là kết quả chắc chắn.
    throw providerIncompatible(
      snapshot.errorMessage ?? 'Provider báo tác vụ tạo video thất bại',
      undefined,
      snapshot.errorMessage
        ? errorMeta('generations.provider_job_failed', { detail: snapshot.errorMessage })
        : errorMeta('generations.provider_failed'),
    )
  }

  return { providerJobId: snapshot.id, progress: snapshot.progress }
}

/**
 * Kiểm tra tiến trình: GET /videos/{id}
 *
 * Luôn dùng ĐÚNG key + URL đã ghim khi gửi job, kể cả key đó đã bị tắt. Kết quả
 * được ghi ở chế độ QUAN SÁT (`observeOnly`) để các tác vụ mới tránh key hỏng mà
 * không hồi sinh key đã bị `auth_failed`/cooldown bởi tác vụ khác.
 */
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

  let response: ProviderResponse
  try {
    response = await callProvider(provider, `videos/${encodeURIComponent(jobId)}`, {
      timeoutMs: 30_000,
    })
  } catch (error) {
    recordPinnedResult(context, {
      message: sanitizeDiagnostic(
        error instanceof Error ? error.message : 'Lỗi mạng khi theo dõi video',
        [provider.apiKey],
      ),
    })
    throw error
  }

  if (response.status === 404) {
    recordPinnedResult(context, { status: 404, message: 'Provider không còn tìm thấy job video này' })
    throw providerIncompatible('Provider không còn tìm thấy job video này')
  }
  if (!response.ok) {
    const detail = await readProviderError(response, [provider.apiKey])
    recordPinnedResult(context, {
      status: response.status,
      retryAfterSeconds: parseRetryAfterSeconds(response.headers),
      message: detail,
    })
    throw providerIncompatible(
      `Không kiểm tra được tiến trình video: ${detail}`,
      { status: response.status },
      errorMeta('generations.video_poll_failed', { detail }),
    )
  }

  recordPinnedResult(context, { status: response.status, ok: true })

  // Thân 2xx không đọc được cũng là chẩn đoán của provider: rửa key + cắt ngắn
  // trước khi ném, tránh lộ nguyên văn thân phản hồi qua cột lỗi.
  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    throw providerIncompatible(
      'Provider trả về dữ liệu job video không đọc được',
      {
        detail: sanitizeDiagnostic(
          error instanceof Error ? error.message : 'Dữ liệu job video không đọc được',
          [provider.apiKey],
        ),
      },
      errorMeta('generations.video_job_payload_invalid'),
    )
  }
  return readVideoJob(payload, [provider.apiKey])
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

  let response: ProviderResponse
  try {
    response = await callProvider(provider, `videos/${encodeURIComponent(jobId)}/content`, {
      timeoutMs: 300_000,
      headers: { Accept: '*/*' },
    })
  } catch (error) {
    recordPinnedResult(context, {
      message: sanitizeDiagnostic(
        error instanceof Error ? error.message : 'Lỗi mạng khi tải video',
        [provider.apiKey],
      ),
    })
    throw error
  }

  if (response.status === 404) {
    recordPinnedResult(context, { status: 404, message: 'Provider chưa có nội dung video để tải' })
    throw providerIncompatible('Provider chưa có nội dung video để tải')
  }
  if (!response.ok) {
    const detail = await readProviderError(response, [provider.apiKey])
    recordPinnedResult(context, {
      status: response.status,
      retryAfterSeconds: parseRetryAfterSeconds(response.headers),
      message: detail,
    })
    throw providerIncompatible(
      `Không tải được video từ provider: ${detail}`,
      { status: response.status },
      errorMeta('generations.video_download_failed', { detail }),
    )
  }

  // Key đã ghim vẫn trả nội dung: ghi nhận ở chế độ quan sát (không hồi sinh key
  // đang auth_failed/cooldown do tác vụ khác gây ra).
  recordPinnedResult(context, { status: response.status, ok: true })

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
