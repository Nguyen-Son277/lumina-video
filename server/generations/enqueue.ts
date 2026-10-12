import { inferVideoApiStyle, normalizeAgnesParams } from '../../shared/videoApi'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AppEnv } from '../env'
import type { Database } from '../db/index'
import { badRequest, errorMeta } from '../lib/errors'
import { ownedCharacterById, ownedUsableCharacter } from '../projects/service'
import {
  MAX_SESSION_CHARACTERS,
  ownedQuickSession,
  sessionCharacterIds,
} from '../quickSessions/service'
import type { SourceImage } from './adapters/image'
import { composeForContext } from './promptComposer'
import type { GenerationRow } from './types'
import type { Worker } from './worker'

/**
 * Thông số người dùng chọn cho một lần tạo nội dung.
 *
 * `useCharacterReference` phải được khai báo ở đây, nếu không zod sẽ loại bỏ và
 * tùy chọn tắt ảnh tham chiếu mất tác dụng.
 */
export const generationParamsSchema = z
  .object({
    size: z.string().max(50).optional(),
    quality: z.string().max(50).optional(),
    seconds: z.union([z.string().max(10), z.number()]).optional(),
    n: z.number().int().min(1).max(4).optional(),
    background: z.string().max(50).optional(),
    useCharacterReference: z.boolean().optional(),
    mode: z.enum(['text', 'keyframe', 'reference']).optional(),
    aspectRatio: z.string().max(20).optional(),
    seed: z.number().int().optional(),
    firstFrame: z.string().max(8192).optional(),
    lastFrame: z.string().max(8192).optional(),
    referenceImages: z.array(z.string().max(8192)).max(100).optional(),
    referenceAudios: z.array(z.string().max(8192)).max(100).optional(),
    // Retain forbidden fields so Agnes validation rejects rather than strips them.
    videos: z.unknown().optional(), referenceVideos: z.unknown().optional(),
    images: z.unknown().optional(), audios: z.unknown().optional(),
    first_frame: z.unknown().optional(), last_frame: z.unknown().optional(),
    input_reference: z.unknown().optional(),
  })
  .default({})

export const enqueueSchema = z.object({
  projectId: z.string().optional(),
  locationId: z.string().min(1).optional(),
  characterId: z.string().optional(),
  /** Phiên "Tạo nội dung đơn lẻ"; nhân vật của phiên được áp cho tác vụ này. */
  quickSessionId: z.string().min(1).optional(),
  /** Dàn nhân vật gửi tường minh; phiên vẫn là nguồn mặc định khi bỏ trống. */
  characterIds: z.array(z.string().min(1)).max(MAX_SESSION_CHARACTERS).optional(),
  modelId: z.string().min(1, 'Vui lòng chọn model'),
  prompt: z.string().trim().min(1, 'Vui lòng nhập mô tả').max(8000),
  params: generationParamsSchema,
  idempotencyKey: z.string().max(100).optional(),
  /** Id ảnh nguồn đã tải lên trước đó, dùng để tạo ảnh mới từ ảnh đó. */
  sourceUploadIds: z.array(z.string().min(1)).max(16).optional(),
  /** Id asset (ảnh đã tạo) dùng làm ảnh nguồn, để sửa tiếp nội dung cũ. */
  sourceAssetIds: z.array(z.string().min(1)).max(16).optional(),
})

export type EnqueuePayload = z.infer<typeof enqueueSchema>

/** Bối cảnh cảnh video, khi tác vụ được tạo từ một cảnh trong dự án. */
export type SceneContext = {
  id: string
  projectId: string
  dialogue: string
  /** Người nói chính (sở hữu lời thoại); thường trùng `data.characterId`. */
  speakerId: string | null
  /** Toàn bộ nhân vật trong cảnh, người nói chính ở vị trí 0. */
  castIds: string[]
  /** Bối cảnh/không gian của cảnh. */
  background: string
  locationId?: string | null
}

export type EnqueueRequest = {
  data: EnqueuePayload
  /** Có giá trị khi tạo từ cảnh: prompt composer nhận thêm lời thoại. */
  scene?: SceneContext | null
  /**
   * Ảnh chụp Canvas của tác vụ (node, đối tượng, bố trí, ảnh đã gửi).
   *
   * Server dựng giá trị này từ graph đã lưu; client không bao giờ gửi trực tiếp.
   * Nó chỉ được ghi vào `prompt_snapshot_json` để tác vụ cũ giữ nguyên đầu vào.
   */
  canvas?: unknown
}

export type EnqueueOutcome = {
  generation: GenerationRow
  /** true khi trả lại tác vụ cũ theo idempotencyKey, không tạo mới. */
  reused: boolean
}

