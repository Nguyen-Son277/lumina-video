import type { AppEnv } from '../env'
import type { Database } from '../db/index'
import { IMAGE_EDITOR_LIMITS, type ImageEditorCapabilities, type ImageEditorRequest, type ImageEditorSnapshot, type ImageEditorPreview, type ImageEditorRegion } from '../../shared/imageEditor'
import { AppError, badRequest } from '../lib/errors'
import { validateFrame } from './schema'
import { regionMask, regionPixelBounds } from './processing'

export type EditorInternal = {
  request: ImageEditorRequest
  snapshot: ImageEditorSnapshot
  sourcePath: string
  retainedSource: unknown
  width: number
  height: number
  /** True when the provider cannot honour a mask (prompt-directed region edit). */
  promptDirected?: boolean
  /** True only when the model is VERIFIED to honour a mask AND the transport can carry it. */
  maskSupported?: boolean
}

export const PROMPT_DIRECTED_WARNING =
  'Chế độ hướng dẫn bằng mô tả: model chưa được xác nhận hỗ trợ mặt nạ nên toàn bộ ảnh có thể thay đổi, ranh giới vùng chỉ mang tính gợi ý.'

/** Ảnh động chỉ giữ khung hình đầu tiên. */
export const FIRST_FRAME_WARNING =
  'Ảnh nguồn là ảnh động nên chỉ khung hình đầu tiên được dùng để chỉnh sửa.'

/** Provider refuses prompts longer than this; preview and submit must agree. */
export const EDITOR_PROMPT_MAX_LENGTH = 8000

type ModelRow = {
  id: string
  modelId: string
  displayName: string
  imageApiStyle: string | null
  imageReferenceTransport: string
  imageReferenceSupport: 'unknown' | 'yes' | 'no'
  imageMaskSupport: 'unknown' | 'yes' | 'no'
  imageTransparentBackgroundSupport: 'unknown' | 'yes' | 'no'
}

function editorModels(db: Database, userId: string): ModelRow[] {
  return db.prepare(`SELECT m.id, m.model_id AS modelId, m.display_name AS displayName,
      p.image_api_style AS imageApiStyle, m.image_reference_transport AS imageReferenceTransport,
      m.image_reference_support AS imageReferenceSupport,
      m.image_mask_support AS imageMaskSupport, m.image_transparent_background_support AS imageTransparentBackgroundSupport
    FROM models m JOIN provider_connections p ON p.id = m.provider_id
    WHERE m.user_id = ? AND m.kind = 'image' AND m.enabled = 1`).all(userId) as unknown as ModelRow[]
}

/**
 * Transport that can carry the source image at all.
 *
 * Every known transport does: the OpenAI style sends the source through
 * /images/edits, the `extra_body` gateway style through `extra_body.image`, and
 * the `generations_images` transport through the `images` field. Only a
 * transport that is not part of this set could not carry a source image.
 */
export function transportCarriesSource(model: Pick<ModelRow, 'imageApiStyle' | 'imageReferenceTransport'>): boolean {
  const style = model.imageApiStyle ?? 'openai'
  return (style === 'openai' || style === 'extra_body' || style === 'default')
    && (model.imageReferenceTransport === 'provider_default' || model.imageReferenceTransport === 'generations_images')
}

/** Transport that can carry an OpenAI-style PNG alpha mask. */
export function transportCarriesMask(model: Pick<ModelRow, 'imageApiStyle' | 'imageReferenceTransport'>): boolean {
  return (model.imageApiStyle ?? 'openai') === 'openai' && model.imageReferenceTransport === 'provider_default'
}

/** The model refuses source images entirely. */
function modelRefusesReferences(model: Pick<ModelRow, 'imageReferenceSupport'>): boolean {
  return model.imageReferenceSupport === 'no'
}

