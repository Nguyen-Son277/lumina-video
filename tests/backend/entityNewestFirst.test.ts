import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLibraryAsset, listEntityCatalog, patchLibraryAsset, resolveEntity, type EntityKind } from '../../server/entityLibrary/service'
import { convertEntity } from '../../server/entityLibrary/conversion'
import { restoreTrash, softDelete, TRASH_RETENTION_MS } from '../../server/trash/service'
import { call, registerUser, startTestServer, type TestContext } from './helpers'

describe('newest-first merged catalog and reversible card trash', () => {
  let ctx: TestContext, userId: string
  beforeEach(async () => { ctx = await startTestServer(); userId = (await registerUser(ctx)).userId })
  afterEach(async () => { await ctx.close() })
  function seed(kind: EntityKind, createdAt: number) {
    if (kind === 'character') {
      const id = randomUUID()
      ctx.db.prepare('INSERT INTO characters(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, userId, `Character ${id}`, createdAt, createdAt)
      return resolveEntity(ctx.db, userId, { kind, id })
    }
    const entity = createLibraryAsset(ctx.db, userId, { kind, name: `${kind} ${randomUUID()}` })
    ctx.db.prepare('UPDATE library_assets SET created_at=? WHERE id=?').run(createdAt, entity.id)
    return resolveEntity(ctx.db, userId, entity)
  }
  it('merges all four types by creation time, not kind buckets or last edit', async () => {
    const character = seed('character', 100), logo = seed('logo', 400), location = seed('location', 200), item = seed('item', 300)
    patchLibraryAsset(ctx.db, userId, location.id, { name: 'Edited old location' })
    const expected = [logo.id, item.id, location.id, character.id]
    expect(listEntityCatalog(ctx.db, userId).map(entity => entity.id)).toEqual(expected)
    const result = await call(ctx, '/api/entity-library')
    expect(result.status).toBe(200)
    expect(result.body.entities.map((entity: { id: string }) => entity.id)).toEqual(expected)
    expect(result.body.entities.map((entity: { createdAt: number }) => entity.createdAt)).toEqual([400, 300, 200, 100])
    const fresh = createLibraryAsset(ctx.db, userId, { kind: 'item', name: 'Newest' })
    expect(listEntityCatalog(ctx.db, userId)[0]!.id).toBe(fresh.id)
  })
  it('breaks timestamp ties deterministically by kind then id', () => {
    const entries = [seed('logo', 10), seed('character', 10), seed('item', 10), seed('location', 10), seed('item', 10)]
    const expected = [...entries].sort((a, b) => a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    expect(listEntityCatalog(ctx.db, userId).map(entity => entity.id)).toEqual(expected.map(entity => entity.id))
  })
  it.each(['character', 'item', 'logo', 'location'] as const)('soft deletes and restores %s with exact 30-day retention and original ordering', kind => {
    const old = seed(kind, 100), newer = seed('item', 200), now = Date.now()
    const trashKind = kind === 'character' ? 'character' : 'library_asset'
    softDelete(ctx.db, userId, trashKind, old.id, now)
    const table = kind === 'character' ? 'characters' : 'library_assets'
    const first = ctx.db.prepare(`SELECT deleted_at,purge_after,created_at FROM ${table} WHERE id=?`).get(old.id)!
    expect(Number(first.purge_after) - Number(first.deleted_at)).toBe(TRASH_RETENTION_MS)
    softDelete(ctx.db, userId, trashKind, old.id, now + 1000)
    expect(ctx.db.prepare(`SELECT deleted_at,purge_after,created_at FROM ${table} WHERE id=?`).get(old.id)).toEqual(first)
    expect(listEntityCatalog(ctx.db, userId).map(entity => entity.id)).toEqual([newer.id])
    restoreTrash(ctx.db, userId, trashKind, old.id, now + 2000)
    expect(listEntityCatalog(ctx.db, userId).map(entity => entity.id)).toEqual([newer.id, old.id])
    expect(resolveEntity(ctx.db, userId, old).createdAt).toBe(100)
  })
  it('preserves creation time when converting, trashing and restoring a standalone location', () => {
    const source = seed('location', 100), newer = seed('character', 200)
    const converted = convertEntity(ctx.db, ctx.env, ctx.mediaStore, userId, source, { targetKind: 'character', expectedRevision: source.revision, name: source.name, description: source.description })
    expect(converted.createdAt).toBe(100)
    softDelete(ctx.db, userId, 'character', converted.id)
    restoreTrash(ctx.db, userId, 'character', converted.id)
    const restored = resolveEntity(ctx.db, userId, converted)
    expect(restored.createdAt).toBe(100)
    expect(restored.handle).toBe(source.handle)
    expect(listEntityCatalog(ctx.db, userId).map(entity => entity.id)).toEqual([newer.id, converted.id])
  })
})
