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
export type TrashEntityKind = 'character' | 'item' | 'logo' | 'location'
export type TrashVoice = Partial<Record<'language' | 'accent' | 'pitch' | 'timbre' | 'pace' | 'articulation' | 'habits', string>>
export type TrashItem = { kind: TrashKind; id: string; title: string; subtitle: string; thumbnailUrl: string | null; deletedAt: number; purgeAfter: number; description?: string; entityKind?: TrashEntityKind; handle?: string; meta: Record<string, unknown> }
export type TrashDetail = TrashItem & {
  createdAt: number | null; updatedAt: number | null
  prompt?: string; appearance?: string; voice?: TrashVoice; continuityNotes?: string
  referenceViews?: Array<{ id: string; label: string; url: string; sheet: boolean }>
}

const text = (value: unknown): string => typeof value === 'string' ? value : ''
function parsedRecord(raw: unknown): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text(raw))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch { return {} }
}
function descriptionFor(kind: TrashKind, row: Row): string {
  if (kind === 'character') return text(row.appearance)
  if (kind === 'generation') return text(row.prompt)
  // Only human-authored script text, never structured plan/config snapshots.
  if (kind === 'plan_session') return text(parsedRecord(row.script_json).text) || text(parsedRecord(row.ideas_json).logline)
  return text(row.description)
}
function entityKindFor(kind: TrashKind, row: Row): TrashEntityKind | undefined {
  if (kind === 'character') return 'character'
  if (kind === 'library_asset' && ['item', 'logo', 'location'].includes(text(row.kind))) return row.kind as TrashEntityKind
  return undefined
}
function ownedImageUrl(db: Database, userId: string, uploadId: unknown): string | null {
  if (typeof uploadId !== 'string' || !uploadId) return null
  return db.prepare("SELECT id FROM uploads WHERE id=? AND user_id=? AND mime_type IN ('image/png','image/jpeg','image/webp','image/gif')").get(uploadId, userId)
    ? `/api/uploads/${encodeURIComponent(uploadId)}` : null
}
function trashItem(db: Database, userId: string, kind: TrashKind, row: Row): TrashItem {
  const title = text(row.name ?? row.title ?? row.prompt).trim()
  const entityKind = entityKindFor(kind, row)
  const handle = entityKind ? db.prepare('SELECT handle FROM entity_handles WHERE user_id=? AND kind=? AND entity_id=?').get(userId, entityKind, row.id) as { handle: string } | undefined : undefined
  let thumbnailUrl: string | null = null
  if (kind === 'character' && row.reference_path) thumbnailUrl = `/api/characters/${encodeURIComponent(row.id)}/reference`
  if (kind === 'generation' && row.kind === 'image') {
    const asset = db.prepare('SELECT id FROM assets WHERE generation_id=? AND user_id=? ORDER BY created_at,id LIMIT 1').get(row.id, userId) as { id: string } | undefined
    if (asset) thumbnailUrl = `/api/assets/${encodeURIComponent(asset.id)}`
  }
  // The active library reference route rejects trash: use the owned upload.
  if (kind === 'library_asset') thumbnailUrl = ownedImageUrl(db, userId, row.reference_upload_id)
  return { kind, id: row.id, title, subtitle: kind === 'generation' || kind === 'library_asset' ? text(row.kind) : '', thumbnailUrl,
    deletedAt: Number(row.deleted_at), purgeAfter: Number(row.purge_after),
    description: Array.from(descriptionFor(kind, row)).slice(0, 240).join(''), ...(entityKind ? { entityKind } : {}), ...(handle ? { handle: text(handle.handle) } : {}),
    meta: { projectId: row.project_id ?? null, mediaKind: row.kind ?? null } }
}
function safeDate(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Number.isFinite(new Date(value).getTime()) ? value : null
}

