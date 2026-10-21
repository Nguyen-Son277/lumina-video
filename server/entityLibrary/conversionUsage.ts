import type { Database } from '../db/index'
import { AppError } from '../lib/errors'
import type { EntityRef } from './service'

export type EntityConversionUsage = {
  type: string
  label: string
  projectId?: string
  sessionId?: string
  sceneId?: string
  nodeId?: string
  generationId?: string
  batchId?: string
  itemId?: string
  invalidMetadata?: boolean
}

type Row = Record<string, unknown>
const record = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value)
const entityKinds = new Set(['character', 'item', 'logo', 'location'])
const mediaKeys = new Set(['uploadId', 'upload_id', 'referenceUploadId', 'reference_upload_id', 'viewUploadId', 'imageUploadId', 'endImageUploadId', 'backgroundUploadId', 'path', 'relativePath', 'relative_path', 'referencePath', 'reference_path', 'referenceIdentity', '_targetReferencePath'])
const mediaLists = new Set(['sourceUploadIds', 'uploadIds', 'referenceUploadIds'])

/** Inspect reference-bearing structures, never prompt text, names, handles or node IDs. */
function references(value: unknown, ref: EntityRef, media: Set<string>): boolean {
  if (Array.isArray(value)) return value.some(entry => references(entry, ref, media))
  if (!record(value)) return false
  const kind = typeof value.entityKind === 'string' ? value.entityKind : value.kind
  if (kind === ref.kind && value.id === ref.id && !record(value.data)) return true
  if (value.entityId === ref.id && (!entityKinds.has(String(kind)) || kind === ref.kind)) return true
  if (ref.kind === 'character' && (value.characterId === ref.id || value.character_id === ref.id || value.reuseCharacterId === ref.id)) return true
  if (ref.kind !== 'character' && (value.libraryAssetId === ref.id || value.library_asset_id === ref.id)) return true
  if (value.sourceId === ref.id && (value.entityKind === ref.kind || (ref.kind === 'character' && value.kind === 'character'))) return true
  // Canvas item/location nodes are project-local, not account library entities.
  if (record(value.data) && value.data.sourceId === ref.id && ((ref.kind === 'character' && value.kind === 'character') || (value.kind === 'library' && value.data.entityKind === ref.kind))) return true
  // The legacy prompt composer has typed containers rather than kind on each entry.
  if (ref.kind === 'character' && ((record(value.character) && value.character.id === ref.id)
    || (Array.isArray(value.cast) && value.cast.some(entry => record(entry) && entry.id === ref.id)))) return true
  return Object.entries(value).some(([key, child]) =>
    (mediaKeys.has(key) && typeof child === 'string' && media.has(child))
    || (mediaLists.has(key) && Array.isArray(child) && child.some(id => typeof id === 'string' && media.has(id)))
    || references(child, ref, media))
}

/**
 * Conversion is stricter than deletion: archived/trashed editable work can be
 * restored and must not acquire dangling kind+ID bindings. Immutable completed
 * generations, aliases and conversion archives are deliberately NOT scanned.
 * Every read is owner scoped, including tables whose owner is on a parent row.
 */