/**
 * Tạo một tác vụ tạo nội dung và đưa vào hàng đợi.
 *
 * Tách khỏi route để dùng lại được ở nhiều lối vào: HTTP, bộ quét cảnh đã duyệt
 * (`auto_generate`) và bước áp dụng kế hoạch của Trợ lý AI. Nhờ vậy mọi lối vào
 * dùng chung một chỗ kiểm tra quyền sở hữu, snapshot và giới hạn đồng thời.
 */
export function enqueueGeneration(options: {
  db: Database
  env: AppEnv
  worker: Worker
  userId: string
  request: EnqueueRequest
}): EnqueueOutcome {
  const { db, env, worker, userId, request } = options
  const scene = request.scene ?? null
  const { modelId, prompt, params, idempotencyKey, sourceUploadIds, sourceAssetIds } = request.data

  if (prompt.length > env.MAX_PROMPT_LENGTH) {
    throw badRequest(
      `Mô tả tối đa ${env.MAX_PROMPT_LENGTH} ký tự`,
      undefined,
      errorMeta('generations.prompt_too_long', { max: env.MAX_PROMPT_LENGTH }),
    )
  }

  // Phiên "Tạo nội dung đơn lẻ": nhân vật của phiên được kế thừa cho tác vụ này
  // nên mọi nội dung trong phiên giữ đúng một bộ nhận diện.
  const quickSession = request.data.quickSessionId
    ? ownedQuickSession(db, userId, request.data.quickSessionId)
    : null
  const sessionCast = quickSession ? sessionCharacterIds(db, quickSession.id) : []

  const requestedLocationId = request.data.locationId ?? scene?.locationId
  type LocationRow = { id: string; name: string; stage: string; description: string; continuity_notes: string; revision: number; reference_upload_id: string | null }
  let location: LocationRow | null = null
  if (requestedLocationId) {
    if (!request.data.projectId) throw badRequest('Bối cảnh cần có dự án.')
    location = (db.prepare(`SELECT l.* FROM project_locations l JOIN projects p ON p.id = l.project_id
      WHERE l.id = ? AND l.project_id = ? AND p.user_id = ? AND p.deleted_at IS NULL`).get(requestedLocationId, request.data.projectId, userId) as LocationRow | undefined) ?? null
    if (!location) throw badRequest('Bối cảnh không tồn tại hoặc không thuộc dự án của bạn.', undefined, errorMeta('locations.unknown'))
  }
  const locationSourceId = location?.reference_upload_id
  if (request.data.locationId && !locationSourceId) throw badRequest('Bối cảnh chưa có ảnh tham chiếu.', undefined, errorMeta('locations.reference_missing'))
  const orderedSourceIds = [...new Set([...(request.data.locationId && locationSourceId ? [locationSourceId] : []), ...(sourceUploadIds ?? [])])]

  // Ảnh nguồn phải thuộc đúng người dùng; lưu snapshot đường dẫn ngay lúc tạo
  // để tác vụ không phụ thuộc việc ảnh nguồn còn tồn tại hay không.
  const sourceImages: SourceImage[] = []
  if (orderedSourceIds.length) {
    if (orderedSourceIds.length > env.MAX_SOURCE_IMAGES) {
      throw badRequest(
        `Tối đa ${env.MAX_SOURCE_IMAGES} ảnh nguồn cho một lần tạo`,
        undefined,
        errorMeta('generations.too_many_source_images', { max: env.MAX_SOURCE_IMAGES }),
      )
    }
    for (const uploadId of orderedSourceIds) {
      const row = db
        .prepare(
          'SELECT relative_path AS path, mime_type AS mime FROM uploads WHERE id = ? AND user_id = ?',
        )
        .get(uploadId, userId) as { path: string; mime: string } | undefined
      if (!row) throw badRequest('Ảnh nguồn không tồn tại hoặc không thuộc tài khoản của bạn', undefined, errorMeta('generations.source_image_not_owned'))
      sourceImages.push({ path: row.path, mime: row.mime })
    }
  }

  // Ảnh nguồn lấy từ nội dung đã tạo (chỉnh sửa nội dung cũ trong phiên).
  // Snapshot đường dẫn như ảnh tải lên, không sao chép tệp.
  if (sourceAssetIds?.length) {
    if (sourceImages.length + sourceAssetIds.length > env.MAX_SOURCE_IMAGES) {
      throw badRequest(
        `Tối đa ${env.MAX_SOURCE_IMAGES} ảnh nguồn cho một lần tạo`,
        undefined,
        errorMeta('generations.too_many_source_images', { max: env.MAX_SOURCE_IMAGES }),
      )
    }
    for (const assetId of sourceAssetIds) {
      const row = db
        .prepare('SELECT relative_path AS path, mime_type AS mime FROM assets WHERE id = ? AND user_id = ?')
        .get(assetId, userId) as { path: string; mime: string } | undefined
      if (!row) throw badRequest('Ảnh nguồn không tồn tại hoặc không thuộc tài khoản của bạn', undefined, errorMeta('generations.source_image_not_owned'))
      if (!sourceImages.some((item) => item.path === row.path)) {
        sourceImages.push({ path: row.path, mime: row.mime })
      }
    }
  }

  // Chống gửi trùng: nếu cùng idempotencyKey đã có tác vụ thì trả lại tác vụ đó.
  if (idempotencyKey) {
    const existing = db
      .prepare('SELECT * FROM generations WHERE user_id = ? AND idempotency_key = ?')
      .get(userId, idempotencyKey) as unknown as GenerationRow | undefined
    if (existing) return { generation: existing, reused: true }
  }

  // Model phải thuộc người dùng và đã được phân loại ảnh/video.
  const model = db
    .prepare(
      `SELECT m.id, m.model_id AS modelId, m.video_api_style AS videoApiStyle, m.kind, m.enabled,
              p.id AS providerId, p.name AS providerName, p.base_url AS baseUrl,
              p.image_api_style AS imageApiStyle
       FROM models m
       JOIN provider_connections p ON p.id = m.provider_id
       WHERE m.id = ? AND m.user_id = ?`,
    )
    .get(modelId, userId) as
    | {
        id: string
        modelId: string
        videoApiStyle: 'openai' | 'agnes'
        kind: string
        enabled: number
        providerId: string
        providerName: string
        baseUrl: string
        imageApiStyle: string | null
      }
    | undefined

  if (!model) throw badRequest('Model không tồn tại hoặc không thuộc tài khoản của bạn')
  if (model.enabled !== 1) throw badRequest('Model này đang bị tắt')
  if (model.kind !== 'image' && model.kind !== 'video') {
    throw badRequest(
      'Model này chưa được phân loại. Hãy đặt thành Tạo ảnh hoặc Tạo video trong API & Models.',
    )
  }

  if (scene && model.kind !== 'video') throw badRequest('Cảnh video phải chọn model video')
  if (sourceImages.length && model.kind !== 'image') {
    throw badRequest('Chỉ model tạo ảnh mới nhận ảnh nguồn để tạo ảnh từ ảnh')
  }

  // Ảnh tham chiếu nhân vật cũng được lưu snapshot ngay lúc tạo, để thay hoặc
  // xóa ảnh của nhân vật sau đó không làm đổi đầu vào của tác vụ đang chạy.
  // Nhân vật có thể là nhân vật thư viện dùng chung, không chỉ của dự án.
  //
  // Thứ tự ưu tiên: người nói chính (characterId), rồi dàn nhân vật của cảnh,
  // rồi nhân vật gửi tường minh, cuối cùng là nhân vật lưu ở phiên tạo nội dung.
  const speakerId = request.data.characterId ?? scene?.speakerId ?? sessionCast[0] ?? null
  const orderedCast: string[] = []
  for (const id of [
    speakerId,
    ...(scene?.castIds ?? []),
    ...(request.data.characterIds ?? []),
    ...sessionCast,
  ]) {
    if (!id || orderedCast.includes(id)) continue
    orderedCast.push(id)
  }

  // Kiểm tra quyền sở hữu cho MỌI nhân vật trong cảnh, kể cả khi không gửi ảnh.
  const resolvedCast = new Map<string, { reference_path: string | null; reference_mime: string | null }>()
  for (const id of orderedCast) {
    const character = request.data.projectId
      ? ownedUsableCharacter(db, userId, request.data.projectId, id)
      : ownedCharacterById(db, userId, id)
    resolvedCast.set(id, character)
  }

  const videoStyle = model.videoApiStyle ?? inferVideoApiStyle(model.modelId)
  let effectiveParams: Record<string, unknown> = params
  if (model.kind === 'video' && videoStyle === 'agnes') {
    try { effectiveParams = normalizeAgnesParams(model.modelId, params as Parameters<typeof normalizeAgnesParams>[1]) }
    catch (error) { const detail = error instanceof Error ? error.message : 'Invalid Agnes parameters'; throw badRequest(detail, undefined, errorMeta('agnes.params_invalid', { detail })) }
    if (params.useCharacterReference === true && [...resolvedCast.values()].some(c => c.reference_path && c.reference_mime)) {
      throw badRequest('Agnes does not accept private character reference images. Use public media URLs instead.', undefined, errorMeta('agnes.private_reference'))
    }
    effectiveParams.useCharacterReference = false
  }
  const useReference = effectiveParams.useCharacterReference !== false
  const characterReferences: SourceImage[] = []

  // Người nói chính: ảnh của họ tính vào giới hạn như trước, vượt thì báo lỗi rõ
  // ràng để người dùng bớt ảnh nguồn thay vì âm thầm mất ảnh tham chiếu.
  if (useReference && speakerId) {
    const speaker = resolvedCast.get(speakerId)
    if (speaker?.reference_path && speaker.reference_mime) {
      characterReferences.push({ path: speaker.reference_path, mime: speaker.reference_mime })
    }
  }

  if (sourceImages.length + characterReferences.length > env.MAX_SOURCE_IMAGES) {
    throw badRequest(
      `Tối đa ${env.MAX_SOURCE_IMAGES} ảnh đầu vào cho một lần tạo, gồm cả ảnh tham chiếu nhân vật. Hãy bớt ảnh nguồn hoặc bỏ chọn nhân vật.`,
      undefined,
      errorMeta('generations.too_many_input_images', { max: env.MAX_SOURCE_IMAGES }),
    )
  }

  // Nhân vật phụ: chỉ thêm khi còn chỗ. Cảnh đông nhân vật vẫn tạo được, chỉ
  // những ảnh tham chiếu vượt giới hạn bị bỏ (người nói chính luôn được ưu tiên).
  if (useReference) {
    for (const id of orderedCast) {
      if (id === speakerId) continue
      if (sourceImages.length + characterReferences.length >= env.MAX_SOURCE_IMAGES) break
      const character = resolvedCast.get(id)
      if (!character?.reference_path || !character.reference_mime) continue
      characterReferences.push({ path: character.reference_path, mime: character.reference_mime })
    }
  }

  const composed =
    request.data.projectId || speakerId
      ? composeForContext(
          db,
          userId,
          request.data.projectId ?? null,
          speakerId,
          model.kind,
          prompt,
          scene?.dialogue ?? '',
          {
            hasSourceImages: sourceImages.length > 0,
            hasCharacterReference: characterReferences.length > 0,
            castIds: orderedCast,
            background: scene?.background ?? '',
            location: location ? { id: location.id, name: location.name, stage: location.stage, description: location.description, continuityNotes: location.continuity_notes, revision: location.revision, referenceUploadId: location.reference_upload_id } : undefined,
            hasLocationReference: Boolean(model.kind === 'image' && request.data.locationId && locationSourceId),
          },
        )
      : null

  if (videoStyle === 'agnes' && composed?.snapshot.character) {
    composed.snapshot.character.hasReference = false
  }

  // Giới hạn số tác vụ đang chạy đồng thời của mỗi người.
  const active = db
    .prepare(
      "SELECT COUNT(*) AS total FROM generations WHERE user_id = ? AND status IN ('queued','running','downloading')",
    )
    .get(userId) as { total: number }
  if (Number(active.total) >= env.MAX_CONCURRENT_JOBS_PER_USER) {
    throw badRequest(
      `Bạn đang có ${Number(active.total)} tác vụ chạy. Hãy đợi hoàn tất rồi tạo thêm.`,
      undefined,
      errorMeta('generations.too_many_active_jobs', { count: Number(active.total) }),
    )
  }

  const id = randomUUID()
  const now = Date.now()

  db.prepare(
    `INSERT INTO generations
       (id, user_id, model_pk, provider_id, kind, prompt, params_json,
        snap_provider, snap_base_url, snap_model_id, status, attempt_count,
        idempotency_key, created_at, updated_at, project_id, scene_id, effective_prompt, prompt_snapshot_json,
        source_images_json, snap_image_style, character_reference_json, character_references_json,
        quick_session_id, snap_video_style)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    model.id,
    model.providerId,
    model.kind,
    prompt,
    JSON.stringify(effectiveParams),
    model.providerName,
    model.baseUrl,
    model.modelId,
    idempotencyKey ?? null,
    now,
    now,
    request.data.projectId ?? null,
    scene?.id ?? null,
    composed?.effectivePrompt ?? null,
    composed ? JSON.stringify(request.canvas ? { ...composed.snapshot, canvas: request.canvas } : composed.snapshot) : (request.canvas ? JSON.stringify({ canvas: request.canvas }) : null),
    sourceImages.length ? JSON.stringify(sourceImages) : null,
    model.imageApiStyle ?? 'openai',
    // Cột cũ (một đối tượng đơn) giữ lại để rollback; cột mảng là nguồn sự thật.
    characterReferences.length ? JSON.stringify(characterReferences[0]) : null,
    characterReferences.length ? JSON.stringify(characterReferences) : null,
    quickSession?.id ?? null,
    videoStyle,
  )

  // Phiên vừa có thêm nội dung: đẩy lên đầu danh sách phiên của người dùng.
  if (quickSession) {
    db.prepare('UPDATE quick_sessions SET updated_at = ? WHERE id = ? AND user_id = ?').run(
      now,
      quickSession.id,
      userId,
    )
  }

  const created = db
    .prepare('SELECT * FROM generations WHERE id = ? AND user_id = ?')
    .get(id, userId) as unknown as GenerationRow

  worker.wake()
  return { generation: created, reused: false }
}
