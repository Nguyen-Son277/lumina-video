import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'
import sharp, { type OverlayOptions } from 'sharp'
import { probeVideo, type FfmpegTooling, type VideoProbe } from '../exports/ffmpeg'
import { badRequest, errorMeta, providerError } from '../lib/errors'
import { sniffMime, type MediaStore } from '../media/store'

const run = promisify(execFile)
const MAX_OVERLAYS = 8
const MAX_PIXELS = 40_000_000
const MAX_LOGO_BYTES = 20 * 1024 * 1024
const RASTER_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export const LOGO_ANCHORS = [
  'top-left', 'top-center', 'top-right',
  'middle-left', 'center', 'middle-right',
  'bottom-left', 'bottom-center', 'bottom-right',
] as const
export type LogoAnchor = typeof LOGO_ANCHORS[number]

/** x/y are legacy top-left coordinates; anchor overrides them after resizing. */
export type LogoOverlay = {
  entityId: string
  anchor?: LogoAnchor
  x: number
  y: number
  width: number
  opacity: number
  startSeconds?: number
  endSeconds?: number
}

/** The caller resolves ownership and supplies a relative path in its media store. */
export type ResolvedLogoOverlay = LogoOverlay & { path: string; mime: string }

/** Pure validation: never reads media, resolves an entity or enqueues paid work. */
export function validateLogoOverlays(value: unknown): LogoOverlay[] {
  if (!Array.isArray(value) || value.length > MAX_OVERLAYS) {
    throw badRequest('Chỉ được ghép tối đa 8 logo')
  }
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw badRequest('Cấu hình logo không hợp lệ')
    }
    const item = entry as Record<string, unknown>
    if (typeof item.entityId !== 'string' || !item.entityId.trim()) {
      throw badRequest('Logo cần có entityId')
    }
    for (const key of ['x', 'y', 'width', 'opacity'] as const) {
      const n = item[key]
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1 || (key === 'width' && n === 0)) {
        throw badRequest(`Thông số logo ${key} không hợp lệ`)
      }
    }
    if (item.anchor !== undefined && !LOGO_ANCHORS.includes(item.anchor as LogoAnchor)) {
      throw badRequest('Vị trí neo logo không hợp lệ')
    }
    const start = item.startSeconds
    const end = item.endSeconds
    if (start !== undefined && (typeof start !== 'number' || !Number.isFinite(start) || start < 0)) {
      throw badRequest('Thời điểm bắt đầu logo không hợp lệ')
    }
    if (end !== undefined && (typeof end !== 'number' || !Number.isFinite(end) || end <= (start as number | undefined ?? 0))) {
      throw badRequest('Thời điểm kết thúc logo phải sau thời điểm bắt đầu')
    }
    return {
      entityId: item.entityId,
      ...(item.anchor !== undefined ? { anchor: item.anchor as LogoAnchor } : {}),
      x: item.x as number,
      y: item.y as number,
      width: item.width as number,
      opacity: item.opacity as number,
      ...(start !== undefined ? { startSeconds: start as number } : {}),
      ...(end !== undefined ? { endSeconds: end as number } : {}),
    }
  })
}

/** Clamp margins only when a fitted logo leaves less than 5% free space. */
function anchorAxis(anchor: LogoAnchor, axis: 'x' | 'y'): 'start' | 'center' | 'end' {
  if (axis === 'x') return anchor.endsWith('-left') ? 'start' : anchor.endsWith('-right') ? 'end' : 'center'
  return anchor.startsWith('top-') ? 'start' : anchor.startsWith('bottom-') ? 'end' : 'center'
}

function anchoredPosition(anchor: LogoAnchor, axis: 'x' | 'y', size: number, logoSize: number): number {
  const available = size - logoSize
  const margin = Math.min(Math.round(size * 0.05), available)
  const align = anchorAxis(anchor, axis)
  return align === 'start' ? margin : align === 'end' ? available - margin : Math.round(available / 2)
}

function videoPosition(overlay: LogoOverlay, axis: 'x' | 'y', size: number): string {
  const available = axis === 'x' ? 'main_w-overlay_w' : 'main_h-overlay_h'
  if (!overlay.anchor) return `min(${Math.round(overlay[axis] * size)},${available})`
  const align = anchorAxis(overlay.anchor, axis)
  const margin = `min(${Math.round(size * 0.05)},${available})`
  return align === 'start' ? margin : align === 'end' ? `${available}-${margin}` : `round((${available})/2)`
}

