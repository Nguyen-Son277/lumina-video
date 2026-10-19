import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { call, registerUser, startTestServer, type TestContext } from './helpers'
import { createLibraryAsset } from '../../server/entityLibrary/service'

let ctx: TestContext
let userId: string
beforeEach(async () => { ctx = await startTestServer(); userId = (await registerUser(ctx)).userId })
afterEach(async () => { await ctx.close() })

describe('AI library handle allocation', () => {
  it('allocates normalized cross-kind suffixes without changing manual collision semantics', () => {
    const first = createLibraryAsset(ctx.db, userId, { kind: 'item', name: 'Đèn đỏ', handle: '@Đèn Đỏ' })
    const second = createLibraryAsset(ctx.db, userId, { kind: 'logo', name: 'Logo', handle: '@ĐÈN ĐỎ', autoHandle: true })
    const third = createLibraryAsset(ctx.db, userId, { kind: 'location', name: 'Studio', handle: 'den-do', autoHandle: true })
    expect([first.handle, second.handle, third.handle]).toEqual(['den-do', 'den-do-2', 'den-do-3'])
    expect(() => createLibraryAsset(ctx.db, userId, { kind: 'item', name: 'Manual', handle: 'den-do' })).toThrow()
  })

  it('bounds suffixes and falls back for non-Latin AI suggestions', () => {
    const handle = 'a'.repeat(64)
    createLibraryAsset(ctx.db, userId, { kind: 'item', name: 'First', handle })
    const second = createLibraryAsset(ctx.db, userId, { kind: 'item', name: 'Second', handle, autoHandle: true })
    expect(second.handle).toBe(`${'a'.repeat(62)}-2`)
    expect(createLibraryAsset(ctx.db, userId, { kind: 'logo', name: 'ロゴ', autoHandle: true }).handle).toBe('logo')
  })

  it('keeps handles account-scoped and reserves character aliases too', async () => {
    ctx.db.prepare('INSERT INTO characters(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run('auto-handle-character', userId, 'Camera', 1, 1)
    expect(createLibraryAsset(ctx.db, userId, { kind: 'item', name: 'Camera', autoHandle: true }).handle).toBe('camera-2')
    const otherId = (await registerUser(ctx)).userId
    expect(createLibraryAsset(ctx.db, otherId, { kind: 'item', name: 'Camera', autoHandle: true }).handle).toBe('camera')
  })

  it('accepts autoHandle through create API but rejects a duplicate manual handle', async () => {
    const body = { kind: 'location', name: 'Forest', handle: 'forest', autoHandle: true }
    const first = await call(ctx, '/api/entity-library/assets', { method: 'POST', body })
    const second = await call(ctx, '/api/entity-library/assets', { method: 'POST', body })
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(second.body.asset.handle).toBe('forest-2')
    const manual = await call(ctx, '/api/entity-library/assets', { method: 'POST', body: { ...body, autoHandle: false } })
    expect(manual.status).toBe(409)
  })
})