/** Read-only safe DTO. Expiry prevents restoration, not inspection before purge. */
export function getTrashDetail(db: Database, userId: string, kind: TrashKind, id: string): TrashDetail {
  const row = ownedTrashRow(db, userId, kind, id)
  if (row.deleted_at == null) throw notFound()
  const item: TrashDetail = { ...trashItem(db, userId, kind, row), description: descriptionFor(kind, row), createdAt: safeDate(row.created_at), updatedAt: safeDate(row.updated_at) }
  if (kind === 'generation') item.prompt = text(row.prompt)
  if (kind === 'character') {
    item.appearance = text(row.appearance)
    const voice = parsedRecord(row.voice_json)
    item.voice = {}
    for (const key of ['language', 'accent', 'pitch', 'timbre', 'pace', 'articulation', 'habits'] as const) {
      if (typeof voice[key] === 'string') item.voice[key] = voice[key]
    }
  }
  if (kind === 'library_asset') {
    item.continuityNotes = text(row.continuity_notes)
    item.referenceViews = []
    try {
      const views: unknown = JSON.parse(text(row.reference_views_json))
      if (Array.isArray(views)) for (const value of views) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue
        const view = value as Record<string, unknown>, url = ownedImageUrl(db, userId, view.uploadId)
        if (url) item.referenceViews.push({ id: text(view.id) || text(view.uploadId), label: text(view.label), url, sheet: view.sheet === true })
      }
    } catch { /* Malformed legacy view JSON yields an empty collection. */ }
  }
  return item
}

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
    rows.push(trashItem(db, userId, kind, row))
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
      || db.prepare("SELECT 1 FROM speech_jobs WHERE project_id=? AND status IN ('queued','running','unknown') LIMIT 1").get(row.id)
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
    if (kind === 'library_asset' || kind === 'character') db.prepare('UPDATE entity_handles SET active=0 WHERE user_id=? AND kind=? AND entity_id=?').run(userId, kind === 'character' ? 'character' : String(row.kind), id)
  }
  if (kind === 'library_asset') transaction(db, update)
  else update()
  if (kind === 'plan_session') reconcileLocationLibrary(db, userId)
}

/** Caller must hold the parent restore transaction; legacy children without aliases remain lazy. */
export function reserveCharacterAliasesForProject(db: Database, userId: string, projectId: string): void {
  const handles = db.prepare(`SELECT h.id,h.handle_key FROM entity_handles h
    JOIN characters c ON c.id=h.entity_id AND c.user_id=h.user_id
    WHERE h.user_id=? AND h.kind='character' AND c.project_id=? AND c.deleted_at IS NULL
    ORDER BY h.id`).all(userId, projectId) as { id: string; handle_key: string }[]
  for (const handle of handles) {
    const occupied = db.prepare('SELECT id FROM entity_handles WHERE user_id=? AND handle_key=? AND active=1 AND id<>?').get(userId, handle.handle_key, handle.id)
    if (occupied) throw conflict('Handle gốc của nhân vật trong dự án đang được một đối tượng khác sử dụng. Hãy đổi handle đối tượng đó trước khi khôi phục.')
    db.prepare('UPDATE entity_handles SET active=1 WHERE id=? AND user_id=?').run(handle.id, userId)
  }
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
    if (kind === 'library_asset' || kind === 'character') {
      // Reserve this exact tombstone alias; never adopt another entity or rewrite documents.
      const handle = db.prepare('SELECT id,handle_key FROM entity_handles WHERE user_id=? AND kind=? AND entity_id=?').get(userId, kind === 'character' ? 'character' : String(row.kind), id) as { id: string; handle_key: string } | undefined
      if (!handle && kind === 'library_asset') throw conflict('Không còn handle gốc của vật phẩm để khôi phục')
      // Legacy characters may never have been catalogued, and have no alias to reserve.
      if (handle) {
        const occupied = db.prepare('SELECT id FROM entity_handles WHERE user_id=? AND handle_key=? AND active=1 AND id<>?').get(userId, handle.handle_key, handle.id)
        if (occupied) throw conflict('Handle gốc đang được một đối tượng khác sử dụng. Hãy đổi handle đối tượng đó trước khi khôi phục.')
        db.prepare('UPDATE entity_handles SET active=1 WHERE id=? AND user_id=?').run(handle.id, userId)
      }
      if (kind === 'library_asset') db.prepare('UPDATE library_assets SET revision=revision+1 WHERE id=? AND user_id=?').run(id, userId)
    }
    if (kind === 'project') {
      reserveCharacterAliasesForProject(db, userId, id)
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
