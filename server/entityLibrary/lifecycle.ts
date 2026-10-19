import type { Database } from '../db/index'
import { badRequest } from '../lib/errors'

/** Compare persisted identities/paths, never labels or current handles. */
export function jsonReferences(value: unknown, identities: readonly string[]): boolean {
  if (typeof value === 'string') {
    if (identities.includes(value)) return true
    try { return referencesValue(JSON.parse(value), identities) } catch {
      // Corrupted retained metadata must not make a quoted ID/path disappear.
      return identities.some(identity => value.includes(JSON.stringify(identity)))
    }
  }
  return referencesValue(value, identities)
}
function referencesValue(value: unknown, identities: readonly string[]): boolean {
  if (typeof value === 'string') return identities.includes(value)
  if (Array.isArray(value)) return value.some(item => referencesValue(item, identities))
  return value !== null && typeof value === 'object' && Object.values(value).some(item => referencesValue(item, identities))
}

export function tableColumns(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name)
}
/** Reads all retained JSON fields, including new entity snapshots and overlays. */
export function retainedJsonReferences(db: Database, table: string, identities: readonly string[], where = '', params: (string | number)[] = []): boolean {
  const columns = tableColumns(db, table).filter(column => column.endsWith('_json'))
  return columns.length > 0 && db.prepare(`SELECT ${columns.join(',')} FROM ${table}${where ? ` WHERE ${where}` : ''}`).all(...params)
    .some(row => Object.values(row).some(value => jsonReferences(value, identities)))
}
/** Media paths are canonical, relative paths rooted in exactly one account. */
function pathOwner(path: string): string | null {
  const parts = path.split('/')
  if (parts.length < 2 || path.includes('\\') || path.includes('\0')
    || parts.some(part => !part || part === '.' || part === '..')) return null
  return parts[0]!
}

/** Missing ownership columns in partial migration fixtures never imply global ownership. */
function ownerScope(db: Database, table: string): string | null {
  const columns = tableColumns(db, table)
  if (['scenes', 'project_locations', 'project_canvas_links'].includes(table)) {
    const projects = tableColumns(db, 'projects')
    return columns.includes('project_id') && projects.includes('id') && projects.includes('user_id')
      ? 'project_id IN (SELECT id FROM projects WHERE user_id=?)' : null
  }
  if (table === 'plan_image_batch_items') {
    const batches = tableColumns(db, 'plan_image_batches')
    return columns.includes('batch_id') && batches.includes('id') && batches.includes('user_id')
      ? 'batch_id IN (SELECT id FROM plan_image_batches WHERE user_id=?)' : null
  }
  if (columns.includes('user_id')) return 'user_id=?'
  // Characters were project-owned before migration 008 introduced user_id.
  if (table === 'characters' && columns.includes('project_id')
    && ['id', 'user_id'].every(column => tableColumns(db, 'projects').includes(column))) {
    return 'project_id IN (SELECT id FROM projects WHERE user_id=?)'
  }
  return null
}
function directReference(db: Database, table: string, column: string, identity: string, userId: string): boolean {
  const scope = ownerScope(db, table)
  return !!scope && tableColumns(db, table).includes(column)
    && !!db.prepare(`SELECT 1 FROM ${table} WHERE ${column}=? AND ${scope} LIMIT 1`).get(identity, userId)
}
function granted(db: Database, path: string, userId: string, now: number): boolean {
  const columns = tableColumns(db, 'temporary_media_grants')
  if (!['relative_path', 'user_id', 'revoked_at', 'expires_at'].every(column => columns.includes(column))) return false
  return !!db.prepare('SELECT 1 FROM temporary_media_grants WHERE relative_path=? AND user_id=? AND revoked_at IS NULL AND expires_at>? LIMIT 1').get(path, userId, now)
}
function ownerRetainedJsonReferences(db: Database, userId: string, identities: readonly string[]): boolean {
  return ['generations', 'scenes', 'plan_sessions', 'quick_sessions', 'project_canvases', 'exports', 'plan_image_batch_items', 'project_locations', 'library_assets']
    .some(table => {
      const scope = ownerScope(db, table)
      return !!scope && retainedJsonReferences(db, table, identities, scope, [userId])
    })
}

