import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  entityLibraryPreferencesDefaults,
  entityLibraryPreferencesPatchSchema,
  entityLibraryPreferencesRequestSchema,
} from '../../shared/entityLibraryPreferences'
import { getEntityLibraryPreferences, patchEntityLibraryPreferences } from '../../server/entityLibrary/preferences'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { if (ctx) await ctx.close() })
const path = '/api/entity-library/preferences'
const seedLlm = async () => {
  const model = await seedProviderAndModel(ctx, 'image')
  ctx.db.prepare("UPDATE models SET kind = 'llm' WHERE id = ?").run(model.modelPk)
  return model
}
const save = (settings: unknown, cookie?: string) => call(ctx, path, {
  method: 'PATCH', body: { version: 1, settings }, cookie,
})

describe('shared entity library preferences schema', () => {
  it('defines stable defaults and accepts strictly partial patches', () => {
    expect(entityLibraryPreferencesDefaults).toEqual({
      kind: 'character', count: 1, modelId: '', imageModelId: '',
      includeImages: false, autoSave: false, size: '1024x1024', quality: '',
    })
    expect(entityLibraryPreferencesPatchSchema.parse({ count: 6 })).toEqual({ count: 6 })
    expect(entityLibraryPreferencesPatchSchema.parse({ modelId: null, imageModelId: '' }))
      .toEqual({ modelId: '', imageModelId: '' })
    expect(entityLibraryPreferencesPatchSchema.parse({})).toEqual({})
    expect(entityLibraryPreferencesRequestSchema.parse({ version: 1, settings: {} }))
      .toEqual({ version: 1, settings: {} })
    expect(entityLibraryPreferencesRequestSchema.parse({ version: 1, expectedUserId: 'account-id', settings: {} }))
      .toEqual({ version: 1, expectedUserId: 'account-id', settings: {} })
  })

  it('rejects invalid values and every transient or unknown key', () => {
    const invalid = [
      null, [], 'settings', { kind: 'video' }, { count: 0 }, { count: 7 }, { count: 1.5 },
      { count: '2' }, { includeImages: 1 }, { autoSave: 'true' }, { size: 'auto' },
      { size: '1024x1024\n' }, { size: '00x1024' }, { size: '8193x1024' },
      { size: '8192x8192' }, { quality: 'ultra' }, { modelId: 3 }, { imageModelId: {} },
      { modelId: 'x'.repeat(201) }, { description: 'transient' }, { prompt: 'transient' },
      { sourceFile: 'blob:local' }, { sourceUploadId: 'upload' }, { referenceImages: [] },
      { media: 'data:image/png;base64,abcd' }, { version: 1 },
    ]
    for (const value of invalid) expect(entityLibraryPreferencesPatchSchema.safeParse(value).success, JSON.stringify(value)).toBe(false)
    for (const value of [
      { version: 2, settings: {} }, { settings: {} }, { version: 1 },
      { version: 1, settings: {}, description: 'extra' },
      ...['', '   ', null, 42, [], {}, 'x'.repeat(201)].map(expectedUserId => ({ version: 1, expectedUserId, settings: {} })),
      { version: 1, expectedUserId: 'account-id', settings: {}, userId: 'unknown-envelope-key' },
    ]) expect(entityLibraryPreferencesRequestSchema.safeParse(value).success).toBe(false)
  })
})

