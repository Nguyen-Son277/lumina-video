import { randomUUID } from 'node:crypto'
import { isAbsolute, normalize } from 'node:path'
import type { Database } from '../db/index'
import type { MediaStore } from '../media/store'
import { logger } from '../lib/logger'
import { transaction } from '../projects/service'

type Project = { id: string; user_id: string; delete_results: number }
type Cleanup = { id: string; user_id: string; path: string }

/** Cả dữ liệu hoạt động và dữ liệu còn trong thùng rác đều giữ quyền sử dụng file. */
function pathReferenced(db: Database, path: string): boolean {
  for (const [table, column] of [['assets', 'relative_path'], ['uploads', 'relative_path'], ['characters', 'reference_path'], ['exports', 'relative_path']]) {
    if (db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`).get(path)) return true
  }
  const snapshots = db.prepare('SELECT source_images_json, character_reference_json, character_references_json FROM generations').all()
  const plans = db.prepare('SELECT cast_json, timeline_json, plan_json, locations_json FROM plan_sessions').all()
  const exports = db.prepare('SELECT spec_json FROM exports').all()
  return [...snapshots, ...plans, ...exports].some(row => Object.values(row).some(value => typeof value === 'string'
    && (value.includes(path) || value.includes(JSON.stringify(path).slice(1, -1)))))
}

function generationShared(db: Database, id: string, projectId: string): boolean {
  if (db.prepare('SELECT 1 FROM scenes WHERE project_id <> ? AND selected_generation_id = ? LIMIT 1').get(projectId, id)) return true
  if (db.prepare('SELECT 1 FROM project_canvas_links WHERE project_id <> ? AND generation_id=? LIMIT 1').get(projectId, id)) return true
  if (db.prepare('SELECT 1 FROM plan_image_batch_items WHERE generation_id = ? LIMIT 1').get(id)) return true
  const assets = db.prepare('SELECT id, relative_path FROM assets WHERE generation_id = ?').all(id)
  const refs = [id, ...assets.flatMap(asset => [String(asset.id), String(asset.relative_path)])]
  const snapshots = db.prepare('SELECT source_images_json, character_reference_json, character_references_json FROM generations WHERE id <> ?').all(id)
  const exports = db.prepare('SELECT spec_json FROM exports WHERE project_id <> ?').all(projectId)
  const plans = db.prepare('SELECT cast_json, timeline_json, plan_json, locations_json FROM plan_sessions').all()
  return [...exports, ...plans, ...snapshots].some(row => Object.values(row).some(value =>
    typeof value === 'string' && refs.some(ref => value.includes(ref))))
}

/** Dọn một dự án đã được xác nhận; caller kiểm tra tác vụ còn hoạt động. */
export function purgeProject(db: Database, project: Project, now: number): void {
  transaction(db, () => {
    const queue = (targetId: string, path: unknown): void => {
      if (typeof path !== 'string' || !path) return
      db.prepare(`INSERT INTO media_cleanup_jobs (id,user_id,kind,target_id,path,created_at,last_error)
        VALUES (?,?,'path',?,?,?,NULL)`).run(randomUUID(), project.user_id, targetId, path, now)
    }
    for (const item of db.prepare('SELECT id, relative_path FROM exports WHERE project_id = ?').all(project.id)) queue(String(item.id), item.relative_path)
    const generations = project.delete_results
      ? db.prepare('SELECT id FROM generations WHERE (project_id = ? OR scene_id IN (SELECT id FROM scenes WHERE project_id = ?)) AND deleted_at IS NULL').all(project.id, project.id)
      : []
    // Canvas của dự án sẽ bị cascade; bỏ trước để không nhầm là nguồn đang dùng.
    db.prepare('DELETE FROM project_canvases WHERE project_id=?').run(project.id)
    db.prepare('DELETE FROM project_canvas_links WHERE project_id=?').run(project.id)
    db.prepare('DELETE FROM scenes WHERE project_id = ?').run(project.id)
    for (const character of db.prepare('SELECT id, reference_path, deleted_at FROM characters WHERE project_id = ?').all(project.id)) {
      const id = String(character.id)
      if (character.deleted_at != null
        || db.prepare('SELECT 1 FROM scenes WHERE character_id = ? UNION SELECT 1 FROM scene_characters WHERE character_id = ? UNION SELECT 1 FROM project_canvas_links WHERE character_id=? LIMIT 1').get(id, id, id)) {
        // Nhân vật đã xoá riêng vẫn giữ đủ thời hạn độc lập sau khi dự án mất.
        db.prepare('UPDATE characters SET project_id = NULL WHERE id = ?').run(id)
      } else {
        queue(id, character.reference_path)
        db.prepare('DELETE FROM characters WHERE id = ?').run(id)
      }
    }
    for (const generation of generations) {
      const id = String(generation.id)
      if (generationShared(db, id, project.id)) continue
      for (const asset of db.prepare('SELECT relative_path FROM assets WHERE generation_id = ?').all(id)) queue(id, asset.relative_path)
      db.prepare('DELETE FROM generations WHERE id = ?').run(id)
    }
    // FK SET NULL giữ các kết quả còn lại (kể cả mục có hạn riêng) và phiên kịch bản.
    db.prepare('DELETE FROM projects WHERE id = ? AND user_id=?').run(project.id, project.user_id)
  })
}

export function cleanMediaJobs(options: { db: Database; mediaStore: Pick<MediaStore, 'removeByPath'>; now?: number; limit?: number }) {
  const { db, mediaStore } = options, now = options.now ?? Date.now(), limit = options.limit ?? 100
  const result = { cleaned: 0, failed: 0 }
  for (const job of db.prepare('SELECT id, user_id, path FROM media_cleanup_jobs ORDER BY created_at, id LIMIT ?').all(limit) as Cleanup[]) {
    try {
      const path = normalize(job.path)
      if (isAbsolute(path) || !path.startsWith(`${job.user_id}/`) || path.includes('..')) throw new Error('Unsafe cleanup path')
      if (pathReferenced(db, job.path)) {
        db.prepare('UPDATE media_cleanup_jobs SET created_at = ? WHERE id = ?').run(now + 1, job.id)
        continue
      }
      mediaStore.removeByPath(job.path)
      db.prepare('DELETE FROM media_cleanup_jobs WHERE id = ?').run(job.id)
      result.cleaned++
    } catch (error) {
      db.prepare('UPDATE media_cleanup_jobs SET last_error = ?, created_at = ? WHERE id = ?').run(String(error).slice(0, 500), now + 1, job.id)
      result.failed++
    }
  }
  return result
}

/** API tương thích cho các test/đường gọi cũ; worker dùng maintainTrash chung. */
export function maintainProjectTrash(options: { db: Database; mediaStore: Pick<MediaStore, 'removeByPath'>; now?: number; limit?: number }) {
  const { db } = options, now = options.now ?? Date.now(), limit = options.limit ?? 100
  const result = { purged: 0, cleaned: 0, failed: 0 }
  const projects = db.prepare('SELECT id,user_id,delete_results FROM projects WHERE deleted_at IS NOT NULL AND purge_after<=? ORDER BY purge_after,id LIMIT ?').all(now, limit) as Project[]
  for (const project of projects) {
    if (db.prepare("SELECT 1 FROM generations WHERE project_id=? AND status IN ('queued','running','downloading','unknown') LIMIT 1").get(project.id)
      || db.prepare("SELECT 1 FROM exports WHERE project_id=? AND status IN ('queued','running') LIMIT 1").get(project.id)
      || db.prepare("SELECT 1 FROM generations g JOIN plan_image_batch_items i ON i.generation_id=g.id JOIN plan_image_batches b ON b.id=i.batch_id JOIN plan_sessions s ON s.id=b.session_id WHERE s.project_id=? AND g.status IN ('queued','running','downloading','unknown') LIMIT 1").get(project.id)) continue
    try { purgeProject(db, project, now); result.purged++ }
    catch (error) { result.failed++; logger.warn('Không thể dọn dự án trong thùng rác', { projectId: project.id, message: String(error) }) }
  }
  const cleanup = cleanMediaJobs(options)
  result.cleaned = cleanup.cleaned; result.failed += cleanup.failed
  return result
}
