import { videoSizeSelection } from '../../../shared/videoControls'
import {
  errorMeta,
  providerIncompatible,
  uncertainOutcome,
} from '../../lib/errors'
import {
  callProvider,
  parseRetryAfterSeconds,
  readProviderError,
  type ProviderResponse,
} from '../../providers/client'
import {
  pinGenerationTarget,
  poolExhaustedError,
  submitWithPool,
} from '../../providers/pool'
import type { GenerationContext, GenerationParams } from '../types'
import {
  loadCharacterReference,
  loadVideoInput,
  readVideoContent,
  recordPinnedResult,
  sanitizeDiagnostic,
  type VideoJobSnapshot,
  type VideoJobState,
} from './video'

/**
 * Xây dựng payload gửi tới endpoint POST /v1/video-generations của Xpiki Gateway.
 *
 * Xpiki yêu cầu:
 * - model: string
 * - prompt: string
 * - duration_seconds: number (bắt buộc > 0, ví dụ 5; muse-video yêu cầu 10)
 * - resolution: string (bắt buộc, ví dụ "720p")
 * - aspect_ratio: string (ví dụ "16:9")
 * - references: string[] (ảnh tham chiếu URL hoặc base64 data-url)
 */
export function buildXpikiRequestBody(
  modelId: string,
  prompt: string,
  params: GenerationParams,
  referenceDataUrl?: string | null,
  explicitInputDataUrl?: string | null,
) {
  const body: Record<string, unknown> = {
    model: modelId,
    prompt,
  }

  // Phân tích kích thước và tỷ lệ từ params.size (ví dụ "1280x720")
  let resolution = '720p'
  let aspectRatio = '16:9'

  if (typeof params.size === 'string' && params.size) {
    if (/^[0-9]+[pP]$/.test(params.size)) {
      resolution = params.size.toLowerCase()
    } else {
      const selection = videoSizeSelection(params.size)
      resolution = `${selection.resolution}p`
      aspectRatio = selection.ratio
    }
  }

  if (typeof params.aspectRatio === 'string' && params.aspectRatio) {
    aspectRatio = params.aspectRatio
  }

  body.resolution = resolution
  body.aspect_ratio = aspectRatio

  // Thời lượng (duration_seconds)
  // muse-video trên xpiki chỉ hỗ trợ duration_seconds = 10
  if (modelId === 'muse-video') {
    body.duration_seconds = 10
  } else {
    let seconds = 5
    if (params.seconds !== undefined) {
      const parsed = Number(params.seconds)
      if (Number.isFinite(parsed) && parsed > 0) {
        seconds = Math.round(parsed)
      }
    }
    body.duration_seconds = seconds
  }

  // Ảnh tham chiếu nhân vật hoặc ảnh đầu vào video
  const imageUrl =
    explicitInputDataUrl ||
    (params.useCharacterReference === false ? null : referenceDataUrl)
  if (imageUrl) {
    body.references = [imageUrl]
  }

  return body
}

/**
 * Đọc dữ liệu job từ phản hồi tạo hoặc polling của Xpiki Gateway.
 */
export function readXpikiJob(
  payload: unknown,
  secrets: Array<string | null | undefined> = [],
): VideoJobSnapshot {
  if (typeof payload !== 'object' || payload === null) {
    throw providerIncompatible('Xpiki trả về dữ liệu job video không đúng định dạng')
  }

  const record = payload as {
    task_id?: unknown
    id?: unknown
    status?: unknown
    state?: unknown
    progress?: unknown
    error_message?: unknown
    error_code?: unknown
    error?: unknown
    outputs?: unknown
  }

  const id =
    typeof record.task_id === 'string' && record.task_id
      ? record.task_id
      : typeof record.id === 'string' && record.id
        ? record.id
        : null

  if (!id) {
    throw providerIncompatible('Xpiki không trả về ID job video')
  }

  const rawState =
    typeof record.status === 'string'
      ? record.status
      : typeof record.state === 'string'
        ? record.state
        : 'queued'

  const normalized = rawState.toLowerCase().replace(/[\s-]+/g, '_')
  let state: VideoJobState
  if (normalized === 'queued' || normalized === 'pending' || normalized === 'starting') {
    state = 'queued'
  } else if (
    normalized === 'running' ||
    normalized === 'processing' ||
    normalized === 'in_progress'
  ) {
    state = 'in_progress'
  } else if (
    normalized === 'succeeded' ||
    normalized === 'completed' ||
    normalized === 'success'
  ) {
    state = 'completed'
  } else if (
    normalized === 'failed' ||
    normalized === 'error' ||
    normalized === 'cancelled'
  ) {
    state = 'failed'
  } else {
    state = 'in_progress'
  }

  let progress: number | null = null
  if (typeof record.progress === 'number' && Number.isFinite(record.progress)) {
    progress = record.progress <= 1 ? Math.round(record.progress * 100) : Math.round(record.progress)
  } else if (state === 'completed') {
    progress = 100
  } else if (state === 'queued') {
    progress = 0
  }

  let errorMessage: string | null = null
  if (typeof record.error_message === 'string' && record.error_message) {
    errorMessage = record.error_message
  } else if (typeof record.error_code === 'string' && record.error_code) {
    errorMessage = record.error_code
  } else if (typeof record.error === 'string') {
    errorMessage = record.error
  } else if (typeof record.error === 'object' && record.error !== null) {
    const msg = (record.error as { message?: unknown }).message
    if (typeof msg === 'string') errorMessage = msg
  }

  if (errorMessage !== null) {
    errorMessage = sanitizeDiagnostic(errorMessage, secrets)
  }

  let resultUrl: string | null = null
  if (Array.isArray(record.outputs) && record.outputs.length > 0) {
    const first = record.outputs[0] as { url?: unknown }
    if (first && typeof first.url === 'string') {
      resultUrl = first.url
    }
  }

  return { id, state, progress, errorMessage, resultUrl }
}

