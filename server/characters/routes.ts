import { randomUUID } from 'node:crypto'
import express, { Router } from 'express'
import { z } from 'zod'
import type { AppEnv } from '../env'
import type { Database } from '../db/index'
import type { MediaStore } from '../media/store'
import { requireUser } from '../auth/middleware'
import { badRequest, notFound } from '../lib/errors'
import { createRateLimiter } from '../lib/rateLimit'
import { characterSchema, characterPatchSchema } from '../projects/schemas'
import type { GenerationRow } from '../generations/types'
import { composeCharacterPrompt } from './prompt'
import {
  characterPublic,
  ownedCharacterById,
  transaction,
  type CharacterRow,
} from '../projects/service'
import {
  DEFAULT_GENERATE_COUNT,
  MAX_DESCRIPTION_LENGTH,
  MAX_GENERATE_COUNT,
  generateCharacterCandidates,
} from './generate'

/** Yêu cầu sinh nhân vật mẫu bằng AI từ mô tả của người dùng. */
const generateSchema = z.object({
  description: z
    .string()
    .trim()
    .min(1, 'Vui lòng nhập mô tả nhân vật')
    .max(MAX_DESCRIPTION_LENGTH, `Mô tả tối đa ${MAX_DESCRIPTION_LENGTH} ký tự`),
  count: z.number().int().min(1).max(MAX_GENERATE_COUNT).default(DEFAULT_GENERATE_COUNT),
  language: z.string().trim().min(1).max(50).default('vi'),
  connectionId: z.string().trim().min(1).optional(),
})

/** Gắn một ảnh đã tạo vào nhân vật làm ảnh tham chiếu. */
const attachReferenceSchema = z.object({
  generationId: z.string().trim().min(1, 'Thiếu tác vụ tạo ảnh'),
  assetId: z.string().trim().min(1).optional(),
})

/**
 * Thư viện nhân vật dùng chung của tài khoản.
 *
 * Nhân vật có `project_id IS NULL` không thuộc dự án nào nên dùng được cho cả
 * "Tạo nội dung đơn lẻ" lẫn mọi dự án. Ảnh tham chiếu nằm trong kho media riêng
 * tư và chỉ phục vụ qua endpoint có kiểm tra quyền sở hữu.
 */
