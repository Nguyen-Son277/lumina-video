import { randomUUID } from 'node:crypto'
import type { Database } from '../../db/index'
import type { AppEnv } from '../../env'
import { insufficientStorage, errorMeta, providerIncompatible, uncertainOutcome } from '../../lib/errors'
import { readProviderError, type ProviderTarget } from '../../providers/client'
import { pinGenerationTarget, poolExhaustedError, submitWithPool } from '../../providers/pool'
import type { GenerationContext, GenerationParams } from '../types'

export type StoredImage = {
  relativePath: string
  mimeType: string
  byteSize: number
}

/** Chỉ gửi tham số người dùng thực sự đặt, để provider dùng mặc định của họ. */
export function buildImageRequestBody(modelId: string, prompt: string, params: GenerationParams) {
  const body: Record<string, unknown> = { model: modelId, prompt }

  if (typeof params.size === 'string' && params.size) body.size = params.size
  if (typeof params.quality === 'string' && params.quality) body.quality = params.quality
  if (typeof params.n === 'number' && Number.isInteger(params.n)) body.n = params.n
  if (typeof params.background === 'string' && params.background) body.background = params.background

  return body
}

/** Đọc danh sách ảnh từ response, chấp nhận cả b64_json và url. */
export function readImageEntries(payload: unknown): Array<{ b64?: string; url?: string }> {
  if (typeof payload !== 'object' || payload === null) {
    throw providerIncompatible('Provider trả về dữ liệu không đúng định dạng')
  }

  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data) || data.length === 0) {
    throw providerIncompatible('Provider không trả về ảnh nào')
  }

  const entries = data.map((item) => {
    if (typeof item !== 'object' || item === null) return {}
    const record = item as { b64_json?: unknown; url?: unknown; image_url?: unknown }
    const b64 = typeof record.b64_json === 'string' ? record.b64_json : undefined
    const url =
      typeof record.url === 'string'
        ? record.url
        : typeof record.image_url === 'string'
          ? record.image_url
          : undefined
    return { b64, url }
  })

  if (!entries.some((entry) => entry.b64 || entry.url)) {
    throw providerIncompatible(
      'Provider trả về thành công nhưng không có trường b64_json hoặc url nào được hỗ trợ',
    )
  }

  return entries
}

/**
 * Tải ảnh từ URL do provider trả về.
 * Không gửi API key sang origin khác và giới hạn kích thước khi tải.
 *
 * `provider` là đích ĐÃ DÙNG để tạo ảnh (có thể là key dự phòng sau failover),
 * nên ảnh trả về từ cùng origin vẫn được tải bằng đúng key đó.
 */
async function downloadImage(
  provider: ProviderTarget,
  env: AppEnv,
  url: string,
): Promise<{ bytes: Uint8Array; mimeType?: string }> {
  const { guardProviderUrl } = await import('../../providers/urlGuard')
  const guarded = await guardProviderUrl(url, { allowPrivate: provider.allowPrivate })

  const sameOrigin = guarded.url.origin === new URL(provider.baseUrl).origin

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)

  try {
    const response = await fetch(guarded.url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: sameOrigin ? { Authorization: `Bearer ${provider.apiKey}` } : {},
    })

    if (!response.ok) {
      throw providerIncompatible(
        `Không tải được ảnh từ provider (mã ${response.status})`,
        undefined,
        errorMeta('generations.image_download_failed', { status: response.status }),
      )
    }

    const declaredLength = Number(response.headers.get('content-length') ?? '0')
    if (declaredLength > env.MAX_IMAGE_BYTES) {
      throw insufficientStorage('Ảnh provider trả về vượt giới hạn dung lượng cho phép')
    }

    const buffer = new Uint8Array(await response.arrayBuffer())
    if (buffer.byteLength > env.MAX_IMAGE_BYTES) {
      throw insufficientStorage('Ảnh provider trả về vượt giới hạn dung lượng cho phép')
    }

    const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim()
    return { bytes: buffer, mimeType }
  } finally {
    clearTimeout(timer)
  }
}

/** Kiểu gọi API ảnh của provider. */
export type ImageApiStyle = 'openai' | 'extra_body'

export const DEFAULT_IMAGE_API_STYLE: ImageApiStyle = 'openai'

export function readImageApiStyle(value: string | null | undefined): ImageApiStyle {
  return value === 'extra_body' ? 'extra_body' : DEFAULT_IMAGE_API_STYLE
}

