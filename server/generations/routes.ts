import { Router } from 'express'
import type { AppEnv } from '../env'
import type { Database } from '../db/index'
import type { MediaStore } from '../media/store'
import { badRequest, notFound } from '../lib/errors'
import { clientIp, createRateLimiter } from '../lib/rateLimit'
import { requireUser } from '../auth/middleware'
import type { Worker } from './worker'
import type { GenerationRow } from './types'
import { enqueueGeneration, enqueueSchema } from './enqueue'
import { sceneGenerationContext } from '../projects/service'

export type AssetPublic = {
  id: string
  mimeType: string
  byteSize: number
  url: string
}

export type GenerationPublic = {
  id: string
  kind: 'image' | 'video'
  prompt: string
  projectId: string | null
  sceneId: string | null
  effectivePrompt: string
  promptSnapshot: unknown
  sourceImageCount: number
  status: GenerationRow['status']
  progress: number | null
  provider: string
  model: string
  params: Record<string, unknown>
  errorCode: string | null
  errorMessage: string | null
  providerJobId: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
  assets: AssetPublic[]
}

/**
 * Schema của một yêu cầu tạo nội dung.
 *
 * Định nghĩa nằm ở `enqueue.ts` để bộ quét cảnh và Trợ lý AI dùng chung đúng một
 * hợp đồng; ở đây giữ tên cũ để không phá vỡ chỗ đang import.
 */
export const createSchema = enqueueSchema

function toPublic(
  row: GenerationRow,
  assets: Array<{ id: string; mime_type: string; byte_size: number }>,
): GenerationPublic {
  return {
    id: row.id,
    kind: row.kind,
    prompt: row.prompt,
    projectId: row.project_id ?? null,
    sceneId: row.scene_id ?? null,
    effectivePrompt: row.effective_prompt ?? row.prompt,
    promptSnapshot: row.prompt_snapshot_json ? JSON.parse(row.prompt_snapshot_json) : null,
    sourceImageCount: row.source_images_json ? (JSON.parse(row.source_images_json) as unknown[]).length : 0,
    status: row.status,
    progress: row.progress,
    provider: row.snap_provider,
    model: row.snap_model_id,
    params: JSON.parse(row.params_json) as Record<string, unknown>,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    providerJobId: row.provider_job_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    assets: assets.map((asset) => ({
      id: asset.id,
      mimeType: asset.mime_type,
      byteSize: asset.byte_size,
      url: `/api/assets/${asset.id}`,
    })),
  }
}