describe('entity library preferences API', () => {
  it('requires authentication for reads and writes', async () => {
    expect((await call(ctx, path, { cookie: '' })).status).toBe(401)
    expect((await save({ count: 2 }, '')).status).toBe(401)
  })

  it('returns defaults, merges partial changes, and persists only stable settings', async () => {
    const { userId } = await registerUser(ctx)
    expect((await call(ctx, path)).body).toEqual({ userId, settings: entityLibraryPreferencesDefaults })
    const llm = await seedLlm()
    const image = await seedProviderAndModel(ctx, 'image')
    const patch = {
      kind: 'logo', count: 4, modelId: llm.modelPk, imageModelId: image.modelPk,
      includeImages: true, autoSave: true, size: '1536x1024', quality: 'high',
    }
    expect((await save(patch)).body).toEqual({ settings: patch })
    expect((await save({ count: 2 })).body).toEqual({ settings: { ...patch, count: 2 } })
    expect((await call(ctx, path)).body.settings).toEqual({ ...patch, count: 2 })
    const row = ctx.db.prepare('SELECT version, settings_json FROM entity_library_preferences WHERE user_id = ?').get(userId) as { version: number; settings_json: string }
    expect(row.version).toBe(1)
    expect(JSON.parse(row.settings_json)).toEqual({ ...patch, count: 2 })
    expect(ctx.db.prepare('SELECT COUNT(*) AS count FROM generations').get()).toMatchObject({ count: 0 })
  })

  it('isolates accounts and rejects foreign, disabled, absent and wrong-kind selections', async () => {
    await registerUser(ctx)
    const firstCookie = ctx.cookie
    const foreignLlm = await seedLlm()
    const foreignImage = await seedProviderAndModel(ctx, 'image')
    expect((await save({ modelId: foreignLlm.modelPk, count: 3 })).status).toBe(200)
    await registerUser(ctx)
    expect((await call(ctx, path)).body.settings).toEqual(entityLibraryPreferencesDefaults)
    const llm = await seedLlm()
    const image = await seedProviderAndModel(ctx, 'image')
    const video = await seedProviderAndModel(ctx, 'video')
    for (const settings of [
      { modelId: foreignLlm.modelPk }, { imageModelId: foreignImage.modelPk },
      { modelId: image.modelPk }, { imageModelId: llm.modelPk }, { imageModelId: video.modelPk },
      { modelId: 'missing' }, { imageModelId: 'missing' },
    ]) expect((await save(settings)).status).toBe(400)
    ctx.db.prepare('UPDATE models SET enabled = 0 WHERE id IN (?, ?)').run(llm.modelPk, image.modelPk)
    expect((await save({ modelId: llm.modelPk })).status).toBe(400)
    expect((await save({ imageModelId: image.modelPk })).status).toBe(400)
    expect((await call(ctx, path)).body.settings).toEqual(entityLibraryPreferencesDefaults)
    expect((await call(ctx, path, { cookie: firstCookie })).body.settings)
      .toEqual({ ...entityLibraryPreferencesDefaults, modelId: foreignLlm.modelPk, count: 3 })
  })

  it('rejects a queued account-A patch sent after switching to account B before any write', async () => {
    const accountA = await registerUser(ctx)
    const cookieA = ctx.cookie
    const readA = await call(ctx, path)
    expect(readA.body).toEqual({ userId: accountA.userId, settings: entityLibraryPreferencesDefaults })
    const savedA = { ...entityLibraryPreferencesDefaults, kind: 'item', count: 2 }
    expect((await call(ctx, path, {
      method: 'PATCH', body: { version: 1, expectedUserId: readA.body.userId, settings: { kind: 'item', count: 2 } },
    })).status).toBe(200)
    // Capture the logical queued request under A, then deliver it using B's current cookie.
    const delayedPatchA = { version: 1, expectedUserId: readA.body.userId, settings: { count: 6, autoSave: true } }
    const accountB = await registerUser(ctx)
    const cookieB = ctx.cookie
    expect((await call(ctx, path)).body).toEqual({ userId: accountB.userId, settings: entityLibraryPreferencesDefaults })
    const rejectedWithoutRow = await call(ctx, path, { method: 'PATCH', cookie: cookieB, body: delayedPatchA })
    expect(rejectedWithoutRow.status).toBe(400)
    expect(ctx.db.prepare('SELECT COUNT(*) AS count FROM entity_library_preferences WHERE user_id = ?').get(accountB.userId))
      .toMatchObject({ count: 0 })

    const savedB = { ...entityLibraryPreferencesDefaults, kind: 'logo', quality: 'low' }
    expect((await call(ctx, path, {
      method: 'PATCH', cookie: cookieB,
      body: { version: 1, expectedUserId: accountB.userId, settings: { kind: 'logo', quality: 'low' } },
    })).status).toBe(200)
    const before = ctx.db.prepare('SELECT * FROM entity_library_preferences WHERE user_id = ?').get(accountB.userId)
    expect((await call(ctx, path, { method: 'PATCH', cookie: cookieB, body: delayedPatchA })).status).toBe(400)
    expect(ctx.db.prepare('SELECT * FROM entity_library_preferences WHERE user_id = ?').get(accountB.userId)).toEqual(before)
    expect((await call(ctx, path, { cookie: cookieB })).body).toEqual({ userId: accountB.userId, settings: savedB })
    expect((await call(ctx, path, { cookie: cookieA })).body).toEqual({ userId: accountA.userId, settings: savedA })
    // The guard is envelope metadata only, never persisted as a setting.
    expect(getEntityLibraryPreferences(ctx.db, accountB.userId)).not.toHaveProperty('expectedUserId')
  })

  it('keeps disabled/deleted saved models readable and patchable, and supports clearing both ids', async () => {
    await registerUser(ctx)
    const llm = await seedLlm()
    const image = await seedProviderAndModel(ctx, 'image')
    expect((await save({ modelId: llm.modelPk, imageModelId: image.modelPk })).status).toBe(200)
    ctx.db.prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(llm.modelPk)
    ctx.db.prepare('DELETE FROM models WHERE id = ?').run(image.modelPk)
    const expected = { ...entityLibraryPreferencesDefaults, modelId: llm.modelPk, imageModelId: image.modelPk }
    expect((await call(ctx, path)).body.settings).toEqual(expected)
    expect((await save({ autoSave: true })).body.settings).toEqual({ ...expected, autoSave: true })
    // A full client snapshot carrying unchanged old ids is also safe.
    expect((await save({ ...expected, count: 2 })).status).toBe(200)
    expect((await save({ modelId: null, imageModelId: '' })).body.settings)
      .toEqual({ ...entityLibraryPreferencesDefaults, count: 2 })
  })

  it('rejects invalid envelopes, unknown keys and transient content without changing saved state', async () => {
    await registerUser(ctx)
    expect((await save({ kind: 'location' })).status).toBe(200)
    for (const body of [
      null, [], { version: 2, settings: {} }, { settings: { count: 2 } }, { version: 1 },
      { version: 1, settings: null }, { version: 1, settings: [] },
      { version: 1, settings: {}, extra: true },
      ...['', '   ', null, 42, [], {}, 'x'.repeat(201)].map(expectedUserId => ({ version: 1, expectedUserId, settings: {} })),
      ...[
        { description: 'private' }, { sourceUploadId: 'upload-id' }, { media: 'https://example.com/image' },
        { prompt: 'x'.repeat(17 * 1024) }, { count: 0 }, { autoSave: null }, { quality: 'ultra' },
      ].map(settings => ({ version: 1, settings })),
    ]) expect((await call(ctx, path, { method: 'PATCH', body })).status).toBe(400)
    expect((await call(ctx, path)).body.settings).toEqual({ ...entityLibraryPreferencesDefaults, kind: 'location' })
  })
})

