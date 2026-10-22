import sharp, { type Metadata } from 'sharp'
import { IMAGE_EDITOR_LIMITS as L, type ImageEditorRegion, type ImageEditorRequest } from '../../shared/imageEditor'
import { badRequest } from '../lib/errors'

export type NormalizedImage = {
  bytes: Buffer
  width: number
  height: number
  /** True when the source was an animation and only the first frame was kept. */
  firstFrameOnly?: boolean
}

/**
 * Chuẩn hoá ảnh nguồn về PNG tĩnh, đã xoay theo EXIF.
 *
 * Ảnh động (GIF nhiều khung hình, APNG, WebP động) KHÔNG bị từ chối: chỉ
 * khung hình ĐẦU TIÊN được giữ lại và `firstFrameOnly` bật để giao diện
 * có thể thông báo cho người dùng.
 */
export async function normalizeImage(bytes: Uint8Array): Promise<NormalizedImage> {
  let meta: Metadata
  try {
    meta = await sharp(bytes, { limitInputPixels: L.maxPixels, animated: false, failOn: 'error' }).metadata()
  } catch {
    throw badRequest(`Ảnh phải là ảnh tĩnh hợp lệ trong ${L.maxDimension}px và ${L.maxPixels} pixel`)
  }
  if (!meta.width || !meta.height || meta.width > L.maxDimension || meta.height > L.maxDimension) {
    throw badRequest(`Ảnh phải là ảnh tĩnh hợp lệ trong ${L.maxDimension}px và ${L.maxPixels} pixel`)
  }
  const animated = (meta.pages ?? 1) > 1
  try {
    // rotate() applies EXIF orientation, so every downstream coordinate lives in
    // the upright pixel grid the user actually saw. `page: 0` keeps only the
    // first frame of an animation.
    const result = await sharp(bytes, { limitInputPixels: L.maxPixels, animated: false, failOn: 'error' })
      .rotate()
      .toColourspace('srgb')
      .ensureAlpha()
      .png()
      .toBuffer({ resolveWithObject: true })
    return {
      bytes: result.data,
      width: result.info.width,
      height: result.info.height,
      ...(animated ? { firstFrameOnly: true } : {}),
    }
  } catch {
    throw badRequest(`Ảnh phải là ảnh tĩnh hợp lệ trong ${L.maxDimension}px và ${L.maxPixels} pixel`)
  }
}

type Bounds = { x0: number; y0: number; x1: number; y1: number }

/**
 * Ngân sách công việc raster hoá.
 *
 * Mỗi hình được duyệt trên HỘP GIỚI HẠN của nó, nên hình học phức tạp có thể
 * tạo ra công việc rất lớn (pixel × điểm). Ngân sách này chặn việc quét
 * pixel khổng lồ và báo lỗi rõ ràng để người dùng đơn giản vùng chọn.
 */
export const MAX_RASTER_WORK = 200_000_000

/** Công việc ước tính của một hình: pixel trong hộp × số điểm cần xét. */
function shapeWork(shape: ImageEditorRegion['shapes'][number], width: number, height: number): number {
  const points = 'points' in shape ? shape.points.length : 1
  if ('x' in shape) {
    const area = Math.max(1, Math.ceil(shape.width * width) * Math.ceil(shape.height * height))
    return area
  }
  const radius = shape.kind === 'brush' ? shape.radius * Math.min(width, height) : 0
  const xs = shape.points.map((p) => p.x * width)
  const ys = shape.points.map((p) => p.y * height)
  const boxWidth = Math.max(1, Math.ceil(Math.max(...xs) - Math.min(...xs) + radius * 2))
  const boxHeight = Math.max(1, Math.ceil(Math.max(...ys) - Math.min(...ys) + radius * 2))
  return boxWidth * boxHeight * Math.max(1, points)
}

