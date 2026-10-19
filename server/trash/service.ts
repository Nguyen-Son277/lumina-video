import { randomUUID } from 'node:crypto'
import type { Database } from '../db/index'
import type { MediaStore } from '../media/store'
import { badRequest, conflict, notFound } from '../lib/errors'
import { assertLibraryAssetIdle, detachInactiveLibraryCanvasNodes, uploadReferenced } from '../entityLibrary/lifecycle'
import { characterUsage, detachCharacterReferences } from '../characters/deletion'
import { transaction } from '../projects/service'
import { purgeProject, cleanMediaJobs } from '../projectsTrash/service'
import { logger } from '../lib/logger'
import { reconcileLocationLibrary } from '../entityLibrary/locationSync'

export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const TRASH_KINDS = ['project', 'character', 'generation', 'plan_session', 'library_asset'] as const
export type TrashKind = typeof TRASH_KINDS[number]
const TABLES: Record<TrashKind, string> = { project: 'projects', character: 'characters', generation: 'generations', plan_session: 'plan_sessions', library_asset: 'library_assets' }
type Row = { id: string; user_id: string; deleted_at: number | null; purge_after: number | null; [key: string]: unknown }
export type TrashItem = { kind: TrashKind; id: string; title: string; subtitle: string; thumbnailUrl: string | null; deletedAt: number; purgeAfter: number; meta: Record<string, unknown> }

export function ownedTrashRow(db: Database, userId: string, kind: TrashKind, id: string): Row {
  const row = db.prepare(`SELECT * FROM ${TABLES[kind]} WHERE id = ? AND user_id = ?`).get(id, userId) as Row | undefined
  if (!row) throw notFound()
  return row
}

export function listTrash(db: Database, userId: string, options: { kind?: TrashKind; limit?: number; offset?: number } = {}) {
  const counts = Object.fromEntries(TRASH_KINDS.map(kind => [kind, Number((db.prepare(`SELECT COUNT(*) AS n FROM ${TABLES[kind]} WHERE user_id = ? AND deleted_at IS NOT NULL`).get(userId) as { n: number }).n)])) as Record<TrashKind, number>
  const kinds = options.kind ? [options.kind] : [...TRASH_KINDS]
  const rows: TrashItem[] = []
  const offset = options.offset ?? 0, limit = options.limit ?? 30
  const selected = db.prepare(kinds.map(kind => `SELECT '${kind}' AS kind,id,deleted_at FROM ${TABLES[kind]} WHERE user_id=? AND deleted_at IS NOT NULL`).join(' UNION ALL ') + ' ORDER BY deleted_at DESC,kind,id LIMIT ? OFFSET ?').all(...kinds.map(() => userId), limit, offset) as Array<{ kind: TrashKind; id: string }>
  for (const item of selected) {
    const kind = item.kind
    const row = ownedTrashRow(db, userId, kind, item.id)
    const title = String(row.name ?? row.title ?? row.prompt ?? '').trim()
    let thumbnailUrl: string | null = null
    if (kind === 'character' && row.reference_path) thumbnailUrl = `/api/characters/${row.id}/reference`
    if (kind === 'generation') {
      const asset = db.prepare('SELECT id FROM assets WHERE generation_id = ? ORDER BY created_at, id LIMIT 1').get(row.id) as { id: string } | undefined
      if (asset && row.kind === 'image') thumbnailUrl = `/api/assets/${asset.id}`
    }
    if (kind === 'library_asset' && row.reference_upload_id && db.prepare('SELECT id FROM uploads WHERE id=? AND user_id=?').get(String(row.reference_upload_id), userId)) thumbnailUrl = `/api/uploads/${row.reference_upload_id}`
    rows.push({ kind, id: row.id, title, subtitle: kind === 'generation' || kind === 'library_asset' ? String(row.kind) : '', thumbnailUrl, deletedAt: Number(row.deleted_at), purgeAfter: Number(row.purge_after), meta: { projectId: row.project_id ?? null, mediaKind: row.kind ?? null } })
  }
  return { items: rows, counts, total: kinds.reduce((total, kind) => total + counts[kind], 0), retentionDays: 30 }
}