describe('entity library preferences persistence', () => {
  it('sanitizes stored rows, defaults missing fields, and never returns transient content', async () => {
    const { userId } = await registerUser(ctx)
    const insert = ctx.db.prepare(`INSERT INTO entity_library_preferences (user_id, version, settings_json, updated_at)
      VALUES (?, 1, ?, 1) ON CONFLICT(user_id) DO UPDATE SET settings_json = excluded.settings_json`)
    insert.run(userId, JSON.stringify({ count: 3, modelId: 'removed-model' }))
    expect(getEntityLibraryPreferences(ctx.db, userId))
      .toEqual({ ...entityLibraryPreferencesDefaults, count: 3, modelId: 'removed-model' })
    for (const raw of ['invalid json', 'null', '[]', '{"count":99}', '{"description":"private","count":2}']) {
      insert.run(userId, raw)
      expect(getEntityLibraryPreferences(ctx.db, userId)).toEqual(entityLibraryPreferencesDefaults)
    }
    expect(() => patchEntityLibraryPreferences(ctx.db, userId, { sourceUploadId: 'private' })).toThrow()
  })

  it('uses one version-1 row per user and cascades on account deletion', async () => {
    const columns = ctx.db.prepare('PRAGMA table_info(entity_library_preferences)').all() as Array<{ name: string; pk: number; notnull: number }>
    expect(columns.map(column => column.name)).toEqual(['user_id', 'version', 'settings_json', 'updated_at'])
    expect(columns.find(column => column.name === 'user_id')).toMatchObject({ pk: 1, notnull: 1 })
    const { userId } = await registerUser(ctx)
    patchEntityLibraryPreferences(ctx.db, userId, { count: 2 })
    patchEntityLibraryPreferences(ctx.db, userId, { quality: 'low' })
    expect(ctx.db.prepare('SELECT COUNT(*) AS count FROM entity_library_preferences WHERE user_id = ?').get(userId)).toMatchObject({ count: 1 })
    expect(() => ctx.db.prepare('UPDATE entity_library_preferences SET version = 2 WHERE user_id = ?').run(userId)).toThrow()
    expect(ctx.db.prepare('PRAGMA foreign_key_list(entity_library_preferences)').all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ table: 'users', from: 'user_id', to: 'id', on_delete: 'CASCADE' })]),
    )
    ctx.db.prepare('DELETE FROM users WHERE id = ?').run(userId)
    expect(ctx.db.prepare('SELECT COUNT(*) AS count FROM entity_library_preferences WHERE user_id = ?').get(userId)).toMatchObject({ count: 0 })
  })
})
