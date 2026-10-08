import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import type { AppEnv } from '../env'
import type { Database } from '../db/index'
import type { MediaStore } from '../media/store'
import { badRequest, notFound } from '../lib/errors'
import { clientIp, createRateLimiter } from '../lib/rateLimit'
import { requireUser } from '../auth/middleware'
import type { Worker } from './worker'
import type { GenerationRow } from './types'
import type { SourceImage } from './adapters/image'
import { composeForContext } from './promptComposer'
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

export const createSchema = z.object({
  projectId: z.string().optional(),
  characterId: z.string().optional(),
  modelId: z.string().min(1, 'Vui lòng chọn model'),
  prompt: z.string().trim().min(1, 'Vui lòng nhập mô tả').max(8000),
  params: z
    .object({
      size: z.string().max(50).optional(),
      quality: z.string().max(50).optional(),
      seconds: z.union([z.string().max(10), z.number()]).optional(),
      n: z.number().int().min(1).max(4).optional(),
      background: z.string().max(50).optional(),
    })
    .default({}),
  idempotencyKey: z.string().max(100).optional(),
  /** Id ảnh nguồn đã tải lên trước đó, dùng để tạo ảnh mới từ ảnh đó. */
  sourceUploadIds: z.array(z.string().min(1)).max(16).optional(),
})

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

    const { modelId, prompt, params, idempotencyKey, sourceUploadIds } = parsed.data

    if (prompt.length > env.MAX_PROMPT_LENGTH) {
      throw badRequest(`Mô tả tối đa ${env.MAX_PROMPT_LENGTH} ký tự`)
    }

    // Ảnh nguồn phải thuộc đúng người dùng; lưu snapshot đường dẫn ngay lúc tạo
    // để tác vụ không phụ thuộc việc ảnh nguồn còn tồn tại hay không.
    const sourceImages: SourceImage[] = []
    if (sourceUploadIds?.length) {
      if (sourceUploadIds.length > env.MAX_SOURCE_IMAGES) {
        throw badRequest(`Tối đa ${env.MAX_SOURCE_IMAGES} ảnh nguồn cho một lần tạo`)
      }
      for (const uploadId of sourceUploadIds) {
        const row = db
          .prepare(
            'SELECT relative_path AS path, mime_type AS mime FROM uploads WHERE id = ? AND user_id = ?',
          )
          .get(uploadId, user.id) as { path: string; mime: string } | undefined
        if (!row) throw badRequest('Ảnh nguồn không tồn tại hoặc không thuộc tài khoản của bạn')
        sourceImages.push({ path: row.path, mime: row.mime })
      }
    }

    // Chống gửi trùng: nếu cùng idempotencyKey đã có tác vụ thì trả lại tác vụ đó.
    if (idempotencyKey) {
      const existing = db
        .prepare('SELECT * FROM generations WHERE user_id = ? AND idempotency_key = ?')
        .get(user.id, idempotencyKey) as unknown as GenerationRow | undefined
      if (existing) {
        res.status(200).json({ generation: toPublic(existing, assetsFor(existing.id)) })
        return
      }
    }

    // Model phải thuộc người dùng và đã được phân loại ảnh/video.
    const model = db
      .prepare(
        `SELECT m.id, m.model_id AS modelId, m.kind, m.enabled,
                p.id AS providerId, p.name AS providerName, p.base_url AS baseUrl
         FROM models m
         JOIN provider_connections p ON p.id = m.provider_id
         WHERE m.id = ? AND m.user_id = ?`,
      )
      .get(modelId, user.id) as
      | {
          id: string
          modelId: string
          kind: string
          enabled: number
          providerId: string
          providerName: string
          baseUrl: string
        }
      | undefined

    if (!model) throw badRequest('Model không tồn tại hoặc không thuộc tài khoản của bạn')
    if (model.enabled !== 1) throw badRequest('Model này đang bị tắt')
    if (model.kind !== 'image' && model.kind !== 'video') {
      throw badRequest(
        'Model này chưa được phân loại. Hãy đặt thành Tạo ảnh hoặc Tạo video trong API & Models.',
      )
    }

    if (sceneInput && model.kind !== 'video') throw badRequest('Cảnh video phải chọn model video')
    if (sourceImages.length && model.kind !== 'image') {
      throw badRequest('Chỉ model tạo ảnh mới nhận ảnh nguồn để tạo ảnh từ ảnh')
    }
    if (parsed.data.characterId && !parsed.data.projectId) throw badRequest('Nhân vật cần thuộc project đã chọn')
    const composed = parsed.data.projectId ? composeForContext(
      db, user.id, parsed.data.projectId, parsed.data.characterId, model.kind,
      prompt, sceneInput?.dialogue ?? '',
      { hasSourceImages: sourceImages.length > 0 },
    ) : null

    // Giới hạn số tác vụ đang chạy đồng thời của mỗi người.
    const active = db
      .prepare(
        "SELECT COUNT(*) AS total FROM generations WHERE user_id = ? AND status IN ('queued','running','downloading')",
      )
      .get(user.id) as { total: number }
    if (Number(active.total) >= env.MAX_CONCURRENT_JOBS_PER_USER) {
      throw badRequest(
        `Bạn đang có ${Number(active.total)} tác vụ chạy. Hãy đợi hoàn tất rồi tạo thêm.`,
      )
    }

    const id = randomUUID()
    const now = Date.now()

    db.prepare(
      `INSERT INTO generations
         (id, user_id, model_pk, provider_id, kind, prompt, params_json,
          snap_provider, snap_base_url, snap_model_id, status, attempt_count,
          idempotency_key, created_at, updated_at, project_id, scene_id, effective_prompt, prompt_snapshot_json,
          source_images_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      user.id,
      model.id,
      model.providerId,
      model.kind,
      prompt,
      JSON.stringify(params),
      model.providerName,
      model.baseUrl,
      model.modelId,
      idempotencyKey ?? null,
      now,
      now,
      parsed.data.projectId ?? null,
      sceneInput?.scene.id ?? null,
      composed?.effectivePrompt ?? null,
      composed ? JSON.stringify(composed.snapshot) : null,
      sourceImages.length ? JSON.stringify(sourceImages) : null,
    )

    const created = ownedGeneration(user.id, id)
    worker.wake()
    res.status(202).json({ generation: toPublic(created, []) })
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
