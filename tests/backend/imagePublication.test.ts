import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'
import { publishGenerationImages, libraryPublications, recoverImagePublications } from '../../server/entityLibrary/publication'
import { uploadReferenced } from '../../server/entityLibrary/lifecycle'
import { createWorker } from '../../server/generations/worker'
import { MOCK_PNG_BYTES } from '../../server/generations/adapters/mock'
import type { GenerationRow } from '../../server/generations/types'

describe('durable image-purpose publication (mock only)', () => {
  let ctx: TestContext, userId: string, modelPk: string
  beforeEach(async () => {
    ctx = await startTestServer()
    await ctx.worker.stop()
    ;({ userId } = await registerUser(ctx))
    ;({ modelPk } = await seedProviderAndModel(ctx, 'image'))
  })
  afterEach(async () => { vi.restoreAllMocks(); await ctx.close() })
  const row = (id: string) => ctx.db.prepare('SELECT * FROM generations WHERE id=?').get(id) as GenerationRow
  async function create(kind: string = 'item', n = 1) {
    const response = await call(ctx, '/api/generations', { method: 'POST', body: { modelId: modelPk, prompt: 'A rendered object', imagePurpose: { kind, name: 'Publication name', description: 'Description only', continuityNotes: 'Keep shape' }, params: { n } } })
    expect(response.status).toBe(202)
    return response.body.generation.id as string
  }
  async function finish(id: string) {
    const worker = createWorker({ db: ctx.db, env: ctx.env, mediaStore: ctx.mediaStore })
    await worker.tick(); await worker.stop()
    expect(row(id).status).toBe('succeeded')
  }
  it('publishes each output distinctly and retries without duplicates or provider calls', async () => {
    const id = await create('item', 3)
    expect(row(id).prompt).toBe('A rendered object')
    expect(row(id).effective_prompt).not.toContain('Publication name')
    await finish(id)
    expect(row(id).library_publish_status).toBe('succeeded')
    const publications = libraryPublications(ctx.db, id)
    expect(publications).toHaveLength(3)
    expect(new Set(publications.map(p => p.targetId)).size).toBe(3)
    expect(publications.map(p => (ctx.db.prepare('SELECT name FROM library_assets WHERE id=?').get(p.targetId) as { name: string }).name).sort())
      .toEqual(['Publication name · 1', 'Publication name · 2', 'Publication name · 3'])
    const before = row(id).attempt_count
    const retry = await call(ctx, `/api/generations/${id}/retry-library-publication`, { method: 'POST', body: {} })
    expect(retry.status).toBe(200)
    expect(retry.body.generation.libraryPublications).toHaveLength(3)
    expect(row(id).attempt_count).toBe(before)
    expect(libraryPublications(ctx.db, id)).toEqual(publications)
    const reference = ctx.db.prepare('SELECT u.id,u.relative_path FROM library_assets a JOIN uploads u ON u.id=a.reference_upload_id WHERE a.id=?').get(publications[0]!.targetId) as { id: string; relative_path: string }
    ctx.db.prepare('UPDATE library_assets SET reference_upload_id=NULL WHERE id=?').run(publications[0]!.targetId)
    expect(uploadReferenced(ctx.db, reference.id, reference.relative_path)).toBe(true)
    await registerUser(ctx)
    expect((await call(ctx, `/api/generations/${id}/retry-library-publication`, { method: 'POST', body: {} })).status).toBe(404)
  })
  it.each(['item', 'logo', 'location'])('creates global %s entity and durable copied reference', async kind => {
    const id = await create(kind)
    await finish(id)
    const publication = libraryPublications(ctx.db, id)[0]!
    expect(publication?.targetKind).toBe(kind)
    const reference = ctx.db.prepare('SELECT a.name,u.relative_path FROM library_assets a JOIN uploads u ON u.id=a.reference_upload_id WHERE a.id=?').get(publication.targetId) as { name: string; relative_path: string }
    expect(reference.name).toBe('Publication name')
    expect(ctx.mediaStore.exists(reference.relative_path)).toBe(true)
  })
  it('never publishes originals while overlays pending or failed; uses final derived output', async () => {
    const id = await create()
    await finish(id)
    // Fresh fixture: remove initial mapped target before simulating deferred postprocessing.
    const mapped = libraryPublications(ctx.db, id)[0]!
    ctx.db.prepare('DELETE FROM generation_library_publications WHERE generation_id=?').run(id)
    ctx.db.prepare('DELETE FROM entity_handles WHERE entity_id=?').run(mapped.targetId)
    ctx.db.prepare('DELETE FROM library_assets WHERE id=?').run(mapped.targetId)
    ctx.db.prepare("UPDATE generations SET logo_overlays_json='[{}]',postprocess_status='queued',library_publish_status='queued' WHERE id=?").run(id)
    publishGenerationImages({ ...ctx, generationId: id })
    expect(libraryPublications(ctx.db, id)).toHaveLength(0)
    ctx.db.prepare("UPDATE generations SET postprocess_status='failed' WHERE id=?").run(id)
    expect((await call(ctx, `/api/generations/${id}/retry-library-publication`, { method: 'POST', body: {} })).status).toBe(400)
    const asset = ctx.db.prepare('SELECT id FROM assets WHERE generation_id=?').get(id) as { id: string }
    const saved = ctx.mediaStore.save({ userId, generationId: id, bytes: MOCK_PNG_BYTES, index: 9 })
    ctx.db.prepare("INSERT INTO assets(id,generation_id,user_id,relative_path,mime_type,byte_size,created_at,variant,source_asset_id) VALUES(?,?,?,?,?,?,?,'logo_overlay',?)").run('derived', id, userId, saved.relativePath, saved.mimeType, saved.byteSize, Date.now(), asset.id)
    ctx.db.prepare("UPDATE generations SET postprocess_status='succeeded' WHERE id=?").run(id)
    publishGenerationImages({ ...ctx, generationId: id })
    expect(libraryPublications(ctx.db, id)).toMatchObject([{ sourceAssetId: asset.id, assetId: 'derived' }])
  })
  it('rolls back failed output creation and recovers locally without duplicate entities', async () => {
    const id = await create()
    const original = ctx.mediaStore.saveUpload
    const spy = vi.spyOn(ctx.mediaStore, 'saveUpload').mockImplementation(() => { throw new Error('Disk unavailable') })
    await finish(id)
    expect(row(id).library_publish_status).toBe('failed')
    expect(row(id).status).toBe('succeeded')
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM library_assets WHERE user_id=?').get(userId)).toEqual({ n: 0 })
    spy.mockImplementation(original)
    ctx.db.prepare('UPDATE generations SET updated_at=? WHERE id=?').run(Date.now() - 120_000, id)
    recoverImagePublications(ctx.db, ctx.env, ctx.mediaStore)
    expect(row(id).library_publish_status).toBe('succeeded')
    expect(libraryPublications(ctx.db, id)).toHaveLength(1)
  })
  it('reuses committed outputs after a later output fails, and never publishes failed provider jobs', async () => {
    const id = await create('item', 3)
    const original = ctx.mediaStore.saveUpload
    let copies = 0
    const spy = vi.spyOn(ctx.mediaStore, 'saveUpload').mockImplementation(input => {
      if (++copies === 2) throw new Error('Second output failed')
      return original(input)
    })
    await finish(id)
    expect(row(id).library_publish_status).toBe('failed')
    const first = libraryPublications(ctx.db, id)
    expect(first).toHaveLength(1)
    spy.mockImplementation(original)
    publishGenerationImages({ ...ctx, generationId: id })
    const all = libraryPublications(ctx.db, id)
    expect(all).toHaveLength(3)
    expect(all.some(item => item.targetId === first[0]!.targetId)).toBe(true)
    expect(all.map(p => (ctx.db.prepare('SELECT name FROM library_assets WHERE id=?').get(p.targetId) as { name: string }).name).sort())
      .toEqual(['Publication name · 1', 'Publication name · 2', 'Publication name · 3'])
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM library_assets WHERE user_id=?').get(userId)).toEqual({ n: 3 })
    const failed = await create('item')
    ctx.db.prepare("UPDATE generations SET status='failed' WHERE id=?").run(failed)
    publishGenerationImages({ ...ctx, generationId: failed })
    expect(libraryPublications(ctx.db, failed)).toHaveLength(0)
    expect((await call(ctx, `/api/generations/${failed}/retry-library-publication`, { method: 'POST', body: {} })).status).toBe(400)
  })
  it('rejects malformed purpose and video purpose and keeps ordinary generations opt-in', async () => {
    const { modelPk: video } = await seedProviderAndModel(ctx, 'video')
    for (const body of [
      { modelId: modelPk, imagePurpose: { kind: 'invented', name: 'x' } },
      { modelId: modelPk, imagePurpose: { kind: 'character', name: 'x' } },
      { modelId: modelPk, imagePurpose: { kind: 'item', name: 'x', description: 'x'.repeat(5001) } },
      { modelId: video, imagePurpose: { kind: 'item', name: 'x' } },
    ]) expect((await call(ctx, '/api/generations', { method: 'POST', body: { prompt: 'Image', ...body } })).status).toBe(400)
    const response = await call(ctx, '/api/generations', { method: 'POST', body: { modelId: modelPk, prompt: 'Normal' } })
    expect(response.status).toBe(202)
    expect(row(response.body.generation.id).image_purpose_json).toBeNull()
  })
})
