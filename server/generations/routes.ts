import { softDelete, ownedTrashRow } from '../trash/service'
import { inferVideoApiStyle, normalizeAgnesParams } from '../../shared/videoApi'
import { guardAgnesMedia } from './adapters/agnes'
import { Router } from 'express'
import type { AppEnv } from '../env'
import type { Database } from '../db/index'
import type { MediaStore } from '../media/store'
import { badRequest, conflict, notFound, validationError, errorMeta } from '../lib/errors'
import {
  genericMessageKeyForCode,
  isErrorMessageKey,
  type ErrorMessageKey,
  type ErrorMessageParams,
} from '../../shared/errorCatalog'
import { clientIp, createRateLimiter } from '../lib/rateLimit'
import { requireUser } from '../auth/middleware'
import type { Worker } from './worker'
import type { GenerationRow } from './types'
import { enqueueGeneration, enqueueSchema } from './enqueue'
import { sceneGenerationContext } from '../projects/service'
import { revokeGenerationMediaGrants } from '../entityLibrary/mediaGrants'

export type AssetPublic = {
  id: string
  mimeType: string
  byteSize: number
  variant?: string
  sourceAssetId?: string | null
  url: string
}

export type GenerationPublic = {
  id: string
  kind: 'image' | 'video'
  prompt: string
  projectId: string | null
  sceneId: string | null
  /** Phiên "Tạo nội dung đơn lẻ" chứa tác vụ (null với tác vụ theo dự án/cảnh). */
  quickSessionId: string | null
  /** Khoá model trong catalog (null khi model đã bị xoá). */
  modelId: string | null
  effectivePrompt: string
  promptSnapshot: unknown
  promptDocument: import('../../shared/promptMentions').PromptDocument | null
  postprocessStatus: string | null
  postprocessError: string | null
  sourceImageCount: number
  status: GenerationRow['status']
  progress: number | null
  provider: string
  model: string
  params: Record<string, unknown>
  errorCode: string | null
  errorMessage: string | null
  /** Khoá ngữ nghĩa của lỗi; suy ra từ `errorCode` với dữ liệu cũ. */
  errorMessageKey: ErrorMessageKey
  /** Tham số nội suy cho `errorMessageKey`. */
  errorMessageParams: ErrorMessageParams
  providerJobId: string | null
  providerStatus: string | null
  canCancel: boolean
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

function publicSnapshot(json: string | null | undefined): unknown {
  if (!json) return null
  const snapshot = JSON.parse(json)
  if (snapshot && Array.isArray(snapshot.entities)) snapshot.entities = snapshot.entities.map(({ reference: _reference, ...entity }: Record<string, unknown>) => entity)
  return snapshot
}

function publicParams(row: GenerationRow): Record<string, unknown> {
  const params = JSON.parse(row.params_json) as Record<string, unknown>
  if (Array.isArray(params.referenceImages)) params.referenceImages = params.referenceImages.filter(value => typeof value !== 'string' || !value.includes('/api/provider-media/'))
  return params
}

export function generationPublic(
  row: GenerationRow,
  assets: Array<{ id: string; mime_type: string; byte_size: number; variant?: string; source_asset_id?: string | null }> = [],
): GenerationPublic {
  return {
    id: row.id,
    kind: row.kind,
    prompt: row.prompt,
    projectId: row.project_id ?? null,
    sceneId: row.scene_id ?? null,
    quickSessionId: row.quick_session_id ?? null,
    modelId: row.model_pk ?? null,
    effectivePrompt: row.effective_prompt ?? row.prompt,
    promptDocument: row.prompt_document_json ? JSON.parse(row.prompt_document_json) : null,
    promptSnapshot: publicSnapshot(row.prompt_snapshot_json),
    sourceImageCount: row.source_images_json ? (JSON.parse(row.source_images_json) as unknown[]).length : 0,
    status: row.status,
    progress: row.progress,
    provider: row.snap_provider,
    model: row.snap_model_id,
    params: publicParams(row),
    postprocessStatus: row.postprocess_status ?? null,
    postprocessError: row.postprocess_error ?? null,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    errorMessageKey: storedErrorKey(row),
    errorMessageParams: storedErrorParams(row),
    providerJobId: row.provider_job_id,
    providerStatus: row.provider_status ?? null,
    canCancel: row.kind === 'video' && (row.status === 'queued' || row.snap_video_style === 'higgsfield' && row.status === 'running' && (!row.provider_job_id || row.provider_status === 'queued')) && !row.cancel_requested,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    assets: assets.map((asset) => ({
      id: asset.id,
      mimeType: asset.mime_type,
      byteSize: asset.byte_size,
      variant: asset.variant ?? 'original',
      sourceAssetId: asset.source_asset_id ?? null,
      url: `/api/assets/${asset.id}`,
    })),
  }
}

/**
 * Khoá ngữ nghĩa đã lưu, hoặc suy ra từ `error_code` cho các hàng cũ chưa có
 * metadata. Khoá lạ trong database cũng rơi về khoá dự phòng theo mã lỗi.
 */
function storedErrorKey(row: GenerationRow): ErrorMessageKey {
  if (row.error_message_key && isErrorMessageKey(row.error_message_key)) return row.error_message_key
  return genericMessageKeyForCode(row.error_code)
}

function storedErrorParams(row: GenerationRow): ErrorMessageParams {
  if (!row.error_message_params) return {}
  try {
    const parsed: unknown = JSON.parse(row.error_message_params)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ErrorMessageParams
    }
  } catch {
    // Dữ liệu cũ hoặc hỏng: bỏ qua tham số.
  }
  return {}
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
        'SELECT id, mime_type, byte_size, variant, source_asset_id FROM assets WHERE generation_id = ? ORDER BY CASE variant WHEN \'logo_overlay\' THEN 0 ELSE 1 END, created_at ASC',
      )
      .all(generationId) as unknown as Array<{ id: string; mime_type: string; byte_size: number; variant?: string; source_asset_id?: string | null }>
  }

  function ownedGeneration(userId: string, id: string): GenerationRow {
    const row = db
      .prepare('SELECT * FROM generations WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
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
    let sql = 'SELECT * FROM generations WHERE user_id = ? AND deleted_at IS NULL'
    if (kind) {
      sql += ' AND kind = ?'
      params.push(kind)
    }
    for (const [queryKey, column] of [['projectId', 'project_id'], ['sceneId', 'scene_id'], ['quickSessionId', 'quick_session_id']] as const) {
      const value = req.query[queryKey]
      if (typeof value === 'string') { sql += ` AND ${column} = ?`; params.push(value) }
    }
    sql += ' ORDER BY created_at DESC LIMIT ?'
    params.push(limit)

    const rows = db.prepare(sql).all(...params) as unknown as GenerationRow[]
    res.json({ generations: rows.map((row) => generationPublic(row, assetsFor(row.id))) })
  })

  const enqueue: import('express').RequestHandler = async (req, res) => {
    const user = requireUser(req)

    if (!createLimiter.check(`generate:${user.id}`)) {
      throw badRequest('Bạn tạo quá nhanh. Vui lòng đợi một lát rồi thử lại.')
    }

    const sceneInput = req.params.sceneId ? sceneGenerationContext(db, user.id, String(req.params.sceneId)) : null
    const input = sceneInput ? {
      modelId: sceneInput.modelId, prompt: sceneInput.prompt, promptDocument: sceneInput.promptDocument ?? undefined, params: sceneInput.params,
      projectId: sceneInput.projectId, characterId: sceneInput.characterId ?? undefined,
      idempotencyKey: req.body?.idempotencyKey,
    } : req.body
    const parsed = createSchema.safeParse(input)
    if (!parsed.success) {
      throw validationError(parsed.error)
    }

    const selected = db.prepare('SELECT model_id, video_api_style, kind FROM models WHERE id = ? AND user_id = ?').get(parsed.data.modelId, user.id) as { model_id: string; video_api_style: 'openai' | 'agnes'; kind: string } | undefined
    if (selected?.kind === 'video' && (selected.video_api_style ?? inferVideoApiStyle(selected.model_id)) === 'agnes') {
      let params
      try { params = (parsed.data.allowTemporaryMedia || (parsed.data.params as Record<string, unknown>).allowTemporaryMedia) && (parsed.data.promptDocument?.mentions.length || sceneInput?.contextDocuments.length) ? parsed.data.params as ReturnType<typeof normalizeAgnesParams> : normalizeAgnesParams(selected.model_id, parsed.data.params as Parameters<typeof normalizeAgnesParams>[1]) }
      catch (error) { const detail = error instanceof Error ? error.message : 'Invalid Agnes parameters'; throw badRequest(detail, undefined, errorMeta('agnes.params_invalid', { detail })) }
      await guardAgnesMedia(params)
    }
    const outcome = enqueueGeneration({
      db,
      env,
      worker,
      mediaStore,
      userId: user.id,
      request: {
        data: parsed.data,
        contextDocuments: sceneInput?.contextDocuments,
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
      .json({ generation: generationPublic(outcome.generation, assets) })
  }
  router.post('/preview', (req, res) => {
    const user = requireUser(req)
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) throw validationError(parsed.error)
    const preview = enqueueGeneration({ db, env, userId: user.id, request: { data: parsed.data }, previewOnly: true })
    res.json({ preview })
  })
  router.post('/', enqueue)
  router.post('/scenes/:sceneId/generate', enqueue)

  router.get('/:id', (req, res) => {
    const user = requireUser(req)
    const row = ownedGeneration(user.id, req.params.id)
    res.json({ generation: generationPublic(row, assetsFor(row.id)) })
  })

  /**
   * Thử tải lại media khi tạo thành công nhưng bước tải thất bại.
   * Không bao giờ tạo job mới ở provider.
   */
  router.post('/:id/revoke-media', (req, res) => {
    const user = requireUser(req)
    ownedGeneration(user.id, String(req.params.id))
    res.json({ revoked: revokeGenerationMediaGrants(db, user.id, String(req.params.id)) })
  })
  router.post('/:id/cancel', async (req, res) => {
    const user = requireUser(req)
    const row = ownedGeneration(user.id, String(req.params.id))
    // Compete atomically with the worker's queued -> running claim. Never
    // pretend to cancel a POST in flight or an already admitted provider job.
    if (row.error_code === 'CANCELLED' && row.status === 'failed') {
      res.json({ generation: generationPublic(row, assetsFor(row.id)) })
      return
    }
    const now = Date.now()
    if (row.snap_video_style === 'higgsfield' && ['queued','running'].includes(row.status)) {
      const op = row.higgsfield_json ? JSON.parse(row.higgsfield_json) : null
      if (row.provider_job_id && row.provider_status !== 'queued') throw conflict('Video is no longer in the queue and cannot be stopped.', errorMeta('generations.cancel_not_queued'))
      if (row.provider_job_id || op?.firstSentAt || row.status === 'running') {
        db.prepare("UPDATE generations SET cancel_requested = 1, next_poll_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued','running')").run(now, now, row.id)
        // Let the single worker reconcile and cancel; it owns poll/submit races.
        worker.wake()
        res.status(202).json({ generation: generationPublic(ownedGeneration(user.id, row.id), assetsFor(row.id)) })
        return
      }
    }
    const result = db.prepare(`UPDATE generations SET status = 'failed',
      error_code = 'CANCELLED', error_message = 'Video creation stopped by user.',
      error_message_key = 'generations.cancelled', error_message_params = NULL,
      next_poll_at = NULL, poll_started_at = NULL, completed_at = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND kind = 'video' AND status = 'queued'
        AND provider_job_id IS NULL AND deleted_at IS NULL`).run(now, now, row.id, user.id)
    if (Number(result.changes) !== 1) throw conflict('Video is no longer in the queue and cannot be stopped.', errorMeta('generations.cancel_not_queued'))
    revokeGenerationMediaGrants(db, user.id, row.id)
    res.json({ generation: generationPublic(ownedGeneration(user.id, row.id), assetsFor(row.id)) })
  })
  router.post('/:id/retry-overlay', (req, res) => {
    const user = requireUser(req)
    const row = ownedGeneration(user.id, String(req.params.id))
    if (row.status !== 'succeeded' || !row.logo_overlays_json || row.postprocess_status === 'running') throw badRequest('Chưa có kết quả hoặc bước chèn logo đang chạy')
    db.prepare("UPDATE generations SET postprocess_status='queued',postprocess_error=NULL,updated_at=? WHERE id=?").run(Date.now(), row.id)
    worker.wake()
    res.json({ generation: generationPublic(ownedGeneration(user.id, row.id), assetsFor(row.id)) })
  })
  router.post('/:id/retry-download', (req, res) => {
    const user = requireUser(req)
    const row = ownedGeneration(user.id, req.params.id)

    if (!row.provider_job_id) {
      throw badRequest('Tác vụ này không có ID job ở provider để tải lại')
    }
    if (row.status === 'succeeded') {
      throw badRequest('Tác vụ đã hoàn tất, không cần tải lại')
    }

    // Không tạo job mới: chỉ đưa tác vụ về vòng poll để tải lại nội dung đã có.
    // Đặt lại `poll_started_at` để cửa sổ theo dõi (VIDEO_POLL_TIMEOUT_MS) được
    // tính lại từ đầu; giữ nguyên `credential_id` + snapshot URL để lần poll/tải
    // này vẫn dùng đúng key đã ghim.
    db.prepare(
      "UPDATE generations SET status = 'running', next_poll_at = NULL, poll_started_at = NULL, error_code = NULL, error_message = NULL, error_message_key = NULL, error_message_params = NULL, updated_at = ? WHERE id = ?",
    ).run(Date.now(), row.id)

    const updated = ownedGeneration(user.id, row.id)
    worker.wake()
    res.json({ generation: generationPublic(updated, assetsFor(updated.id)) })
  })

  router.delete('/:id', (req, res) => {
    const user = requireUser(req)
    const row = ownedTrashRow(db, user.id, 'generation', String(req.params.id))
    if (row.deleted_at != null) { res.status(204).end(); return }
    softDelete(db, user.id, 'generation', row.id)
    res.status(204).end()
  })

  return router
}

/** Đếm số ký tự IP cho rate limit ở tầng ngoài nếu cần. */
export { clientIp }
