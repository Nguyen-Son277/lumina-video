import { randomUUID } from 'node:crypto'
import express, { Router } from 'express'
import type { AppEnv } from '../env'
import type { Database } from '../db/index'
import type { MediaStore } from '../media/store'
import { requireUser } from '../auth/middleware'
import { badRequest } from '../lib/errors'
import { characterSchema, characterPatchSchema } from '../projects/schemas'
import {
  characterPublic,
  ownedCharacterById,
  transaction,
  type CharacterRow,
} from '../projects/service'

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

  router.get('/', (req, res) => {
    const user = requireUser(req)
    res.json({ characters: listForUser(user.id).map(characterPublic) })
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

    // Nhân vật đang được cảnh sử dụng thì phải gỡ khỏi cảnh trước.
    const linked = db.prepare('SELECT id FROM scenes WHERE character_id = ? LIMIT 1').get(old.id)
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
   * Ảnh tham chiếu được phục vụ tại `/api/characters/:id/reference` (media/routes.ts)
   * cho cả nhân vật dự án lẫn nhân vật thư viện, sau khi kiểm tra quyền sở hữu.
   */
  return router
}
