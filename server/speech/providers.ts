import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import type { Database } from '../db/index'
import type { AppEnv } from '../env'
import { requireUser } from '../auth/middleware'
import { errorMeta, notFound, providerError, tooManyRequests, validationError } from '../lib/errors'
import { createRateLimiter } from '../lib/rateLimit'
import { callProvider, readProviderError } from '../providers/client'
import { readWithPool, selectPoolTarget } from '../providers/pool'
import { speechTransaction } from './idempotency'

export function speechProviderRoutes(db: Database, env: AppEnv): Router {
  const router = Router()
  const limiter = createRateLimiter({ windowMs: 60_000, max: 20 })
  router.post('/:id/sync-speech-models', async (req, res) => {
    const user = requireUser(req)
    const provider = db.prepare('SELECT id FROM provider_connections WHERE id=? AND user_id=?').get(req.params.id, user.id) as { id: string } | undefined
    if (!provider) throw notFound('Không tìm thấy provider')
    const parsed = z.object({ catalog: z.enum(['models', 'edge-tts']).default('edge-tts') }).strict().safeParse(req.body ?? {})
    if (!parsed.success) throw validationError(parsed.error)
    if (!limiter.check(user.id)) throw tooManyRequests()
    let entries: Array<Record<string, unknown>>
    if (env.PROVIDER_MODE === 'mock') {
      entries = [
        { id: 'vi-VN-NamMinhNeural', name: 'Nam Minh · vi-VN', model: 'edge-tts/vi-VN-NamMinhNeural' },
        { id: 'vi-VN-HoaiMyNeural', name: 'Hoài My · vi-VN', model: 'edge-tts/vi-VN-HoaiMyNeural' },
      ]
    } else {
      const path = parsed.data.catalog === 'edge-tts' ? 'audio/voices?provider=edge-tts' : 'models'
      const initial = selectPoolTarget(db, env, provider.id, { advance: false })
      // Some gateways proxy voice discovery through a dashboard login. A 401
      // there must not disable a key that still works for paid speech requests.
      const outcome = parsed.data.catalog === 'edge-tts'
        ? { response: await callProvider(initial, path, { timeoutMs: 20_000 }), target: initial }
        : await readWithPool({ db, env, providerId: provider.id, initial, call: target => callProvider(target, path, { timeoutMs: 20_000 }) })
      if (!outcome.response.ok) {
        const detail = await readProviderError(outcome.response, [outcome.target.apiKey])
        throw providerError('Không lấy được danh sách giọng', { status: outcome.response.status }, errorMeta('speech.catalog_failed', { detail }))
      }
      const payload = await outcome.response.json() as { data?: unknown }
      if (!Array.isArray(payload.data)) throw providerError('Danh sách giọng không hợp lệ', undefined, errorMeta('speech.catalog_failed', { detail: 'Invalid model list' }))
      entries = payload.data.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    }
    let added = 0
    let skipped = 0
    speechTransaction(db, () => {
      for (const item of entries) {
        const id = typeof item.model === 'string' ? item.model : typeof item.id === 'string' ? item.id : ''
        if (!id || id.length > 200) continue
        const capability = item.capabilities as { audioOutput?: boolean } | undefined
        if (parsed.data.catalog === 'models' && env.PROVIDER_MODE !== 'mock'
          && item.kind !== 'tts' && item.type !== 'tts' && item.object !== 'voice'
          && !/tts|speech|neural$/i.test(id) && !capability?.audioOutput) continue
        const name = typeof item.name === 'string' ? item.name : typeof item.display_name === 'string' ? item.display_name : id
        const now = Date.now()
        const result = db.prepare(`INSERT INTO models(id,user_id,provider_id,model_id,display_name,kind,enabled,created_at,updated_at,video_api_style)
          VALUES(?,?,?,?,?,'tts',1,?,?,'openai') ON CONFLICT(provider_id,model_id) DO UPDATE SET kind='tts',updated_at=excluded.updated_at WHERE models.kind='unclassified'`)
          .run(randomUUID(), user.id, provider.id, id, name.slice(0, 200), now, now)
        if (Number(result.changes)) added += 1
        else skipped += 1
      }
    })
    res.json({ added, skipped, total: added + skipped })
  })
  return router
}