/**
 * Bắt đầu tạo video: POST /v1/video-generations
 */
export async function startXpikiVideo(
  context: GenerationContext,
): Promise<{ providerJobId: string; progress: number | null }> {
  const { generation, provider } = context
  const params = JSON.parse(generation.params_json) as GenerationParams

  if (!generation.provider_id) {
    throw providerIncompatible('Tác vụ này không có provider để gửi yêu cầu tạo video')
  }

  const outcome = await submitWithPool({
    db: context.db,
    env: context.env,
    providerId: generation.provider_id,
    initial: provider,
    call: (target) =>
      callProvider(target, 'video-generations', {
        method: 'POST',
        body: buildXpikiRequestBody(
          generation.snap_model_id,
          generation.effective_prompt ?? generation.prompt,
          params,
          loadCharacterReference(context),
          loadVideoInput(context),
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
        `Xpiki gặp lỗi máy chủ (mã ${response.status}) sau khi nhận yêu cầu tạo video. Không tự gửi lại để tránh tính phí hai lần — hãy kiểm tra ở provider trước.`,
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
    snapshot = readXpikiJob(await response.json(), [
      outcome.target.apiKey,
      provider.apiKey,
    ])
  } catch (error) {
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
    throw providerIncompatible(
      snapshot.errorMessage ?? 'Xpiki báo tác vụ tạo video thất bại',
      undefined,
      snapshot.errorMessage
        ? errorMeta('generations.provider_job_failed', { detail: snapshot.errorMessage })
        : errorMeta('generations.provider_failed'),
    )
  }

  return { providerJobId: snapshot.id, progress: snapshot.progress }
}

/**
 * Kiểm tra tiến trình: GET /v1/generation-tasks/{task_id}
 */
export async function pollXpikiVideo(
  context: GenerationContext,
): Promise<VideoJobSnapshot> {
  const { generation, provider } = context
  const jobId = generation.provider_job_id
  if (!jobId) {
    throw providerIncompatible('Tác vụ video không có ID job để theo dõi')
  }

  let response: ProviderResponse
  try {
    response = await callProvider(
      provider,
      `generation-tasks/${encodeURIComponent(jobId)}`,
      {
        timeoutMs: 30_000,
      },
    )
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
    recordPinnedResult(context, {
      status: 404,
      message: 'Provider không còn tìm thấy job video này',
    })
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

  const snapshot = readXpikiJob(payload, [provider.apiKey])
  if (snapshot.resultUrl) {
    context.db
      .prepare('UPDATE generations SET provider_result_url = ?, updated_at = ? WHERE id = ?')
      .run(snapshot.resultUrl, Date.now(), context.generation.id)
    context.generation.provider_result_url = snapshot.resultUrl
  }

  return snapshot
}

/**
 * Tải nội dung video đã hoàn tất từ Xpiki Gateway.
 * Endpoint: GET /v1/generation-tasks/{task_id}/outputs/0
 */
export async function downloadXpikiVideo(
  context: GenerationContext,
): Promise<Uint8Array> {
  const { generation, provider } = context
  const jobId = generation.provider_job_id
  if (!jobId) throw providerIncompatible('Tác vụ video không có ID job để tải')

  let downloadEndpoint = `generation-tasks/${encodeURIComponent(jobId)}/outputs/0`
  let absoluteUrl: string | undefined

  if (generation.provider_result_url) {
    if (generation.provider_result_url.startsWith('http://') || generation.provider_result_url.startsWith('https://')) {
      absoluteUrl = generation.provider_result_url
    } else {
      // Relative URL từ origin, ví dụ "/v1/generation-tasks/.../outputs/0"
      try {
        absoluteUrl = new URL(generation.provider_result_url, provider.baseUrl).toString()
      } catch {
        downloadEndpoint = generation.provider_result_url.replace(/^\/+/, '')
      }
    }
  }

  let response: ProviderResponse
  try {
    response = await callProvider(provider, downloadEndpoint, {
      timeoutMs: 300_000,
      headers: { Accept: 'video/*, */*' },
      ...(absoluteUrl ? { absoluteUrl } : {}),
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
    recordPinnedResult(context, {
      status: 404,
      message: 'Provider chưa có nội dung video để tải',
    })
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

  recordPinnedResult(context, { status: response.status, ok: true })
  return readVideoContent(context, response)
}
