import { randomUUID } from 'node:crypto'
import express, { Router } from 'express'
import { z } from 'zod'
import type { Database } from '../db/index'
import type { AppEnv } from '../env'
import type { MediaStore } from '../media/store'
import { requireUser } from '../auth/middleware'
import { badRequest } from '../lib/errors'
import { composeForContext } from '../generations/promptComposer'
import { characterSchema, characterPatchSchema, projectSchema, projectPatchSchema, sceneSchema, scenePatchSchema } from './schemas'
import { ownedProject, ownedCharacter, ownedUsableCharacter, ownedScene, projectPublic, characterPublic, scenePublic, transaction, validateModel, validateSelectedGeneration, type CharacterRow, type SceneRow, type ProjectRow } from './service'

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw badRequest(result.error.issues[0]?.message ?? 'Dữ liệu không hợp lệ')
  return result.data
}
export function projectRoutes(db: Database, mediaStore: MediaStore, env: AppEnv): Router {
  const router = Router()

  /**
   * Nhận ảnh tham chiếu dạng nhị phân thô. Dùng express.raw thay vì JSON base64
   * để tránh phình dữ liệu và để giới hạn kích thước riêng cho ảnh.
   */
  const rawImage = express.raw({
    type: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    limit: env.MAX_REFERENCE_BYTES,
  })
  const scenes = (projectId: string) => db.prepare('SELECT * FROM scenes WHERE project_id = ? ORDER BY position, id').all(projectId) as SceneRow[]
  const normalize = (projectId: string) => scenes(projectId).forEach((s, i) => db.prepare('UPDATE scenes SET position = ? WHERE id = ?').run(i, s.id))
  router.get('/projects', (req, res) => {
    const user = requireUser(req)
    const rows = db.prepare('SELECT * FROM projects WHERE user_id = ? ORDER BY created_at DESC, id').all(user.id) as ProjectRow[]
    res.json({ projects: rows.map(projectPublic) })
  })
  router.post('/projects', (req, res) => {
    const user = requireUser(req), data = parse(projectSchema, req.body), id = randomUUID(), now = Date.now()
    db.prepare('INSERT INTO projects (id,user_id,name,description,style,language,archived,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id,user.id,data.name,data.description,data.style,data.language,Number(data.archived),now,now)
    res.status(201).json({ project: projectPublic(ownedProject(db,user.id,id)) })
  })
  router.get('/projects/:id', (req,res) => res.json({ project: projectPublic(ownedProject(db,requireUser(req).id,req.params.id)) }))
  router.patch('/projects/:id', (req,res) => {
    const user = requireUser(req), old = ownedProject(db,user.id,req.params.id), data = parse(projectPatchSchema,req.body)
    const next = { ...projectPublic(old), ...data }
    db.prepare('UPDATE projects SET name=?,description=?,style=?,language=?,archived=?,updated_at=? WHERE id=?').run(next.name,next.description,next.style,next.language,Number(next.archived),Date.now(),old.id)
    res.json({ project: projectPublic(ownedProject(db,user.id,old.id)) })
  })
  router.delete('/projects/:id', (req,res) => {
    const user = requireUser(req), row = ownedProject(db,user.id,req.params.id)
    db.prepare('UPDATE projects SET archived=1,updated_at=? WHERE id=?').run(Date.now(),row.id)
    res.status(204).end()
  })
  router.get('/projects/:id/characters', (req,res) => {
    ownedProject(db,requireUser(req).id,req.params.id)
    // Gồm nhân vật của dự án và nhân vật thư viện dùng chung (project_id IS NULL).
    const rows = db.prepare(
      'SELECT * FROM characters WHERE (project_id = ? OR project_id IS NULL) AND user_id = ? ORDER BY created_at, id',
    ).all(req.params.id, requireUser(req).id) as CharacterRow[]
    res.json({ characters: rows.map(characterPublic) })
  })
  router.post('/projects/:id/characters', (req,res) => {
    const user = requireUser(req), project = ownedProject(db,user.id,req.params.id,true), data = parse(characterSchema,req.body), id = randomUUID(), now = Date.now()
    db.prepare('INSERT INTO characters (id,user_id,project_id,name,appearance,voice_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id,user.id,project.id,data.name,data.appearance,JSON.stringify(data.voice),now,now)
    res.status(201).json({ character: characterPublic(ownedCharacter(db,user.id,project.id,id)) })
  })
  router.get('/projects/:id/characters/:characterId', (req,res) => res.json({ character: characterPublic(ownedCharacter(db,requireUser(req).id,req.params.id,req.params.characterId)) }))
  router.patch('/projects/:id/characters/:characterId', (req,res) => {
    const user = requireUser(req); ownedProject(db,user.id,req.params.id,true)
    const old = ownedCharacter(db,user.id,req.params.id,req.params.characterId), data = parse(characterPatchSchema,req.body), next = { ...characterPublic(old), ...data }
    db.prepare('UPDATE characters SET name=?,appearance=?,voice_json=?,updated_at=? WHERE id=?').run(next.name,next.appearance,JSON.stringify(next.voice),Date.now(),old.id)
    res.json({ character: characterPublic(ownedCharacter(db,user.id,req.params.id,old.id)) })
  })
  router.delete('/projects/:id/characters/:characterId', (req,res) => {
    const user = requireUser(req); ownedProject(db,user.id,req.params.id,true)
    const old = ownedCharacter(db,user.id,req.params.id,req.params.characterId)
    const linked = db.prepare('SELECT id FROM scenes WHERE character_id=? LIMIT 1').get(old.id)
    if (linked) throw badRequest('Nhân vật đang được cảnh sử dụng. Gỡ nhân vật khỏi cảnh trước khi xóa.')
    mediaStore.removeCharacterReference(user.id, old.id)
    db.prepare('DELETE FROM characters WHERE id=?').run(old.id); res.status(204).end()
  })

  /** Tải lên (hoặc thay thế) ảnh tham chiếu của nhân vật. */
  router.post('/projects/:id/characters/:characterId/reference', rawImage, (req, res) => {
    const user = requireUser(req)
    ownedProject(db, user.id, req.params.id, true)
    const character = ownedCharacter(db, user.id, req.params.id, req.params.characterId)

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
      'UPDATE characters SET reference_path=?, reference_mime=?, reference_bytes=?, updated_at=? WHERE id=?',
    ).run(saved.relativePath, saved.mimeType, saved.byteSize, Date.now(), character.id)

    res.status(201).json({
      character: characterPublic(ownedCharacter(db, user.id, req.params.id, character.id)),
    })
  })

  router.delete('/projects/:id/characters/:characterId/reference', (req, res) => {
    const user = requireUser(req)
    ownedProject(db, user.id, req.params.id, true)
    const character = ownedCharacter(db, user.id, req.params.id, req.params.characterId)

    mediaStore.removeCharacterReference(user.id, character.id)
    db.prepare(
      'UPDATE characters SET reference_path=NULL, reference_mime=NULL, reference_bytes=NULL, updated_at=? WHERE id=?',
    ).run(Date.now(), character.id)

    res.json({
      character: characterPublic(ownedCharacter(db, user.id, req.params.id, character.id)),
    })
  })
  router.get('/projects/:id/scenes', (req,res) => {
    ownedProject(db,requireUser(req).id,req.params.id); res.json({ scenes: scenes(req.params.id).map(scenePublic) })
  })
  router.post('/projects/:id/scenes', (req,res) => {
    const user = requireUser(req), project = ownedProject(db,user.id,req.params.id,true), data = parse(sceneSchema,req.body), id = randomUUID(), now = Date.now()
    if (data.characterId) ownedUsableCharacter(db,user.id,project.id,data.characterId)
    validateModel(db,user.id,data.modelId)
    if (data.selectedGenerationId) throw badRequest('Cảnh mới chưa có tác vụ để chọn')
    transaction(db, () => {
      const count = scenes(project.id).length, position = data.position ?? count
      if (position > count) throw badRequest('Vị trí cảnh không hợp lệ')
      db.prepare('UPDATE scenes SET position=position+1 WHERE project_id=? AND position>=?').run(project.id,position)
      db.prepare('INSERT INTO scenes (id,project_id,title,prompt,character_id,dialogue,model_id,params_json,position,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,project.id,data.title,data.prompt,data.characterId,data.dialogue,data.modelId,JSON.stringify(data.params),position,now,now)
    })
    res.status(201).json({ scene: scenePublic(ownedScene(db,user.id,id)) })
  })
  router.post('/projects/:id/scenes/reorder', (req,res) => {
    const user = requireUser(req), project = ownedProject(db,user.id,req.params.id,true)
    const { sceneIds } = parse(z.object({ sceneIds: z.array(z.string().min(1)) }).strict(),req.body)
    transaction(db, () => {
      const existing = scenes(project.id).map(s => s.id), unique = new Set(sceneIds)
      if (existing.length !== sceneIds.length || unique.size !== sceneIds.length || existing.some(id => !unique.has(id))) throw badRequest('Thứ tự phải chứa đầy đủ mỗi cảnh đúng một lần')
      const now = Date.now()
      sceneIds.forEach((id,i) => db.prepare('UPDATE scenes SET position=?,updated_at=? WHERE id=? AND project_id=?').run(i,now,id,project.id))
    })
    res.json({ scenes: scenes(project.id).map(scenePublic) })
  })
  router.get('/projects/:id/scenes/:sceneId', (req,res) => res.json({ scene: scenePublic(ownedScene(db,requireUser(req).id,req.params.sceneId,req.params.id)) }))
  router.patch('/projects/:id/scenes/:sceneId', (req,res) => {
    const user = requireUser(req); ownedProject(db,user.id,req.params.id,true)
    const old = ownedScene(db,user.id,req.params.sceneId,req.params.id), data = parse(scenePatchSchema,req.body), next = { ...scenePublic(old), ...data }
    if (next.characterId) ownedUsableCharacter(db,user.id,old.project_id,next.characterId)
    validateModel(db,user.id,next.modelId)
    if (data.selectedGenerationId !== undefined) validateSelectedGeneration(db,user.id,old.id,data.selectedGenerationId)
    db.prepare('UPDATE scenes SET title=?,prompt=?,character_id=?,dialogue=?,model_id=?,params_json=?,selected_generation_id=?,updated_at=? WHERE id=?').run(next.title,next.prompt,next.characterId,next.dialogue,next.modelId,JSON.stringify(next.params),next.selectedGenerationId,Date.now(),old.id)
    res.json({ scene: scenePublic(ownedScene(db,user.id,old.id)) })
  })
  router.delete('/projects/:id/scenes/:sceneId', (req,res) => {
    const user = requireUser(req); ownedProject(db,user.id,req.params.id,true)
    const old = ownedScene(db,user.id,req.params.sceneId,req.params.id)
    transaction(db, () => { db.prepare('DELETE FROM scenes WHERE id=?').run(old.id); normalize(old.project_id) })
    res.status(204).end()
  })
  router.post('/scenes/:id/preview-prompt', (req,res) => {
    const user = requireUser(req), scene = ownedScene(db,user.id,req.params.id)
    const data = parse(z.object({ kind: z.enum(['image','video']).optional(), prompt: z.string().max(8000).optional(), dialogue: z.string().max(4000).optional() }).strict(),req.body ?? {})
    const model = scene.model_id ? db.prepare('SELECT kind FROM models WHERE id=? AND user_id=?').get(scene.model_id,user.id) as { kind: string } | undefined : undefined
    const kind = data.kind ?? (model?.kind === 'image' ? 'image' : 'video')
    res.json(composeForContext(db,user.id,scene.project_id,scene.character_id,kind,data.prompt ?? scene.prompt,data.dialogue ?? scene.dialogue))
  })
  router.post('/scenes/:id/select-generation', (req,res) => {
    const user = requireUser(req), scene = ownedScene(db,user.id,req.params.id)
    ownedProject(db,user.id,scene.project_id,true)
    const { generationId } = parse(z.object({ generationId: z.string().min(1).nullable() }).strict(),req.body)
    validateSelectedGeneration(db,user.id,scene.id,generationId)
    db.prepare('UPDATE scenes SET selected_generation_id=?,updated_at=? WHERE id=?').run(generationId,Date.now(),scene.id)
    res.json({ scene: scenePublic(ownedScene(db,user.id,scene.id)) })
  })
  return router
}