/** Includes trash, archived work and every retained generation snapshot of the media owner. */
export function uploadReferenced(db: Database, uploadId: string, path: string, now = Date.now()): boolean {
  const userId = pathOwner(path)
  if (!userId) return false
  const uploadColumns = tableColumns(db, 'uploads')
  if (['id', 'user_id', 'relative_path'].every(column => uploadColumns.includes(column))) {
    const upload = db.prepare('SELECT user_id,relative_path FROM uploads WHERE id=?').get(uploadId)
    if (upload && (upload.user_id !== userId || upload.relative_path !== path)) return false
  }
  if ([['library_assets', 'reference_upload_id'], ['project_items', 'reference_upload_id'], ['project_locations', 'reference_upload_id'], ['project_canvas_links', 'upload_id']]
    .some(([table, column]) => directReference(db, table!, column!, uploadId, userId))) return true
  if ([['assets', 'relative_path'], ['characters', 'reference_path'], ['exports', 'relative_path']]
    .some(([table, column]) => directReference(db, table!, column!, path, userId))) return true
  return granted(db, path, userId, now) || ownerRetainedJsonReferences(db, userId, [uploadId, path])
}

/** Shared guard for queued cleanup; does not count the upload's own row. */
export function retainedPathReferenced(db: Database, path: string, now = Date.now()): boolean {
  const userId = pathOwner(path)
  return !!userId && (granted(db, path, userId, now) || ownerRetainedJsonReferences(db, userId, [path]))
}

export type LibraryAssetUsage = {
  scenes: Array<{ sceneId: string; projectId: string; projectName: string }>
  canvas: Array<{ nodeId: string; projectId: string; projectName: string }>
  pendingGenerationIds: string[]
}

/** Only editable projects block deletion; immutable snapshots always keep their IDs. */
export function libraryAssetUsage(db: Database, userId: string, id: string): LibraryAssetUsage {
  const usage: LibraryAssetUsage = { scenes: [], canvas: [], pendingGenerationIds: [] }
  const scenes = db.prepare(`SELECT s.*,p.id AS projectId,p.name AS projectName FROM scenes s JOIN projects p ON p.id=s.project_id
    WHERE p.user_id=? AND p.deleted_at IS NULL AND p.archived=0`).all(userId)
  for (const scene of scenes) if (Object.entries(scene).some(([key, value]) => key.endsWith('_json') && jsonReferences(value, [id]))) {
    usage.scenes.push({ sceneId: String(scene.id), projectId: String(scene.projectId), projectName: String(scene.projectName) })
  }
  const seen = new Set<string>()
  if (tableColumns(db, 'project_canvas_links').includes('library_asset_id')) {
    const links = db.prepare(`SELECT l.node_id,p.id AS projectId,p.name AS projectName FROM project_canvas_links l JOIN projects p ON p.id=l.project_id
      WHERE p.user_id=? AND p.deleted_at IS NULL AND p.archived=0 AND l.library_asset_id=?`).all(userId, id)
    for (const link of links) { seen.add(`${link.projectId}:${link.node_id}`); usage.canvas.push({ nodeId: String(link.node_id), projectId: String(link.projectId), projectName: String(link.projectName) }) }
  }
  const boards = db.prepare(`SELECT c.graph_json,p.id AS projectId,p.name AS projectName FROM project_canvases c JOIN projects p ON p.id=c.project_id
    WHERE p.user_id=? AND p.deleted_at IS NULL AND p.archived=0`).all(userId)
  for (const board of boards) {
    let graph: { nodes?: Array<{ id: string }> }
    try { graph = JSON.parse(String(board.graph_json)) } catch { continue }
    for (const node of graph.nodes ?? []) if (jsonReferences(node, [id]) && !seen.has(`${board.projectId}:${node.id}`)) {
      usage.canvas.push({ nodeId: node.id, projectId: String(board.projectId), projectName: String(board.projectName) })
    }
  }
  const reference = db.prepare(`SELECT u.id,u.relative_path FROM library_assets a JOIN uploads u ON u.id=a.reference_upload_id
    WHERE a.id=? AND a.user_id=?`).get(id, userId)
  const pendingIdentities = [id, ...(reference ? [String(reference.id), String(reference.relative_path)] : [])]
  const pending = db.prepare("SELECT * FROM generations WHERE user_id=? AND (status IN ('queued','running','downloading','unknown') OR postprocess_status IN ('queued','running'))").all(userId)
  for (const generation of pending) if (Object.entries(generation).some(([key, value]) => key.endsWith('_json') && jsonReferences(value, pendingIdentities))) usage.pendingGenerationIds.push(String(generation.id))
  return usage
}

