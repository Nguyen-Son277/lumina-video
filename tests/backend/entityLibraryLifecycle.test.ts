import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { call, registerUser, startTestServer, type TestContext } from './helpers'
import { MOCK_PNG_BYTES } from '../../server/generations/adapters/mock'
import { createLibraryAsset, setLibraryAssetReference, softDeleteLibraryAsset, updateEntityHandle } from '../../server/entityLibrary/service'
import { resolvePromptDocument } from '../../server/entityLibrary/mentions'
import { assertLibraryAssetIdle } from '../../server/entityLibrary/lifecycle'
import { cleanMediaJobs } from '../../server/projectsTrash/service'
import { listTrash, purgeTrashItem, restoreTrash, TRASH_RETENTION_MS } from '../../server/trash/service'

let ctx: TestContext
let userId: string
beforeEach(async () => { ctx = await startTestServer({ providerMode: 'mock' }); ({ userId } = await registerUser(ctx)) })
afterEach(async () => { vi.restoreAllMocks(); if (ctx) await ctx.close() })
function asset(kind: 'item' | 'logo' = 'item', handle: string = randomUUID()) { return createLibraryAsset(ctx.db, userId, { kind, name: 'Retained entity', handle }) }
function upload() {
  const id = randomUUID(), saved = ctx.mediaStore.saveUpload({ userId, uploadId: id, bytes: MOCK_PNG_BYTES, maxBytes: ctx.env.MAX_SOURCE_IMAGE_BYTES })
  ctx.db.prepare('INSERT INTO uploads (id,user_id,relative_path,mime_type,byte_size,created_at) VALUES (?,?,?,?,?,?)').run(id, userId, saved.relativePath, saved.mimeType, saved.byteSize, Date.now())
  return { id, path: saved.relativePath }
}
function generation(field: string, value: unknown, status = 'succeeded') {
  const id = randomUUID()
  ctx.db.prepare(`INSERT INTO generations (id,user_id,kind,prompt,snap_provider,snap_base_url,snap_model_id,status,created_at,updated_at,${field})
    VALUES (?,?,'image','Retained','mock','https://mock.test/v1','mock',?,?,?,?)`).run(id, userId, status, Date.now(), Date.now(), JSON.stringify(value))
  return id
}
function project(archived = false) {
  const id = randomUUID()
  ctx.db.prepare('INSERT INTO projects (id,user_id,name,archived,created_at,updated_at) VALUES (?,?,?, ?,1,1)').run(id, userId, 'Usage project', archived ? 1 : 0)
  return id
}
function canvas(projectId: string, assetId: string) {
  const graph = { nodes: [{ id: 'source', type: 'item', data: { libraryAssetId: assetId } }, { id: 'next', type: 'note', data: {} }], edges: [{ id: 'wire', source: 'source', target: 'next' }] }
  ctx.db.prepare('INSERT INTO project_canvases (project_id,user_id,graph_json,created_at,updated_at) VALUES (?,?,?,1,1)').run(projectId, userId, JSON.stringify(graph))
  ctx.db.prepare("INSERT INTO project_canvas_links (id,project_id,node_id,role,target_id,library_asset_id,created_at) VALUES (?,?,'source','item',?,?,1)").run(randomUUID(), projectId, assetId, assetId)
}
function grant(path: string, expiresAt: number) {
  const generationId = generation('source_images_json', [])
  ctx.db.prepare('INSERT INTO temporary_media_grants (id,user_id,generation_id,token_hash,relative_path,mime_type,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(randomUUID(), userId, generationId, 'a'.repeat(64), path, 'image/png', expiresAt - 1000, expiresAt)
}

describe('entity library lifecycle', () => {
  it('lists item/logo metadata and authenticated trash thumbnails; repeated delete keeps 30 day deadline', async () => {
    const item = asset('logo'), image = upload()
    setLibraryAssetReference(ctx.db, userId, item.id, image.id)
    softDeleteLibraryAsset(ctx.db, userId, item.id)
    const deleted = ctx.db.prepare('SELECT deleted_at,purge_after FROM library_assets WHERE id=?').get(item.id) as { deleted_at: number; purge_after: number }
    expect(deleted.purge_after - deleted.deleted_at).toBe(TRASH_RETENTION_MS)
    softDeleteLibraryAsset(ctx.db, userId, item.id)
    expect(ctx.db.prepare('SELECT purge_after FROM library_assets WHERE id=?').get(item.id)?.purge_after).toBe(deleted.purge_after)
    const listed = listTrash(ctx.db, userId, { kind: 'library_asset' })
    expect(listed.items[0]).toMatchObject({ kind: 'library_asset', subtitle: 'logo', thumbnailUrl: `/api/uploads/${image.id}`, meta: { mediaKind: 'logo' } })
    expect(listed.counts.library_asset).toBe(1)
    expect((await call(ctx, `/api/uploads/${image.id}`)).status).toBe(200)
    expect((await call(ctx, `/api/uploads/${image.id}`, { cookie: '' })).status).toBe(401)
    expect((await call(ctx, '/api/trash?kind=library_asset')).status).toBe(200)
  })

  it('deletion/recreation never rebinds an old document and restore conflicts atomically until the original handle is free', async () => {
    const old = asset('item', 'retained-box')
    const document = { version: 1 as const, text: '@retained-box', mentions: [{ id: 'mention', start: 0, end: 13, label: 'retained-box', entity: { kind: 'item' as const, id: old.id } }] }
    const activeProject = project()
    ctx.db.prepare('INSERT INTO scenes (id,project_id,title,position,prompt_document_json,created_at,updated_at) VALUES (?,?,?,0,?,1,1)').run(randomUUID(), activeProject, 'Scene', JSON.stringify(document))
    // Simulates explicit detachment from blocking usage, retaining immutable history separately.
    ctx.db.prepare('DELETE FROM scenes WHERE project_id=?').run(activeProject)
    generation('prompt_document_json', document)
    softDeleteLibraryAsset(ctx.db, userId, old.id)
    const replacement = asset('item', 'retained-box')
    expect(replacement.id).not.toBe(old.id)
    expect(() => resolvePromptDocument(ctx.db, userId, document)).toThrow()
    const before = ctx.db.prepare('SELECT * FROM library_assets WHERE id=?').get(old.id)
    expect((await call(ctx, `/api/trash/library_asset/${old.id}/restore`, { method: 'POST' })).status).toBe(409)
    expect(ctx.db.prepare('SELECT * FROM library_assets WHERE id=?').get(old.id)).toEqual(before)
    expect(ctx.db.prepare('SELECT active FROM entity_handles WHERE entity_id=?').get(old.id)?.active).toBe(0)
    updateEntityHandle(ctx.db, userId, { kind: 'item', id: replacement.id }, 'different-box')
    restoreTrash(ctx.db, userId, 'library_asset', old.id)
    expect(resolvePromptDocument(ctx.db, userId, document).entities[0]?.id).toBe(old.id)
    expect(ctx.db.prepare('SELECT prompt_document_json FROM generations').get()?.prompt_document_json).toBe(JSON.stringify(document))
  })

  it('purge leaves ID tombstones, queues rather than deletes physical media and only removes orphan uploads', () => {
    const item = asset(), image = upload()
    setLibraryAssetReference(ctx.db, userId, item.id, image.id)
    softDeleteLibraryAsset(ctx.db, userId, item.id)
    purgeTrashItem(ctx.db, userId, 'library_asset', item.id)
    expect(ctx.db.prepare('SELECT id FROM library_assets WHERE id=?').get(item.id)).toBeUndefined()
    expect(ctx.db.prepare('SELECT active FROM entity_handles WHERE entity_id=?').get(item.id)?.active).toBe(0)
    expect(ctx.db.prepare('SELECT id FROM uploads WHERE id=?').get(image.id)).toBeUndefined()
    expect(ctx.mediaStore.exists(image.path)).toBe(true)
    expect(ctx.db.prepare('SELECT kind FROM media_cleanup_jobs WHERE path=?').get(image.path)?.kind).toBe('orphan_upload')
    expect(cleanMediaJobs({ db: ctx.db, mediaStore: ctx.mediaStore }).cleaned).toBe(1)
    expect(ctx.mediaStore.exists(image.path)).toBe(false)
  })

  it.each(['source_images_json', 'entity_references_json', 'logo_overlays_json'])('keeps retained %s snapshots and blocks upload DELETE', async field => {
    const item = asset(), image = upload()
    setLibraryAssetReference(ctx.db, userId, item.id, image.id)
    const generationId = generation(field, [{ entityId: item.id, reference: { uploadId: image.id, path: image.path } }])
    softDeleteLibraryAsset(ctx.db, userId, item.id)
    purgeTrashItem(ctx.db, userId, 'library_asset', item.id)
    expect(cleanMediaJobs({ db: ctx.db, mediaStore: ctx.mediaStore }).cleaned).toBe(0)
    expect(ctx.db.prepare('SELECT id FROM uploads WHERE id=?').get(image.id)).toBeDefined()
    expect((await call(ctx, `/api/uploads/${image.id}`, { method: 'DELETE' })).status).toBe(400)
    ctx.db.prepare('DELETE FROM generations WHERE id=?').run(generationId)
    expect(cleanMediaJobs({ db: ctx.db, mediaStore: ctx.mediaStore }).cleaned).toBe(1)
    expect(ctx.mediaStore.exists(image.path)).toBe(false)
  })

  it('retains a shared upload until every library owner is purged', () => {
    const first = asset(), second = asset(), image = upload()
    setLibraryAssetReference(ctx.db, userId, first.id, image.id)
    setLibraryAssetReference(ctx.db, userId, second.id, image.id)
    softDeleteLibraryAsset(ctx.db, userId, first.id)
    purgeTrashItem(ctx.db, userId, 'library_asset', first.id)
    expect(cleanMediaJobs({ db: ctx.db, mediaStore: ctx.mediaStore }).cleaned).toBe(0)
    expect(ctx.db.prepare('SELECT id FROM uploads WHERE id=?').get(image.id)).toBeDefined()
    softDeleteLibraryAsset(ctx.db, userId, second.id)
    purgeTrashItem(ctx.db, userId, 'library_asset', second.id)
    expect(cleanMediaJobs({ db: ctx.db, mediaStore: ctx.mediaStore }).cleaned).toBeGreaterThan(0)
    expect(ctx.mediaStore.exists(image.path)).toBe(false)
  })

  it('keeps active grants until expiry then safely collects the orphan upload', async () => {
    const item = asset(), image = upload(), now = Date.now(), expiresAt = now + 60000
    setLibraryAssetReference(ctx.db, userId, item.id, image.id)
    grant(image.path, expiresAt)
    softDeleteLibraryAsset(ctx.db, userId, item.id)
    purgeTrashItem(ctx.db, userId, 'library_asset', item.id, now)
    expect(cleanMediaJobs({ db: ctx.db, mediaStore: ctx.mediaStore, now }).cleaned).toBe(0)
    expect((await call(ctx, `/api/uploads/${image.id}`, { method: 'DELETE' })).status).toBe(400)
    expect(cleanMediaJobs({ db: ctx.db, mediaStore: ctx.mediaStore, now: expiresAt + 1 }).cleaned).toBe(1)
    expect(ctx.db.prepare('SELECT id FROM uploads WHERE id=?').get(image.id)).toBeUndefined()
  })

  it('blocks queued snapshot work and editable Canvas/scene usage; purges archived invalid nodes without rewriting scene mentions', () => {
    const item = asset(), projectId = project(), sceneId = randomUUID()
    canvas(projectId, item.id)
    ctx.db.prepare('INSERT INTO scenes (id,project_id,title,position,prompt_document_json,created_at,updated_at) VALUES (?,?,?,0,?,1,1)').run(sceneId, projectId, 'Scene', JSON.stringify({ entity: { id: item.id, kind: 'item' } }))
    expect(() => assertLibraryAssetIdle(ctx.db, userId, item.id)).toThrow()
    ctx.db.prepare('UPDATE projects SET archived=1 WHERE id=?').run(projectId)
    const pending = generation('logo_overlays_json', [{ entityId: item.id }], 'queued')
    expect(() => assertLibraryAssetIdle(ctx.db, userId, item.id)).toThrow()
    // A legacy source-only snapshot is busy even when it carries no entity ID.
    const image = upload()
    setLibraryAssetReference(ctx.db, userId, item.id, image.id)
    const sourcePending = generation('source_images_json', [{ path: image.path }], 'unknown')
    ctx.db.prepare("UPDATE generations SET status='succeeded' WHERE id=?").run(pending)
    expect(() => assertLibraryAssetIdle(ctx.db, userId, item.id)).toThrow()
    ctx.db.prepare("UPDATE generations SET status='succeeded' WHERE id=?").run(sourcePending)
    softDeleteLibraryAsset(ctx.db, userId, item.id)
    purgeTrashItem(ctx.db, userId, 'library_asset', item.id)
    const graph = JSON.parse(String(ctx.db.prepare('SELECT graph_json FROM project_canvases WHERE project_id=?').get(projectId)?.graph_json))
    expect(graph.nodes.map((node: { id: string }) => node.id)).toEqual(['next'])
    expect(graph.edges).toEqual([])
    expect(ctx.db.prepare('SELECT id FROM project_canvas_links WHERE library_asset_id=?').get(item.id)).toBeUndefined()
    expect(String(ctx.db.prepare('SELECT prompt_document_json FROM scenes WHERE id=?').get(sceneId)?.prompt_document_json)).toContain(item.id)
  })

  it('default DELETE service blocks editable usage and pending jobs before any registry mutation', async () => {
    const item = asset(), projectId = project()
    canvas(projectId, item.id)
    expect(() => softDeleteLibraryAsset(ctx.db, userId, item.id)).toThrow()
    expect(ctx.db.prepare('SELECT deleted_at FROM library_assets WHERE id=?').get(item.id)?.deleted_at).toBeNull()
    expect(ctx.db.prepare('SELECT active FROM entity_handles WHERE entity_id=?').get(item.id)?.active).toBe(1)
    // Verify purge also blocks if work starts after deletion (old frozen inputs).
    ctx.db.prepare('UPDATE projects SET archived=1 WHERE id=?').run(projectId)
    softDeleteLibraryAsset(ctx.db, userId, item.id)
    const pending = generation('entity_references_json', [{ id: item.id }], 'running')
    expect((await call(ctx, `/api/trash/library_asset/${item.id}`, { method: 'DELETE' })).status).toBe(400)
    expect(ctx.db.prepare('SELECT id FROM library_assets WHERE id=?').get(item.id)).toBeDefined()
    ctx.db.prepare("UPDATE generations SET status='succeeded' WHERE id=?").run(pending)
  })

  it('enforces expiry boundary, owner isolation and no name-based ID matching', async () => {
    const item = asset(), image = upload(), now = Date.now()
    setLibraryAssetReference(ctx.db, userId, item.id, image.id)
    // Plain prompt text containing an old handle is not a bound reference.
    const projectId = project()
    ctx.db.prepare("INSERT INTO scenes (id,project_id,title,prompt,position,created_at,updated_at) VALUES (?,?,'Text only',?,0,1,1)").run(randomUUID(), projectId, `@${item.handle}`)
    expect(() => assertLibraryAssetIdle(ctx.db, userId, item.id)).not.toThrow()
    softDeleteLibraryAsset(ctx.db, userId, item.id)
    ctx.db.prepare('UPDATE library_assets SET deleted_at=?,purge_after=? WHERE id=?').run(now - TRASH_RETENTION_MS, now, item.id)
    expect(() => restoreTrash(ctx.db, userId, 'library_asset', item.id, now)).toThrow()
    const ownerCookie = ctx.cookie
    await registerUser(ctx)
    expect((await call(ctx, '/api/trash?kind=library_asset')).body.total).toBe(0)
    expect((await call(ctx, `/api/uploads/${image.id}`)).status).toBe(404)
    expect((await call(ctx, `/api/trash/library_asset/${item.id}/restore`, { method: 'POST' })).status).toBe(404)
    ctx.cookie = ownerCookie
    purgeTrashItem(ctx.db, userId, 'library_asset', item.id, now)
    expect(ctx.db.prepare('SELECT id FROM library_assets WHERE id=?').get(item.id)).toBeUndefined()
  })

  it('blocks upload DELETE referenced by library, project items/locations, Canvas, scenes or planner JSON', async () => {
    const item = asset(), image = upload(), projectId = project()
    const check = async () => expect((await call(ctx, `/api/uploads/${image.id}`, { method: 'DELETE' })).status).toBe(400)
    setLibraryAssetReference(ctx.db, userId, item.id, image.id); await check()
    setLibraryAssetReference(ctx.db, userId, item.id, null)
    ctx.db.prepare("INSERT INTO project_items (id,project_id,user_id,kind,name,reference_upload_id,created_at,updated_at) VALUES (?,?,?,'prop','Prop',?,1,1)").run(randomUUID(), projectId, userId, image.id); await check()
    ctx.db.prepare('DELETE FROM project_items WHERE project_id=?').run(projectId)
    ctx.db.prepare("INSERT INTO project_locations (id,project_id,name,reference_upload_id,created_at,updated_at) VALUES (?,?,'Location',?,1,1)").run(randomUUID(), projectId, image.id); await check()
    ctx.db.prepare('DELETE FROM project_locations WHERE project_id=?').run(projectId)
    ctx.db.prepare("INSERT INTO project_canvas_links (id,project_id,node_id,role,target_id,upload_id,created_at) VALUES (?,?,'source','upload',?,?,1)").run(randomUUID(), projectId, image.id, image.id); await check()
    ctx.db.prepare('DELETE FROM project_canvas_links WHERE project_id=?').run(projectId)
    ctx.db.prepare("INSERT INTO scenes (id,project_id,title,position,params_json,created_at,updated_at) VALUES (?,?,'Scene',0,?,1,1)").run(randomUUID(), projectId, JSON.stringify({ sourceUploadIds: [image.id] })); await check()
    ctx.db.prepare('DELETE FROM scenes WHERE project_id=?').run(projectId)
    const plan = await call(ctx, '/api/plans', { method: 'POST', body: { title: 'Retained' } })
    ctx.db.prepare('UPDATE plan_sessions SET timeline_json=? WHERE id=?').run(JSON.stringify([{ background: { uploadId: image.id } }]), plan.body.session.id); await check()
    ctx.db.prepare('UPDATE plan_sessions SET timeline_json=? WHERE id=?').run('[]', plan.body.session.id)
    expect((await call(ctx, `/api/uploads/${image.id}`, { method: 'DELETE' })).status).toBe(204)
    expect(ctx.mediaStore.exists(image.path)).toBe(true)
    cleanMediaJobs({ db: ctx.db, mediaStore: ctx.mediaStore })
    expect(ctx.mediaStore.exists(image.path)).toBe(false)
  })
})
