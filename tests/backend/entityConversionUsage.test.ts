import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type Database } from '../../server/db/index'
import { assertEntityConvertible, getEntityConversionUsage } from '../../server/entityLibrary/conversionUsage'
import type { EntityKind, EntityRef } from '../../server/entityLibrary/service'

let db: Database
const owner = 'usage-owner', other = 'other-owner'
const ref: EntityRef = { kind: 'item', id: 'entity-id' }
const character: EntityRef = { kind: 'character', id: 'character-id' }
const path = `${owner}/uploads/reference.png`
const json = JSON.stringify
function project(id = 'project', userId = owner, archived = 0, deletedAt: number | null = null) {
  db.prepare('INSERT INTO projects(id,user_id,name,archived,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,1,1)').run(id, userId, 'Project label', archived, deletedAt)
  return id
}
function scene(projectId = project(), fields: Record<string, unknown> = {}) {
  const row = { id: 'scene', project_id: projectId, title: 'Scene label', position: 0, created_at: 1, updated_at: 1, ...fields }
  db.prepare(`INSERT INTO scenes(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row) as Array<string | number | null>)
}
function quick(id = 'quick', userId = owner) {
  db.prepare('INSERT INTO quick_sessions(id,user_id,title,created_at,updated_at) VALUES(?,?,?,1,1)').run(id, userId, 'Quick label')
  return id
}
function plan(id = 'plan', userId = owner, fields: Record<string, unknown> = {}) {
  const row = { id, user_id: userId, title: 'Planner label', created_at: 1, updated_at: 1, ...fields }
  db.prepare(`INSERT INTO plan_sessions(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row) as Array<string | number | null>)
  return id
}
function generation(status = 'queued', field = 'entity_references_json', value: unknown = [ref], userId = owner, postprocess: string | null = null) {
  db.prepare(`INSERT INTO generations(id,user_id,kind,prompt,snap_provider,snap_base_url,snap_model_id,status,postprocess_status,${field},created_at,updated_at)
    VALUES('generation',?,'image','Plain text','mock','https://mock.test','mock',?,?,?,1,1)`).run(userId, status, postprocess, json(value))
}
function document(entity: EntityRef = ref) {
  return { version: 1, text: '#old-alias', mentions: [{ id: 'binding', start: 0, end: 10, label: 'old-alias', entity }] }
}
function usage(entity = ref, media?: string[]) { return getEntityConversionUsage(db, owner, entity, media) }
function blocked(type: string, entity = ref, media?: string[]) {
  const result = usage(entity, media)
  expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ type, label: expect.any(String) })]))
  expect(() => assertEntityConvertible(db, owner, entity, media)).toThrow(expect.objectContaining({ status: 409, code: 'CONFLICT', details: { usage: result } }))
  return result
}
beforeEach(() => {
  db = openDatabase(':memory:')
  for (const id of [owner, other]) db.prepare('INSERT INTO users(id,email,password_hash,password_salt,created_at) VALUES(?,?,?,?,1)').run(id, `${id}@example.test`, 'synthetic', 'synthetic')
  db.prepare("INSERT INTO library_assets(id,user_id,kind,name,created_at,updated_at) VALUES(?,?,'item','Entity label',1,1)").run(ref.id, owner)
  db.prepare("INSERT INTO characters(id,user_id,name,created_at,updated_at) VALUES(?,?,'Character label',1,1)").run(character.id, owner)
})
afterEach(() => { db.close() })

