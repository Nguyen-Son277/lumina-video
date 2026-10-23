import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readProviderError, type ProviderResponse } from '../providers/client'
import { errorMeta, insufficientStorage, isUncertain, providerIncompatible, uncertainOutcome } from '../lib/errors'
import type { FfmpegTooling } from '../exports/ffmpeg'

const run = promisify(execFile)

export async function readSpeechError(response: ProviderResponse, secrets: string[], deadline: number): Promise<string> {
  try {
    const bytes = await readSpeechBytes(response, 16 * 1024, deadline)
    return await readProviderError({ ...response, text: async () => new TextDecoder().decode(bytes) }, secrets)
  } catch (error) {
    if (isUncertain(error)) throw error
    return `Provider HTTP ${response.status}`
  }
}

export async function readSpeechBytes(response: ProviderResponse, maxBytes: number, deadline: number): Promise<Uint8Array> {
  if (!response.body) throw providerIncompatible('Provider không trả về tệp âm thanh MP3 hợp lệ.', undefined, errorMeta('speech.invalid_audio'))
  const declaredSize = Number(response.headers.get('content-length'))
  const reader = response.body.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    if (declaredSize > maxBytes) throw insufficientStorage('Âm thanh vượt giới hạn cho phép', errorMeta('speech.too_large', { maxMb: Math.round(maxBytes / 1024 / 1024) }))
    const read = async () => {
      const chunks: Uint8Array[] = []
      let total = 0
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        total += chunk.value.byteLength
        if (total > maxBytes) throw insufficientStorage('Âm thanh vượt giới hạn cho phép', errorMeta('speech.too_large', { maxMb: Math.round(maxBytes / 1024 / 1024) }))
        chunks.push(chunk.value)
      }
      return new Uint8Array(Buffer.concat(chunks, total))
    }
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(uncertainOutcome('Tác vụ giọng đọc bị gián đoạn.', undefined, errorMeta('speech.interrupted')))
        void reader.cancel().catch(() => undefined)
      }, Math.max(1, deadline - Date.now()))
    })
    return await Promise.race([read(), timeout])
  } finally {
    if (timer) clearTimeout(timer)
    await reader.cancel().catch(() => undefined)
  }
}

export async function probeSpeech(tooling: FfmpegTooling, path: string): Promise<number> {
  if (!tooling.ffprobe) throw new Error('ffprobe is required')
  try {
    const { stdout } = await run(tooling.ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name:format=format_name,duration', '-of', 'json', path], { timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 })
    const metadata = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string; codec_name?: string }>; format?: { format_name?: string; duration?: string } }
    const seconds = Number(metadata.format?.duration)
    if (metadata.format?.format_name !== 'mp3' || !metadata.streams?.some(stream => stream.codec_type === 'audio' && stream.codec_name === 'mp3')
      || metadata.streams.some(stream => stream.codec_type === 'video') || !Number.isFinite(seconds) || seconds <= 0) throw new Error('Invalid MP3')
    return seconds
  } catch {
    throw providerIncompatible('Provider không trả về tệp âm thanh MP3 hợp lệ.', undefined, errorMeta('speech.invalid_audio'))
  }
}
