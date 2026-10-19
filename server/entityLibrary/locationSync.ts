import { createHash, randomUUID } from 'node:crypto'
import type { Database } from '../db/index'
import type { LocationReference, LocationView } from '../planner/artifacts'

// Leaf parser: importing planner schemas here would introduce a resolver cycle.
function parseLocations(raw: unknown): LocationReference[] | null {
  try {
    const values: unknown = JSON.parse(String(raw))
    if (!Array.isArray(values)) return null
    return values.filter((v): v is LocationReference => Boolean(v && typeof v.id === 'string' && typeof v.name === 'string'))
  } catch { return null }
}
type Source = { kind: 'timeline' | 'project'; scopeId: string; entity: LocationReference }
type Link = { timeline_session_id: string; timeline_location_id: string; project_id: string; project_location_id: string; library_asset_id: string | null }
type LinkedRow = { id: string; name: string; description: string; continuity_notes: string; reference_upload_id: string | null; reference_views_json: string; source_kind: string; source_scope_id: string; source_entity_id: string; source_revision: number | null; source_deleted: number }
const key = (kind: string, scope: string, id: string) => JSON.stringify([kind, scope, id])
/** Stable identity is independent of mutable labels and source availability. */
export function locationLibraryId(userId: string, kind: string, scopeId: string, entityId: string): string {
  return `location-${createHash('sha256').update(JSON.stringify([userId,kind,scopeId,entityId])).digest('hex').slice(0,40)}`
}
/** Persist actual application mappings, never infer equivalence from names or image bytes. */
export function linkLocationSources(db: Database, userId: string, sessionId: string, locationId: string, projectId: string, projectLocationId: string): void {
  db.prepare(`INSERT OR IGNORE INTO location_source_links(user_id,timeline_session_id,timeline_location_id,project_id,project_location_id) VALUES(?,?,?,?,?)`)
    .run(userId, sessionId, locationId, projectId, projectLocationId)
}
function ownedViews(db: Database, userId: string, entity: LocationReference): LocationView[] {
  const raw = Array.isArray(entity.referenceViews) && entity.referenceViews.length ? entity.referenceViews
    : entity.reference?.uploadId ? [{ id: `legacy-${entity.reference.uploadId}`, label: '', uploadId: entity.reference.uploadId, sheet: false }] : []
  const seen = new Set<string>()
  return raw.flatMap(view => {
    if (!view || typeof view.uploadId !== 'string' || seen.has(view.uploadId)) return []
    const upload = db.prepare(`SELECT relative_path FROM uploads WHERE id=? AND user_id=? AND mime_type IN ('image/png','image/jpeg','image/webp','image/gif')`).get(view.uploadId,userId) as { relative_path: string } | undefined
    // Do not publish forged/cross-account media even if corrupt source JSON bypassed its write API.
    if (!upload || !upload.relative_path.startsWith(`${userId}/`) || upload.relative_path.split('/').some(part => !part || part === '.' || part === '..') || /[\\:]/.test(upload.relative_path)) return []
    seen.add(view.uploadId)
    return [{ id: typeof view.id === 'string' ? view.id : `view-${view.uploadId}`, label: typeof view.label === 'string' ? view.label : '', uploadId: view.uploadId, sheet: view.sheet === true }]
  })
}
function enqueueReleasedViews(db: Database, userId: string, row: LinkedRow): void {
  let raw: Array<{ uploadId?: string }> = []
  try { raw = JSON.parse(row.reference_views_json) } catch { /* malformed references cannot be trusted */ }
  const ids = new Set([row.reference_upload_id, ...raw.map(view => view.uploadId)].filter((id): id is string => typeof id === 'string'))
  for (const id of ids) {
    const upload = db.prepare('SELECT relative_path FROM uploads WHERE id=? AND user_id=?').get(id,userId) as { relative_path: string } | undefined
    if (upload) db.prepare(`INSERT INTO media_cleanup_jobs(id,user_id,kind,target_id,path,created_at) VALUES(?,?,'orphan_upload',?,?,?)`).run(randomUUID(),userId,id,upload.relative_path,Date.now())
  }
}
/** Reconcile on reads and source writes. Snapshot JSON remains an independent retention root. */
export function reconcileLocationLibrary(db: Database, userId: string): void {
  const savepoint = `location_sync_${randomUUID().replace(/-/g,'')}`
  db.exec(`SAVEPOINT ${savepoint}`)
  try {
    reconcileSources(db,userId)
    db.exec(`RELEASE ${savepoint}`)
  } catch (error) {
    db.exec(`ROLLBACK TO ${savepoint}`); db.exec(`RELEASE ${savepoint}`)
    throw error
  }
}
function reconcileSources(db: Database, userId: string): void {
  // Backfill mappings for existing applied timelines, and capture mappings created by ongoing sync.
  db.prepare(`INSERT OR IGNORE INTO location_source_links(user_id,timeline_session_id,timeline_location_id,project_id,project_location_id)
    SELECT s.user_id,e.session_id,e.source_id,s.project_id,e.target_id FROM timeline_canvas_entities e JOIN timeline_canvas_sessions s ON s.session_id=e.session_id WHERE s.user_id=? AND e.source_kind='location'`).run(userId)
  const sources = new Map<string, Source>(), existing = new Set<string>(), protectedScopes = new Set<string>()
  for (const row of db.prepare('SELECT id,locations_json,deleted_at FROM plan_sessions WHERE user_id=?').all(userId)) {
    const scope = String(row.id), parsed = parseLocations(row.locations_json)
    if (!parsed) { protectedScopes.add(`timeline:${scope}`); continue }
    for (const entity of parsed) {
      const identity = key('timeline',scope,entity.id); existing.add(identity)
      if (row.deleted_at === null) sources.set(identity,{kind:'timeline',scopeId:scope,entity})
    }
  }
  for (const row of db.prepare('SELECT l.*,p.deleted_at AS parent_deleted FROM project_locations l JOIN projects p ON p.id=l.project_id WHERE p.user_id=?').all(userId)) {
    const scope = String(row.project_id), identity = key('project',scope,String(row.id)); existing.add(identity)
    let views: LocationView[]
    try { views = JSON.parse(String(row.reference_views_json || '[]')); if (!Array.isArray(views)) throw new Error() }
    catch { protectedScopes.add(`project:${scope}`); continue }
    const entity = {id:String(row.id), name:String(row.name), stage:String(row.stage ?? ''), description:String(row.description ?? ''), continuityNotes:String(row.continuity_notes ?? ''), imagePrompt:String(row.image_prompt ?? ''), revision:Number(row.revision), reference:row.reference_upload_id ? {uploadId:String(row.reference_upload_id)} : null, referenceViews:views}
    if (row.parent_deleted === null) sources.set(identity,{kind:'project',scopeId:scope,entity})
  }
  const links = db.prepare('SELECT * FROM location_source_links WHERE user_id=? ORDER BY timeline_session_id,timeline_location_id,project_id,project_location_id').all(userId) as unknown as Link[]
  const sourceGroups = new Map<string, { identities: Set<string>; sources: Source[] }>()
  for (const [identity, source] of sources) {
    const link = links.find(link => identity === key('timeline',link.timeline_session_id,link.timeline_location_id) || identity === key('project',link.project_id,link.project_location_id))
    let id = locationLibraryId(userId,source.kind,source.scopeId,source.entity.id)
    const identities = new Set([identity])
    if (link) {
      const related = links.filter(candidate => candidate.timeline_session_id === link.timeline_session_id && candidate.timeline_location_id === link.timeline_location_id)
      const timelineId = locationLibraryId(userId,'timeline',link.timeline_session_id,link.timeline_location_id)
      // Prefer an already-published timeline identity. Otherwise preserve an existing project card.
      const established = related.find(candidate => candidate.library_asset_id)?.library_asset_id
        ?? (db.prepare('SELECT id FROM library_assets WHERE id=? AND user_id=?').get(timelineId,userId) ? timelineId : undefined)
        ?? related.map(candidate => locationLibraryId(userId,'project',candidate.project_id,candidate.project_location_id)).find(candidate => db.prepare('SELECT id FROM library_assets WHERE id=? AND user_id=?').get(candidate,userId))
      id = established ?? timelineId
      for (const candidate of related) {
        identities.add(key('timeline',candidate.timeline_session_id,candidate.timeline_location_id)); identities.add(key('project',candidate.project_id,candidate.project_location_id))
        db.prepare('UPDATE location_source_links SET library_asset_id=? WHERE user_id=? AND timeline_session_id=? AND timeline_location_id=? AND project_id=? AND project_location_id=?').run(id,userId,candidate.timeline_session_id,candidate.timeline_location_id,candidate.project_id,candidate.project_location_id)
      }
    }
    const group = sourceGroups.get(id) ?? {identities:new Set<string>(),sources:[]}
    for (const identity of identities) group.identities.add(identity)
    group.sources.push(source); sourceGroups.set(id,group)
  }
  const active = new Set<string>()
  for (const [id, group] of sourceGroups) {
    // The Timeline is authoritative while alive; project is a durable fallback after deletion.
    const source = group.sources.sort((a,b) => (a.kind === 'timeline' ? 0 : 1) - (b.kind === 'timeline' ? 0 : 1)).find(source => ownedViews(db,userId,source.entity).length)
    if (!source) continue
    const e = source.entity, views = ownedViews(db,userId,e)
    const upload = views.find(view => view.uploadId === e.reference?.uploadId)?.uploadId ?? views[0]!.uploadId
    const serialized = JSON.stringify(views), revision = Number.isSafeInteger(e.revision) ? e.revision : 0
    active.add(id)
    const old = db.prepare('SELECT * FROM library_assets WHERE id=? AND user_id=?').get(id,userId) as LinkedRow | undefined
    // Hide previously materialized duplicate source cards; keep their IDs as tombstones.
    for (const identity of group.identities) {
      const [kind,scope,entityId] = JSON.parse(identity) as string[]
      const duplicate = db.prepare('SELECT * FROM library_assets WHERE user_id=? AND id<>? AND source_kind=? AND source_scope_id=? AND source_entity_id=?').get(userId,id,kind!,scope!,entityId!) as LinkedRow | undefined
      if (duplicate) {
        enqueueReleasedViews(db,userId,duplicate)
        db.prepare(`UPDATE library_assets SET source_kind=NULL,source_scope_id=NULL,source_entity_id=NULL,source_deleted=1,reference_upload_id=NULL,reference_views_json='[]',revision=revision+1 WHERE id=? AND user_id=?`).run(duplicate.id,userId)
        db.prepare('UPDATE entity_handles SET active=0 WHERE entity_id=? AND user_id=?').run(duplicate.id,userId)
      }
    }
    if (!old) db.prepare(`INSERT INTO library_assets(id,user_id,kind,name,description,continuity_notes,reference_upload_id,reference_views_json,source_kind,source_scope_id,source_entity_id,source_revision,created_at,updated_at) VALUES(?,?,'location',?,?,?,?,?,?,?,?,?,?,?)`).run(id,userId,e.name,e.description ?? '',e.continuityNotes ?? '',upload,serialized,source.kind,source.scopeId,e.id,revision,Date.now(),Date.now())
    else if (old.name !== e.name || old.description !== (e.description ?? '') || old.continuity_notes !== (e.continuityNotes ?? '') || old.reference_upload_id !== upload || old.reference_views_json !== serialized || old.source_revision !== revision || old.source_deleted || old.source_kind !== source.kind || old.source_scope_id !== source.scopeId || old.source_entity_id !== e.id) {
      if (old.reference_upload_id !== upload || old.reference_views_json !== serialized) enqueueReleasedViews(db,userId,old)
      // A legacy second card for the same known mapping remains an invisible tombstone, never rebind its ID.
      db.prepare(`UPDATE library_assets SET source_kind=NULL,source_scope_id=NULL,source_entity_id=NULL WHERE user_id=? AND id<>? AND source_kind=? AND source_scope_id=? AND source_entity_id=?`).run(userId,id,source.kind,source.scopeId,e.id)
      db.prepare(`UPDATE library_assets SET name=?,description=?,continuity_notes=?,reference_upload_id=?,reference_views_json=?,source_kind=?,source_scope_id=?,source_entity_id=?,source_revision=?,source_deleted=0,revision=revision+1,updated_at=? WHERE id=? AND user_id=?`).run(e.name,e.description ?? '',e.continuityNotes ?? '',upload,serialized,source.kind,source.scopeId,e.id,revision,Date.now(),id,userId)
    }
  }
  const rows = db.prepare('SELECT * FROM library_assets WHERE user_id=? AND (source_kind IS NOT NULL OR source_deleted=1)').all(userId) as unknown as LinkedRow[]
  for (const row of rows) {
    if (active.has(row.id) || protectedScopes.has(`${row.source_kind}:${row.source_scope_id}`)) continue
    const linked = links.filter(link => link.library_asset_id === row.id)
    const identities = [key(row.source_kind,row.source_scope_id,row.source_entity_id), ...linked.flatMap(link => [key('timeline',link.timeline_session_id,link.timeline_location_id),key('project',link.project_id,link.project_location_id)])]
    const hardDeleted = !identities.some(identity => existing.has(identity)) && !linked.some(link => protectedScopes.has(`timeline:${link.timeline_session_id}`) || protectedScopes.has(`project:${link.project_id}`))
    const liveWithoutImages = identities.some(identity => sources.has(identity))
    if ((hardDeleted || liveWithoutImages) && (row.reference_upload_id || row.reference_views_json !== '[]')) {
      enqueueReleasedViews(db,userId,row)
      db.prepare(`UPDATE library_assets SET reference_upload_id=NULL,reference_views_json='[]',source_deleted=1,revision=revision+1,updated_at=? WHERE id=? AND user_id=?`).run(Date.now(),row.id,userId)
    } else if (!row.source_deleted) db.prepare('UPDATE library_assets SET source_deleted=1,revision=revision+1,updated_at=? WHERE id=? AND user_id=?').run(Date.now(),row.id,userId)
    db.prepare('UPDATE entity_handles SET active=0 WHERE entity_id=? AND user_id=?').run(row.id,userId)
  }
}
