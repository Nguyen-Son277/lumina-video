import { inferVideoApiStyle, normalizeAgnesParams } from '../../shared/videoApi'
import { resolveImageSettings } from '../models/imageSettings'
import { normalizeHiggsfieldParams } from '../../shared/higgsfield'
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
import type { PromptDocument } from '../../shared/promptMentions'
import { promptDocumentSchema, resolvePromptDocument, renderPromptDocument } from '../entityLibrary/mentions'
import { resolveEntity, type CatalogEntity } from '../entityLibrary/service'
import { validateLogoOverlays, type LogoOverlay, type ResolvedLogoOverlay } from '../entityLibrary/overlay'
import { parsePromptMentions } from '../../shared/promptMentions'
import { issueMediaGrant, validateMediaGrantOrigin, DEFAULT_MEDIA_GRANT_TTL_MS, MAX_MEDIA_GRANT_TTL_MS } from '../entityLibrary/mediaGrants'
import { createMediaStore, type MediaStore } from '../media/store'

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
    allowTemporaryMedia: z.boolean().optional(),
    logoOverlays: z.array(z.object({ entityId: z.string().min(1), x: z.number(), y: z.number(), width: z.number(), opacity: z.number(), startSeconds: z.number().optional(), endSeconds: z.number().optional() }).strict()).max(8).optional(),
    mode: z.enum(['text', 'keyframe', 'reference', 'image']).optional(),
    duration: z.number().optional(), resolution: z.string().optional(),
    bitrateMode: z.string().optional(), generateAudio: z.boolean().optional(), outputFormat: z.string().optional(),
    imageUrl: z.string().max(8192).optional(), endImageUrl: z.string().max(8192).optional(),
    imageUploadId: z.string().optional(), endImageUploadId: z.string().optional(),
    imageAssetId: z.string().optional(), endImageAssetId: z.string().optional(),
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
  .passthrough()
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
  prompt: z.string().max(8000).default(''),
  promptDocument: promptDocumentSchema.optional(),
  logoOverlays: z.array(z.object({ entityId: z.string().min(1), x: z.number(), y: z.number(), width: z.number(), opacity: z.number(), startSeconds: z.number().optional(), endSeconds: z.number().optional() }).strict()).max(8).optional(),
  allowTemporaryMedia: z.boolean().optional(),
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
  /** Server-resolved Canvas image edge; separate from generic image-edit sources. */
  videoInput?: { uploadId?: string; assetId?: string; nodeId: string } | null
  /** ID-bound documents from structured planner/frame fields. */
  contextDocuments?: PromptDocument[]
  /** Server-only frozen batch metadata; never accepted from HTTP payloads. */
  resolvedContextEntities?: CatalogEntity[]
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
export type GenerationPreview = {
  prompt: string; entities: Array<{ id: string; kind: string; name: string; handle: string; revision: number; referenceMode: string }>;
  referenceCount: number; maxReferenceCount: number; warnings: string[]; overlays: LogoOverlay[]
}
type EnqueueOptions = { db: Database; env: AppEnv; worker?: Worker; mediaStore?: MediaStore; userId: string; request: EnqueueRequest }
export function enqueueGeneration(options: EnqueueOptions & { previewOnly: true }): GenerationPreview
export function enqueueGeneration(options: EnqueueOptions & { previewOnly?: false }): EnqueueOutcome
export function enqueueGeneration(options: EnqueueOptions & { previewOnly?: boolean }): EnqueueOutcome | GenerationPreview {
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

  // Keep idempotency tombstones: a trashed result is unavailable, never a new POST.
  if (idempotencyKey && !options.previewOnly) {
    const existing = db
      .prepare('SELECT * FROM generations WHERE user_id = ? AND idempotency_key = ?')
      .get(userId, idempotencyKey) as GenerationRow | undefined
    if (existing?.deleted_at != null) throw badRequest('Tác vụ đã có trong Thùng rác và không còn khả dụng')
    if (existing) return { generation: existing, reused: true }
  }

  const document = request.data.promptDocument
  if (!document && !request.canvas && !(request.contextDocuments?.length) && parsePromptMentions(prompt).length) throw badRequest('Mention @ cần được chọn từ thư viện và lưu bằng ID, không chỉ nhập tên trong prompt.')
  if (document && document.text !== prompt) throw badRequest('Văn bản prompt không khớp tài liệu mention')
  const documents = [ ...(document ? [document] : []), ...(request.contextDocuments ?? []) ]
  const resolutions = documents.map(doc => {
    const result = resolvePromptDocument(db, userId, doc, request.data.projectId)
    if (request.resolvedContextEntities) result.entities = result.entities.map(entity => {
      const frozen = request.resolvedContextEntities!.find(item => item.kind === entity.kind && item.id === entity.id)
      if (!frozen) throw badRequest('Snapshot batch thiếu đối tượng được tham chiếu')
      return frozen
    })
    if (request.resolvedContextEntities) result.context = result.entities.length ? `Đối tượng được tham chiếu (giữ đúng nhận diện):\n${result.entities.map(entity => `- ${entity.name} (${entity.kind}; ID ${entity.id}): ${entity.description}${entity.continuityNotes ? `. Giữ nguyên: ${entity.continuityNotes}` : ''}`).join('\n')}` : ''
    return result
  })
  const mentionedEntities = [...new Map(resolutions.flatMap(result => result.entities).map(entity => [`${entity.kind}:${entity.id}`, entity] as const)).values()]
  const overlaySpecs = validateLogoOverlays(request.data.logoOverlays ?? (params as Record<string, unknown>).logoOverlays ?? [])
  const resolvedOverlays: ResolvedLogoOverlay[] = overlaySpecs.map(spec => {
    const entity = resolveEntity(db, userId, { kind: 'logo', id: spec.entityId }, request.data.projectId)
    if (!entity.reference) throw badRequest(`Logo ${entity.name} chưa có ảnh nguyên bản`)
    return { ...spec, path: entity.reference.path, mime: entity.reference.mime }
  })
  const overlayIds = new Set(overlaySpecs.map(spec => spec.entityId))

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
        .prepare('SELECT a.relative_path AS path, a.mime_type AS mime FROM assets a JOIN generations g ON g.id = a.generation_id WHERE a.id = ? AND a.user_id = ? AND g.deleted_at IS NULL')
        .get(assetId, userId) as { path: string; mime: string } | undefined
      if (!row) throw badRequest('Ảnh nguồn không tồn tại hoặc không thuộc tài khoản của bạn', undefined, errorMeta('generations.source_image_not_owned'))
      if (!sourceImages.some((item) => item.path === row.path)) {
        sourceImages.push({ path: row.path, mime: row.mime })
      }
    }
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
        videoApiStyle: 'openai' | 'agnes' | 'higgsfield'
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
  const imageSettings = model.kind === 'image'
    ? resolveImageSettings(db, model.id, userId, { hasReferences: sourceImages.length > 0 })
    : null

  // Ảnh tham chiếu nhân vật cũng được lưu snapshot ngay lúc tạo, để thay hoặc
  // xóa ảnh của nhân vật sau đó không làm đổi đầu vào của tác vụ đang chạy.
  // Nhân vật có thể là nhân vật thư viện dùng chung, không chỉ của dự án.
  //
  // Thứ tự ưu tiên: người nói chính (characterId), rồi dàn nhân vật của cảnh,
  // rồi nhân vật gửi tường minh, cuối cùng là nhân vật lưu ở phiên tạo nội dung.
  const speakerId = request.data.characterId ?? scene?.speakerId ?? sessionCast[0] ?? mentionedEntities.find(entity => entity.kind === 'character')?.id ?? null
  const orderedCast: string[] = []
  for (const id of [
    speakerId,
    ...(scene?.castIds ?? []),
    ...(request.data.characterIds ?? []),
    ...mentionedEntities.filter(entity => entity.kind === 'character').map(entity => entity.id),
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
    const frozen = request.resolvedContextEntities?.find(entity => entity.kind === 'character' && entity.id === id)
    resolvedCast.set(id, frozen ? { reference_path: frozen.reference?.path ?? null, reference_mime: frozen.reference?.mime ?? null } : character)
  }

  const videoStyle = model.videoApiStyle ?? inferVideoApiStyle(model.modelId)
  let videoInput: SourceImage | null = null
  if (request.videoInput) {
    if (model.kind !== 'video') throw badRequest('Ảnh đầu vào video cần model video')
    const input = request.videoInput
    if (Boolean(input.uploadId) === Boolean(input.assetId)) throw badRequest('Chọn đúng một nguồn ảnh video')
    videoInput = (input.uploadId
      ? db.prepare("SELECT relative_path AS path, mime_type AS mime FROM uploads WHERE id=? AND user_id=? AND mime_type LIKE 'image/%'").get(input.uploadId, userId)
      : db.prepare("SELECT a.relative_path AS path, a.mime_type AS mime FROM assets a JOIN generations g ON g.id=a.generation_id WHERE a.id=? AND a.user_id=? AND g.user_id=? AND g.status='succeeded' AND g.deleted_at IS NULL AND a.mime_type LIKE 'image/%'").get(input.assetId!, userId, userId)) as SourceImage | null
    if (!videoInput) throw badRequest('Ảnh video không còn khả dụng hoặc không thuộc tài khoản')
    if (videoStyle === 'openai' || videoStyle === 'agnes') sourceImages.push(videoInput)
  }
  if (model.kind === 'video' && videoStyle === 'higgsfield') {
    if (model.modelId.endsWith('/text-to-video') && (videoInput || params.mode === 'image')) throw badRequest('Model text-to-video không nhận ảnh. Hãy chọn model image-to-video.')
    if (model.modelId.endsWith('/image-to-video') && !videoInput && params.mode !== 'image') throw badRequest('Model image-to-video cần ảnh đầu vào và chế độ image.')
  }
  if (!(model.kind === 'video' && videoStyle === 'higgsfield' && params.mode === 'image') && !prompt.trim()) throw badRequest('Vui lòng nhập mô tả')
  const referenceWarnings: string[] = []
  const temporaryMedia = request.data.allowTemporaryMedia ?? (params as Record<string, unknown>).allowTemporaryMedia === true
  const temporaryRefs = model.kind === 'video' && videoStyle === 'agnes' && temporaryMedia
    ? mentionedEntities.filter(entity => entity.reference && !overlayIds.has(entity.id)) : []
  const grantTtlMs = Math.max(DEFAULT_MEDIA_GRANT_TTL_MS, env.VIDEO_POLL_TIMEOUT_MS + 15 * 60 * 1000)
  const temporaryVideoInput = videoStyle === 'agnes' ? videoInput : null
  if (temporaryVideoInput && !temporaryMedia) throw badRequest('Ảnh video riêng tư cần sự đồng ý sử dụng URL media tạm.')
  if (temporaryRefs.length || temporaryVideoInput) {
    validateMediaGrantOrigin(env.APP_ORIGIN)
    if (grantTtlMs > MAX_MEDIA_GRANT_TTL_MS) throw badRequest('Thời gian chờ video vượt thời hạn tối đa của media tạm (24 giờ).')
  }
  const objectRefs = mentionedEntities.filter(entity => entity.kind !== 'character' && entity.reference && !overlayIds.has(entity.id))
  if (model.kind === 'image') {
    for (const entity of objectRefs) {
      if (!sourceImages.some(image => image.path === entity.reference!.path)) sourceImages.push({ path: entity.reference!.path, mime: entity.reference!.mime })
    }
    if (sourceImages.length > env.MAX_SOURCE_IMAGES) throw badRequest(`Có ${sourceImages.length} ảnh tham chiếu; tối đa ${env.MAX_SOURCE_IMAGES}. Hãy giảm số đối tượng/ảnh nguồn.`)
  } else if (objectRefs.length) {
    referenceWarnings.push('Model video hiện chỉ dùng mô tả cho đồ vật/logo; ảnh đồ vật không được gửi như nguồn ảnh. Logo nguyên bản có thể chèn sau khi tạo.')
  }
  let effectiveParams: Record<string, unknown> = {
    ...params,
    ...(model.kind === 'image' && !params.size && imageSettings?.params.size ? { size: imageSettings.params.size } : {}),
  }
  if (model.kind === 'video' && videoStyle === 'agnes') {
    const agnesParams = { ...params }
    if (temporaryVideoInput) {
      const mode = params.mode ?? (temporaryRefs.length ? 'reference' : 'keyframe')
      if (mode !== 'keyframe' && mode !== 'reference') throw badRequest('Ảnh video cần chế độ keyframe hoặc reference, không dùng text.')
      agnesParams.mode = mode
      if (mode === 'keyframe') agnesParams.firstFrame = `${env.APP_ORIGIN}/api/provider-media/preview-input`
      else agnesParams.referenceImages = [...(params.referenceImages ?? []), `${env.APP_ORIGIN}/api/provider-media/preview-input`]
    }
    if (temporaryRefs.length) {
      if (params.mode && params.mode !== 'reference') throw badRequest('Ảnh thư viện có URL tạm chỉ dùng với chế độ reference, không dùng text/keyframe.')
      const max = model.modelId.toLowerCase().includes('flash') ? 5 : env.MAX_SOURCE_IMAGES
      if (temporaryRefs.length + (temporaryVideoInput ? 1 : 0) + (params.referenceImages?.length ?? 0) > max) throw badRequest(`Video này nhận tối đa ${max} ảnh tham chiếu.`)
    }
    if (temporaryVideoInput && temporaryRefs.length && agnesParams.mode !== 'reference') throw badRequest('Ảnh thư viện và ảnh đầu vào chỉ dùng chung trong chế độ reference.')
    const plannedParams = temporaryRefs.length ? { ...agnesParams, mode: 'reference' as const, referenceImages: [...(agnesParams.referenceImages ?? []), ...temporaryRefs.map((_, index) => `${env.APP_ORIGIN}/api/provider-media/preview-${index}`)] } : agnesParams
    try { effectiveParams = normalizeAgnesParams(model.modelId, plannedParams as Parameters<typeof normalizeAgnesParams>[1]) }
    catch (error) { const detail = error instanceof Error ? error.message : 'Invalid Agnes parameters'; throw badRequest(detail, undefined, errorMeta('agnes.params_invalid', { detail })) }
    if (!temporaryRefs.length && params.useCharacterReference === true && [...resolvedCast.values()].some(c => c.reference_path && c.reference_mime)) {
      throw badRequest('Agnes does not accept private character reference images. Use public media URLs instead.', undefined, errorMeta('agnes.private_reference'))
    }
    effectiveParams.useCharacterReference = false
  }
  if (model.kind === 'video' && videoStyle === 'higgsfield') {
    if (sourceUploadIds?.length || sourceAssetIds?.length) throw badRequest('Select explicit start/end frames for Higgsfield')
    const frameParams = { ...params }
    if (videoInput && request.videoInput) {
      delete frameParams.imageUrl; delete frameParams.imageUploadId; delete frameParams.imageAssetId
      frameParams.mode = 'image'
      if (request.videoInput.uploadId) frameParams.imageUploadId = request.videoInput.uploadId
      else frameParams.imageAssetId = request.videoInput.assetId
    }
    try { effectiveParams = normalizeHiggsfieldParams(frameParams as import('../../shared/higgsfield').HiggsfieldParams, prompt) }
    catch (error) { throw badRequest(error instanceof Error ? error.message : 'Invalid Higgsfield parameters') }
    // Validate frame ownership before any network operation, also for preview.
    for (const prefix of ['image', 'endImage']) {
      const uploadId = effectiveParams[`${prefix}UploadId`]
      const assetId = effectiveParams[`${prefix}AssetId`]
      if (uploadId && !db.prepare('SELECT 1 FROM uploads WHERE id = ? AND user_id = ?').get(String(uploadId), userId)) throw badRequest('Frame upload does not belong to this account')
      if (assetId && !db.prepare("SELECT 1 FROM assets a JOIN generations g ON g.id = a.generation_id WHERE a.id = ? AND a.user_id = ? AND a.mime_type LIKE 'image/%' AND g.deleted_at IS NULL").get(String(assetId), userId)) throw badRequest('Frame asset does not belong to this account')
      const frame = uploadId ? db.prepare('SELECT relative_path AS path, mime_type AS mime FROM uploads WHERE id = ? AND user_id = ?').get(String(uploadId), userId)
        : assetId ? db.prepare('SELECT relative_path AS path, mime_type AS mime FROM assets WHERE id = ? AND user_id = ?').get(String(assetId), userId) : null
      if (frame) sourceImages.push({ path: String(frame.path), mime: String(frame.mime) })
    }
  }
  if (videoInput) effectiveParams.useCharacterReference = false
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

  if (model.kind === 'image' && sourceImages.length + characterReferences.length > 0) {
    resolveImageSettings(db, model.id, userId, { hasReferences: true })
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
      const character = resolvedCast.get(id)
      if (!character?.reference_path || !character.reference_mime) continue
      if (sourceImages.length + characterReferences.length >= env.MAX_SOURCE_IMAGES) {
        if (mentionedEntities.some(entity => entity.kind === 'character' && entity.id === id)) throw badRequest(`Nhân vật được gọi trong prompt vượt giới hạn ${env.MAX_SOURCE_IMAGES} ảnh đầu vào. Hãy bớt ảnh nguồn hoặc đối tượng.`)
        referenceWarnings.push('Một ảnh nhân vật đã chọn không được gửi vì giới hạn ảnh; nhân vật đó chỉ được mô tả.')
        continue
      }
      characterReferences.push({ path: character.reference_path, mime: character.reference_mime })
    }
  }

  if (imageSettings) {
    const referenceCount = sourceImages.length + characterReferences.length
    const limit = imageSettings.maxReferences ?? env.MAX_SOURCE_IMAGES
    if (referenceCount > limit && params.referenceSheet !== true) {
      throw badRequest(`Model chỉ nhận tối đa ${limit} ảnh tham chiếu, nhưng frame có ${referenceCount} ảnh. Hãy xác nhận ghép thành bảng ảnh hoặc chọn model khác.`)
    }
  }

  const providerUserPrompt = document ? renderPromptDocument(document, mentionedEntities) : prompt
  const renderedContextFields = resolutions.filter(result => result.document !== document).map(result => renderPromptDocument(result.document, result.entities))
  const composed =
    request.data.projectId || speakerId
      ? composeForContext(
          db,
          userId,
          request.data.projectId ?? null,
          speakerId,
          model.kind,
          providerUserPrompt,
          scene?.dialogue ?? '',
          {
            hasSourceImages: sourceImages.length > 0,
            hasCharacterReference: characterReferences.length > 0,
            castIds: orderedCast,
            frozenCharacters: request.resolvedContextEntities?.filter(entity => entity.kind === 'character'),
            background: scene?.background ?? '',
            location: location ? { id: location.id, name: location.name, stage: location.stage, description: location.description, continuityNotes: location.continuity_notes, revision: location.revision, referenceUploadId: location.reference_upload_id } : undefined,
            hasLocationReference: Boolean(model.kind === 'image' && request.data.locationId && locationSourceId),
          },
        )
      : null

  const entityContext = resolutions.map(result => result.context).filter(Boolean).join('\n')
  const finalPrompt = [entityContext, composed?.effectivePrompt ?? providerUserPrompt, ...renderedContextFields.map(text => `Mô tả đã gắn ID: ${text}`)].filter(Boolean).join('\n\n')
  if (finalPrompt.length > 16000) throw badRequest('Mô tả tổng hợp tối đa 16000 ký tự')
  if (model.kind === 'video' && videoStyle === 'openai' && characterReferences.length > 1) referenceWarnings.push('Video chỉ gửi ảnh nhân vật chính; các nhân vật còn lại được mô tả bằng văn bản.')
  if (model.kind === 'video' && videoStyle === 'agnes' && !temporaryRefs.length && mentionedEntities.some(entity => entity.reference)) referenceWarnings.push('Agnes chưa nhận ảnh thư viện riêng tư trong request này; chỉ mô tả được gửi. Chọn chế độ URL tạm ở bước preview khi hạ tầng HTTPS công khai đã cấu hình.')
  const manifest = mentionedEntities.map(entity => ({ id: entity.id, kind: entity.kind, name: entity.name, handle: entity.handle, revision: entity.revision,
    referenceMode: overlayIds.has(entity.id) ? 'overlay' : !entity.reference ? 'description-only' : temporaryRefs.some(ref => ref.id === entity.id && ref.kind === entity.kind) ? 'sent' : model.kind === 'image' && (sourceImages.some(ref => ref.path === entity.reference!.path) || characterReferences.some(ref => ref.path === entity.reference!.path)) ? 'sent' : entity.kind === 'character' && entity.id === speakerId && videoStyle === 'openai' && useReference ? 'sent' : 'description-only',
    reference: entity.reference,
  }))
  if (options.previewOnly) return { prompt: finalPrompt, entities: manifest.map(({ reference: _reference, ...entity }) => entity), referenceCount: model.kind === 'video' ? (videoStyle === 'higgsfield' ? ['image', 'endImage'].filter(prefix => ['Url', 'UploadId', 'AssetId'].some(suffix => effectiveParams[`${prefix}${suffix}`])).length : videoInput ? 1 + temporaryRefs.length + (videoStyle === 'agnes' && effectiveParams.mode === 'reference' ? (params.referenceImages?.length ?? 0) : 0) : temporaryRefs.length ? temporaryRefs.length + (params.referenceImages?.length ?? 0) : videoStyle === 'openai' && characterReferences.length ? 1 : 0) : sourceImages.length + characterReferences.length, maxReferenceCount: model.kind === 'video' ? (videoStyle === 'higgsfield' ? 2 : videoStyle === 'agnes' ? (model.modelId.toLowerCase().includes('flash') ? 5 : env.MAX_SOURCE_IMAGES) : 1) : env.MAX_SOURCE_IMAGES, warnings: referenceWarnings, overlays: overlaySpecs }

  if (videoStyle === 'agnes' && composed?.snapshot.character) {
    composed.snapshot.character.hasReference = false
  }

  // Giới hạn số tác vụ đang chạy đồng thời của mỗi người.
  const active = db
    .prepare(
      "SELECT COUNT(*) AS total FROM generations WHERE user_id = ? AND deleted_at IS NULL AND status IN ('queued','running','downloading')",
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
  effectiveParams = { ...effectiveParams, ...(temporaryMedia ? { allowTemporaryMedia: true } : {}), ...(overlaySpecs.length ? { logoOverlays: overlaySpecs } : {}) }
  if (temporaryRefs.length) effectiveParams.referenceImages = params.referenceImages ?? []

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
    finalPrompt,
    JSON.stringify({ ...(composed?.snapshot ?? {}), ...(request.canvas ? { canvas: request.canvas } : {}), contextDocuments: documents, entities: manifest, warnings: referenceWarnings }),
    sourceImages.length ? JSON.stringify(sourceImages) : null,
    model.imageApiStyle ?? 'openai',
    // Cột cũ (một đối tượng đơn) giữ lại để rollback; cột mảng là nguồn sự thật.
    characterReferences.length ? JSON.stringify(characterReferences[0]) : null,
    characterReferences.length ? JSON.stringify(characterReferences) : null,
    quickSession?.id ?? null,
    videoStyle,
  )

  if (imageSettings) db.prepare('UPDATE generations SET snap_image_reference_transport = ?, snap_image_max_references = ? WHERE id = ?')
    .run(imageSettings.transport, imageSettings.maxReferences, id)
  if (videoStyle === 'higgsfield') db.prepare("UPDATE generations SET snap_auth_scheme = 'higgsfield' WHERE id = ?").run(id)
  db.prepare('UPDATE generations SET prompt_document_json=?,entity_references_json=?,logo_overlays_json=? WHERE id=?').run(document ? JSON.stringify(document) : null, manifest.length ? JSON.stringify(manifest) : null, resolvedOverlays.length ? JSON.stringify(resolvedOverlays) : null, id)

  if (temporaryRefs.length || temporaryVideoInput) {
    try {
      const store = options.mediaStore ?? createMediaStore({ root: env.MEDIA_DIR, maxImageBytes: env.MAX_IMAGE_BYTES, maxVideoBytes: env.MAX_VIDEO_BYTES, maxUserBytes: env.MAX_USER_MEDIA_BYTES })
      const urls = temporaryRefs.map(entity => issueMediaGrant({ db, appOrigin: env.APP_ORIGIN, userId, generationId: id, path: entity.reference!.path, mime: entity.reference!.mime, mediaStore: store, ttlMs: grantTtlMs }).url)
      effectiveParams.referenceImages = [...(params.referenceImages ?? []), ...urls]
      if (temporaryVideoInput) {
        const url = issueMediaGrant({ db, appOrigin: env.APP_ORIGIN, userId, generationId: id, path: temporaryVideoInput.path, mime: temporaryVideoInput.mime, mediaStore: store, ttlMs: grantTtlMs }).url
        if (effectiveParams.mode === 'keyframe') effectiveParams.firstFrame = url
        else effectiveParams.referenceImages = [...(effectiveParams.referenceImages as string[]), url]
      }
      db.prepare('UPDATE generations SET params_json=? WHERE id=?').run(JSON.stringify(effectiveParams), id)
    } catch (error) {
      db.prepare('DELETE FROM generations WHERE id=?').run(id)
      throw error
    }
  }

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

  if (!worker) throw new Error('Generation enqueue requires a worker')
  worker.wake()
  return { generation: created, reused: false }
}