export function getEntityConversionUsage(db: Database, userId: string, ref: EntityRef, mediaIdentities: string[] = []): EntityConversionUsage[] {
  const cache = new Map<string, Set<string>>()
  const columns = (table: string): Set<string> => {
    if (!cache.has(table)) cache.set(table, new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name)))
    return cache.get(table)!
  }
  const has = (table: string, ...names: string[]) => names.every(name => columns(table).has(name))
  const owned = (table: string): Row[] => {
    if (!columns(table).size) return []
    const constraints: string[] = [], params: string[] = []
    if (has(table, 'user_id')) { constraints.push('r.user_id=?'); params.push(userId) }
    // Parent checks supplement rather than replace explicit row ownership.
    if (has(table, 'project_id') && has('projects', 'id', 'user_id') && table !== 'plan_sessions' && table !== 'generations') {
      constraints.push('r.project_id IN (SELECT id FROM projects WHERE user_id=?)'); params.push(userId)
    } else if (has(table, 'session_id') && table.startsWith('quick_') && has('quick_sessions', 'id', 'user_id')) {
      constraints.push('r.session_id IN (SELECT id FROM quick_sessions WHERE user_id=?)'); params.push(userId)
    } else if (has(table, 'batch_id') && has('plan_image_batches', 'id', 'user_id')) {
      const sessionScope = has('plan_image_batches', 'session_id') && has('plan_sessions', 'id', 'user_id')
      constraints.push(`r.batch_id IN (SELECT id FROM plan_image_batches WHERE user_id=?${sessionScope ? ' AND session_id IN (SELECT id FROM plan_sessions WHERE user_id=?)' : ''})`); params.push(userId)
      if (sessionScope) params.push(userId)
    } else if (table.startsWith('timeline_canvas_') && table !== 'timeline_canvas_sessions' && has(table, 'session_id')
      && has('timeline_canvas_sessions', 'session_id', 'user_id') && has('plan_sessions', 'id', 'user_id')) {
      const projectScope = has('timeline_canvas_sessions', 'project_id') && has('projects', 'id', 'user_id')
      constraints.push(`r.session_id IN (SELECT session_id FROM timeline_canvas_sessions WHERE user_id=? AND session_id IN (SELECT id FROM plan_sessions WHERE user_id=?)${projectScope ? ' AND project_id IN (SELECT id FROM projects WHERE user_id=?)' : ''})`); params.push(userId, userId)
      if (projectScope) params.push(userId)
    }
    // Missing ownership in a partial/legacy fixture is never permission to scan globally.
    return constraints.length ? db.prepare(`SELECT r.* FROM ${table} r WHERE ${constraints.join(' AND ')}`).all(...params) as Row[] : []
  }
  const media = new Set(mediaIdentities.filter(Boolean))
  const upload = (id: unknown) => {
    if (typeof id !== 'string' || !has('uploads', 'id', 'user_id', 'relative_path')) return
    const row = db.prepare('SELECT relative_path FROM uploads WHERE id=? AND user_id=?').get(id, userId)
    if (row) { media.add(id); media.add(String(row.relative_path)) }
  }
  if (ref.kind === 'character' && has('characters', 'id', 'user_id', 'reference_path')) {
    const row = db.prepare('SELECT reference_path FROM characters WHERE id=? AND user_id=?').get(ref.id, userId)
    if (typeof row?.reference_path === 'string') media.add(row.reference_path)
  } else if (ref.kind !== 'character' && has('library_assets', 'id', 'user_id', 'reference_upload_id')) {
    const row = db.prepare('SELECT * FROM library_assets WHERE id=? AND user_id=?').get(ref.id, userId)
    upload(row?.reference_upload_id)
    try {
      const views: unknown = JSON.parse(String(row?.reference_views_json ?? '[]'))
      if (Array.isArray(views)) for (const view of views) if (record(view)) upload(view.uploadId)
    } catch { /* The conversion service validates its own entity media metadata. */ }
  }
  const usage: EntityConversionUsage[] = []
  const info = (row: Row, type: string, fallback: string): EntityConversionUsage => ({
    type, label: String(row.title || row.name || fallback),
    ...(typeof row.project_id === 'string' ? { projectId: row.project_id } : {}),
    ...(typeof row.session_id === 'string' ? { sessionId: row.session_id } : {}),
    ...(typeof row.node_id === 'string' ? { nodeId: row.node_id } : {}),
  })
  const scan = (row: Row, fields: string[], entry: EntityConversionUsage, direct = false) => {
    let matched = direct, invalid = false
    for (const field of fields) {
      if (row[field] == null) continue
      try {
        const parsed: unknown = JSON.parse(String(row[field]))
        if (parsed !== null && typeof parsed !== 'object') invalid = true
        else if (references(parsed, ref, media)) matched = true
      } catch { invalid = true }
    }
    if (matched || invalid) usage.push({ ...entry, ...(invalid ? { invalidMetadata: true } : {}) })
  }
  const jsonFields = (table: string) => [...columns(table)].filter(key => key.endsWith('_json') && !['error_message_params_json', 'voice_json', 'conflicts_json', 'tombstones_json'].includes(key))
  const scenes = owned('scenes')
  const sceneById = new Map(scenes.map(row => [row.id, row]))
  for (const row of scenes) scan(row, ['params_json', 'prompt_document_json', 'context_documents_json'],
    { ...info(row, 'scene', 'Cảnh'), sceneId: String(row.id) },
    (ref.kind === 'character' && row.character_id === ref.id) || (typeof row.background_upload_id === 'string' && media.has(row.background_upload_id)))
  if (ref.kind === 'character' && has('scene_characters', 'scene_id', 'character_id')) {
    for (const row of db.prepare('SELECT scene_id FROM scene_characters WHERE character_id=?').all(ref.id)) {
      const scene = sceneById.get(row.scene_id)
      if (scene && !usage.some(entry => entry.type === 'scene' && entry.sceneId === scene.id)) usage.push({ ...info(scene, 'scene', 'Cảnh'), sceneId: String(scene.id) })
    }
  }
  for (const row of owned('project_canvas_links')) {
    const matches = ref.kind === 'character' ? row.character_id === ref.id : row.library_asset_id === ref.id
    if (matches || (ref.kind === 'character' && row.role === 'character' && row.target_id === ref.id) || (typeof row.upload_id === 'string' && media.has(row.upload_id))) usage.push(info(row, 'canvas', 'Canvas dự án'))
  }
  for (const row of owned('project_canvases')) scan(row, ['graph_json'], info(row, 'canvas', 'Canvas dự án'))
  const quickSessions = owned('quick_sessions')
  const quickById = new Map(quickSessions.map(row => [row.id, row]))
  for (const row of quickSessions) scan(row, jsonFields('quick_sessions'), { ...info(row, 'quick_session', 'Phiên tạo nội dung'), sessionId: String(row.id) })
  if (ref.kind === 'character' && has('quick_session_characters', 'session_id', 'character_id')) {
    for (const row of db.prepare('SELECT session_id FROM quick_session_characters WHERE character_id=?').all(ref.id)) {
      const session = quickById.get(row.session_id)
      if (session && !usage.some(entry => entry.type === 'quick_session' && entry.sessionId === session.id)) usage.push({ ...info(session, 'quick_session', 'Phiên tạo nội dung'), sessionId: String(session.id) })
    }
  }
  for (const row of owned('quick_canvases')) scan(row, ['graph_json'], info(row, 'quick_canvas', 'Canvas phiên'))
  for (const row of owned('quick_canvas_sources')) if (!row.tombstoned) scan(row, ['snapshot_json'], info(row, 'quick_canvas', 'Nguồn Canvas phiên'))
  for (const row of owned('plan_sessions')) scan(row, jsonFields('plan_sessions'), { ...info(row, 'planner', 'Kịch bản / Timeline'), sessionId: String(row.id) })
  for (const row of owned('timeline_canvas_entities')) scan(row, ['snapshot_json'], info(row, 'timeline_canvas', 'Đồng bộ Timeline / Canvas'), ref.kind === 'character' && row.source_kind === 'cast' && row.target_id === ref.id)
  for (const row of owned('timeline_canvas_frames')) if (!row.detached) scan(row, ['snapshot_json'], info(row, 'timeline_canvas', 'Đồng bộ khung Timeline'))
  for (const row of owned('plan_image_batch_items')) {
    // Error/stopped items are explicitly retryable from their frozen snapshot,
    // including items that have never acquired a generation_id.
    if (!['pending', 'running', 'error', 'stopped'].includes(String(row.status))) continue
    if (row.status !== 'pending' && typeof row.generation_id === 'string' && has('generations', 'id', 'user_id', 'status')) {
      const generation = db.prepare('SELECT status FROM generations WHERE id=? AND user_id=?').get(row.generation_id, userId)
      // Retrying a succeeded job only reattaches its immutable output; it does
      // not enqueue the frozen input again. Active postprocessing is scanned below.
      if (generation?.status === 'succeeded') continue
    }
    scan(row, ['snapshot_json'], { ...info(row, 'image_batch', 'Batch tạo ảnh'), batchId: String(row.batch_id), itemId: String(row.id) })
  }
  for (const row of owned('generations')) {
    if (!['queued', 'running', 'downloading', 'unknown'].includes(String(row.status)) && !['queued', 'running', 'unknown'].includes(String(row.postprocess_status))) continue
    scan(row, ['params_json', 'prompt_snapshot_json', 'prompt_document_json', 'entity_references_json', 'source_images_json', 'character_reference_json', 'character_references_json', 'logo_overlays_json'],
      { ...info(row, 'generation', 'Tác vụ đang xử lý'), generationId: String(row.id), ...(typeof row.quick_session_id === 'string' ? { sessionId: row.quick_session_id } : {}) })
  }
  return usage
}

/** Run inside the conversion transaction, before changing identity or media. */
export function assertEntityConvertible(db: Database, userId: string, ref: EntityRef, mediaIdentities?: string[]): void {
  const usage = getEntityConversionUsage(db, userId, ref, mediaIdentities)
  if (usage.length) throw new AppError(409, 'CONFLICT', 'Đối tượng đang được sử dụng. Hãy gỡ tham chiếu hoặc đợi tác vụ hoàn tất trước khi chuyển loại.', { usage })
}
