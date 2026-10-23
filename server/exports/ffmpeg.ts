import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { badRequest, errorMeta, providerError } from '../lib/errors'
import { logger } from '../lib/logger'

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

type ExportVideoProbe = VideoProbe & { durationSeconds: number }

/** Export needs video duration as well as stream presence; logo probing keeps its existing contract. */
async function probeExportVideo(
  tooling: FfmpegTooling,
  path: string,
  index: number,
  timeoutMs: number,
): Promise<ExportVideoProbe> {
  try {
    const { stdout } = await run(tooling.ffprobe!, [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,width,height,duration:format=duration',
      '-of', 'json', path,
    ], { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 })
    const metadata = JSON.parse(stdout) as {
      streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }>
      format?: { duration?: string }
    }
    const video = metadata.streams?.find(stream => stream.codec_type === 'video')
    const width = Number(video?.width)
    const height = Number(video?.height)
    // Container duration can include a longer audio track. Prefer the video stream.
    const streamDuration = Number(video?.duration)
    const durationSeconds = Number.isFinite(streamDuration) && streamDuration > 0
      ? streamDuration : Number(metadata.format?.duration)
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
      || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error('Video stream has no usable dimensions or duration')
    }
    return { width, height, durationSeconds, hasAudio: metadata.streams!.some(stream => stream.codec_type === 'audio') }
  } catch (error) {
    logger.warn('Không đọc được video để xuất', { index: index + 1, path, message: error instanceof Error ? error.message : String(error) })
    throw badRequest(
      `Không đọc được video của cảnh thứ ${index + 1}. Hãy kiểm tra video cảnh đó rồi xuất lại.`,
      undefined, errorMeta('exports.video_unreadable', { index: index + 1 }),
    )
  }
}

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
 * Giữ tiếng của từng cảnh; thêm khoảng lặng khi một cảnh không có tiếng. Độ dài
 * âm thanh bám theo hình để tiếng không đẩy lùi cảnh tiếp theo.
 */
export async function stitchVideos(options: {
  tooling: FfmpegTooling
  inputs: string[]
  output: string
  timeoutMs: number
}): Promise<{ width: number; height: number; hasAudio: boolean }> {
  const { tooling, inputs, output, timeoutMs } = options
  if (inputs.length === 0) throw badRequest('Không có cảnh nào để ghép')
  if (!tooling.ffprobe) {
    throw providerError('Cần có cả ffmpeg và ffprobe trên máy chủ để xuất video.', undefined, errorMeta('exports.ffmpeg_missing'))
  }

  const deadline = Date.now() + timeoutMs
  const remainingMs = () => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw providerError('Xuất video vượt thời gian xử lý cho phép. Hãy thử lại hoặc xuất ít cảnh hơn.', undefined, errorMeta('exports.timeout'))
    }
    return remaining
  }
  const probes = await Promise.all(inputs.map((path, index) =>
    probeExportVideo(tooling, path, index, Math.min(30_000, remainingMs()))))

  // H.264/YUV420 needs even dimensions. A bad first clip must not silently change the canvas.
  const width = Math.ceil(probes[0]!.width / 2) * 2
  const height = Math.ceil(probes[0]!.height / 2) * 2
  const keepAudio = probes.some(probe => probe.hasAudio)

  const args: string[] = ['-y', '-nostdin', '-hide_banner', '-v', 'error']
  for (const path of inputs) args.push('-i', path)

  const chains: string[] = []
  for (const [index, probe] of probes.entries()) {
    // Align segment boundaries to the 30fps output, including fractional source durations.
    const duration = Math.max(1, Math.round(probe.durationSeconds * 30)) / 30
    chains.push(
      `[${index}:v:0]setpts=PTS-STARTPTS,` +
      `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,` +
      `tpad=stop_mode=clone:stop_duration=${1 / 30},trim=duration=${duration},format=yuv420p[v${index}]`,
    )
    if (keepAudio) {
      chains.push(probe.hasAudio
        ? `[${index}:a:0]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS,apad,atrim=duration=${duration}[a${index}]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${duration},asetpts=PTS-STARTPTS[a${index}]`)
    }
  }

  const concatInputs = inputs.map((_, index) => `[v${index}]${keepAudio ? `[a${index}]` : ''}`).join('')
  if (keepAudio) {
    chains.push(`${concatInputs}concat=n=${inputs.length}:v=1:a=1[outv][outa]`)
    args.push(
      '-filter_complex', chains.join(';'),
      '-map', '[outv]', '-map', '[outa]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart',
      output,
    )
  } else {
    chains.push(`${concatInputs}concat=n=${inputs.length}:v=1:a=0[outv]`)
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
    await run(tooling.ffmpeg, args, { timeout: remainingMs(), killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 })
  } catch (error) {
    logger.warn('FFmpeg ghép video thất bại', { message: error instanceof Error ? error.message : String(error) })
    remainingMs()
    throw providerError('Không thể ghép video. Hãy thử xuất lại hoặc liên hệ người quản lý ứng dụng.', undefined, errorMeta('exports.stitch_failed'))
  }

  return { width, height, hasAudio: keepAudio }
}
