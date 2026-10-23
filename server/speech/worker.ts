import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Database } from '../db/index'
import type { AppEnv } from '../env'
import type { MediaStore } from '../media/store'
import { AppError, errorMeta, insufficientStorage, isUncertain, providerError, uncertainOutcome } from '../lib/errors'
import { logger } from '../lib/logger'
import { resolveFfmpeg } from '../exports/ffmpeg'
import { callProvider, redactSecrets } from '../providers/client'
import { selectPoolTarget, submitWithPool } from '../providers/pool'
import { readSpeechBytes, readSpeechError, probeSpeech } from './audio'
import type { SpeechRow } from './service'

const run = promisify(execFile)
export type SpeechWorker = {
  start: () => void
  stop: () => Promise<void>
  tick: () => Promise<void>
  wake: () => void
}

export function recoverSpeechJobs(db: Database, mediaStore: MediaStore): void {
  const rows = db.prepare("SELECT * FROM speech_jobs WHERE status='running'").all() as SpeechRow[]
  for (const row of rows) {
    if (row.relative_path && row.duration_seconds && mediaStore.exists(row.relative_path)) {
      db.prepare("UPDATE speech_jobs SET status='succeeded',completed_at=?,updated_at=? WHERE id=?").run(Date.now(), Date.now(), row.id)
    } else {
      db.prepare(`UPDATE speech_jobs SET status='unknown',error_code='INTERRUPTED',error_message=?,error_message_key='speech.interrupted',completed_at=?,updated_at=? WHERE id=?`)
        .run('Tác vụ giọng đọc bị gián đoạn. Hệ thống không tự gửi lại yêu cầu.', Date.now(), Date.now(), row.id)
    }
  }
}

export function createSpeechWorker({ db, env, mediaStore, onComplete }: {
  db: Database
  env: AppEnv
  mediaStore: MediaStore
  onComplete?: () => void
}): SpeechWorker {
  let timer: ReturnType<typeof setInterval> | undefined
  let current: Promise<void> | undefined
  let stopped = false

  async function processNext(): Promise<void> {
    const row = db.prepare(`SELECT s.* FROM speech_jobs s
      LEFT JOIN projects p ON p.id=s.project_id
      WHERE s.status='queued' AND (s.project_id IS NULL OR p.deleted_at IS NULL)
      ORDER BY s.created_at,s.id LIMIT 1`).get() as SpeechRow | undefined
    if (!row) return
    const claimed = db.prepare("UPDATE speech_jobs SET status='running',updated_at=? WHERE id=? AND status='queued'").run(Date.now(), row.id)
    if (Number(claimed.changes) !== 1) return
    let directory: string | undefined
    let submitted = false
    const secrets: string[] = []
    try {
      const tooling = await resolveFfmpeg(env.FFMPEG_PATH)
      if (!tooling?.ffprobe) throw new AppError(502, 'FFMPEG_MISSING', 'Cần cài cả ffmpeg và ffprobe.', undefined, errorMeta('exports.ffmpeg_missing'))
      if (!row.provider_id) throw providerError('Provider không còn tồn tại')
      if (mediaStore.userUsageBytes(db, row.user_id) >= env.MAX_USER_MEDIA_BYTES) throw insufficientStorage('Đã hết dung lượng lưu trữ')
      directory = await mkdtemp(join(tmpdir(), 'lumina-speech-'))
      const path = join(directory, 'speech.mp3')
      let bytes: Uint8Array
      if (env.PROVIDER_MODE === 'mock') {
        await run(tooling.ffmpeg, ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=0.5', '-c:a', 'libmp3lame', '-q:a', '5', path], { timeout: 15_000 })
        bytes = new Uint8Array(await readFile(path))
      } else {
        const deadline = Date.now() + env.TTS_REQUEST_TIMEOUT_MS
        const initial = selectPoolTarget(db, env, row.provider_id, { baseUrlOverride: row.snap_base_url })
        const outcome = await submitWithPool({
          db, env, providerId: row.provider_id, initial,
          onAttempt(target) {
            secrets.push(target.apiKey)
            db.prepare('UPDATE speech_jobs SET credential_id=?,snap_credential_hint=?,snap_credential_base_url=?,updated_at=? WHERE id=?')
              .run(target.credentialId, target.keyHint, target.baseUrl, Date.now(), row.id)
          },
          call(target) {
            submitted = true
            return callProvider(target, 'audio/speech', {
              method: 'POST', body: { model: row.snap_model_id, input: row.input },
              headers: { Accept: 'audio/mpeg, audio/mp3' },
              timeoutMs: Math.max(1, deadline - Date.now()),
            })
          },
        })
        if (!outcome.response.ok) {
          const detail = await readSpeechError(outcome.response, secrets, deadline)
          if (outcome.response.status >= 500) throw uncertainOutcome(detail, undefined, errorMeta('speech.failed', { detail }))
          throw providerError(detail, undefined, errorMeta('speech.failed', { detail }))
        }
        bytes = await readSpeechBytes(outcome.response, env.MAX_AUDIO_BYTES, deadline)
        await writeFile(path, bytes)
      }
      const duration = await probeSpeech(tooling, path)
      if (mediaStore.userUsageBytes(db, row.user_id) + bytes.byteLength > env.MAX_USER_MEDIA_BYTES) throw insufficientStorage('Đã hết dung lượng lưu trữ')
      const saved = mediaStore.saveSpeech({ userId: row.user_id, speechId: row.id, bytes, maxBytes: env.MAX_AUDIO_BYTES })
      db.prepare(`UPDATE speech_jobs SET status='succeeded',relative_path=?,mime_type=?,byte_size=?,duration_seconds=?,completed_at=?,updated_at=? WHERE id=?`)
        .run(saved.relativePath, saved.mimeType, saved.byteSize, duration, Date.now(), Date.now(), row.id)
    } catch (error) {
      const unknown = isUncertain(error) || (submitted && !(error instanceof AppError))
      const message = redactSecrets(error instanceof Error ? error.message : 'Speech generation failed', secrets).slice(0, 500)
      const key = error instanceof AppError ? error.messageKey : unknown ? 'speech.interrupted' : 'speech.failed'
      const params = error instanceof AppError ? error.messageParams : { detail: message }
      db.prepare(`UPDATE speech_jobs SET status=?,error_code=?,error_message=?,error_message_key=?,error_message_params=?,completed_at=?,updated_at=? WHERE id=?`)
        .run(unknown ? 'unknown' : 'failed', error instanceof AppError ? error.code : 'SPEECH_FAILED', message, key, JSON.stringify(params), Date.now(), Date.now(), row.id)
      logger.warn('TTS failed', { id: row.id, status: unknown ? 'unknown' : 'failed', message })
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true })
      onComplete?.()
    }
  }

  function tick(): Promise<void> {
    if (stopped) return Promise.resolve()
    if (current) return current
    current = processNext().catch(error => logger.error('Speech worker failed', error)).finally(() => { current = undefined })
    return current
  }

  return {
    start() {
      if (timer) return
      stopped = false
      recoverSpeechJobs(db, mediaStore)
      timer = setInterval(() => void tick(), 1000)
      void tick()
    },
    async stop() {
      stopped = true
      if (timer) clearInterval(timer)
      timer = undefined
      await current
    },
    tick,
    wake() {
      if (!stopped) void tick()
    },
  }
}