/** Chuyển ảnh nhị phân thành Data URI để gửi trong extra_body.image. */
function toDataUrl(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`
}

/**
 * Kiểu `extra_body`: tất cả trong POST /images/generations (JSON).
 *
 * Theo tài liệu Agnes Image 2.0 Flash:
 * - Ảnh nguồn nằm trong `extra_body.image` (mảng URL công khai hoặc Data URI).
 * - `response_format` BẮT BUỘC nằm trong `extra_body`; đặt ở top-level có thể gây 400.
 * - Chỉ gửi các trường được tài liệu mô tả để tránh bị từ chối vì trường lạ.
 */
export function buildExtraBodyImageRequest(input: {
  modelId: string
  prompt: string
  params: GenerationParams
  sources: Array<{ bytes: Uint8Array; mimeType: string }>
}): Record<string, unknown> {
  const body: Record<string, unknown> = { model: input.modelId, prompt: input.prompt }

  if (typeof input.params.size === 'string' && input.params.size) {
    body.size = input.params.size
  }
  // `quality` là đặc thù của GPT Image nên không gửi cho kiểu này.
  const count = input.params.n
  if (typeof count === 'number' && Number.isInteger(count) && count > 1) {
    body.n = count
  }

  const extraBody: Record<string, unknown> = { response_format: 'url' }
  if (input.sources.length) {
    extraBody.image = input.sources.map((source) => toDataUrl(source.bytes, source.mimeType))
  }
  body.extra_body = extraBody

  return body
}

/** Ảnh nguồn đã lưu trong snapshot của tác vụ. */
export type SourceImage = {
  path: string
  mime: string
}

/**
 * Đọc ảnh tham chiếu nhân vật từ cột snapshot, chịu được dữ liệu cũ hoặc hỏng.
 * Trả null khi tác vụ không gắn nhân vật có ảnh tham chiếu.
 */
export function readCharacterReference(json: string | null | undefined): SourceImage | null {
  if (!json) return null
  try {
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as { path?: unknown; mime?: unknown }
    if (typeof record.path !== 'string' || typeof record.mime !== 'string') return null
    return { path: record.path, mime: record.mime }
  } catch {
    return null
  }
}

/**
 * Đọc danh sách ảnh tham chiếu nhân vật từ cột snapshot mảng.
 *
 * Ưu tiên cột mảng (nhiều nhân vật mỗi cảnh). Tác vụ cũ chỉ có cột một-đối-tượng
 * nên vẫn đọc được qua tham số thứ hai.
 */
export function readCharacterReferences(
  jsonArray: string | null | undefined,
  jsonSingle: string | null | undefined,
): SourceImage[] {
  const list: SourceImage[] = []

  if (jsonArray) {
    try {
      const parsed: unknown = JSON.parse(jsonArray)
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item !== 'object' || item === null) continue
          const record = item as { path?: unknown; mime?: unknown }
          if (typeof record.path !== 'string' || typeof record.mime !== 'string') continue
          list.push({ path: record.path, mime: record.mime })
        }
      }
    } catch {
      // Dữ liệu hỏng thì rơi xuống cột cũ.
    }
  }

  if (!list.length) {
    const single = readCharacterReference(jsonSingle)
    if (single) list.push(single)
  }

  return list
}

/** Đọc danh sách ảnh nguồn từ cột snapshot, chịu được dữ liệu cũ hoặc hỏng. */
export function readSourceImages(json: string | null | undefined): SourceImage[] {
  if (!json) return []
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item) => {
        if (typeof item !== 'object' || item === null) return null
        const record = item as { path?: unknown; mime?: unknown }
        if (typeof record.path !== 'string' || typeof record.mime !== 'string') return null
        return { path: record.path, mime: record.mime }
      })
      .filter((item): item is SourceImage => item !== null)
  } catch {
    return []
  }
}

/**
 * Dựng multipart/form-data cho endpoint /images/edits.
 *
 * Endpoint này nhận nhiều ảnh dưới cùng một khóa `image`, theo đúng hợp đồng
 * của OpenAI cho các model GPT Image.
 */
export function buildImageEditForm(input: {
  modelId: string
  prompt: string
  params: GenerationParams
  sources: Array<{ bytes: Uint8Array; mimeType: string }>
}): FormData {
  const form = new FormData()
  form.append('model', input.modelId)
  form.append('prompt', input.prompt)

  if (typeof input.params.size === 'string' && input.params.size) {
    form.append('size', input.params.size)
  }
  if (typeof input.params.quality === 'string' && input.params.quality) {
    form.append('quality', input.params.quality)
  }
  if (typeof input.params.n === 'number' && Number.isInteger(input.params.n)) {
    form.append('n', String(input.params.n))
  }
  if (typeof input.params.background === 'string' && input.params.background) {
    form.append('background', input.params.background)
  }

  for (const source of input.sources) {
    const extension = source.mimeType.split('/')[1] ?? 'png'
    // Sao chép sang ArrayBuffer riêng để Blob nhận đúng kiểu nhị phân.
    const copy = new Uint8Array(source.bytes.byteLength)
    copy.set(source.bytes)
    form.append('image', new Blob([copy.buffer], { type: source.mimeType }), `source.${extension}`)
  }

  return form
}

/**
 * Adapter cho provider chuẩn OpenAI: POST /images/generations
 * Hỗ trợ cả kết quả base64 và URL.
 */
export async function runImageGeneration(context: GenerationContext): Promise<void> {
  const { generation, provider, db, mediaStore } = context
  const params = JSON.parse(generation.params_json) as GenerationParams
  const sources = readSourceImages(generation.source_images_json)

  // Ảnh tham chiếu nhân vật đứng sau ảnh nguồn để giữ nguyên thứ tự người dùng
  // đã chọn; tắt được bằng tham số useCharacterReference = false. Cảnh có nhiều
  // nhân vật thì gửi mọi ảnh tham chiếu (người nói chính ở đầu danh sách).
  const characterReferences = params.useCharacterReference === false
    ? []
    : readCharacterReferences(
        generation.character_references_json,
        generation.character_reference_json,
      )
  for (const reference of characterReferences) {
    if (!mediaStore.exists(reference.path)) {
      throw providerIncompatible(
        'Ảnh tham chiếu của nhân vật không còn trong kho media. Hãy tải lại ảnh cho nhân vật.',
      )
    }
  }
  const loadedSources = [...sources, ...characterReferences].map((source) => ({
    bytes: mediaStore.readFile(source.path),
    mimeType: source.mime,
  }))

  let payload: unknown
  // Đích ĐÃ DÙNG cho lần gửi cuối (có thể là key dự phòng sau failover 401/403/429).
  let activeProvider = provider
  // Chỉ khác null khi lần gửi này thực sự đi qua pool (chế độ live).
  let usedPool = false

  if (context.env.PROVIDER_MODE === 'mock') {
    // Chế độ test: không gọi mạng, không dùng API key thật.
    const { mockImageResponse } = await import('./mock')
    const count = typeof params.n === 'number' ? Math.max(1, Math.min(4, params.n)) : 1
    payload = mockImageResponse(count)
  } else {
    const { callProvider } = await import('../../providers/client')
    const prompt = generation.effective_prompt ?? generation.prompt
    const style = readImageApiStyle(generation.snap_image_style)

    if (!generation.provider_id) {
      throw providerIncompatible('Tác vụ này không có provider để gửi yêu cầu tạo ảnh')
    }

    // Một hàm gửi, ba hợp đồng endpoint. Cơ chế chọn key/failover nằm ở pool.
    const send = (target: typeof provider) => {
      if (style === 'extra_body') {
        // Agnes và các gateway tương tự: một endpoint duy nhất, ảnh nguồn trong extra_body.
        return callProvider(target, 'images/generations', {
          method: 'POST',
          body: buildExtraBodyImageRequest({
            modelId: generation.snap_model_id,
            prompt,
            params,
            sources: loadedSources,
          }),
          timeoutMs: 360_000,
        })
      }
      if (loadedSources.length) {
        // Chuẩn OpenAI: tạo ảnh từ ảnh qua /images/edits dạng multipart.
        return callProvider(target, 'images/edits', {
          method: 'POST',
          formData: buildImageEditForm({
            modelId: generation.snap_model_id,
            prompt,
            params,
            sources: loadedSources,
          }),
          timeoutMs: 300_000,
        })
      }
      return callProvider(target, 'images/generations', {
        method: 'POST',
        body: buildImageRequestBody(generation.snap_model_id, prompt, params),
        timeoutMs: 300_000,
      })
    }

    // Chỉ đổi key khi provider trả 401/403/429. Timeout/mất kết nối/5xx được ném
    // hoặc trả nguyên về để không gửi lại yêu cầu có thể đã bị tính phí.
    const outcome = await submitWithPool({
      db,
      env: context.env,
      providerId: generation.provider_id,
      initial: provider,
      call: send,
      onAttempt: (target) => pinGenerationTarget(db, generation.id, target),
    })

    usedPool = true
    activeProvider = outcome.target
    const response = outcome.response

    if (!response.ok) {
      if (outcome.exhausted) throw poolExhaustedError(response, outcome.target)

      // 5xx sau khi provider đã nhận yêu cầu: có thể đã bị tính phí ⇒ không tự gửi lại.
      if (response.status >= 500) {
        throw uncertainOutcome(
          `Provider gặp lỗi máy chủ (mã ${response.status}) sau khi nhận yêu cầu tạo ảnh. Không tự gửi lại để tránh tính phí hai lần — hãy kiểm tra ở provider trước.`,
          { status: response.status },
          errorMeta('errors.outcome_unknown', { status: response.status }),
        )
      }

      const detail = await readProviderError(response, [outcome.target.apiKey])
      // `quality` là trường đặc thù GPT Image; nhiều gateway từ chối và chỉ nói
      // chung chung, nên gợi ý thẳng cách xử lý.
      const qualityHint = /quality/i.test(detail)
        ? ' Provider không hỗ trợ trường quality — hãy để mục Chất lượng ở "Mặc định của model (không gửi)".'
        : ''
      const referenceHint = characterReferences.length
        ? ' Ảnh tham chiếu nhân vật được gửi kèm; hãy bỏ chọn nhân vật hoặc tắt tùy chọn gửi ảnh tham chiếu nếu model không hỗ trợ.'
        : ''
      const hint =
        style === 'extra_body'
          ? ' Kiểm tra model ID và tham số; provider này dùng ảnh nguồn trong extra_body.image.'
          : loadedSources.length
            ? ' Hãy kiểm tra model có hỗ trợ /images/edits, hoặc thử tạo ảnh không kèm ảnh nguồn.'
            : ''
      throw providerIncompatible(
        `Provider từ chối yêu cầu tạo ảnh: ${detail}.${qualityHint}${referenceHint}${hint}`,
        { status: response.status },
        errorMeta('generations.image_request_rejected', {
          detail: `${detail}.${qualityHint}${referenceHint}${hint}`,
        }),
      )
    }

    try {
      payload = await response.json()
    } catch {
      // 2xx nhưng thân không đọc được: request CHẮC CHẮN đã tới provider.
      throw uncertainOutcome(
        'Provider báo thành công nhưng trả về dữ liệu ảnh không đọc được. Không tự gửi lại để tránh tính phí hai lần — hãy kiểm tra ở provider trước.',
        { status: response.status },
        errorMeta('errors.outcome_unknown', { status: response.status }),
      )
    }
  }

  let entries: ReturnType<typeof readImageEntries>
  try {
    entries = readImageEntries(payload)
  } catch (error) {
    // Chỉ coi là "không xác định" khi đã thực sự gửi qua pool; chế độ mock là lỗi lập trình.
    if (usedPool) throw uncertainOutcome(
      'Provider báo thành công nhưng không trả về ảnh đọc được. Không tự gửi lại để tránh tính phí hai lần — hãy kiểm tra ở provider trước.',
      { detail: error instanceof Error ? error.message : undefined },
      errorMeta('errors.outcome_unknown'),
    )
    throw error
  }

  // Giới hạn dung lượng media của từng người dùng trước khi ghi thêm.
  const usage = mediaStore.userUsageBytes(db, generation.user_id)

  let stored = 0
  let index = 0
  for (const entry of entries) {
    let bytes: Uint8Array
    let declaredMime: string | undefined

    if (entry.b64) {
      bytes = Buffer.from(entry.b64, 'base64')
    } else if (entry.url) {
      const downloaded = await downloadImage(activeProvider, context.env, entry.url)
      bytes = downloaded.bytes
      declaredMime = downloaded.mimeType
    } else {
      continue
    }

    if (usage + bytes.byteLength > context.env.MAX_USER_MEDIA_BYTES) {
      throw insufficientStorage(
        'Bạn đã dùng hết dung lượng media cho phép. Hãy xóa bớt kết quả cũ.',
      )
    }

    const saved = mediaStore.save({
      userId: generation.user_id,
      generationId: generation.id,
      bytes,
      declaredMime,
      index,
    })

    db.prepare(
      'INSERT INTO assets (id, generation_id, user_id, relative_path, mime_type, byte_size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      randomUUID(),
      generation.id,
      generation.user_id,
      saved.relativePath,
      saved.mimeType,
      saved.byteSize,
      Date.now(),
    )

    stored += 1
    index += 1
  }

  if (stored === 0) {
    throw providerIncompatible('Provider không trả về nội dung ảnh nào có thể lưu')
  }
}
