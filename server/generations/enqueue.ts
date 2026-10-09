import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AppEnv } from '../env'
import type { Database } from '../db/index'
import { badRequest } from '../lib/errors'
import { ownedCharacterById, ownedUsableCharacter } from '../projects/service'
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
  })
  .default({})

export const enqueueSchema = z.object({
  projectId: z.string().optional(),
  characterId: z.string().optional(),
  modelId: z.string().min(1, 'Vui lòng chọn model'),
  prompt: z.string().trim().min(1, 'Vui lòng nhập mô tả').max(8000),
  params: generationParamsSchema,
  idempotencyKey: z.string().max(100).optional(),
  /** Id ảnh nguồn đã tải lên trước đó, dùng để tạo ảnh mới từ ảnh đó. */
  sourceUploadIds: z.array(z.string().min(1)).max(16).optional(),
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
}

export type EnqueueRequest = {
  data: EnqueuePayload
  /** Có giá trị khi tạo từ cảnh: prompt composer nhận thêm lời thoại. */
  scene?: SceneContext | null
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
  const { modelId, prompt, params, idempotencyKey, sourceUploadIds } = request.data

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
        .get(uploadId, userId) as { path: string; mime: string } | undefined
      if (!row) throw badRequest('Ảnh nguồn không tồn tại hoặc không thuộc tài khoản của bạn')
      sourceImages.push({ path: row.path, mime: row.mime })
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
      `SELECT m.id, m.model_id AS modelId, m.kind, m.enabled,
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
  const speakerId = request.data.characterId ?? scene?.speakerId ?? null
  const orderedCast: string[] = []
  for (const id of [speakerId, ...(scene?.castIds ?? [])]) {
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

  const useReference = params.useCharacterReference !== false
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
          },
        )
      : null

  // Giới hạn số tác vụ đang chạy đồng thời của mỗi người.
  const active = db
    .prepare(
      "SELECT COUNT(*) AS total FROM generations WHERE user_id = ? AND status IN ('queued','running','downloading')",
    )
    .get(userId) as { total: number }
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
        source_images_json, snap_image_style, character_reference_json, character_references_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
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
    request.data.projectId ?? null,
    scene?.id ?? null,
    composed?.effectivePrompt ?? null,
    composed ? JSON.stringify(composed.snapshot) : null,
    sourceImages.length ? JSON.stringify(sourceImages) : null,
    model.imageApiStyle ?? 'openai',
    // Cột cũ (một đối tượng đơn) giữ lại để rollback; cột mảng là nguồn sự thật.
    characterReferences.length ? JSON.stringify(characterReferences[0]) : null,
    characterReferences.length ? JSON.stringify(characterReferences) : null,
  )

  const created = db
    .prepare('SELECT * FROM generations WHERE id = ? AND user_id = ?')
    .get(id, userId) as unknown as GenerationRow

  worker.wake()
  return { generation: created, reused: false }
}