/** Rasterize one shape into a coverage plane. White means "covered". */
function rasterizeShape(
  shape: ImageEditorRegion['shapes'][number],
  width: number,
  height: number,
  plane: Buffer,
  erase = false,
): void {
  const points = 'points' in shape ? shape.points.map((p) => ({ x: p.x * width, y: p.y * height })) : []
  const radius = shape.kind === 'brush' ? shape.radius * Math.min(width, height) : 0
  let bounds: Bounds
  if ('x' in shape) {
    bounds = {
      x0: Math.max(0, Math.floor(shape.x * width)),
      y0: Math.max(0, Math.floor(shape.y * height)),
      x1: Math.min(width - 1, Math.ceil((shape.x + shape.width) * width)),
      y1: Math.min(height - 1, Math.ceil((shape.y + shape.height) * height)),
    }
  } else if (points.length) {
    bounds = {
      x0: Math.max(0, Math.floor(Math.min(...points.map((p) => p.x)) - radius)),
      y0: Math.max(0, Math.floor(Math.min(...points.map((p) => p.y)) - radius)),
      x1: Math.min(width - 1, Math.ceil(Math.max(...points.map((p) => p.x)) + radius)),
      y1: Math.min(height - 1, Math.ceil(Math.max(...points.map((p) => p.y)) + radius)),
    }
  } else {
    return
  }
  if (bounds.x1 < bounds.x0 || bounds.y1 < bounds.y0) return

  for (let y = bounds.y0; y <= bounds.y1; y++) {
    for (let x = bounds.x0; x <= bounds.x1; x++) {
      const px = x + 0.5
      const py = y + 0.5
      let inside = false
      if (shape.kind === 'rect') {
        inside = px >= shape.x * width && px < (shape.x + shape.width) * width
          && py >= shape.y * height && py < (shape.y + shape.height) * height
      } else if (shape.kind === 'ellipse') {
        const rx = (shape.width * width) / 2
        const ry = (shape.height * height) / 2
        if (rx > 0 && ry > 0) {
          inside = ((px - (shape.x + shape.width / 2) * width) / rx) ** 2
            + ((py - (shape.y + shape.height / 2) * height) / ry) ** 2 <= 1
        }
      } else if (shape.kind === 'polygon') {
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
          const a = points[i]!
          const b = points[j]!
          if ((a.y > py) !== (b.y > py) && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) inside = !inside
        }
      } else {
        for (let i = 0; i < points.length; i++) {
          const a = points[Math.max(0, i - 1)]!
          const b = points[i]!
          const dx = b.x - a.x
          const dy = b.y - a.y
          const lenSq = dx * dx + dy * dy || 1
          const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / lenSq))
          const distX = px - a.x - t * dx
          const distY = py - a.y - t * dy
          if (distX * distX + distY * distY <= radius * radius) { inside = true; break }
        }
      }
      if (inside) plane[y * width + x] = erase ? 0 : 255
    }
  }
}

/**
 * Build the editable mask.
 *
 * Mỗi vùng có MỘT mặt phẳng riêng và các hình được vẽ THEO THỨ TỰ, đúng như
 * thao tác trên canvas: vẽ sau khi tẩy sẽ thêm lại vùng đã tẩy. Một hình
 * `erase` chỉ xoá trong vùng của nó, nên không bao giờ chạm vùng khác.
 *
 * Mặt nạ cuối cùng là hợp của các mặt phẳng vùng, nên các vùng chồng nhau vẫn
 * sửa được.
 */
export function regionMask(width: number, height: number, regions: ImageEditorRegion[]): Buffer {
  const union = Buffer.alloc(width * height)
  // Chặn trước khi quét: công việc raster phải nằm trong ngân sách.
  let work = 0
  for (const region of regions) {
    for (const shape of region.shapes) work += shapeWork(shape, width, height)
  }
  if (work > MAX_RASTER_WORK) {
    throw badRequest('Vùng chọn quá phức tạp để xử lý. Hãy đơn giản vùng chọn (ít điểm nét hơn) rồi thử lại.')
  }
  for (const region of regions) {
    const plane = Buffer.alloc(width * height)
    for (const shape of region.shapes) {
      // Vẽ và tẩy dùng CHUNG một mặt phẳng theo đúng thứ tự: vẽ sau khi tẩy
      // thêm lại vùng đã tẩy. Hình tẩy chỉ xoá ở phần nó phủ.
      rasterizeShape(shape, width, height, plane, shape.erase === true)
    }
    for (let i = 0; i < union.length; i++) {
      if (plane[i]) union[i] = 255
    }
  }
  return union
}