/** Không huỷ request provider đang chạy/chưa xác định; thao tác xoá phải đợi đối soát. */
export function assertTrashIdle(db: Database, kind: TrashKind, row: Row, options: { acknowledgeUnknown?: boolean } = {}): void {
  let busy: unknown = false
  if (kind === 'library_asset') { assertLibraryAssetIdle(db, row.user_id, row.id); return }
  if (kind === 'generation') {
    // A trashed unresolved video passed the explicit acknowledgement gate when
    // first hidden. Permit its later purge, but never bypass an active status.
    const acknowledgedUnknown = (options.acknowledgeUnknown === true || (row.kind === 'video' && row.deleted_at != null))
      && ['image', 'video'].includes(String(row.kind)) && row.status === 'unknown' && !row.provider_job_id
    busy = (['queued', 'running', 'downloading', 'unknown'].includes(String(row.status)) && !acknowledgedUnknown) || ['queued', 'running'].includes(String(row.postprocess_status))
    const exports = db.prepare("SELECT spec_json FROM exports WHERE user_id = ? AND status IN ('queued','running')").all(row.user_id)
    busy ||= exports.some(item => String(item.spec_json).includes(row.id))
  } else if (kind === 'plan_session') {
    busy = db.prepare("SELECT 1 FROM plan_image_batches WHERE session_id = ? AND status = 'running' LIMIT 1").get(row.id)
      || db.prepare("SELECT 1 FROM plan_image_batch_items i JOIN plan_image_batches b ON b.id=i.batch_id JOIN generations g ON g.id=i.generation_id WHERE b.session_id=? AND g.status IN ('queued','running','downloading','unknown') LIMIT 1").get(row.id)
  } else if (kind === 'project') {
    busy = db.prepare("SELECT 1 FROM generations WHERE (project_id=? OR scene_id IN (SELECT id FROM scenes WHERE project_id=?)) AND (status IN ('queued','running','downloading','unknown') OR postprocess_status IN ('queued','running')) LIMIT 1").get(row.id, row.id)
      || db.prepare("SELECT 1 FROM exports WHERE project_id=? AND status IN ('queued','running') LIMIT 1").get(row.id)
      || db.prepare("SELECT 1 FROM plan_image_batch_items i JOIN plan_image_batches b ON b.id=i.batch_id JOIN plan_sessions s ON s.id=b.session_id JOIN generations g ON g.id=i.generation_id WHERE s.project_id=? AND g.status IN ('queued','running','downloading','unknown') LIMIT 1").get(row.id)
  }
  if (busy) throw badRequest('Dữ liệu còn tác vụ đang chạy hoặc chưa xác định. Hãy đợi hoặc đối soát trước.', undefined, { messageKey: 'trash.busy' })
}

export function softDelete(db: Database, userId: string, kind: Exclude<TrashKind, 'project'>, id: string, now = Date.now(), options: { acknowledgeUnknown?: boolean } = {}): void {
  const row = ownedTrashRow(db, userId, kind, id)
  if (kind === 'library_asset' && row.source_kind) throw badRequest('Bối cảnh liên kết chỉ được xoá tại nguồn gốc.')
  if (row.deleted_at != null) return // Request lặp không kéo dài thời hạn.
  assertTrashIdle(db, kind, row, options)
  // Existing character routes already wrap their detach + delete in a transaction.
  const update = () => {
    db.prepare(`UPDATE ${TABLES[kind]} SET deleted_at=?,purge_after=?,updated_at=? WHERE id=? AND user_id=? AND deleted_at IS NULL`).run(now, now + TRASH_RETENTION_MS, now, id, userId)
    if (kind === 'library_asset') db.prepare('UPDATE entity_handles SET active=0 WHERE user_id=? AND kind=? AND entity_id=?').run(userId, String(row.kind), id)
  }
  if (kind === 'library_asset') transaction(db, update)
  else update()
  if (kind === 'plan_session') reconcileLocationLibrary(db, userId)
}