export function generationRoutes(
  db: Database,
  env: AppEnv,
  mediaStore: MediaStore,
  worker: Worker,
): Router {
  const router = Router()

  // Giới hạn số lần tạo nội dung để tránh lạm dụng key của chính người dùng.
  const createLimiter = createRateLimiter({
    windowMs: 60_000,
    max: env.RATE_LIMIT_GENERATE_PER_MIN || Number.MAX_SAFE_INTEGER,
  })

  function assetsFor(generationId: string) {
    return db
      .prepare(
        'SELECT id, mime_type, byte_size FROM assets WHERE generation_id = ? ORDER BY created_at ASC',
      )
      .all(generationId) as unknown as Array<{ id: string; mime_type: string; byte_size: number }>
  }

  function ownedGeneration(userId: string, id: string): GenerationRow {
    const row = db
      .prepare('SELECT * FROM generations WHERE id = ? AND user_id = ?')
      .get(id, userId) as unknown as GenerationRow | undefined
    if (!row) throw notFound('Không tìm thấy tác vụ')
    return row
  }

  router.get('/', (req, res) => {
    const user = requireUser(req)

    const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined
    if (kind && kind !== 'image' && kind !== 'video') throw badRequest('Loại nội dung không hợp lệ')

    const limitRaw = Number(req.query.limit ?? 30)
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 100) : 30

    const params: Array<string | number> = [user.id]
    let sql = 'SELECT * FROM generations WHERE user_id = ?'
    if (kind) {
      sql += ' AND kind = ?'
      params.push(kind)
    }
    for (const [queryKey, column] of [['projectId', 'project_id'], ['sceneId', 'scene_id']] as const) {
      const value = req.query[queryKey]
      if (typeof value === 'string') { sql += ` AND ${column} = ?`; params.push(value) }
    }
    sql += ' ORDER BY created_at DESC LIMIT ?'
    params.push(limit)

    const rows = db.prepare(sql).all(...params) as unknown as GenerationRow[]
    res.json({ generations: rows.map((row) => toPublic(row, assetsFor(row.id))) })
  })

  const enqueue: import('express').RequestHandler = (req, res) => {
    const user = requireUser(req)

    if (!createLimiter.check(`generate:${user.id}`)) {
      throw badRequest('Bạn tạo quá nhanh. Vui lòng đợi một lát rồi thử lại.')
    }

    const sceneInput = req.params.sceneId ? sceneGenerationContext(db, user.id, String(req.params.sceneId)) : null
    const input = sceneInput ? {
      modelId: sceneInput.modelId, prompt: sceneInput.prompt, params: sceneInput.params,
      projectId: sceneInput.projectId, characterId: sceneInput.characterId ?? undefined,
      idempotencyKey: req.body?.idempotencyKey,
    } : req.body
    const parsed = createSchema.safeParse(input)
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Dữ liệu không hợp lệ')
    }

    const outcome = enqueueGeneration({
      db,
      env,
      worker,
      userId: user.id,
      request: {
        data: parsed.data,
        scene: sceneInput
          ? {
              id: sceneInput.scene.id,
              projectId: sceneInput.projectId,
              dialogue: sceneInput.dialogue,
              speakerId: sceneInput.characterId,
              castIds: sceneInput.castIds,
              background: sceneInput.background,
            }
          : null,
      },
    })

    // Tác vụ trả lại theo idempotencyKey giữ nguyên hợp đồng cũ: kèm asset đã có.
    const assets = outcome.reused ? assetsFor(outcome.generation.id) : []
    res
      .status(outcome.reused ? 200 : 202)
      .json({ generation: toPublic(outcome.generation, assets) })
  }
  router.post('/', enqueue)
  router.post('/scenes/:sceneId/generate', enqueue)

  router.get('/:id', (req, res) => {
    const user = requireUser(req)
    const row = ownedGeneration(user.id, req.params.id)
    res.json({ generation: toPublic(row, assetsFor(row.id)) })
  })

  /**
   * Thử tải lại media khi tạo thành công nhưng bước tải thất bại.
   * Không bao giờ tạo job mới ở provider.
   */
  router.post('/:id/retry-download', (req, res) => {
    const user = requireUser(req)
    const row = ownedGeneration(user.id, req.params.id)

    if (!row.provider_job_id) {
      throw badRequest('Tác vụ này không có ID job ở provider để tải lại')
    }
    if (row.status === 'succeeded') {
      throw badRequest('Tác vụ đã hoàn tất, không cần tải lại')
    }

    db.prepare(
      "UPDATE generations SET status = 'running', next_poll_at = NULL, error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?",
    ).run(Date.now(), row.id)

    const updated = ownedGeneration(user.id, row.id)
    worker.wake()
    res.json({ generation: toPublic(updated, assetsFor(updated.id)) })
  })

  router.delete('/:id', (req, res) => {
    const user = requireUser(req)
    const row = ownedGeneration(user.id, req.params.id)

    if (['queued', 'running', 'downloading'].includes(row.status)) {
      throw badRequest('Tác vụ đang chạy, không thể xóa. Hãy đợi hoàn tất.')
    }

    // Xóa file media trước, sau đó xóa bản ghi (assets sẽ cascade theo).
    mediaStore.removeGenerationDir(row.user_id, row.id)
    db.prepare('DELETE FROM generations WHERE id = ? AND user_id = ?').run(row.id, user.id)
    res.status(204).end()
  })

  return router
}

/** Đếm số ký tự IP cho rate limit ở tầng ngoài nếu cần. */
export { clientIp }