/**
 * Hộp giới hạn THỰC TẾ của vùng sau khi áp dụng tuần tự các hình.
 *
 * Hộp phải bám theo phần còn lại sau khi tẩy, và vùng bị tẩy sạch thì KHÔNG
 * được mô tả trong prompt.
 */
export function regionPixelBounds(
  width: number,
  height: number,
  region: ImageEditorRegion,
): { x0: number; y0: number; x1: number; y1: number } | null {
  const work = region.shapes.reduce((total, shape) => total + shapeWork(shape, width, height), 0)
  if (work > MAX_RASTER_WORK) {
    throw badRequest('Vùng chọn quá phức tạp để xử lý. Hãy đơn giản vùng chọn (ít điểm nét hơn) rồi thử lại.')
  }
  const plane = Buffer.alloc(width * height)
  for (const shape of region.shapes) {
    rasterizeShape(shape, width, height, plane, shape.erase === true)
  }
  let x0 = width
  let y0 = height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!plane[y * width + x]) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  // Vùng bị tẩy sạch không mô tả trong prompt.
  if (x1 < x0 || y1 < y0) return null
  return { x0, y0, x1: x1 + 1, y1: y1 + 1 }
}

export async function rawRgba(bytes: Uint8Array): Promise<Buffer> {
  const image = sharp(bytes, { limitInputPixels: L.maxPixels, failOn: 'error' }).rotate().toColourspace('srgb').ensureAlpha()
  return image.raw().toBuffer()
}

export async function pngRgba(raw: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer()
}

/**
 * Place the source inside the output frame.
 *
 * `scale === 1` (default) copies the source pixels RAW: no resampling, no colour
 * change, and the RGB bytes under transparent padding stay untouched.
 * `scale < 1` downscales exactly once with a high-quality resampler and then
 * copies the resampled pixels at the frame offset.
 */
export async function padImage(
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  frame: NonNullable<ImageEditorRequest['frame']>,
): Promise<Buffer> {
  const scale = frame.scale ?? 1
  let placedWidth = sourceWidth
  let placedHeight = sourceHeight
  let placed: Buffer
  if (scale < 1) {
    placedWidth = Math.max(1, Math.round(sourceWidth * scale))
    placedHeight = Math.max(1, Math.round(sourceHeight * scale))
    placed = await sharp(await rawRgba(source), { raw: { width: sourceWidth, height: sourceHeight, channels: 4 } })
      .resize(placedWidth, placedHeight, { fit: 'fill', kernel: 'lanczos3' })
      .raw()
      .toBuffer()
  } else {
    placed = await rawRgba(source)
  }
  const out = Buffer.alloc(frame.width * frame.height * 4)
  if (frame.background !== 'transparent') {
    const color = frame.background.slice(1)
    const r = parseInt(color.slice(0, 2), 16)
    const g = parseInt(color.slice(2, 4), 16)
    const b = parseInt(color.slice(4, 6), 16)
    for (let i = 0; i < out.length; i += 4) {
      out[i] = r
      out[i + 1] = g
      out[i + 2] = b
      out[i + 3] = 255
    }
  }
  // Raw copy (not alpha-over) preserves even RGB bytes underneath transparent pixels.
  for (let y = 0; y < placedHeight; y++) {
    placed.copy(
      out,
      ((y + frame.offsetY) * frame.width + frame.offsetX) * 4,
      y * placedWidth * 4,
      (y + 1) * placedWidth * 4,
    )
  }
  return pngRgba(out, frame.width, frame.height)
}

/** Provider mask: transparent where the provider may edit, opaque elsewhere. */
export async function providerMaskPng(mask: Buffer, width: number, height: number): Promise<Buffer> {
  const rgba = Buffer.alloc(width * height * 4, 255)
  for (let i = 0; i < mask.length; i++) rgba[i * 4 + 3] = 255 - mask[i]!
  return pngRgba(rgba, width, height)
}

/**
 * Restore protected pixels from the original source.
 *
 * The provider result is accepted ONLY at the exact expected dimensions, then
 * every pixel outside the editable mask is copied back from the original, so
 * protected content stays bit-identical to the source.
 */