export function restoreTrash(db: Database, userId: string, kind: TrashKind, id: string, now = Date.now()): void {
  transaction(db, () => {
    const row = ownedTrashRow(db, userId, kind, id)
    if (row.deleted_at == null) return
    if (!row.purge_after || row.purge_after <= now) throw badRequest('Đã hết thời hạn khôi phục.', undefined, { messageKey: 'trash.expired' })
    if (kind === 'character' && row.project_id) {
      const parent = db.prepare('SELECT deleted_at FROM projects WHERE id=? AND user_id=?').get(String(row.project_id), userId) as { deleted_at: number | null } | undefined
      if (parent?.deleted_at != null) throw badRequest('Hãy khôi phục dự án trước khi khôi phục nhân vật.', undefined, { messageKey: 'trash.parent_required' })
    }
    if (kind === 'library_asset') {
      // Reserve this exact tombstone alias; never adopt another entity or rewrite documents.
      const handle = db.prepare('SELECT id,handle_key FROM entity_handles WHERE user_id=? AND kind=? AND entity_id=?').get(userId, String(row.kind), id) as { id: string; handle_key: string } | undefined
      if (!handle) throw conflict('Không còn handle gốc của vật phẩm để khôi phục')
      const occupied = db.prepare('SELECT id FROM entity_handles WHERE user_id=? AND handle_key=? AND active=1 AND id<>?').get(userId, handle.handle_key, handle.id)
      if (occupied) throw conflict('Handle gốc đang được một đối tượng khác sử dụng. Hãy đổi handle đối tượng đó trước khi khôi phục.')
      db.prepare('UPDATE entity_handles SET active=1 WHERE id=? AND user_id=?').run(handle.id, userId)
      db.prepare('UPDATE library_assets SET revision=revision+1 WHERE id=? AND user_id=?').run(id, userId)
    }
    if (kind === 'project') {
      db.prepare('UPDATE scenes SET auto_generate=0,updated_at=? WHERE project_id=?').run(now, id)
      db.prepare('UPDATE projects SET delete_results=0 WHERE id=?').run(id)
    }
    db.prepare(`UPDATE ${TABLES[kind]} SET deleted_at=NULL,purge_after=NULL,updated_at=? WHERE id=? AND user_id=?`).run(now, id, userId)
    if (kind === 'project' || kind === 'plan_session') reconcileLocationLibrary(db, userId)
  })
}

function queuePath(db: Database, row: Row, path: unknown, now: number, kind = 'path'): void {
  if (typeof path !== 'string' || !path) return
  db.prepare('INSERT INTO media_cleanup_jobs (id,user_id,kind,target_id,path,created_at) VALUES (?,?,?,?,?,?)').run(randomUUID(), row.user_id, kind, row.id, path, now)
}

