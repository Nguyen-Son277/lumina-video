import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'
import { MOCK_PNG_BYTES } from '../../server/generations/adapters/mock'
import { cleanMediaJobs } from '../../server/projectsTrash/service'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer(); await ctx.worker.stop() })
afterAll(async () => { if (ctx) await ctx.close() })

async function setup() {
  const { userId } = await registerUser(ctx)
  const character = (await call(ctx, '/api/shared-characters', { method: 'POST', body: { name: 'Immutable An' } })).body.character
  return { userId, character }
}
function upload(id: string, bytes: Uint8Array = MOCK_PNG_BYTES) {
  return fetch(`${ctx.baseUrl}/api/shared-characters/${id}/reference`, {
    method: 'POST', headers: { Cookie: ctx.cookie, 'Content-Type': 'image/png' }, body: bytes,
  })
}
function path(id: string): string {
  return String(ctx.db.prepare('SELECT reference_path FROM characters WHERE id=?').get(id)!.reference_path)
}

describe('Immutable character media versions', () => {
  it('same-format replacements never overwrite pinned queued/history snapshot bytes', async () => {
    const { userId, character } = await setup()
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    expect((await upload(character.id)).status).toBe(201)
    const first = path(character.id)
    const original = ctx.mediaStore.readFile(first)
    const generation = await call(ctx, '/api/generations', { method: 'POST', body: {
      modelId: modelPk, characterId: character.id, prompt: 'Pinned portrait',
    } })
    expect(generation.status).toBe(202)
    const snapshot = ctx.db.prepare('SELECT character_references_json,character_reference_json FROM generations WHERE id=?').get(generation.body.generation.id)
    expect(JSON.stringify(snapshot)).toContain(first)
    const changed = new Uint8Array([...MOCK_PNG_BYTES, 1])
    expect((await upload(character.id, changed)).status).toBe(201)
    const second = path(character.id)
    expect(second).not.toBe(first)
    expect(ctx.mediaStore.readFile(first)).toEqual(original)
    expect(ctx.mediaStore.readFile(second)).toEqual(Buffer.from(changed))
    expect(ctx.db.prepare('SELECT path FROM media_cleanup_jobs WHERE path=?').get(first)).toBeTruthy()
    expect(ctx.mediaStore.userUsageBytes(ctx.db, userId)).toBeGreaterThanOrEqual(original.byteLength + changed.byteLength)
    cleanMediaJobs({ db: ctx.db, mediaStore: ctx.mediaStore })
    expect(ctx.mediaStore.exists(first)).toBe(true)
    expect(ctx.db.prepare('SELECT path FROM immutable_media_versions WHERE path=?').get(first)).toBeTruthy()
    expect(ctx.db.prepare('SELECT character_references_json,character_reference_json FROM generations WHERE id=?').get(generation.body.generation.id)).toEqual(snapshot)
  })

  it('clearing the pointer retains and charges old bytes until guarded cleanup', async () => {
    const { userId, character } = await setup()
    expect((await upload(character.id)).status).toBe(201)
    const old = path(character.id)
    const usage = ctx.mediaStore.userUsageBytes(ctx.db, userId)
    const cleared = await call(ctx, `/api/shared-characters/${character.id}/reference`, { method: 'DELETE' })
    expect(cleared.status).toBe(200)
    expect(cleared.body.character.referenceUrl).toBeNull()
    expect(ctx.mediaStore.exists(old)).toBe(true)
    expect(ctx.mediaStore.userUsageBytes(ctx.db, userId)).toBe(usage)
    expect((await call(ctx, `/api/shared-characters/${character.id}/reference`, { method: 'DELETE' })).status).toBe(200)
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM media_cleanup_jobs WHERE path=?').get(old)!.n).toBe(1)
    cleanMediaJobs({ db: ctx.db, mediaStore: ctx.mediaStore })
    expect(ctx.mediaStore.exists(old)).toBe(false)
    expect(ctx.db.prepare('SELECT 1 FROM immutable_media_versions WHERE path=?').get(old)).toBeUndefined()
    expect(ctx.mediaStore.userUsageBytes(ctx.db, userId)).toBe(0)
  })

  it('quota rejects replacement without changing old pointer or bytes', async () => {
    const { userId, character } = await setup()
    expect((await upload(character.id)).status).toBe(201)
    const old = path(character.id)
    const limit = ctx.env.MAX_USER_MEDIA_BYTES
    try {
      ctx.env.MAX_USER_MEDIA_BYTES = ctx.mediaStore.userUsageBytes(ctx.db, userId) + MOCK_PNG_BYTES.byteLength - 1
      expect((await upload(character.id)).status).toBe(413)
      expect(path(character.id)).toBe(old)
      expect(ctx.mediaStore.readFile(old)).toEqual(MOCK_PNG_BYTES)
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM immutable_media_versions WHERE user_id=?').get(userId)!.n).toBe(1)
      expect(ctx.db.prepare('SELECT 1 FROM media_cleanup_jobs WHERE path=?').get(old)).toBeUndefined()
    } finally { ctx.env.MAX_USER_MEDIA_BYTES = limit }
  })

  it('registers legacy current media once when replaced and enforces account ownership', async () => {
    const { userId, character } = await setup()
    expect((await upload(character.id)).status).toBe(201)
    const old = path(character.id)
    ctx.db.prepare('DELETE FROM immutable_media_versions WHERE path=?').run(old)
    expect(ctx.mediaStore.userUsageBytes(ctx.db, userId)).toBe(MOCK_PNG_BYTES.byteLength)
    expect((await upload(character.id)).status).toBe(201)
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM immutable_media_versions WHERE user_id=?').get(userId)!.n).toBe(2)
    expect(ctx.mediaStore.userUsageBytes(ctx.db, userId)).toBe(2 * MOCK_PNG_BYTES.byteLength)
    await registerUser(ctx)
    expect((await upload(character.id)).status).toBe(404)
    expect((await call(ctx, `/api/shared-characters/${character.id}/reference`, { method: 'DELETE' })).status).toBe(404)
    expect(ctx.mediaStore.exists(old)).toBe(true)
  })

  it('attaching generated media also retains the previous immutable version', async () => {
    const { userId, character } = await setup()
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    expect((await upload(character.id)).status).toBe(201)
    const old = path(character.id)
    const generation = await call(ctx, '/api/generations', { method: 'POST', body: { modelId: modelPk, prompt: 'portrait' } })
    expect(generation.status).toBe(202)
    // No provider or network: install a succeeded mock asset explicitly.
    const generationId = generation.body.generation.id
    const saved = ctx.mediaStore.save({ userId, generationId, bytes: MOCK_PNG_BYTES })
    ctx.db.prepare("UPDATE generations SET status='succeeded' WHERE id=?").run(generationId)
    ctx.db.prepare(`INSERT INTO assets (id,user_id,generation_id,relative_path,mime_type,byte_size,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(`asset-${generationId}`, userId, generationId, saved.relativePath, saved.mimeType, saved.byteSize, Date.now())
    const attached = await call(ctx, `/api/shared-characters/${character.id}/reference/from-generation`, {
      method: 'POST', body: { generationId },
    })
    expect(attached.status).toBe(201)
    expect(path(character.id)).not.toBe(old)
    expect(ctx.mediaStore.exists(old)).toBe(true)
    expect(ctx.db.prepare('SELECT 1 FROM media_cleanup_jobs WHERE path=?').get(old)).toBeTruthy()
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM immutable_media_versions WHERE user_id=?').get(userId)!.n).toBe(2)
  })
})