describe('entity conversion usage guard (local database only)', () => {
  const kinds: EntityKind[] = ['character', 'item', 'logo', 'location']
  it.each(kinds.flatMap(from => kinds.filter(to => to !== from).map(to => [from, to] as const)))('permits unused %s → %s without counting entity rows or handles', (from, _to) => {
    const entity = from === 'character' ? character : { ...ref, kind: from }
    if (from !== 'character') db.prepare('UPDATE library_assets SET kind=? WHERE id=?').run(from, ref.id)
    db.prepare('INSERT INTO entity_handles(id,user_id,kind,entity_id,handle,handle_key,created_at) VALUES(?,?,?,?,?,?,1)').run('handle', owner, from, entity.id, 'alias', 'alias')
    expect(usage(entity)).toEqual([])
    expect(() => assertEntityConvertible(db, owner, entity)).not.toThrow()
  })

  it.each([[0, null], [1, null], [0, 123]] as const)('blocks scene documents in active/archived/trashed projects (%s,%s)', (archived, deletedAt) => {
    scene(project('project', owner, archived, deletedAt), { prompt_document_json: json(document()) })
    expect(blocked('scene')[0]).toMatchObject({ sceneId: 'scene', projectId: 'project', label: 'Scene label' })
  })
  it.each(['speaker', 'cast'] as const)('blocks scene %s without any reference image', mode => {
    scene(project(), mode === 'speaker' ? { character_id: character.id } : {})
    if (mode === 'cast') db.prepare('INSERT INTO scene_characters(scene_id,character_id,position) VALUES(?,?,0)').run('scene', character.id)
    blocked('scene', character)
  })
  it.each(['context_documents_json', 'params_json'] as const)('finds structured scene references in %s', field => {
    scene(project(), { [field]: json(field === 'params_json' ? { logoOverlays: [{ entityId: ref.id }] } : [document()]) })
    blocked('scene')
  })
  it('ignores raw names/text, binding IDs and wrong entity kind with the same ID', () => {
    scene(project(), { title: ref.id, prompt: `#${ref.id}`, dialogue: ref.id, params_json: json({ background: ref.id }), prompt_document_json: json({ version: 1, text: ref.id, mentions: [{ id: ref.id, label: ref.id, entity: { kind: 'logo', id: ref.id } }] }) })
    expect(usage()).toEqual([])
  })
  it.each(['graph', 'link'] as const)('blocks archived Canvas %s references', mode => {
    const projectId = project('project', owner, 1)
    if (mode === 'graph') db.prepare('INSERT INTO project_canvases(project_id,user_id,graph_json,created_at,updated_at) VALUES(?,?,?,1,1)').run(projectId, owner, json({ nodes: [{ id: 'source', kind: 'library', data: { sourceId: ref.id, entityKind: ref.kind } }], edges: [] }))
    else db.prepare("INSERT INTO project_canvas_links(id,project_id,node_id,role,target_id,library_asset_id,created_at) VALUES('link',?,'node','library',?,?,1)").run(projectId, ref.id, ref.id)
    blocked('canvas')
  })
  it('does not confuse Canvas node IDs or project-local item IDs with library IDs', () => {
    db.prepare('INSERT INTO project_canvases(project_id,user_id,graph_json,created_at,updated_at) VALUES(?,?,?,1,1)').run(project(), owner, json({ nodes: [{ id: ref.id, kind: 'item', data: { sourceId: ref.id } }, { id: character.id, kind: 'character', data: {} }], edges: [] }))
    expect(usage()).toEqual([])
    expect(usage(character)).toEqual([])
  })
  it.each(['characters', 'document', 'canvas'] as const)('blocks quick-session %s', mode => {
    const sessionId = quick()
    if (mode === 'characters') db.prepare('INSERT INTO quick_session_characters(session_id,character_id,position) VALUES(?,?,0)').run(sessionId, character.id)
    if (mode === 'document') db.prepare('UPDATE quick_sessions SET prompt_document_json=? WHERE id=?').run(json(document()), sessionId)
    if (mode === 'canvas') db.prepare('INSERT INTO quick_canvases(session_id,user_id,graph_json,created_at,updated_at) VALUES(?,?,?,1,1)').run(sessionId, owner, json({ nodes: [{ id: 'node', kind: 'prompt', data: { promptDocument: document() } }] }))
    blocked(mode === 'canvas' ? 'quick_canvas' : 'quick_session', mode === 'characters' ? character : ref)
  })
  it('excludes tombstoned quick imports, but blocks retained live import snapshots', () => {
    db.prepare('INSERT INTO quick_canvas_sources(session_id,source_key,node_id,snapshot_json,tombstoned) VALUES(?,?,?,?,1)').run(quick(), 'import', 'node', json({ kind: 'library', data: { sourceId: ref.id, entityKind: ref.kind } }))
    expect(usage()).toEqual([])
    db.prepare('UPDATE quick_canvas_sources SET tombstoned=0').run()
    blocked('quick_canvas')
  })
  it.each(['script_json', 'timeline_json', 'cast_json', 'plan_json'] as const)('blocks restorable planner %s', field => {
    plan('plan', owner, { deleted_at: 123, [field]: json(field === 'cast_json' || field === 'plan_json' ? { characters: [{ reuseCharacterId: character.id }] } : { scenes: [{ mentionDocuments: { action: document(character) } }] }) })
    blocked('planner', character)
  })
  it('blocks explicit timeline entity provenance after the source artifact was cleared', () => {
    db.prepare('INSERT INTO timeline_canvas_sessions(session_id,project_id,user_id,created_at) VALUES(?,?,?,1)').run(plan(), project(), owner)
    db.prepare("INSERT INTO timeline_canvas_entities(session_id,source_kind,source_id,target_id,snapshot_json) VALUES('plan','cast','cast-local',?,'{}')").run(character.id)
    blocked('timeline_canvas', character)
  })
  it.each(['pending', 'running', 'error', 'stopped'] as const)('blocks %s batch snapshots with no generation yet', status => {
    db.prepare("INSERT INTO plan_image_batches(id,user_id,session_id,status,created_at,updated_at) VALUES('batch',?,?,'done',1,1)").run(owner, plan())
    db.prepare("INSERT INTO plan_image_batch_items(id,batch_id,frame_id,position,status,snapshot_json,created_at,updated_at) VALUES('item','batch','frame',0,?,?,1,1)").run(status, json({ contextDocuments: [document()] }))
    expect(blocked('image_batch')[0]).toMatchObject({ batchId: 'batch', itemId: 'item' })
    db.prepare("UPDATE plan_image_batch_items SET status='done'").run()
    expect(usage()).toEqual([])
  })
  it.each(['queued', 'running', 'downloading', 'unknown'] as const)('blocks %s generation identity snapshots', status => {
    generation(status)
    blocked('generation')
  })
  it.each(['queued', 'running'] as const)('blocks completed generations still %s in postprocessing', postprocess => {
    generation('succeeded', 'logo_overlays_json', [{ entityId: ref.id, path }], owner, postprocess)
    blocked('generation')
  })
  it.each(['succeeded', 'failed'] as const)('completed %s generation snapshots are immutable and nonblocking', status => {
    generation(status)
    expect(usage()).toEqual([])
    db.prepare("UPDATE generations SET entity_references_json='{broken'").run()
    expect(usage()).toEqual([])
  })
  it.each(['character', 'cast'] as const)('recognizes legacy prompt snapshot %s container', field => {
    generation('queued', 'prompt_snapshot_json', { [field]: field === 'cast' ? [{ id: character.id }] : { id: character.id } })
    blocked('generation', character)
  })
  it('resolves current entity upload/path identities without counting its own reference', () => {
    db.prepare("INSERT INTO uploads(id,user_id,relative_path,mime_type,byte_size,created_at) VALUES('upload',?,?,'image/png',1,1)").run(owner, path)
    db.prepare("UPDATE library_assets SET reference_upload_id='upload' WHERE id=?").run(ref.id)
    expect(usage()).toEqual([])
    generation('queued', 'source_images_json', [{ path, mime: 'image/png' }])
    blocked('generation')
  })
  it('finds historical media passed by conversion without matching raw prompt strings', () => {
    generation('running', 'params_json', { endImageUploadId: 'old-upload' })
    blocked('generation', ref, ['old-upload'])
    db.prepare('UPDATE generations SET params_json=?').run(json({ prompt: 'old-upload', background: path }))
    expect(usage(ref, ['old-upload', path])).toEqual([])
  })
  it.each(['scene', 'canvas', 'quick', 'planner', 'batch', 'generation'] as const)('fails closed on corrupt mutable %s JSON', type => {
    if (type === 'scene') scene(project(), { params_json: '{broken' })
    if (type === 'canvas') db.prepare("INSERT INTO project_canvases(project_id,user_id,graph_json,created_at,updated_at) VALUES(?,?,'{broken',1,1)").run(project(), owner)
    if (type === 'quick') db.prepare("UPDATE quick_sessions SET prompt_document_json='{broken' WHERE id=?").run(quick())
    if (type === 'planner') plan('plan', owner, { timeline_json: '{broken' })
    if (type === 'batch') {
      db.prepare("INSERT INTO plan_image_batches(id,user_id,session_id,created_at,updated_at) VALUES('batch',?,?,1,1)").run(owner, plan())
      db.prepare("INSERT INTO plan_image_batch_items(id,batch_id,frame_id,position,snapshot_json,created_at,updated_at) VALUES('item','batch','frame',0,'{broken',1,1)").run()
    }
    if (type === 'generation') { generation(); db.prepare("UPDATE generations SET params_json='{broken'").run() }
    expect(usage()).toEqual(expect.arrayContaining([expect.objectContaining({ invalidMetadata: true })]))
    expect(() => assertEntityConvertible(db, owner, ref)).toThrow(expect.objectContaining({ status: 409 }))
  })
  it('does not scan another account or disclose its labels, even for corrupt JSON', () => {
    scene(project('foreign', other), { title: 'Private foreign title', prompt_document_json: json(document()) })
    plan('foreign-plan', other, { timeline_json: '{broken' })
    generation('queued', 'entity_references_json', [ref], other)
    db.prepare("INSERT INTO quick_canvases(session_id,user_id,graph_json,created_at,updated_at) VALUES(?,?,'{broken',1,1)").run(quick('foreign-quick', other), other)
    expect(usage()).toEqual([])
  })
  it('ignores its own conversion archive, even when retained metadata is corrupt', () => {
    db.prepare("INSERT INTO entity_conversion_data(entity_id,user_id,voice_json,retained_media_json,updated_at) VALUES(?,?,'{broken',?,1)").run(ref.id, owner, json([{ path, entityId: ref.id }]))
    expect(usage(ref, [path])).toEqual([])
  })
  it('does not block retryable batch output reattachment from a completed generation', () => {
    generation('succeeded')
    db.prepare("INSERT INTO plan_image_batches(id,user_id,session_id,status,created_at,updated_at) VALUES('batch',?,?,'done',1,1)").run(owner, plan())
    db.prepare("INSERT INTO plan_image_batch_items(id,batch_id,frame_id,position,status,generation_id,snapshot_json,created_at,updated_at) VALUES('item','batch','frame',0,'error','generation',?,1,1)").run(json({ contextDocuments: [document()] }))
    expect(usage()).toEqual([])
    db.prepare("UPDATE generations SET status='failed'").run()
    blocked('image_batch')
  })
  it.each(['entity_references_json', 'prompt_document_json', 'prompt_snapshot_json', 'source_images_json', 'character_reference_json', 'character_references_json', 'logo_overlays_json', 'params_json'] as const)('finds active generation refs in %s', field => {
    const value = field === 'prompt_document_json' ? document() : field === 'prompt_snapshot_json' ? { entities: [ref] } : field === 'source_images_json' || field.startsWith('character_reference') ? [{ path }] : field === 'params_json' ? { logoOverlays: [{ entityId: ref.id }] } : [{ ...ref, entityId: ref.id }]
    generation('running', field, value)
    blocked('generation', ref, [path])
  })
  it('collects pinned location view upload paths as media identities', () => {
    db.prepare("INSERT INTO uploads(id,user_id,relative_path,mime_type,byte_size,created_at) VALUES('view-upload',?,?,'image/png',1,1)").run(owner, path)
    db.prepare("UPDATE library_assets SET kind='location',reference_views_json=? WHERE id=?").run(json([{ id: 'view', uploadId: 'view-upload', label: 'View', sheet: false }]), ref.id)
    const location = { ...ref, kind: 'location' as const }
    expect(usage(location)).toEqual([])
    generation('queued', 'source_images_json', [{ path }])
    blocked('generation', location)
  })
  it('requires both Canvas row owner and parent project owner', () => {
    db.prepare("INSERT INTO project_canvases(project_id,user_id,graph_json,created_at,updated_at) VALUES(?,?,?,1,1)").run(project('foreign', other), owner, json({ nodes: [{ kind: 'library', data: { entityKind: ref.kind, sourceId: ref.id } }] }))
    expect(usage()).toEqual([])
  })
})