export function purgeTrashItem(db: Database, userId: string, kind: TrashKind, id: string, now = Date.now()): void {
  const row = ownedTrashRow(db, userId, kind, id)
  if (row.deleted_at == null) throw badRequest('Dữ liệu không nằm trong Thùng rác.', undefined, { messageKey: 'trash.not_trashed' })
  assertTrashIdle(db, kind, row)
  if (kind === 'project') { purgeProject(db, { id, user_id: userId, delete_results: Number(row.delete_results) }, now); return }
  transaction(db, () => {
    if (kind === 'character') {
      detachCharacterReferences(db, userId, id, characterUsage(db, id), { onlyNonEditable: false, inTransaction: true })
      queuePath(db, row, row.reference_path, now)
    } else if (kind === 'generation') {
      for (const asset of db.prepare('SELECT relative_path FROM assets WHERE generation_id=?').all(id)) queuePath(db, row, asset.relative_path, now)
      // ID bị dọn không còn được dùng để chọn đầu ra; lịch sử tác vụ giữ snapshot riêng.
      db.prepare('UPDATE scenes SET selected_generation_id=NULL WHERE selected_generation_id=?').run(id)
      const runs = new Set((db.prepare('SELECT id FROM project_canvas_runs WHERE generation_id=?').all(id) as Array<{ id: string }>).map(run => run.id))
      if (runs.size) {
        const boards = db.prepare('SELECT project_id AS projectId,graph_json AS graphJson FROM project_canvases WHERE user_id=?').all(userId) as Array<{ projectId: string; graphJson: string }>
        for (const board of boards) {
          const graph = JSON.parse(board.graphJson) as { nodes?: Array<{ data?: { selectedRunId?: string | null } }> }
          let changed = false
          for (const node of graph.nodes ?? []) {
            if (node.data?.selectedRunId && runs.has(node.data.selectedRunId)) { node.data.selectedRunId = null; changed = true }
          }
          if (changed) db.prepare('UPDATE project_canvases SET graph_json=?,revision=revision+1,updated_at=? WHERE project_id=?').run(JSON.stringify(graph), now, board.projectId)
        }
      }
    }
    if (kind === 'library_asset') {
      detachInactiveLibraryCanvasNodes(db, userId, id, now)
      // Registry tombstones and JSON mentions intentionally outlive the entity row.
      db.prepare('UPDATE entity_handles SET active=0 WHERE user_id=? AND kind=? AND entity_id=?').run(userId, String(row.kind), id)
    }
    db.prepare(`DELETE FROM ${TABLES[kind]} WHERE id=? AND user_id=?`).run(id, userId)
    if (kind === 'library_asset' && row.reference_upload_id) {
      const upload = db.prepare('SELECT id,relative_path FROM uploads WHERE id=? AND user_id=?').get(String(row.reference_upload_id), userId) as { id: string; relative_path: string } | undefined
      if (upload) {
        queuePath(db, row, upload.relative_path, now, 'orphan_upload')
        if (!uploadReferenced(db, upload.id, upload.relative_path, now)) db.prepare('DELETE FROM uploads WHERE id=? AND user_id=?').run(upload.id, userId)
      }
    }
  })
}

export function emptyTrash(db: Database, userId: string, now = Date.now()) {
  const result = { purged: 0, blocked: 0, failed: 0 }
  // Dọn mục độc lập trước dự án để giữ chính sách riêng và tránh cascade ngoài ý muốn.
  for (const kind of ['library_asset', 'character', 'generation', 'plan_session', 'project'] as TrashKind[]) {
    const ids = db.prepare(`SELECT id FROM ${TABLES[kind]} WHERE user_id=? AND deleted_at IS NOT NULL`).all(userId)
    for (const { id } of ids) {
      try { purgeTrashItem(db, userId, kind, String(id), now); result.purged++ }
      catch (error) { if (error instanceof Error && 'status' in error && error.status === 400) result.blocked++; else { result.failed++; logger.warn('Không thể dọn mục trong thùng rác', { kind, id, message: String(error) }) } }
    }
  }
  return result
}

export function maintainTrash(options: { db: Database; mediaStore: Pick<MediaStore, 'removeByPath'>; now?: number; limit?: number }) {
  const { db, mediaStore } = options, now = options.now ?? Date.now(), limit = options.limit ?? 100
  const result = { purged: 0, failed: 0, cleaned: 0 }
  let remaining = limit
  for (const kind of ['library_asset', 'character', 'generation', 'plan_session', 'project'] as TrashKind[]) {
    const rows = db.prepare(`SELECT id,user_id FROM ${TABLES[kind]} WHERE deleted_at IS NOT NULL AND purge_after<=? ORDER BY purge_after,id LIMIT ?`).all(now, Math.max(0, remaining))
    for (const row of rows) {
      remaining--
      try { purgeTrashItem(db, String(row.user_id), kind, String(row.id), now); result.purged++ }
      catch (error) { result.failed++; logger.warn('Không thể dọn mục hết hạn', { kind, id: row.id, message: String(error) }) }
    }
  }
  const cleanup = cleanMediaJobs({ db, mediaStore, now, limit })
  result.cleaned = cleanup.cleaned; result.failed += cleanup.failed
  return result
}
