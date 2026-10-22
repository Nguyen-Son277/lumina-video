import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import type { Database } from '../db/index'
import type { AppEnv } from '../env'
import type { MediaStore } from '../media/store'
import type { Worker } from '../generations/worker'
import type { GenerationRow } from '../generations/types'
import { enqueueGeneration } from '../generations/enqueue'
import { generationPublic } from '../generations/routes'
import { requireUser } from '../auth/middleware'
import { badRequest, notFound, validationError, tooManyRequests } from '../lib/errors'
import { createRateLimiter, clientIp } from '../lib/rateLimit'
import { parseEditorRequest, sourceSchema } from './schema'
import { prepareEditorSource, resolveEditorSource } from './sources'
import { buildEditorWork, editorCapabilities, validateEditorModel, type EditorInternal } from './service'

export function createImageEditorRouter(db: Database, env: AppEnv, store: MediaStore, worker: Worker): Router {
  const router = Router()
  const limiter = createRateLimiter({ windowMs: 60_000, max: env.RATE_LIMIT_GENERATE_PER_MIN || Number.MAX_SAFE_INTEGER })
  const prepareSchema = z.object({ source: sourceSchema }).strict()

  function publicJob(row: GenerationRow) {
    const assets = db.prepare('SELECT id, mime_type, byte_size, variant, source_asset_id FROM assets WHERE generation_id = ? ORDER BY created_at')
      .all(row.id) as unknown as Parameters<typeof generationPublic>[1]
    return generationPublic(row, assets, db)
  }

  /** Tác vụ cũ theo idempotencyKey; null khi chưa có. */
  function existingJob(userId: string, idempotencyKey: string): GenerationRow | undefined {
    return db.prepare('SELECT * FROM generations WHERE user_id = ? AND idempotency_key = ?').get(userId, idempotencyKey) as GenerationRow | undefined
  }

  router.get('/capabilities', async (req, res) => {
    res.json(await editorCapabilities(db, env, requireUser(req).id))
  })

  router.post('/sources', async (req, res) => {
    const user = requireUser(req)
    if (!limiter.check(`${user.id}:${clientIp(req)}`)) throw tooManyRequests()
    const parsed = prepareSchema.safeParse(req.body)
    if (!parsed.success) throw validationError(parsed.error)
    res.status(201).json({ source: await prepareEditorSource(db, env, store, user.id, parsed.data.source) })
  })

  router.post('/preview', async (req, res) => {
    const user = requireUser(req)
    if (!limiter.check(`${user.id}:${clientIp(req)}`)) throw tooManyRequests()
    const request = parseEditorRequest(req.body)
    // Preview dùng ĐÚNG bước kiểm tra của lúc gửi để không hứa hở.
    const { promptDirected } = validateEditorModel(db, user.id, request)
    const prepared = await prepareEditorSource(db, env, store, user.id, request.source)
    const { preview } = buildEditorWork(request, prepared.width, prepared.height, { promptDirected, firstFrameOnly: prepared.firstFrameOnly })
    res.json(preview)
  })

  router.post('/jobs', async (req, res) => {
    const user = requireUser(req)
    if (!limiter.check(`${user.id}:${clientIp(req)}`)) throw tooManyRequests()
    const request = parseEditorRequest(req.body)
    // Kiểm tra idempotency TRƯỚC khi chuẩn bị nguồn (tránh làm việc thừa).
    if (request.idempotencyKey) {
      const row = existingJob(user.id, request.idempotencyKey)
      if (row) {
        if (row.deleted_at != null || !row.image_editor_json) throw badRequest('Khoá idempotency đã được dùng cho tác vụ khác')
        res.json({ generation: publicJob(row), reused: true })
        return
      }
    }
    const { promptDirected, maskSupported } = validateEditorModel(db, user.id, request)
    const prepared = await prepareEditorSource(db, env, store, user.id, request.source)
    // Kiểm tra idempotency LẦN NỮA sau khi chuẩn bị: hai POST song song có thể
    // cùng đi qua lần kiểm tra đầu, và chỉ một tác vụ được tạo.
    if (request.idempotencyKey) {
      const row = existingJob(user.id, request.idempotencyKey)
      if (row) {
        if (row.deleted_at != null || !row.image_editor_json) throw badRequest('Khoá idempotency đã được dùng cho tác vụ khác')
        res.json({ generation: publicJob(row), reused: true })
        return
      }
    }
    const resolved = resolveEditorSource(db, user.id, { kind: 'upload', id: prepared.uploadId })
    const work = buildEditorWork(request, prepared.width, prepared.height, { promptDirected, firstFrameOnly: prepared.firstFrameOnly })
    const internal: EditorInternal = {
      request: { ...request, source: { kind: 'upload', id: prepared.uploadId } },
      sourcePath: resolved.path,
      retainedSource: resolved.retained,
      width: prepared.width,
      height: prepared.height,
      promptDirected,
      maskSupported,
      snapshot: {
        source: prepared.lineage,
        preparedUploadId: prepared.uploadId,
        width: prepared.width,
        height: prepared.height,
        operation: request.operation,
        engine: request.engine,
        ...(request.regions ? { regions: request.regions } : {}),
        ...(request.frame ? { frame: request.frame } : {}),
        ...(request.background ? { background: request.background } : {}),
        ...(promptDirected ? { promptDirected: true } : {}),
        ...(prepared.firstFrameOnly ? { firstFrameOnly: true } : {}),
      },
    }
    let row: GenerationRow
    if (request.engine === 'provider') {
      const result = enqueueGeneration({
        db, env, worker, mediaStore: store, userId: user.id,
        request: {
          imageEditor: internal,
          data: {
            modelId: request.modelId!,
            prompt: work.preview.prompt,
            params: {
              size: `${work.width}x${work.height}`,
              n: 1,
              useCharacterReference: false,
              ...(request.background?.mode === 'remove' ? { background: 'transparent' } : {}),
            },
            sourceUploadIds: [prepared.uploadId],
            idempotencyKey: request.idempotencyKey,
          },
        },
      })
      row = result.generation
    } else {
      if (request.operation === 'background' && !env.BACKGROUND_REMOVAL_URL) throw badRequest('Chưa cấu hình dịch vụ xoá nền cục bộ')
      const active = db.prepare("SELECT COUNT(*) AS n FROM generations WHERE user_id = ? AND deleted_at IS NULL AND status IN ('queued','running','downloading')").get(user.id) as { n: number }
      if (active.n >= env.MAX_CONCURRENT_JOBS_PER_USER) throw badRequest('Bạn đang có quá nhiều tác vụ đang chạy. Hãy đợi hoàn tất rồi tạo thêm.')
      const id = randomUUID()
      const now = Date.now()
      db.prepare(`INSERT INTO generations (id,user_id,kind,prompt,effective_prompt,params_json,snap_provider,snap_base_url,snap_model_id,status,created_at,updated_at,idempotency_key,source_images_json,image_editor_json)
        VALUES (?,?,'image',?,?,'{}','Local image editor','','local','queued',?,?,?,?,?)`).run(
        id, user.id, work.preview.prompt, work.preview.prompt, now, now,
        request.idempotencyKey ?? null, JSON.stringify([{ path: resolved.path, mime: 'image/png' }]), JSON.stringify(internal),
      )
      row = db.prepare('SELECT * FROM generations WHERE id = ?').get(id) as GenerationRow
      worker.wake()
    }
    res.status(201).json({ generation: publicJob(row), reused: false })
  })

  router.get('/jobs/:id', (req, res) => {
    const user = requireUser(req)
    const row = db.prepare('SELECT * FROM generations WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND image_editor_json IS NOT NULL').get(req.params.id, user.id) as GenerationRow | undefined
    if (!row) throw notFound('Không tìm thấy tác vụ chỉnh sửa ảnh')
    res.json({ generation: publicJob(row) })
  })

  return router
}

export const imageEditorRoutes = createImageEditorRouter
