import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { badRequest, errorMeta, providerError } from '../lib/errors'

const run = promisify(execFile)

/** Mã lỗi riêng để route trả hướng dẫn cài đặt thay vì lỗi chung. */
export const FFMPEG_MISSING = 'FFMPEG_MISSING'

export type FfmpegTooling = { ffmpeg: string; ffprobe: string | null }

/**
 * Tìm ffmpeg/ffprobe.
 *
 * `FFMPEG_PATH` được ưu tiên; nếu không đặt thì dựa vào PATH. Trả null khi không
 * có ffmpeg, để tầng trên báo lỗi rõ ràng thay vì thất bại khó hiểu.
 */
export async function resolveFfmpeg(
  configuredPath: string | undefined,
  timeoutMs = 10_000,
): Promise<FfmpegTooling | null> {
  const ffmpeg = (configuredPath ?? '').trim()

  if (ffmpeg) {
    if (!existsSync(ffmpeg)) return null
    const sibling = join(dirname(ffmpeg), 'ffprobe')
    return { ffmpeg, ffprobe: existsSync(sibling) ? sibling : null }
  }

  try {
    await run('ffmpeg', ['-version'], { timeout: timeoutMs })
  } catch {
    return null
  }

  let ffprobe: string | null = null
  try {
    await run('ffprobe', ['-version'], { timeout: timeoutMs })
    ffprobe = 'ffprobe'
  } catch {
    ffprobe = null
  }

  return { ffmpeg: 'ffmpeg', ffprobe }
}

export type VideoProbe = { width: number; height: number; hasAudio: boolean }

/** Đọc kích thước và sự tồn tại của luồng âm thanh. Trả null khi không dò được. */
export async function probeVideo(
  tooling: FfmpegTooling,
  path: string,
  timeoutMs: number,
): Promise<VideoProbe | null> {
  if (!tooling.ffprobe) return null

  try {
    const { stdout } = await run(
      tooling.ffprobe,
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height',
        '-of', 'csv=p=0',
        path,
      ],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
    )

    const [widthRaw, heightRaw] = stdout.trim().split(/[,\n]/)
    const width = Number(widthRaw)
    const height = Number(heightRaw)
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return null
    }

    let hasAudio = false
    try {
      const audio = await run(
        tooling.ffprobe,
        [
          '-v', 'error',
          '-select_streams', 'a',
          '-show_entries', 'stream=index',
          '-of', 'csv=p=0',
          path,
        ],
        { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      )
      hasAudio = audio.stdout.trim().length > 0
    } catch {
      hasAudio = false
    }

    return { width, height, hasAudio }
  } catch {
    return null
  }
}

/**
 * Ghép nhiều video thành một tệp duy nhất.
 *
 * Dùng `concat` filter (không phải concat demuxer) vì các cảnh do model sinh ra
 * thường khác codec/độ phân giải/fps. Mỗi đầu vào được chuẩn hoá về cùng khung
 * hình rồi mới nối, nên kết quả luôn phát được.
 *
 * Âm thanh: chỉ giữ khi MỌI cảnh đều có tiếng. Nếu chỉ một phần có tiếng thì xuất
 * video không tiếng — thà mất tiếng còn hơn lệch tiếng so với hình.
 */
export async function stitchVideos(options: {
  tooling: FfmpegTooling
  inputs: string[]
  output: string
  timeoutMs: number
}): Promise<{ width: number; height: number; hasAudio: boolean }> {
  const { tooling, inputs, output, timeoutMs } = options
  if (inputs.length === 0) throw badRequest('Không có cảnh nào để ghép')

  const probes = await Promise.all(inputs.map((path) => probeVideo(tooling, path, timeoutMs)))

  // Khung đích lấy theo cảnh đầu tiên dò được, mặc định 1280×720.
  const first = probes.find((probe): probe is VideoProbe => probe !== null)
  const width = first?.width ?? 1280
  const height = first?.height ?? 720
  // Chỉ giữ tiếng khi mọi cảnh đều có tiếng và dò được.
  const keepAudio = probes.length > 0 && probes.every((probe) => probe?.hasAudio === true)

  const args: string[] = ['-y']
  for (const path of inputs) args.push('-i', path)

  const normalize = (index: number, label: string) =>
    `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[${label}]`

  const chains: string[] = []
  for (let index = 0; index < inputs.length; index += 1) {
    chains.push(normalize(index, `v${index}`))
  }

  const videoInputs = inputs.map((_, index) => `[v${index}]`).join('')

  if (keepAudio) {
    // Chuẩn hoá âm thanh về cùng số kênh và tần số lấy mẫu trước khi nối.
    for (let index = 0; index < inputs.length; index += 1) {
      chains.push(`[${index}:a]aformat=sample_rates=48000:channel_layouts=stereo[a${index}]`)
    }
    const audioInputs = inputs.map((_, index) => `[a${index}]`).join('')
    chains.push(`${videoInputs}${audioInputs}concat=n=${inputs.length}:v=1:a=1[outv][outa]`)
    args.push(
      '-filter_complex', chains.join(';'),
      '-map', '[outv]', '-map', '[outa]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-c:a', 'aac', '-b:a', '160k',
      '-movflags', '+faststart',
      output,
    )
  } else {
    chains.push(`${videoInputs}concat=n=${inputs.length}:v=1:a=0[outv]`)
    args.push(
      '-filter_complex', chains.join(';'),
      '-map', '[outv]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-movflags', '+faststart',
      // Không có tiếng thì ghi rõ để trình phát không chờ luồng audio.
      '-an',
      output,
    )
  }

  try {
    await run(tooling.ffmpeg, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'lỗi không xác định'
    const detail = message.slice(0, 500)
    throw providerError(`Ghép video thất bại: ${detail}`, undefined, errorMeta('exports.ffmpeg_failed', { detail }))
  }

  return { width, height, hasAudio: keepAudio }
}