export async function backgroundServiceReady(env: AppEnv): Promise<boolean> {
  if (!env.BACKGROUND_REMOVAL_URL) return false
  try {
    const response = await fetch(`${env.BACKGROUND_REMOVAL_URL.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(2000), redirect: 'error' })
    const data = await response.json() as { ok?: boolean }
    return response.ok && data.ok === true
  } catch {
    return false
  }
}

export async function editorCapabilities(db: Database, env: AppEnv, userId: string): Promise<ImageEditorCapabilities> {
  const rows = editorModels(db, userId)
  return {
    limits: IMAGE_EDITOR_LIMITS,
    local: { pad: true, backgroundRemoval: await backgroundServiceReady(env) },
    operations: ['region', 'reframe', 'background'],
    models: rows.map((model) => {
      const mask = model.imageMaskSupport
      const transparent = model.imageTransparentBackgroundSupport
      const carriesSource = transportCarriesSource(model) && !modelRefusesReferences(model)
      const carriesMask = transportCarriesMask(model) && !modelRefusesReferences(model)
      // A mask is only claimed when the model is VERIFIED and the transport can
      // carry one. An unverified model is never reported as mask-capable.
      const preciseRegion = carriesMask && mask === 'yes'
      return {
        id: String(model.id),
        label: String(model.displayName || model.modelId),
        maskSupport: mask,
        transparentBackgroundSupport: transparent,
        region: preciseRegion,
        regionPromptOnly: carriesSource && !preciseRegion,
        reframe: carriesSource,
        background: carriesSource,
        backgroundRemoval: carriesSource && transparent === 'yes',
      }
    }),
  }
}

/**
 * Mô tả vùng bằng HỘP GIỚI HẠN PIXEL, không nhúng JSON thô.
 *
 * Nhúng toàn bộ điểm brush sẽ làm prompt vượt giới hạn của provider, nên
 * hình học đầy đủ chỉ nằm trong snapshot và mặt nạ gửi kèm. Hộp bám theo phần
 * còn lại SAU khi tẩy, và vùng bị tẩy sạch không được mô tả.
 */
function regionDescription(region: ImageEditorRegion, index: number, width: number, height: number): string | null {
  const bounds = regionPixelBounds(width, height, region)
  if (!bounds) return null
  const kind = region.shapes.some((shape) => shape.kind === 'brush') ? 'painted'
    : region.shapes.some((shape) => shape.kind === 'polygon') ? 'outlined' : 'rectangular'
  return `Region ${index + 1} (${region.id}, ${kind} area): bounding box x=${bounds.x0}..${bounds.x1}, y=${bounds.y0}..${bounds.y1} in pixels of a ${width}x${height} image, origin at the top-left corner.\nInstruction: ${region.comment}`
}

export function editorPrompt(
  request: ImageEditorRequest,
  width: number,
  height: number,
  promptDirected = false,
): string {
  const base = [
    `Image editor operation: ${request.operation}. Source image size: ${width}x${height} pixels, origin at the top-left corner.`,
    request.prompt?.trim() || '',
  ]
  if (request.operation === 'region') {
    base.push(promptDirected
      ? 'Apply the following edits to the whole image. The region boxes are advisory guidance only and must not be treated as a strict mask.'
      : 'Edit only the indicated editable regions and keep everything outside them unchanged.',
      ...(request.regions ?? [])
        .map((region, index) => regionDescription(region, index, width, height))
        .filter((text): text is string => text !== null))
  }
  if (request.operation === 'reframe') {
    base.push('Extend the scene naturally into the empty padding around the original image. Preserve the original image at its exact location, scale, identity, colors and details. Do not crop, move or resize the original.')
  }
  if (request.operation === 'background') {
    base.push(request.background?.mode === 'remove'
      ? 'Remove the background, retaining the foreground subject. Return a transparent PNG.'
      : `Replace only the background. Preserve subject identity and details. ${request.background?.color ? 'Background color: ' + request.background.color + '.' : ''} ${request.background?.prompt ?? ''}`)
  }
  return base.filter(Boolean).join('\n\n')
}

/** Giới hạn prompt giống hệt lúc gửi provider để preview không hứa hở. */
function assertPromptLength(prompt: string): void {
  if (prompt.length > EDITOR_PROMPT_MAX_LENGTH) {
    throw badRequest(`Mô tả tổng hợp tối đa ${EDITOR_PROMPT_MAX_LENGTH} ký tự. Hãy rút gọn ghi chú vùng.`)
  }
}

export function buildEditorWork(
  request: ImageEditorRequest,
  width: number,
  height: number,
  options: { promptDirected?: boolean; firstFrameOnly?: boolean } = {},
): { width: number; height: number; mask?: Buffer; preview: ImageEditorPreview } {
  validateFrame(request, width, height)
  const w = request.frame?.width ?? width
  const h = request.frame?.height ?? height
  const promptDirected = options.promptDirected === true
  let mask: Buffer | undefined
  if (request.operation === 'region') {
    // A prompt-directed edit has no mask: the provider cannot honour one.
    if (!promptDirected) {
      mask = regionMask(width, height, request.regions ?? [])
      if (!mask.some((v) => v !== 0)) throw badRequest('Hãy chọn ít nhất một vùng cần sửa')
    }
  } else if (request.operation === 'reframe') {
    // Editable area = the frame minus the scaled source rectangle.
    mask = Buffer.alloc(w * h, 255)
    const f = request.frame!
    const scale = f.scale ?? 1
    const placedWidth = Math.max(1, Math.round(width * scale))
    const placedHeight = Math.max(1, Math.round(height * scale))
    for (let y = 0; y < placedHeight; y++) {
      const row = (y + f.offsetY) * w + f.offsetX
      if (row < 0 || row + placedWidth <= 0 || row >= w * h) continue
      mask.fill(0, Math.max(0, row), Math.min(w * h, row + placedWidth))
    }
    // Chỉ MỞ RỘNG ẢNH (AI outpaint) mới cần phần trống. Cục bộ được phép
    // giữ nguyên khung hoặc thu nhỏ vừa khung: đó là thao tác hợp lệ.
    if (request.engine === 'provider' && !mask.some((v) => v !== 0)) {
      throw badRequest('Khung mới phải có phần trống để mở rộng ảnh. Hãy chọn khung lớn hơn ảnh gốc.')
    }
  }
  const warnings: string[] = []
  if (promptDirected) warnings.push(PROMPT_DIRECTED_WARNING)
  if (options.firstFrameOnly) warnings.push(FIRST_FRAME_WARNING)
  if (request.engine === 'provider' && request.operation === 'reframe') {
    warnings.push('Vùng ảnh gốc luôn được khôi phục nguyên pixel từ ảnh nguồn.')
  }
  const prompt = editorPrompt(request, width, height, promptDirected)
  assertPromptLength(prompt)
  return {
    width: w,
    height: h,
    mask,
    preview: { width: w, height: h, prompt, warnings, ...(promptDirected ? { promptDirected: true } : {}) },
  }
}

/**
 * Kiểm tra model cho từng chế độ.
 *
 * - region + provider: chấp nhận model có thể mang ảnh nguồn; nếu chưa xác
 *   nhận hỗ trợ mặt nạ thì chuyển sang chế độ hướng dẫn bằng mô tả, KHÔNG
 *   biến một yêu cầu sửa chính xác thành sửa toàn ảnh mà không cảnh báo.
 * - reframe/background: cần model mang được ảnh nguồn.
 */
export function validateEditorModel(db: Database, userId: string, request: ImageEditorRequest): { promptDirected: boolean; maskSupported: boolean } {
  if (request.engine === 'local') return { promptDirected: false, maskSupported: false }
  const model = db.prepare(`SELECT m.id, m.model_id AS modelId, m.display_name AS displayName,
      p.image_api_style AS imageApiStyle, m.image_reference_transport AS imageReferenceTransport,
      m.image_reference_support AS imageReferenceSupport,
      m.image_mask_support AS imageMaskSupport, m.image_transparent_background_support AS imageTransparentBackgroundSupport
    FROM models m JOIN provider_connections p ON p.id = m.provider_id
    WHERE m.id = ? AND m.user_id = ? AND m.kind = 'image' AND m.enabled = 1`).get(request.modelId!, userId) as ModelRow | undefined
  if (!model) throw badRequest('Hãy chọn model tạo ảnh đang bật thuộc tài khoản của bạn')
  if (modelRefusesReferences(model)) {
    throw badRequest('Model này không nhận ảnh nguồn nên không thể dùng cho trình chỉnh sửa ảnh. Hãy chọn model khác.')
  }
  if (!transportCarriesSource(model)) {
    throw badRequest('Model này không nhận ảnh nguồn nên không thể dùng cho trình chỉnh sửa ảnh. Hãy chọn model khác.')
  }
  const maskSupported = transportCarriesMask(model) && model.imageMaskSupport === 'yes'
  if (request.operation === 'region') {
    return { promptDirected: !maskSupported, maskSupported }
  }
  if (request.operation === 'background' && request.background?.mode === 'remove' && model.imageTransparentBackgroundSupport !== 'yes') {
    throw badRequest('Xoá nền cần model đã xác nhận hỗ trợ ảnh nền trong suốt. Hãy chọn model khác hoặc dùng chế độ cục bộ.')
  }
  return { promptDirected: false, maskSupported }
}

/**
 * Gọi dịch vụ xoá nền cục bộ.
 *
 * Mã lỗi của dịch vụ được phân loại rõ:
 * - 429 busy, 503 model_unavailable, 504 inference_timeout: TẠM THỜI, có thể thử lại.
 * - 400/404/413/415/422: VĨNH VIỄN, không thử lại.
 */
export async function fetchForegroundMask(env: AppEnv, png: Uint8Array): Promise<Uint8Array> {
  if (!env.BACKGROUND_REMOVAL_URL) throw badRequest('Chưa cấu hình dịch vụ xoá nền cục bộ')
  const response = await fetch(`${env.BACKGROUND_REMOVAL_URL.replace(/\/$/, '')}/mask`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: new Uint8Array(png),
    redirect: 'error',
    signal: AbortSignal.timeout(env.BACKGROUND_REMOVAL_TIMEOUT_MS),
  })
  if (!response.ok) {
    if (response.status === 429) {
      throw new AppError(503, 'BACKGROUND_SERVICE_BUSY', 'Dịch vụ xoá nền đang bận. Hãy thử lại sau ít phút.', undefined, { messageKey: 'errors.outcome_unknown' })
    }
    if (response.status === 503 || response.status === 504) {
      throw new AppError(503, 'BACKGROUND_SERVICE_UNAVAILABLE', 'Dịch vụ xoá nền đang tải lại mô hình. Hãy thử lại sau ít phút.', undefined, { messageKey: 'errors.outcome_unknown' })
    }
    throw badRequest(`Dịch vụ xoá nền từ chối ảnh này (mã ${response.status}). Hãy thử ảnh khác.`)
  }
  const limit = IMAGE_EDITOR_LIMITS.maxPixels + 1024 * 1024
  if (Number(response.headers.get('content-length') ?? 0) > limit) throw badRequest('Mặt nạ nền vượt giới hạn dung lượng')
  const reader = response.body?.getReader()
  if (!reader) throw badRequest('Dịch vụ xoá nền không trả về mặt nạ')
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const part = await reader.read()
    if (part.done) break
    size += part.value.length
    if (size > limit) {
      await reader.cancel()
      throw badRequest('Mặt nạ nền vượt giới hạn dung lượng')
    }
    chunks.push(part.value)
  }
  return Buffer.concat(chunks)
}

export function editorSnapshot(internal: EditorInternal): ImageEditorSnapshot { return internal.snapshot }
