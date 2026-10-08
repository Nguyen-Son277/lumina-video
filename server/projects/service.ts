import type { Database } from '../db/index'
import { badRequest, notFound } from '../lib/errors'
import type { Voice } from './schemas'

export type ProjectRow = { id: string; user_id: string; name: string; description: string; style: string; language: string; archived: number; created_at: number; updated_at: number }
export type CharacterRow = { id: string; user_id: string; project_id: string | null; name: string; appearance: string; voice_json: string; reference_path: string | null; reference_mime: string | null; reference_bytes: number | null; created_at: number; updated_at: number }
export type SceneRow = { id: string; project_id: string; title: string; prompt: string; character_id: string | null; dialogue: string; model_id: string | null; params_json: string; position: number; selected_generation_id: string | null; created_at: number; updated_at: number }
export function ownedProject(db: Database, userId: string, id: string, active = false): ProjectRow {
  const row = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(id, userId) as ProjectRow | undefined
  if (!row) throw notFound('Không tìm thấy dự án')
  if (active && row.archived) throw badRequest('Dự án đã được lưu trữ')
  return row
}
export function ownedCharacter(db: Database, userId: string, projectId: string, id: string): CharacterRow {
  ownedProject(db, userId, projectId)
  const row = db.prepare('SELECT * FROM characters WHERE id = ? AND project_id = ? AND user_id = ?').get(id, projectId, userId) as CharacterRow | undefined
  if (!row) throw notFound('Không tìm thấy nhân vật')
  return row
}
/** Nhân vật bất kỳ của người dùng: dùng cho thư viện nhân vật dùng chung. */
export function ownedCharacterById(db: Database, userId: string, id: string): CharacterRow {
  const row = db.prepare('SELECT * FROM characters WHERE id = ? AND user_id = ?').get(id, userId) as CharacterRow | undefined
  if (!row) throw notFound('Không tìm thấy nhân vật')
  return row
}
/**
 * Nhân vật dùng được trong một dự án: nhân vật của chính dự án đó hoặc nhân vật
 * thư viện (project_id IS NULL). Dùng khi gắn nhân vật vào cảnh hoặc tác vụ.
 */
export function ownedUsableCharacter(db: Database, userId: string, projectId: string, id: string): CharacterRow {
  ownedProject(db, userId, projectId)
  const row = db.prepare(
    'SELECT * FROM characters WHERE id = ? AND user_id = ? AND (project_id IS NULL OR project_id = ?)',
  ).get(id, userId, projectId) as CharacterRow | undefined
  if (!row) throw notFound('Không tìm thấy nhân vật')
  return row
}
export function ownedScene(db: Database, userId: string, id: string, projectId?: string): SceneRow {
  const row = db.prepare('SELECT s.* FROM scenes s JOIN projects p ON p.id = s.project_id WHERE s.id = ? AND p.user_id = ?').get(id, userId) as SceneRow | undefined
  if (!row || (projectId && row.project_id !== projectId)) throw notFound('Không tìm thấy cảnh')
  return row
}
export function validateModel(db: Database, userId: string, id: string | null) {
  if (id && !db.prepare('SELECT id FROM models WHERE id = ? AND user_id = ?').get(id, userId)) throw badRequest('Model không thuộc tài khoản của bạn')
}
export function validateSelectedGeneration(db: Database, userId: string, sceneId: string, generationId: string | null) {
  if (!generationId) return
  const row = db.prepare("SELECT id FROM generations WHERE id = ? AND user_id = ? AND scene_id = ? AND status = 'succeeded'").get(generationId, userId, sceneId)
  if (!row) throw badRequest('Chỉ có thể chọn tác vụ thành công thuộc cảnh này')
}
export function projectPublic(row: ProjectRow) {
  return { id: row.id, name: row.name, description: row.description, style: row.style, language: row.language, archived: !!row.archived, createdAt: row.created_at, updatedAt: row.updated_at }
}
export function characterPublic(row: CharacterRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    appearance: row.appearance,
    voice: JSON.parse(row.voice_json) as Voice,
    referenceUrl: row.reference_path ? `/api/characters/${row.id}/reference` : null,
    referenceMime: row.reference_mime,
    referenceBytes: row.reference_bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
export function scenePublic(row: SceneRow) {
  return { id: row.id, projectId: row.project_id, title: row.title, prompt: row.prompt, characterId: row.character_id, dialogue: row.dialogue, modelId: row.model_id, params: JSON.parse(row.params_json) as Record<string, unknown>, position: row.position, selectedGenerationId: row.selected_generation_id, createdAt: row.created_at, updatedAt: row.updated_at }
}
/** The parent generation route may override model/prompt/params after validating its own request. */
export function sceneGenerationContext(db: Database, userId: string, sceneId: string) {
  const scene = ownedScene(db, userId, sceneId)
  ownedProject(db, userId, scene.project_id, true)
  return { scene, projectId: scene.project_id, characterId: scene.character_id, prompt: scene.prompt, dialogue: scene.dialogue, modelId: scene.model_id, params: JSON.parse(scene.params_json) as Record<string, unknown> }
}
export function transaction<T>(db: Database, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try { const result = fn(); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error }
}
