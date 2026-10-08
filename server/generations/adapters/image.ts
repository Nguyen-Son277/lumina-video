import { randomUUID } from 'node:crypto'
import type { Database } from '../../db/index'
import { insufficientStorage, providerIncompatible } from '../../lib/errors'
import { readProviderError } from '../../providers/client'
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
 */
async function downloadImage(
  context: GenerationContext,
  url: string,
): Promise<{ bytes: Uint8Array; mimeType?: string }> {
  const { guardProviderUrl } = await import('../../providers/urlGuard')
  const guarded = await guardProviderUrl(url, { allowPrivate: context.provider.allowPrivate })

  const sameOrigin = guarded.url.origin === new URL(context.provider.baseUrl).origin

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)

  try {
    const response = await fetch(guarded.url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: sameOrigin ? { Authorization: `Bearer ${context.provider.apiKey}` } : {},
    })

    if (!response.ok) {
      throw providerIncompatible(`Không tải được ảnh từ provider (mã ${response.status})`)
    }

    const declaredLength = Number(response.headers.get('content-length') ?? '0')
    if (declaredLength > context.env.MAX_IMAGE_BYTES) {
      throw insufficientStorage('Ảnh provider trả về vượt giới hạn dung lượng cho phép')
    }

    const buffer = new Uint8Array(await response.arrayBuffer())
    if (buffer.byteLength > context.env.MAX_IMAGE_BYTES) {
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

  let payload: unknown

  if (context.env.PROVIDER_MODE === 'mock') {
    // Chế độ test: không gọi mạng, không dùng API key thật.
    const { mockImageResponse } = await import('./mock')
    const count = typeof params.n === 'number' ? Math.max(1, Math.min(4, params.n)) : 1
    payload = mockImageResponse(count)
  } else {
    const { callProvider } = await import('../../providers/client')
    const prompt = generation.effective_prompt ?? generation.prompt
    const style = readImageApiStyle(generation.snap_image_style)
    const loadedSources = sources.map((source) => ({
      bytes: mediaStore.readFile(source.path),
      mimeType: source.mime,
    }))

    let response

    if (style === 'extra_body') {
      // Agnes và các gateway tương tự: một endpoint duy nhất, ảnh nguồn trong extra_body.
      response = await callProvider(provider, 'images/generations', {
        method: 'POST',
        body: buildExtraBodyImageRequest({
          modelId: generation.snap_model_id,
          prompt,
          params,
          sources: loadedSources,
        }),
        timeoutMs: 360_000,
      })
    } else if (loadedSources.length) {
      // Chuẩn OpenAI: tạo ảnh từ ảnh qua /images/edits dạng multipart.
      response = await callProvider(provider, 'images/edits', {
        method: 'POST',
        formData: buildImageEditForm({
          modelId: generation.snap_model_id,
          prompt,
          params,
          sources: loadedSources,
        }),
        timeoutMs: 300_000,
      })
    } else {
      response = await callProvider(provider, 'images/generations', {
        method: 'POST',
        body: buildImageRequestBody(generation.snap_model_id, prompt, params),
        timeoutMs: 300_000,
      })
    }

    if (!response.ok) {
      const detail = await readProviderError(response)
      // `quality` là trường đặc thù GPT Image; nhiều gateway từ chối và chỉ nói
      // chung chung, nên gợi ý thẳng cách xử lý.
      const qualityHint = /quality/i.test(detail)
        ? ' Provider không hỗ trợ trường quality — hãy để mục Chất lượng ở "Mặc định của model (không gửi)".'
        : ''
      const hint =
        style === 'extra_body'
          ? ' Kiểm tra model ID và tham số; provider này dùng ảnh nguồn trong extra_body.image.'
          : loadedSources.length
            ? ' Hãy kiểm tra model có hỗ trợ /images/edits, hoặc thử tạo ảnh không kèm ảnh nguồn.'
            : ''
      throw providerIncompatible(
        `Provider từ chối yêu cầu tạo ảnh: ${detail}.${qualityHint}${hint}`,
        { status: response.status },
      )
    }

    payload = await response.json()
  }

  const entries = readImageEntries(payload)

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
      const downloaded = await downloadImage(context, entry.url)
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
