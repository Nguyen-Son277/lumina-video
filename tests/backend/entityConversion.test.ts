import { randomUUID } from 'node:crypto'
import { symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { convertEntity, getEntityConversionData } from '../../server/entityLibrary/conversion'
import { createLibraryAsset, entityLibraryUsageBytes, listEntityCatalog, resolveEntity, saveLibraryAssetReference, type EntityKind } from '../../server/entityLibrary/service'
import { setCharacterMedia } from '../../server/entityLibrary/characterMedia'
import { cleanMediaJobs } from '../../server/projectsTrash/service'
import { ownedCharacterById } from '../../server/projects/service'
import { purgeTrashItem, softDelete } from '../../server/trash/service'
import { call, registerUser, startTestServer, type TestContext } from './helpers'

const PNG = Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0])
const KINDS: EntityKind[] = ['character', 'item', 'logo', 'location']
const directions = KINDS.flatMap(from => KINDS.filter(to => to !== from).map(to => [from, to] as const))

describe('atomic reversible entity conversion', () => {
  let ctx: TestContext, userId: string
  beforeEach(async () => { ctx = await startTestServer(); userId = (await registerUser(ctx)).userId })
  afterEach(async () => { vi.restoreAllMocks(); await ctx.close() })
  function create(kind: EntityKind, withImage = false) {
    let entity
    if (kind === 'character') {
      const id = randomUUID()
      ctx.db.prepare(`INSERT INTO characters(id,user_id,name,appearance,voice_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
        .run(id, userId, 'Original', 'Original description', '{"accent":"Northern","pitch":"low"}', 123, 234)
      if (withImage) setCharacterMedia(ctx.db, ownedCharacterById(ctx.db, userId, id), ctx.mediaStore.saveCharacterReference({ userId, characterId: id, bytes: PNG, maxBytes: ctx.env.MAX_REFERENCE_BYTES }))
      entity = resolveEntity(ctx.db, userId, { kind, id })
    } else {
      entity = createLibraryAsset(ctx.db, userId, { kind, name: 'Original', description: 'Original description', continuityNotes: 'Keep this note' })
      ctx.db.prepare('UPDATE library_assets SET created_at=123 WHERE id=?').run(entity.id)
      if (withImage) entity = saveLibraryAssetReference(ctx.db, ctx.env, ctx.mediaStore, userId, entity.id, PNG)
    }
    return entity
  }
  function convert(entity: ReturnType<typeof create>, targetKind: EntityKind, extra = {}) {
    return convertEntity(ctx.db, ctx.env, ctx.mediaStore, userId, entity, {
      targetKind, expectedRevision: entity.revision, name: 'Edited name', description: 'Edited description', ...extra,
    })
  }

  it.each(directions)('moves %s → %s retaining identity/alias/date without trash source', (from, to) => {
    const source = create(from), target = convert(source, to)
    expect(target).toMatchObject({ id: source.id, kind: to, handle: source.handle, name: 'Edited name', description: 'Edited description' })
    expect(target.revision).toBeGreaterThan(source.revision)
    const table = to === 'character' ? 'characters' : 'library_assets'
    expect(ctx.db.prepare(`SELECT created_at,deleted_at FROM ${table} WHERE id=?`).get(source.id)).toMatchObject({ created_at: 123, deleted_at: null })
    expect(listEntityCatalog(ctx.db, userId).filter(item => item.id === source.id)).toHaveLength(1)
    expect(ctx.db.prepare('SELECT kind FROM entity_handles WHERE entity_id=? AND active=1').all(source.id)).toEqual([{ kind: to }])
    expect(ctx.db.prepare('SELECT active FROM entity_handles WHERE kind=? AND entity_id=?').get(from, source.id)).toMatchObject({ active: 0 })
    expect(() => resolveEntity(ctx.db, userId, source)).toThrow()
    expect(ctx.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('archives voice, continuity notes and location views across multiple cycles', () => {
    let entity = create('location', true)
    const uploadId = randomUUID(), saved = ctx.mediaStore.saveUpload({ userId, uploadId, bytes: PNG, maxBytes: ctx.env.MAX_REFERENCE_BYTES })
    ctx.db.prepare('INSERT INTO uploads(id,user_id,relative_path,mime_type,byte_size,created_at) VALUES(?,?,?,?,?,1)').run(uploadId, userId, saved.relativePath, saved.mimeType, saved.byteSize)
    const views = [{ id: 'front', label: 'Front view', uploadId, sheet: true }]
    ctx.db.prepare('UPDATE library_assets SET reference_views_json=? WHERE id=?').run(JSON.stringify(views), entity.id)
    entity = convert(entity, 'character', { voice: { accent: 'Southern' }, continuityNotes: 'Updated note' })
    expect(getEntityConversionData(ctx.db, userId, entity)).toEqual({ revision: entity.revision, voice: { accent: 'Southern' }, continuityNotes: 'Updated note', referenceViews: views })
    entity = convert(entity, 'logo')
    expect(getEntityConversionData(ctx.db, userId, entity).voice).toEqual({ accent: 'Southern' })
    entity = convert(entity, 'location')
    expect(entity).toMatchObject({ continuityNotes: 'Updated note', referenceViews: views })
    entity = convert(entity, 'character')
    expect(JSON.parse(ownedCharacterById(ctx.db, userId, entity.id).voice_json)).toEqual({ accent: 'Southern' })
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM entity_handles WHERE entity_id=? AND active=1').get(entity.id)!.n).toBe(1)
  })

  it.each(directions.filter(([from, to]) => from === 'character' || to === 'character'))('copies canonical primary image %s → %s using actual store root', (from, to) => {
    const source = create(from, true), originalPath = source.reference!.path
    const originalBytes = ctx.mediaStore.readFile(originalPath)
    // MEDIA_DIR is deliberately wrong; use the injected store, never reconstruct it.
    const env = { ...ctx.env, MEDIA_DIR: join(ctx.dir, 'wrong-media-root') }
    const target = convertEntity(ctx.db, env, ctx.mediaStore, userId, source, { targetKind: to, expectedRevision: source.revision, name: 'Image', description: '' })
    expect(target.reference!.path).not.toBe(originalPath)
    expect(target.reference!.path).toContain(to === 'character' ? '/characters/' : '/uploads/')
    expect(ctx.mediaStore.readFile(target.reference!.path)).toEqual(originalBytes)
    expect(entityLibraryUsageBytes(ctx.db, userId)).toBe(PNG.byteLength * 2)
    expect(cleanMediaJobs({ db: ctx.db, mediaStore: ctx.mediaStore }).cleaned).toBe(0)
    expect(ctx.mediaStore.exists(originalPath)).toBe(true)
  })

  it('keeps primary upload on same-table moves without extra quota or copy', () => {
    const source = create('item', true), target = convert(source, 'logo')
    expect(target.reference).toEqual(source.reference)
    expect(entityLibraryUsageBytes(ctx.db, userId)).toBe(PNG.byteLength)
  })

  it('rejects quota before disk writes and preserves the source completely', () => {
    const source = create('character', true), save = vi.spyOn(ctx.mediaStore, 'saveUpload')
    ctx.env.MAX_USER_MEDIA_BYTES = PNG.byteLength * 2 - 1
    expect(() => convert(source, 'item')).toThrow(expect.objectContaining({ status: 413 }))
    expect(save).not.toHaveBeenCalled()
    expect(resolveEntity(ctx.db, userId, source)).toEqual(source)
    expect(entityLibraryUsageBytes(ctx.db, userId)).toBe(PNG.byteLength)
  })

  it('accounts an unregistered legacy primary image before quota and retains its actual bytes', () => {
    const source = create('character', true), path = source.reference!.path
    ctx.db.prepare('UPDATE characters SET reference_bytes=NULL WHERE id=?').run(source.id)
    ctx.db.prepare('DELETE FROM immutable_media_versions WHERE path=?').run(path)
    expect(entityLibraryUsageBytes(ctx.db, userId)).toBe(0)
    ctx.env.MAX_USER_MEDIA_BYTES = PNG.byteLength * 2 - 1
    const save = vi.spyOn(ctx.mediaStore, 'saveUpload')
    expect(() => convert(source, 'item')).toThrow(expect.objectContaining({ status: 413 }))
    expect(save).not.toHaveBeenCalled()
    expect(ctx.db.prepare('SELECT reference_bytes FROM characters WHERE id=?').get(source.id)).toMatchObject({ reference_bytes: null })
    expect(ctx.db.prepare('SELECT 1 FROM immutable_media_versions WHERE path=?').get(path)).toBeUndefined()
    ctx.env.MAX_USER_MEDIA_BYTES = PNG.byteLength * 2
    const target = convert(source, 'item')
    expect(entityLibraryUsageBytes(ctx.db, userId)).toBe(PNG.byteLength * 2)
    expect(ctx.db.prepare('SELECT byte_size FROM immutable_media_versions WHERE path=?').get(path)).toMatchObject({ byte_size: PNG.byteLength })
    expect(ctx.mediaStore.exists(target.reference!.path)).toBe(true)
  })

  it('refuses malformed active or archived voice hydration instead of handing out destructive empty defaults', async () => {
    const source = create('character')
    ctx.db.prepare("UPDATE characters SET voice_json='not-json' WHERE id=?").run(source.id)
    expect((await call(ctx, `/api/entity-library/character/${source.id}/conversion-data`)).status).toBe(409)
    expect(() => convert(source, 'item', { voice: {} })).toThrow(expect.objectContaining({ status: 409 }))
    ctx.db.prepare("UPDATE characters SET voice_json='{}' WHERE id=?").run(source.id)
    const target = convert(source, 'item')
    ctx.db.prepare("UPDATE entity_conversion_data SET voice_json='[]' WHERE entity_id=?").run(source.id)
    expect((await call(ctx, `/api/entity-library/item/${target.id}/conversion-data`)).status).toBe(409)
    expect(() => convert(target, 'character', { voice: {} })).toThrow(expect.objectContaining({ status: 409 }))
  })

  it('returns the exact read revision so mismatched parallel hydration can be rejected', () => {
    const source = create('item')
    const before = getEntityConversionData(ctx.db, userId, source)
    ctx.db.prepare('UPDATE library_assets SET continuity_notes=?,revision=revision+1 WHERE id=?').run('Concurrent note', source.id)
    const native = resolveEntity(ctx.db, userId, source)
    expect(before.revision).not.toBe(native.revision)
    expect(getEntityConversionData(ctx.db, userId, source)).toMatchObject({ revision: native.revision, continuityNotes: 'Concurrent note' })
  })

  it('rejects oversized character appearance without truncating or mutating the source', async () => {
    const source = create('item', true), description = 'x'.repeat(4500)
    ctx.db.prepare('UPDATE library_assets SET description=? WHERE id=?').run(description, source.id)
    const current = resolveEntity(ctx.db, userId, source)
    const save = vi.spyOn(ctx.mediaStore, 'saveCharacterReference')
    expect(() => convert(current, 'character', { description })).toThrow(expect.objectContaining({ status: 400 }))
    const response = await call(ctx, `/api/entity-library/item/${source.id}/convert`, { method: 'POST', body: { targetKind: 'character', expectedRevision: current.revision, name: 'Character', description } })
    expect(response.status).toBe(400)
    expect(save).not.toHaveBeenCalled()
    expect(resolveEntity(ctx.db, userId, current)).toEqual(current)
    expect(ctx.db.prepare('SELECT * FROM characters WHERE id=?').get(source.id)).toBeUndefined()
    expect(ctx.db.prepare('SELECT * FROM entity_conversion_data WHERE entity_id=?').get(source.id)).toBeUndefined()
    expect(ctx.db.prepare('SELECT kind,active FROM entity_handles WHERE entity_id=?').all(source.id)).toEqual([{ kind: 'item', active: 1 }])
    expect(convert(current, 'character', { description: 'x'.repeat(4000) }).description).toHaveLength(4000)
  })

  it('keeps the full 5000-character description limit for non-character conversion targets', () => {
    const source = create('character'), description = 'x'.repeat(5000)
    expect(convert(source, 'item', { description }).description).toBe(description)
  })

  it('rolls back source, alias, metadata and new media on late SQL failure', () => {
    const source = create('character', true)
    const save = vi.spyOn(ctx.mediaStore, 'saveUpload')
    ctx.db.exec("CREATE TRIGGER fail_conversion BEFORE INSERT ON entity_conversion_data BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
    expect(() => convert(source, 'item')).toThrow('synthetic failure')
    const path = save.mock.results[0]!.value.relativePath
    expect(ctx.mediaStore.exists(path)).toBe(false)
    expect(resolveEntity(ctx.db, userId, source)).toEqual(source)
    expect(ctx.db.prepare('SELECT * FROM library_assets WHERE id=?').get(source.id)).toBeUndefined()
    expect(ctx.db.prepare('SELECT * FROM entity_conversion_data WHERE entity_id=?').get(source.id)).toBeUndefined()
    expect(ctx.db.prepare('SELECT kind,active FROM entity_handles WHERE entity_id=?').all(source.id)).toEqual([{ kind: 'character', active: 1 }])
    expect(entityLibraryUsageBytes(ctx.db, userId)).toBe(PNG.byteLength)
  })

  it('queues and accounts rollback media when immediate file cleanup fails', () => {
    const source = create('item', true), save = vi.spyOn(ctx.mediaStore, 'saveCharacterReference')
    ctx.db.exec("CREATE TRIGGER fail_conversion BEFORE INSERT ON entity_conversion_data BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
    vi.spyOn(ctx.mediaStore, 'removeByPath').mockImplementationOnce(() => { throw new Error('synthetic disk cleanup error') })
    expect(() => convert(source, 'character')).toThrow('synthetic failure')
    const path = save.mock.results[0]!.value.relativePath
    expect(ctx.mediaStore.exists(path)).toBe(true)
    expect(entityLibraryUsageBytes(ctx.db, userId)).toBe(PNG.byteLength * 2)
    expect(cleanMediaJobs({ db: ctx.db, mediaStore: ctx.mediaStore }).cleaned).toBe(1)
    expect(ctx.mediaStore.exists(path)).toBe(false)
    expect(entityLibraryUsageBytes(ctx.db, userId)).toBe(PNG.byteLength)
  })

  it('supports exact lost-response retry but refuses changed request or target revision', () => {
    const source = create('item', true)
    const input = { targetKind: 'character' as const, expectedRevision: source.revision, name: 'Target', description: 'new' }
    const target = convertEntity(ctx.db, ctx.env, ctx.mediaStore, userId, source, input)
    const save = vi.spyOn(ctx.mediaStore, 'saveCharacterReference')
    expect(convertEntity(ctx.db, ctx.env, ctx.mediaStore, userId, source, input)).toEqual(target)
    expect(save).not.toHaveBeenCalled()
    expect(() => convertEntity(ctx.db, ctx.env, ctx.mediaStore, userId, source, { ...input, name: 'Different' })).toThrow()
    ctx.db.prepare('UPDATE characters SET updated_at=updated_at+1 WHERE id=?').run(source.id)
    expect(() => convertEntity(ctx.db, ctx.env, ctx.mediaStore, userId, source, input)).toThrow(expect.objectContaining({ status: 409 }))
  })

  it('refuses stale revisions, other owners, trashed rows and a target collision', async () => {
    const source = create('item')
    expect(() => convert({ ...source, revision: source.revision + 1 }, 'character')).toThrow(expect.objectContaining({ status: 409 }))
    const other = (await registerUser(ctx, 'conversion-other@gigone.com')).userId
    expect(() => convertEntity(ctx.db, ctx.env, ctx.mediaStore, other, source, { targetKind: 'character', expectedRevision: source.revision, name: 'Steal', description: '' })).toThrow(expect.objectContaining({ status: 404 }))
    ctx.db.prepare('INSERT INTO characters(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(source.id, other, 'Collision', 1, 1)
    expect(() => convert(source, 'character')).toThrow(expect.objectContaining({ status: 409 }))
    ctx.db.prepare('DELETE FROM characters WHERE id=?').run(source.id)
    softDelete(ctx.db, userId, 'library_asset', source.id)
    expect(() => convert(source, 'character')).toThrow(expect.objectContaining({ status: 404 }))
  })

  it('blocks project characters and linked locations without mutating either', () => {
    const projectId = randomUUID()
    ctx.db.prepare('INSERT INTO projects(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(projectId, userId, 'Project', 1, 1)
    const character = create('character')
    ctx.db.prepare('UPDATE characters SET project_id=? WHERE id=?').run(projectId, character.id)
    expect(() => convert(character, 'item')).toThrow(expect.objectContaining({ status: 409 }))
    // A linked source that still exists prevents reconciliation from removing it.
    const locationId = randomUUID()
    const uploadId = randomUUID(), saved = ctx.mediaStore.saveUpload({ userId, uploadId, bytes: PNG, maxBytes: ctx.env.MAX_REFERENCE_BYTES })
    ctx.db.prepare('INSERT INTO uploads(id,user_id,relative_path,mime_type,byte_size,created_at) VALUES(?,?,?,?,?,1)').run(uploadId, userId, saved.relativePath, saved.mimeType, saved.byteSize)
    ctx.db.prepare('INSERT INTO project_locations(id,project_id,name,reference_upload_id,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(locationId, projectId, 'Location', uploadId, 1, 1)
    const location = listEntityCatalog(ctx.db, userId).find(entity => entity.source?.entityId === locationId)!
    expect(() => convert(location, 'logo')).toThrow(expect.objectContaining({ status: 409 }))
  })

  it('rejects cross-account, traversal, missing and symlink-escaped source media', () => {
    const source = create('character', true), originalPath = source.reference!.path
    for (const path of ['other/characters/ref.png', `${userId}/../escape.png`, `${userId}/characters/missing.png`]) {
      ctx.db.prepare('UPDATE characters SET reference_path=? WHERE id=?').run(path, source.id)
      expect(() => convert(source, 'logo')).toThrow(expect.objectContaining({ status: 404 }))
    }
    // A link inside the media root pointing outside the account must not be read.
    const symlinkPath = `${userId}/characters/escape.png`
    expect(ctx.mediaStore.exists(originalPath)).toBe(true)
    symlinkSync(join(ctx.dir, 'app.db'), ctx.mediaStore.absolutePath(symlinkPath))
    ctx.db.prepare('UPDATE characters SET reference_path=? WHERE id=?').run(symlinkPath, source.id)
    expect(() => convert(source, 'logo')).toThrow(expect.objectContaining({ status: 404 }))
  })

  it('retains archive uploads in trash then releases all archive media after purge', () => {
    const source = create('character', true), target = convert(source, 'item')
    const paths = [source.reference!.path, target.reference!.path]
    softDelete(ctx.db, userId, 'library_asset', target.id)
    expect(cleanMediaJobs({ db: ctx.db, mediaStore: ctx.mediaStore }).cleaned).toBe(0)
    expect(ctx.db.prepare('SELECT 1 FROM entity_conversion_data WHERE entity_id=?').get(target.id)).toBeTruthy()
    purgeTrashItem(ctx.db, userId, 'library_asset', target.id)
    expect(ctx.db.prepare('SELECT 1 FROM entity_conversion_data WHERE entity_id=?').get(target.id)).toBeUndefined()
    expect(cleanMediaJobs({ db: ctx.db, mediaStore: ctx.mediaStore }).cleaned).toBeGreaterThanOrEqual(2)
    for (const path of paths) expect(ctx.mediaStore.exists(path)).toBe(false)
    expect(entityLibraryUsageBytes(ctx.db, userId)).toBe(0)
  })

  it('pins hidden archived location views until the logical target is purged', () => {
    const source = create('location')
    const uploadId = randomUUID(), saved = ctx.mediaStore.saveUpload({ userId, uploadId, bytes: PNG, maxBytes: ctx.env.MAX_REFERENCE_BYTES })
    ctx.db.prepare('INSERT INTO uploads(id,user_id,relative_path,mime_type,byte_size,created_at) VALUES(?,?,?,?,?,1)').run(uploadId, userId, saved.relativePath, saved.mimeType, saved.byteSize)
    ctx.db.prepare('UPDATE library_assets SET reference_views_json=? WHERE id=?').run(JSON.stringify([{ id: 'side', label: 'Side', uploadId, sheet: false }]), source.id)
    const target = convert(source, 'logo')
    expect(target.referenceViews).toBeUndefined()
    expect(cleanMediaJobs({ db: ctx.db, mediaStore: ctx.mediaStore }).cleaned).toBe(0)
    expect(ctx.db.prepare('SELECT 1 FROM uploads WHERE id=?').get(uploadId)).toBeTruthy()
    softDelete(ctx.db, userId, 'library_asset', target.id)
    purgeTrashItem(ctx.db, userId, 'library_asset', target.id)
    expect(cleanMediaJobs({ db: ctx.db, mediaStore: ctx.mediaStore }).cleaned).toBe(1)
    expect(ctx.mediaStore.exists(saved.relativePath)).toBe(false)
    expect(ctx.db.prepare('SELECT 1 FROM uploads WHERE id=?').get(uploadId)).toBeUndefined()
  })

  it('runs the usage guard inside the move before adopting media or aliases', () => {
    const source = create('character', true), projectId = randomUUID(), sceneId = randomUUID()
    ctx.db.prepare('INSERT INTO projects(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(projectId, userId, 'Referenced project', 1, 1)
    ctx.db.prepare('INSERT INTO scenes(id,project_id,title,character_id,position,created_at,updated_at) VALUES(?,?,?,?,0,1,1)').run(sceneId, projectId, 'Referenced scene', source.id)
    const save = vi.spyOn(ctx.mediaStore, 'saveUpload')
    expect(() => convert(source, 'item')).toThrow(expect.objectContaining({ status: 409, details: { usage: expect.arrayContaining([expect.objectContaining({ type: 'scene', sceneId })]) } }))
    expect(save).not.toHaveBeenCalled()
    expect(resolveEntity(ctx.db, userId, source)).toEqual(source)
    expect(ctx.db.prepare('SELECT character_id FROM scenes WHERE id=?').get(sceneId)).toMatchObject({ character_id: source.id })
  })

  it('fails closed on corrupt type-specific data rather than silently dropping it', () => {
    const source = create('location')
    ctx.db.prepare("UPDATE library_assets SET reference_views_json='not-json' WHERE id=?").run(source.id)
    expect(() => convert(source, 'item')).toThrow(expect.objectContaining({ status: 409 }))
    expect(ctx.db.prepare('SELECT kind,reference_views_json FROM library_assets WHERE id=?').get(source.id)).toMatchObject({ kind: 'location', reference_views_json: 'not-json' })
  })

  it('does not remove completed-history media after converting and purging the target', () => {
    const source = create('character', true), path = source.reference!.path
    ctx.db.prepare(`INSERT INTO generations(id,user_id,kind,prompt,snap_provider,snap_base_url,snap_model_id,status,params_json,created_at,updated_at)
      VALUES(?,?,'image','History','mock','https://mock.test/v1','mock','succeeded',?,1,1)`).run(randomUUID(), userId, JSON.stringify({ referencePath: path }))
    const target = convert(source, 'logo')
    softDelete(ctx.db, userId, 'library_asset', target.id)
    purgeTrashItem(ctx.db, userId, 'library_asset', target.id)
    cleanMediaJobs({ db: ctx.db, mediaStore: ctx.mediaStore })
    expect(ctx.mediaStore.exists(path)).toBe(true)
    expect(entityLibraryUsageBytes(ctx.db, userId)).toBe(PNG.byteLength)
  })

  it('serves safe hydration and strict authenticated POST response without storage paths', async () => {
    const source = create('character', true)
    expect((await call(ctx, `/api/entity-library/character/${source.id}/conversion-data`)).body).toEqual({ revision: source.revision, voice: { accent: 'Northern', pitch: 'low' }, continuityNotes: '', referenceViews: [] })
    expect((await call(ctx, `/api/entity-library/character/${source.id}/conversion-data`, { cookie: '' })).status).toBe(401)
    const input = { targetKind: 'item', expectedRevision: source.revision, name: 'Saved edit', description: 'Saved description', continuityNotes: 'Note', voice: { accent: 'Updated' } }
    expect((await call(ctx, `/api/entity-library/character/${source.id}/convert`, { method: 'POST', body: { ...input, unexpected: true } })).status).toBe(400)
    const result = await call(ctx, `/api/entity-library/character/${source.id}/convert`, { method: 'POST', body: input })
    expect(result.status).toBe(200)
    expect(result.body.entity).toMatchObject({ id: source.id, kind: 'item', name: 'Saved edit', description: 'Saved description', reference: { url: `/api/entity-library/assets/${source.id}/reference`, mime: 'image/png' } })
    expect(result.body.entity.reference).not.toHaveProperty('path')
    expect((await call(ctx, `/api/entity-library/item/${source.id}/conversion-data`)).body).toEqual({ revision: result.body.entity.revision, voice: { accent: 'Updated' }, continuityNotes: 'Note', referenceViews: [] })
  })
})
