import { Router } from 'express'
import { z } from 'zod'
import type { Database } from '../db/index'
import type { AppEnv } from '../env'
import type { MediaStore } from '../media/store'
import { requireUser } from '../auth/middleware'
import { conflict, errorMeta, notFound, tooManyRequests, validationError } from '../lib/errors'
import { createRateLimiter } from '../lib/rateLimit'
import { defaultNarrationPreferences, narrationPreferencesSchema, speechInputSchema, speechScopeSchema } from '../../shared/speech'
import { createSpeechJob, ownedSpeech, requireSpeechScope, speechInUse, speechPublic, type SpeechRow } from './service'
import { rememberRequest, replayRequest, requestHash, requestKey, speechTransaction } from './idempotency'
import type { SpeechWorker } from './worker'

export function speechRoutes(db: Database, env: AppEnv, mediaStore: MediaStore, worker?: SpeechWorker): Router {
  const router = Router()
  const limiter = createRateLimiter({ windowMs: 60_000, max: env.RATE_LIMIT_GENERATE_PER_MIN })

  router.get('/preferences', (req, res) => {
    const user = requireUser(req)
    const parsed = speechScopeSchema.safeParse(req.query)
    if (!parsed.success) throw validationError(parsed.error)
    const scope = requireSpeechScope(db, user.id, parsed.data)
    const row = db.prepare('SELECT preferences_json FROM narration_preferences WHERE user_id=? AND scope=?').get(user.id, scope) as { preferences_json: string } | undefined
    const preferences = row ? narrationPreferencesSchema.parse(JSON.parse(row.preferences_json)) : defaultNarrationPreferences()
    if (preferences.modelId && !db.prepare("SELECT id FROM models WHERE id=? AND user_id=? AND kind='tts'").get(preferences.modelId,user.id)) preferences.modelId = null
    res.json({ preferences })
  })

  router.put('/preferences', (req, res) => {
    const user = requireUser(req)
    const parsed = z.object({ scope: speechScopeSchema, preferences: narrationPreferencesSchema }).strict().safeParse(req.body)
    if (!parsed.success) throw validationError(parsed.error)
    const scope = requireSpeechScope(db, user.id, parsed.data.scope, true)
    if (parsed.data.preferences.modelId && !db.prepare("SELECT id FROM models WHERE id=? AND user_id=? AND kind='tts'").get(parsed.data.preferences.modelId, user.id)) {
      throw notFound('Hãy chọn model giọng nói đang bật.', errorMeta('speech.model_required'))
    }
    db.prepare(`INSERT INTO narration_preferences(user_id,scope,preferences_json,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(user_id,scope) DO UPDATE SET preferences_json=excluded.preferences_json,updated_at=excluded.updated_at`)
      .run(user.id, scope, JSON.stringify(parsed.data.preferences), Date.now())
    res.json({ preferences: parsed.data.preferences })
  })

  router.post('/', (req, res) => {
    const user = requireUser(req)
    const parsed = speechInputSchema.safeParse(req.body)
    if (!parsed.success) throw validationError(parsed.error)
    const key = requestKey(req)
    const hash = requestHash(parsed.data)
    const replay = replayRequest(db, user.id, 'speech', key, hash)
    if (replay) {
      res.status(202).json({ job: speechPublic(ownedSpeech(db, user.id, replay)) })
      return
    }
    if (env.RATE_LIMIT_GENERATE_PER_MIN && !limiter.check(user.id)) throw tooManyRequests()
    const row = speechTransaction(db, () => {
      const created = createSpeechJob(db, env, mediaStore, user.id, parsed.data)
      rememberRequest(db, user.id, 'speech', key, hash, created.id)
      return created
    })
    res.status(202).json({ job: speechPublic(row) })
    worker?.wake()
  })

  router.get('/', (req, res) => {
    const user = requireUser(req)
    const parsed = z.object({ projectId: z.string().min(1).optional(), quickSessionId: z.string().min(1).optional(), limit: z.coerce.number().int().min(1).max(100).default(30), offset: z.coerce.number().int().min(0).default(0) }).strict().safeParse(req.query)
    if (!parsed.success) throw validationError(parsed.error)
    const scope = speechScopeSchema.safeParse({ projectId: parsed.data.projectId, quickSessionId: parsed.data.quickSessionId })
    if (!scope.success) throw validationError(scope.error)
    requireSpeechScope(db, user.id, scope.data)
    const rows = db.prepare(`SELECT * FROM speech_jobs WHERE user_id=? AND (? IS NULL OR project_id=?) AND (? IS NULL OR quick_session_id=?) ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`)
      .all(user.id, scope.data.projectId ?? null, scope.data.projectId ?? null, scope.data.quickSessionId ?? null, scope.data.quickSessionId ?? null, parsed.data.limit, parsed.data.offset) as SpeechRow[]
    res.json({ jobs: rows.map(speechPublic) })
  })

  router.get('/:id', (req, res) => {
    const user = requireUser(req)
    res.json({ job: speechPublic(ownedSpeech(db, user.id, req.params.id)) })
  })

  router.get('/:id/file', (req, res) => {
    const user = requireUser(req)
    const row = ownedSpeech(db, user.id, req.params.id)
    if (row.status !== 'succeeded' || !row.relative_path || !mediaStore.exists(row.relative_path)) throw notFound('Không tìm thấy bản giọng đọc.', errorMeta('speech.not_found'))
    const size = mediaStore.stat(row.relative_path).size
    res.setHeader('Content-Type', 'audio/mpeg')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate')
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${row.id}.mp3"`)
    const range = req.headers.range
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range)
      const first = match?.[1] ?? ''
      const last = match?.[2] ?? ''
      const suffix = !first && last ? Number(last) : undefined
      const start = suffix !== undefined ? Math.max(0, size - suffix) : Number(first || 0)
      const end = first && last ? Math.min(Number(last), size - 1) : size - 1
      if (!match || (!first && !last) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end || (suffix !== undefined && (!Number.isSafeInteger(suffix) || suffix <= 0))) {
        res.status(416).setHeader('Content-Range', `bytes */${size}`).end()
        return
      }
      res.status(206)
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
      res.setHeader('Content-Length', String(end - start + 1))
      mediaStore.openReadStream(row.relative_path, { start, end }).pipe(res)
      return
    }
    res.setHeader('Content-Length', String(size))
    mediaStore.openReadStream(row.relative_path).pipe(res)
  })

  router.delete('/:id', (req, res) => {
    const user = requireUser(req)
    const row = ownedSpeech(db, user.id, req.params.id)
    if (row.status === 'running' || speechInUse(db, row.id)) throw conflict('Bản giọng đọc đang chạy hoặc đang được dùng để xuất video.', errorMeta('speech.in_use'))
    speechTransaction(db, () => {
      db.prepare('UPDATE exports SET speech_job_id=NULL WHERE speech_job_id=?').run(row.id)
      db.prepare('DELETE FROM speech_jobs WHERE id=? AND user_id=?').run(row.id, user.id)
    })
    mediaStore.removeSpeech(user.id, row.id)
    res.status(204).end()
  })
  return router
}