function validateResolved(overlays: ResolvedLogoOverlay[]): void {
  validateLogoOverlays(overlays)
  for (const overlay of overlays) {
    if (!RASTER_MIMES.has(overlay.mime)) throw badRequest('Logo phải là PNG, JPEG, WebP hoặc GIF; không nhận SVG')
    // Do not let even a permissive MediaStore resolve traversal, URLs or absolute paths.
    if (typeof overlay.path !== 'string' || !overlay.path || overlay.path.includes('\0') ||
      overlay.path.includes('\\') || overlay.path.includes(':') || isAbsolute(overlay.path) ||
      overlay.path.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
      throw badRequest('Đường dẫn logo trong kho media không hợp lệ')
    }
  }
}

function checkRaster(bytes: Uint8Array, expectedMime?: string): void {
  const mime = sniffMime(bytes)
  if (!mime || !RASTER_MIMES.has(mime) || (expectedMime !== undefined && mime !== expectedMime)) {
    throw badRequest('Ảnh phải là PNG, JPEG, WebP hoặc GIF hợp lệ; không nhận SVG')
  }
}

/** First frame only, auto-orient EXIF, with a bounded decoder for all raster inputs. */
async function raster(bytes: Uint8Array, expectedMime?: string): Promise<Buffer> {
  checkRaster(bytes, expectedMime)
  try {
    return await sharp(bytes, { limitInputPixels: MAX_PIXELS, animated: false, failOn: 'error' })
      .rotate().toColourspace('srgb').ensureAlpha().png().toBuffer()
  } catch {
    throw badRequest('Không giải mã được ảnh hoặc ảnh vượt giới hạn 40 triệu pixel')
  }
}

/**
 * Produce a new PNG; never mutate the source or save/delete any media. Image
 * overlays are applied in array order; video-only time windows have no effect.
 * A tall logo is reduced further to fit the source height, without stretching.
 */
export async function compositeLogoImage(
  inputBytes: Uint8Array,
  overlays: ResolvedLogoOverlay[],
  mediaStore: Pick<MediaStore, 'readFile'>,
): Promise<Uint8Array> {
  validateResolved(overlays)
  const base = await raster(inputBytes)
  const metadata = await sharp(base, { limitInputPixels: MAX_PIXELS }).metadata()
  const width = metadata.width!
  const height = metadata.height!
  const layers: OverlayOptions[] = []
  for (const overlay of overlays) {
    const bytes = mediaStore.readFile(overlay.path)
    if (bytes.byteLength > MAX_LOGO_BYTES) throw badRequest('Logo vượt giới hạn 20 MB')
    const logo = await raster(bytes, overlay.mime)
    const { data, info } = await sharp(logo, { limitInputPixels: MAX_PIXELS })
      .resize({ width: Math.max(1, Math.round(overlay.width * width)), height, fit: 'inside' })
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    // Preserve intrinsic alpha (including transparent PNGs), rather than replace it.
    for (let index = 3; index < data.length; index += 4) data[index] = Math.round(data[index]! * overlay.opacity)
    layers.push({
      input: data,
      raw: { width: info.width, height: info.height, channels: 4 },
      left: overlay.anchor ? anchoredPosition(overlay.anchor, 'x', width, info.width)
        : Math.min(Math.round(overlay.x * width), width - info.width),
      top: overlay.anchor ? anchoredPosition(overlay.anchor, 'y', height, info.height)
        : Math.min(Math.round(overlay.y * height), height - info.height),
      blend: 'over',
    })
  }
  return sharp(base, { limitInputPixels: MAX_PIXELS }).composite(layers).png().toBuffer()
}

function trustedLocalPath(path: string): void {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || path.includes('\n') || path.includes('\r')) {
    throw badRequest('Đường dẫn video phải là đường dẫn tệp tuyệt đối do máy chủ cung cấp')
  }
}