export function assertLibraryAssetIdle(db: Database, userId: string, id: string): void {
  const usage = libraryAssetUsage(db, userId, id)
  if (usage.scenes.length || usage.canvas.length || usage.pendingGenerationIds.length) {
    throw badRequest('Vật phẩm còn được cảnh/Canvas đang hoạt động hoặc tác vụ đang chạy sử dụng. Hãy gỡ tham chiếu hoặc đợi tác vụ hoàn tất.', usage)
  }
}

/** Caller must run the idle guard and wrap this operation in its transaction. */
export function detachInactiveLibraryCanvasNodes(db: Database, userId: string, id: string, now: number): void {
  const boards = db.prepare(`SELECT c.project_id,c.graph_json FROM project_canvases c JOIN projects p ON p.id=c.project_id
    WHERE p.user_id=? AND (p.deleted_at IS NOT NULL OR p.archived=1)`).all(userId)
  for (const board of boards) {
    const links = tableColumns(db, 'project_canvas_links').includes('library_asset_id')
      ? db.prepare('SELECT node_id FROM project_canvas_links WHERE project_id=? AND library_asset_id=?').all(String(board.project_id), id) : []
    const nodeIds = new Set(links.map(link => String(link.node_id)))
    let graph: { nodes?: Array<{ id: string }>; edges?: Array<{ source: string; target: string }> }
    try { graph = JSON.parse(String(board.graph_json)) } catch {
      // A corrupted board cannot be detached safely. Do not clear the FK silently.
      if (nodeIds.size) throw badRequest('Canvas không hợp lệ. Hãy sửa hoặc xoá dự án trước khi dọn vật phẩm.')
      continue
    }
    for (const node of graph.nodes ?? []) if (jsonReferences(node, [id])) nodeIds.add(node.id)
    if (!nodeIds.size) continue
    graph.nodes = (graph.nodes ?? []).filter(node => !nodeIds.has(node.id))
    graph.edges = (graph.edges ?? []).filter(edge => !nodeIds.has(edge.source) && !nodeIds.has(edge.target))
    db.prepare('UPDATE project_canvases SET graph_json=?,revision=revision+1,updated_at=? WHERE project_id=?').run(JSON.stringify(graph), now, String(board.project_id))
    for (const nodeId of nodeIds) db.prepare('DELETE FROM project_canvas_links WHERE project_id=? AND node_id=?').run(String(board.project_id), nodeId)
  }
  // Legacy orphan link rows (no board) are removable only in noneditable projects.
  if (tableColumns(db, 'project_canvas_links').includes('library_asset_id')) db.prepare(`DELETE FROM project_canvas_links WHERE library_asset_id=? AND project_id IN
    (SELECT id FROM projects WHERE user_id=? AND (deleted_at IS NOT NULL OR archived=1))`).run(id, userId)
}
