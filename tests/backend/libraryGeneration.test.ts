import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { call, registerUser, startTestServer, type TestContext } from './helpers'
import { createLibraryAsset, listEntityCatalog } from '../../server/entityLibrary/service'
import { restoreTrash, softDelete } from '../../server/trash/service'
import { runLoggedLlm } from '../../server/usage/llm'
import { mockChatCompletionWithUsage } from '../../server/generations/adapters/mock'

vi.mock('../../server/usage/llm', () => ({ runLoggedLlm: vi.fn() }))
let ctx: TestContext, userId: string, llm: string, image: string
const candidate = { name: 'Lantern', handle: 'Đèn', description: 'A red lantern', continuityNotes: 'Keep red' }
beforeEach(async () => {
  ctx = await startTestServer()
  userId = (await registerUser(ctx)).userId
  const p = await call(ctx, '/api/providers', { method: 'POST', body: { name: 'Mock', baseUrl: 'https://mock.test/v1', apiKey: 'sk-test' } })
  for (const kind of ['llm', 'image']) {
    const m = await call(ctx, '/api/models', { method: 'POST', body: { providerId: p.body.provider.id, modelId: `mock-${kind}`, kind } })
    if (kind === 'llm') llm = m.body.model.id
    else image = m.body.model.id
  }
  vi.mocked(runLoggedLlm).mockReset().mockResolvedValue(JSON.stringify({ candidates: [candidate] }))
})
afterEach(async () => { await ctx.close() })
const post = (path: string, body: unknown) => call(ctx, `/api/entity-library/${path}`, { method: 'POST', body })
describe('library generation (mock providers only)', () => {
  it('supports deterministic candidate fixtures for text and image mock messages', () => {
    const result = mockChatCompletionWithUsage([
      { role: 'system', content: 'LIBRARY_CANDIDATE_GENERATION' },
      { role: 'user', content: [{ type: 'text', text: JSON.stringify({ kind: 'location', count: 2, existingNames: ['Bối cảnh mẫu 1'] }) }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AA==' } }] },
    ])
    expect(JSON.parse(result.text).candidates.map((entry: { name: string }) => entry.name)).toEqual(['Bối cảnh mẫu 2', 'Bối cảnh mẫu 3'])
  })
  it('forwards character illustration idempotency to the shared enqueue path', async () => {
    vi.spyOn(ctx.worker, 'wake').mockImplementation(() => {})
    const body = { modelId: image, name: 'Pilot', appearance: 'Red coat', idempotencyKey: 'character-test' }
    const first = await call(ctx, '/api/shared-characters/illustrations', { method: 'POST', body })
    expect(first.status).toBe(201)
    const second = await call(ctx, '/api/shared-characters/illustrations', { method: 'POST', body })
    expect(second.body.generation.id).toBe(first.body.generation.id)
  })
  it('generates preview candidates of every kind without persistence', async () => {
    for (const kind of ['item', 'logo', 'location']) {
      const result = await post('generate', { kind, description: 'red', modelId: llm, count: 6 })
      expect(result.status).toBe(200)
      expect(result.body.candidates).toEqual([{ ...candidate, handle: 'den' }])
    }
    expect(ctx.db.prepare('SELECT count(*) AS n FROM library_assets').get()).toMatchObject({ n: 0 })
    expect(vi.mocked(runLoggedLlm)).toHaveBeenCalledTimes(3)
  })
  it('rejects invalid input, wrong models and unowned sources before calling LLM', async () => {
    for (const body of [
      { kind: 'item', modelId: llm },
      { kind: 'character', modelId: llm, description: 'x' },
      { kind: 'item', modelId: llm, description: 'x', count: 7 },
      { kind: 'item', modelId: llm, sourceUploadId: 'missing', count: 2 },
      { kind: 'item', modelId: llm, sourceUploadId: 'missing', count: 1 },
      { kind: 'item', modelId: image, description: 'x' },
    ]) expect((await post('generate', body)).status).toBeGreaterThanOrEqual(400)
    expect(runLoggedLlm).not.toHaveBeenCalled()
  })
  it('reduces owned images, requires exactly one valid visible subject', async () => {
    const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: 'red' } }).png().toBuffer()
    const response = await fetch(`${ctx.baseUrl}/api/uploads`, { method: 'POST', headers: { Cookie: ctx.cookie, 'Content-Type': 'image/png' }, body: new Uint8Array(bytes) })
    const { upload } = await response.json() as { upload: { id: string } }
    const body = { kind: 'item', modelId: llm, count: 1, sourceUploadId: upload.id }
    expect((await post('generate', body)).status).toBe(200)
    expect(JSON.stringify(vi.mocked(runLoggedLlm).mock.calls[0])).toContain('data:image/jpeg;base64,')
    vi.mocked(runLoggedLlm).mockResolvedValue('{"candidates":[],"imageError":"ambiguous"}')
    expect((await post('generate', body)).status).toBe(502)
    await registerUser(ctx)
    expect((await post('generate', body)).status).toBe(404)
  })
  it('enqueues one image with autosave purpose and idempotency, never creates assets early', async () => {
    vi.spyOn(ctx.worker, 'wake').mockImplementation(() => {})
    const body = { kind: 'logo', modelId: image, ...candidate, handle: undefined, autoSave: true, idempotencyKey: 'library-test' }
    const first = await post('illustrations', body)
    expect(first.status).toBe(201)
    expect((await post('illustrations', body)).body.generation.id).toBe(first.body.generation.id)
    const row = ctx.db.prepare('SELECT image_purpose_json,library_publish_status FROM generations WHERE id=?').get(first.body.generation.id)
    expect(row).toMatchObject({ image_purpose_json: JSON.stringify({ kind: 'logo', name: candidate.name, description: candidate.description, continuityNotes: candidate.continuityNotes }), library_publish_status: 'queued' })
    expect(ctx.db.prepare('SELECT count(*) AS n FROM library_assets').get()).toMatchObject({ n: 0 })
  })
  it('gets owned assets with public reference metadata and hides other users', async () => {
    const asset = createLibraryAsset(ctx.db, userId, { kind: 'item', name: 'Private' })
    expect((await call(ctx, `/api/entity-library/assets/${asset.id}`)).body.asset).toMatchObject({ id: asset.id, handle: 'private' })
    await registerUser(ctx)
    expect((await call(ctx, `/api/entity-library/assets/${asset.id}`)).status).toBe(404)
  })
  it('restores character aliases atomically, keeping tombstones on conflict', async () => {
    const c = await call(ctx, '/api/shared-characters', { method: 'POST', body: { name: 'Pilot', appearance: '' } })
    const id = c.body.character.id
    listEntityCatalog(ctx.db, userId)
    softDelete(ctx.db, userId, 'character', id)
    const asset = createLibraryAsset(ctx.db, userId, { kind: 'item', name: 'Pilot' })
    expect(() => restoreTrash(ctx.db, userId, 'character', id)).toThrow(/Handle/)
    expect(ctx.db.prepare('SELECT deleted_at FROM characters WHERE id=?').get(id)).not.toMatchObject({ deleted_at: null })
    ctx.db.prepare('UPDATE entity_handles SET active=0 WHERE entity_id=?').run(asset.id)
    restoreTrash(ctx.db, userId, 'character', id)
    expect(ctx.db.prepare('SELECT active FROM entity_handles WHERE entity_id=?').get(id)).toMatchObject({ active: 1 })
  })
})