export function characterRoutes(db: Database, mediaStore: MediaStore, env: AppEnv): Router {
  const router = Router()

  const rawImage = express.raw({
    type: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    limit: env.MAX_REFERENCE_BYTES,
  })

  function listForUser(userId: string): CharacterRow[] {
    return db
      .prepare('SELECT * FROM characters WHERE user_id = ? ORDER BY created_at ASC, id')
      .all(userId) as unknown as CharacterRow[]
  }

  // Sinh nhân vật gọi LLM (tốn token của người dùng) nên cần giới hạn tần suất.
  const generateLimiter = createRateLimiter({
    windowMs: 60_000,
    max: env.RATE_LIMIT_LLM_CHAT_PER_MIN || Number.MAX_SAFE_INTEGER,
  })

  router.get('/', (req, res) => {
    const user = requireUser(req)
    res.json({ characters: listForUser(user.id).map(characterPublic) })
  })

  /**
   * Sinh vài nhân vật mẫu bằng AI từ mô tả, để người dùng chọn một và thêm vào
   * thư viện. **Không lưu gì**: chỉ trả ứng viên cho giao diện xem trước.
   *
   * Khai báo trước các route `/:id` để không bị bắt nhầm thành `id`.
   */
  router.post('/generate', async (req, res) => {
    const user = requireUser(req)

    if (!generateLimiter.check(`character-generate:${user.id}`)) {
      throw badRequest('Bạn tạo quá nhanh. Vui lòng đợi một lát rồi thử lại.')
    }

    const parsed = generateSchema.safeParse(req.body)
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Dữ liệu không hợp lệ')
    }

    const result = await generateCharacterCandidates({
      db,
      env,
      userId: user.id,
      description: parsed.data.description,
      count: parsed.data.count,
      language: parsed.data.language,
      connectionId: parsed.data.connectionId,
    })

    res.json(result)
  })

  /** Tạo nhân vật thư viện (không gắn dự án). */
  router.post('/', (req, res) => {
    const user = requireUser(req)
    const parsed = characterSchema.safeParse(req.body)
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Dữ liệu không hợp lệ')
    }

    const id = randomUUID()
    const now = Date.now()
    db.prepare(
      `INSERT INTO characters
         (id, user_id, project_id, name, appearance, voice_json, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
    ).run(id, user.id, parsed.data.name, parsed.data.appearance, JSON.stringify(parsed.data.voice), now, now)

    res.status(201).json({ character: characterPublic(ownedCharacterById(db, user.id, id)) })
  })

  router.get('/:id', (req, res) => {
    const user = requireUser(req)
    res.json({ character: characterPublic(ownedCharacterById(db, user.id, req.params.id)) })
  })

  /**
   * Prompt hoàn chỉnh của nhân vật để người dùng mang sang công cụ khác.
   * Chỉ ghép từ dữ liệu đã lưu, không gọi LLM.
   */
  router.get('/:id/prompt', (req, res) => {
    const user = requireUser(req)
    const character = ownedCharacterById(db, user.id, req.params.id)
    res.json({ prompt: composeCharacterPrompt(character), character: characterPublic(character) })
  })

  router.patch('/:id', (req, res) => {
    const user = requireUser(req)
    const old = ownedCharacterById(db, user.id, req.params.id)
    const parsed = characterPatchSchema.safeParse(req.body)
    if (!parsed.success) throw badRequest('Dữ liệu không hợp lệ')

    const next = { ...characterPublic(old), ...parsed.data }
    db.prepare(
      'UPDATE characters SET name = ?, appearance = ?, voice_json = ?, updated_at = ? WHERE id = ?',
    ).run(next.name, next.appearance, JSON.stringify(next.voice), Date.now(), old.id)

    res.json({ character: characterPublic(ownedCharacterById(db, user.id, old.id)) })
  })

  router.delete('/:id', (req, res) => {
    const user = requireUser(req)
    const old = ownedCharacterById(db, user.id, req.params.id)

    // Nhân vật đang được cảnh sử dụng thì phải gỡ khỏi cảnh trước. Kiểm tra cả
    // người nói chính (scenes.character_id) lẫn danh sách nhân vật của cảnh.
    const linked = db
      .prepare(
        `SELECT s.id FROM scenes s WHERE s.character_id = ?
         UNION ALL
         SELECT sc.scene_id FROM scene_characters sc WHERE sc.character_id = ?
         LIMIT 1`,
      )
      .get(old.id, old.id)
    if (linked) {
      throw badRequest('Nhân vật đang được cảnh sử dụng. Gỡ nhân vật khỏi cảnh trước khi xóa.')
    }

    mediaStore.removeCharacterReference(user.id, old.id)
    transaction(db, () => {
      db.prepare('DELETE FROM characters WHERE id = ? AND user_id = ?').run(old.id, user.id)
    })
    res.status(204).end()
  })

  /** Tải lên (hoặc thay thế) ảnh tham chiếu; nhận dạng bằng magic bytes. */
  router.post('/:id/reference', rawImage, (req, res) => {
    const user = requireUser(req)
    const character = ownedCharacterById(db, user.id, req.params.id)

    const body = req.body as Buffer | undefined
    if (!body || body.byteLength === 0) {
      throw badRequest('Không nhận được nội dung ảnh tham chiếu')
    }

    const saved = mediaStore.saveCharacterReference({
      userId: user.id,
      characterId: character.id,
      bytes: new Uint8Array(body),
      declaredMime: req.get('content-type')?.split(';')[0]?.trim(),
      maxBytes: env.MAX_REFERENCE_BYTES,
    })

    db.prepare(
      'UPDATE characters SET reference_path = ?, reference_mime = ?, reference_bytes = ?, updated_at = ? WHERE id = ?',
    ).run(saved.relativePath, saved.mimeType, saved.byteSize, Date.now(), character.id)

    res.status(201).json({ character: characterPublic(ownedCharacterById(db, user.id, character.id)) })
  })

  router.delete('/:id/reference', (req, res) => {
    const user = requireUser(req)
    const character = ownedCharacterById(db, user.id, req.params.id)

    mediaStore.removeCharacterReference(user.id, character.id)
    db.prepare(
      'UPDATE characters SET reference_path = NULL, reference_mime = NULL, reference_bytes = NULL, updated_at = ? WHERE id = ?',
    ).run(Date.now(), character.id)

    res.json({ character: characterPublic(ownedCharacterById(db, user.id, character.id)) })
  })

  /**
   * Gắn một ảnh đã tạo (generation) làm ảnh tham chiếu của nhân vật.
   *
   * Ảnh được sao chép ngay trên server từ kho media của tác vụ sang thư mục ảnh
   * tham chiếu, nên không cần tải vòng qua trình duyệt. Nhờ vậy ảnh minh hoạ do
   * AI sinh ra trở thành ảnh tham chiếu thật của nhân vật.
   */
  router.post('/:id/reference/from-generation', (req, res) => {
    const user = requireUser(req)
    const character = ownedCharacterById(db, user.id, req.params.id)

    const parsed = attachReferenceSchema.safeParse(req.body)
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Dữ liệu không hợp lệ')
    }

    const generation = db
      .prepare('SELECT * FROM generations WHERE id = ? AND user_id = ?')
      .get(parsed.data.generationId, user.id) as unknown as GenerationRow | undefined
    if (!generation) throw notFound('Không tìm thấy tác vụ tạo ảnh')

    if (generation.status !== 'succeeded') {
      throw badRequest('Tác vụ tạo ảnh chưa hoàn tất. Hãy đợi ảnh xong rồi gắn vào nhân vật.')
    }

    const asset = parsed.data.assetId
      ? (db
          .prepare('SELECT relative_path AS path FROM assets WHERE id = ? AND generation_id = ?')
          .get(parsed.data.assetId, generation.id) as { path: string } | undefined)
      : (db
          .prepare(
            'SELECT relative_path AS path FROM assets WHERE generation_id = ? ORDER BY created_at ASC LIMIT 1',
          )
          .get(generation.id) as { path: string } | undefined)

    if (!asset) throw notFound('Tác vụ này không có ảnh nào để gắn')
    if (!mediaStore.exists(asset.path)) {
      throw notFound('Ảnh của tác vụ không còn trên máy chủ')
    }

    const saved = mediaStore.saveCharacterReference({
      userId: user.id,
      characterId: character.id,
      bytes: mediaStore.readFile(asset.path),
      maxBytes: env.MAX_REFERENCE_BYTES,
    })

    db.prepare(
      'UPDATE characters SET reference_path = ?, reference_mime = ?, reference_bytes = ?, updated_at = ? WHERE id = ?',
    ).run(saved.relativePath, saved.mimeType, saved.byteSize, Date.now(), character.id)

    res.status(201).json({
      character: characterPublic(ownedCharacterById(db, user.id, character.id)),
    })
  })

  /**
   * Ảnh tham chiếu được phục vụ tại `/api/characters/:id/reference` (media/routes.ts)
   * cho cả nhân vật dự án lẫn nhân vật thư viện, sau khi kiểm tra quyền sở hữu.
   */
  return router
}