export async function preserveProtected(
  source: Uint8Array,
  result: Uint8Array,
  mask: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  const original = await rawRgba(source)
  const out = await rawRgba(result)
  if (original.length !== out.length) throw badRequest('Provider returned incorrect editor output dimensions')
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) original.copy(out, i * 4, i * 4, i * 4 + 4)
  }
  return pngRgba(out, width, height)
}

/**
 * Resize a provider result to the expected output size.
 *
 * A provider that answers with a different size must not fail the job: the
 * guarantee is upheld by compositing afterwards. The resize is geometric
 * (contain-fit inside the expected canvas, transparent padding) so no content
 * is cropped away.
 */
export async function resizeToFrame(result: Uint8Array, width: number, height: number): Promise<Buffer> {
  const metadata = await sharp(result, { limitInputPixels: L.maxPixels, failOn: 'error' }).metadata()
  if (!metadata.width || !metadata.height) throw badRequest('Provider did not return a readable image')
  if (metadata.width === width && metadata.height === height) {
    return sharp(result, { limitInputPixels: L.maxPixels }).toColourspace('srgb').ensureAlpha().raw().toBuffer()
  }
  return sharp(result, { limitInputPixels: L.maxPixels })
    .resize(width, height, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: 'lanczos3' })
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer()
}

/**
 * Masked region edit: protected pixels are restored from the original source.
 *
 * A provider result with a different size is resized to the expected frame
 * first; only an unreadable image fails the job.
 */
export async function restoreMaskedResult(
  source: Uint8Array,
  result: Uint8Array,
  mask: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  const out = await resizeToFrame(result, width, height)
  const original = await rawRgba(source)
  if (original.length !== out.length) throw badRequest('Provider returned incorrect editor output dimensions')
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) original.copy(out, i * 4, i * 4, i * 4 + 4)
  }
  return pngRgba(out, width, height)
}

/**
 * AI outpaint: the original rectangle is restored from the padded source.
 *
 * This guarantee does NOT depend on provider mask support: the region that
 * held the original image always comes back pixel-exactly from the source.
 */
export async function restoreRectResult(
  paddedSource: Uint8Array,
  result: Uint8Array,
  rect: { x: number; y: number; width: number; height: number },
  width: number,
  height: number,
): Promise<Buffer> {
  const out = await resizeToFrame(result, width, height)
  const source = await rawRgba(paddedSource)
  for (let row = 0; row < rect.height; row++) {
    const targetY = rect.y + row
    if (targetY < 0 || targetY >= height) continue
    for (let column = 0; column < rect.width; column++) {
      const targetX = rect.x + column
      if (targetX < 0 || targetX >= width) continue
      const sourceIndex = (targetY * width + targetX) * 4
      if (sourceIndex + 4 > source.length) continue
      source.copy(out, sourceIndex, sourceIndex, sourceIndex + 4)
    }
  }
  return pngRgba(out, width, height)
}

/** Apply a grayscale foreground mask (white = foreground) to the source. */
export async function applyForegroundMask(
  source: Uint8Array,
  maskBytes: Uint8Array,
  width: number,
  height: number,
  color?: string,
): Promise<Buffer> {
  const meta = await sharp(maskBytes, { limitInputPixels: L.maxPixels }).metadata()
  if (meta.width !== width || meta.height !== height || meta.format !== 'png' || (meta.pages ?? 1) !== 1) {
    throw badRequest('Background service returned an invalid mask')
  }
  const mask = await sharp(maskBytes).toColourspace('b-w').removeAlpha().raw().toBuffer()
  const raw = await rawRgba(source)
  if (raw.length !== mask.length * 4) throw badRequest('Background service returned an invalid mask')
  const replacement = color
    ? [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16)]
    : null
  for (let i = 0; i < mask.length; i++) {
    const alpha = (raw[i * 4 + 3]! / 255) * (mask[i]! / 255)
    if (replacement) {
      for (let c = 0; c < 3; c++) {
        raw[i * 4 + c] = Math.round(raw[i * 4 + c]! * alpha + replacement[c]! * (1 - alpha))
      }
      raw[i * 4 + 3] = 255
    } else {
      raw[i * 4 + 3] = Math.round(alpha * 255)
    }
  }
  return pngRgba(raw, width, height)
}