/** Pure argument builder. absolutePath is server-resolved, never a request field. */
export function buildLogoVideoArgs(
  input: string,
  output: string,
  overlays: Array<ResolvedLogoOverlay & { absolutePath: string }>,
  width: number,
  height: number,
): string[] {
  validateResolved(overlays)
  trustedLocalPath(input)
  trustedLocalPath(output)
  if (resolve(input) === resolve(output)) throw badRequest('Video kết quả phải khác video gốc')
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width * height > MAX_PIXELS) {
    throw badRequest('Kích thước video không hợp lệ hoặc vượt giới hạn 40 triệu pixel')
  }
  const args = ['-y', '-nostdin', '-filter_complex_threads', '1', '-protocol_whitelist', 'file,pipe', '-i', input]
  const filters = ['[0:v:0]setpts=PTS-STARTPTS[base]']
  let previous = 'base'
  overlays.forEach((overlay, index) => {
    trustedLocalPath(overlay.absolutePath)
    args.push('-protocol_whitelist', 'file,pipe', '-i', overlay.absolutePath)
    const targetWidth = Math.max(1, Math.round(overlay.width * width))
    const label = `logo${index}`
    filters.push(`[${index + 1}:v:0]scale=${targetWidth}:${height}:force_original_aspect_ratio=decrease,` +
      `format=rgba,colorchannelmixer=aa=${overlay.opacity},setpts=PTS-STARTPTS[${label}]`)
    const next = `over${index}`
    let enable = ''
    if (overlay.startSeconds !== undefined || overlay.endSeconds !== undefined) {
      const start = overlay.startSeconds ?? 0
      enable = overlay.endSeconds !== undefined
        ? `:enable='between(t,${start},${overlay.endSeconds})'`
        : `:enable='gte(t,${start})'`
    }
    // Single-frame image inputs repeat their final frame; the main video determines
    // duration. No -loop or -shortest: short audio must not truncate the video.
    filters.push(`[${previous}][${label}]overlay=` +
      `x='${videoPosition(overlay, 'x', width)}':` +
      `y='${videoPosition(overlay, 'y', height)}':` +
      `eof_action=repeat:shortest=0${enable}[${next}]`)
    previous = next
  })
  // yuv420p requires even dimensions. Odd inputs gain at most one padding pixel.
  filters.push(`[${previous}]pad=ceil(iw/2)*2:ceil(ih/2)*2,setsar=1,format=yuv420p[outv]`)
  args.push('-filter_complex', filters.join(';'), '-map', '[outv]', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    // Existing probe exposes only hasAudio, not codec; AAC works for all MP4 inputs.
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-f', 'mp4', output)
  return args
}

/**
 * Input/output/tooling are trusted local server paths, not client configuration.
 * Only the media store may supply logo absolute paths. The caller must preserve
 * its original asset, save the new output and clean partial outputs on failure.
 */
export async function overlayLogoVideo(options: {
  input: string
  output: string
  overlays: ResolvedLogoOverlay[]
  mediaStore: Pick<MediaStore, 'absolutePath'>
  tooling: FfmpegTooling
  timeoutMs: number
}): Promise<VideoProbe> {
  const { input, output, overlays, mediaStore, tooling, timeoutMs } = options
  validateResolved(overlays)
  trustedLocalPath(input)
  trustedLocalPath(output)
  if (resolve(input) === resolve(output)) throw badRequest('Video kết quả phải khác video gốc')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3_600_000) {
    throw badRequest('Thời gian xử lý video phải từ 1 ms đến 1 giờ')
  }
  const deadline = Date.now() + timeoutMs
  const resolved = [] as Array<ResolvedLogoOverlay & { absolutePath: string }>
  for (const overlay of overlays) {
    const absolutePath = mediaStore.absolutePath(overlay.path)
    trustedLocalPath(absolutePath)
    const info = await stat(absolutePath)
    if (!info.isFile() || info.size > MAX_LOGO_BYTES) throw badRequest('Logo không hợp lệ hoặc vượt giới hạn 20 MB')
    // Do not feed SVG or a forged MIME into ffmpeg; bound image decoder pixels too.
    await raster(await readFile(absolutePath), overlay.mime)
    resolved.push({ ...overlay, absolutePath })
  }
  const probe = await probeVideo(tooling, input, Math.max(1, Math.min(30_000, deadline - Date.now())))
  if (!probe) throw badRequest('Không dò được kích thước video để ghép logo')
  const args = buildLogoVideoArgs(input, output, resolved, probe.width, probe.height)
  try {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('Hết thời gian xử lý video')
    await run(tooling.ffmpeg, args, { timeout: remaining, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 })
  } catch (error) {
    const detail = (error instanceof Error ? error.message : 'lỗi không xác định').slice(0, 500)
    throw providerError(`Ghép logo video thất bại: ${detail}`, undefined, errorMeta('exports.ffmpeg_failed', { detail }))
  }
  return { width: probe.width + probe.width % 2, height: probe.height + probe.height % 2, hasAudio: probe.hasAudio }
}
