import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'
import { sweepAutoGenerate } from '../../server/generations/sweeper'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { if (ctx) await ctx.close() })

async function fixture() {
  const owner = await registerUser(ctx)
  const { modelPk } = await seedProviderAndModel(ctx, 'video')
  const project = (await call(ctx, '/api/projects', { method: 'POST', body: { name: 'Bulk configuration' } })).body.project
  const create = async (body: Record<string, unknown> = {}) => {
    const result = await call(ctx, `/api/projects/${project.id}/scenes`, { method: 'POST', body: { title: 'Scene', prompt: 'Actual scene prompt', ...body } })
    expect(result.status).toBe(201)
    return result.body.scene
  }
  const bulk = (body: Record<string, unknown>) => call(ctx, `/api/projects/${project.id}/scenes/bulk`, { method: 'POST', body })
  const rows = () => ctx.db.prepare('SELECT * FROM scenes WHERE project_id=? ORDER BY position').all(project.id)
  const model = (modelId: string, style: string) => ctx.db.prepare('UPDATE models SET model_id=?,video_api_style=? WHERE id=?').run(modelId, style, modelPk)
  return { owner, modelPk, project, create, bulk, rows, model }
}

function upload(userId: string, mime = 'image/png', available = true) {
  const id = randomUUID()
  const saved = ctx.mediaStore.saveUpload({ userId, uploadId: id, bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'), maxBytes: ctx.env.MAX_REFERENCE_BYTES })
  ctx.db.prepare('INSERT INTO uploads (id,user_id,relative_path,mime_type,byte_size,created_at) VALUES (?,?,?,?,?,?)').run(id, userId, available ? saved.relativePath : 'missing.png', mime, saved.byteSize, Date.now())
  return id
}

function asset(userId: string, options: { mime?: string; status?: string; deleted?: boolean; available?: boolean; generationUserId?: string } = {}) {
  const uploadId = upload(userId)
  const source = ctx.db.prepare('SELECT relative_path FROM uploads WHERE id=?').get(uploadId) as { relative_path: string }
  const generationId = randomUUID(), assetId = randomUUID(), now = Date.now()
  // Copy a complete mock generation fixture without contacting any provider.
  const model = ctx.db.prepare('SELECT id,provider_id FROM models WHERE user_id=? LIMIT 1').get(userId) as { id: string; provider_id: string }
  ctx.db.prepare(`INSERT INTO generations (id,user_id,provider_id,model_pk,kind,prompt,params_json,snap_provider,snap_base_url,snap_model_id,status,created_at,updated_at,deleted_at)
    VALUES (?,?,?,?,'image','Frame','{}','mock','https://mock.test','mock-image',?,?,?,?)`).run(generationId, options.generationUserId ?? userId, model.provider_id, model.id, options.status ?? 'succeeded', now, now, options.deleted ? now : null)
  ctx.db.prepare('INSERT INTO assets (id,user_id,generation_id,relative_path,mime_type,byte_size,created_at) VALUES (?,?,?,?,?,?,?)').run(assetId, userId, generationId, options.available === false ? 'missing.png' : source.relative_path, options.mime ?? 'image/png', 10, now)
  return assetId
}

describe('bulk video configuration', () => {
  it('fills only no-model scenes by default, rebuilds defaults, preserves scene metadata and never enqueues', async () => {
    const f = await fixture()
    const contexts = [{ version: 1, text: 'Legacy context', mentions: [] }]
    const first = await f.create({ approved: true, autoGenerate: true, params: { staleField: 'remove', duration: 22, logoOverlays: [], allowTemporaryMedia: true, useCharacterReference: false } })
    ctx.db.prepare('UPDATE scenes SET params_json=? WHERE id=?').run(JSON.stringify({ ...first.params, contextDocuments: contexts }), first.id)
    const second = await f.create({ modelId: f.modelPk, autoGenerate: true, params: { seconds: '8', quality: 'old' } })
    const before = f.rows()[1]
    const result = await f.bulk({ modelId: f.modelPk, params: { seconds: '6' } })
    expect(result.status).toBe(200)
    expect(result.body.scenes[0]).toMatchObject({ modelId: f.modelPk, autoGenerate: false, approved: true,
      params: { size: '1280x720', seconds: '6', logoOverlays: [], allowTemporaryMedia: true, useCharacterReference: false }, contextDocuments: contexts })
    const stored = JSON.parse((f.rows()[0] as any).params_json)
    expect(stored).toEqual({ size: '1280x720', seconds: '6', logoOverlays: [], allowTemporaryMedia: true, useCharacterReference: false, contextDocuments: contexts })
    expect(f.rows()[1]).toEqual(before)
    expect(result.body.scenes[1].id).toBe(second.id)
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM generations WHERE user_id=?').get(f.owner.userId)).toEqual({ n: 0 })
  })

  it('replaces only explicitly selected scenes and disables character references for Agnes Flash', async () => {
    const f = await fixture()
    f.model('agnes-video-2.5-flash', 'agnes')
    const first = await f.create({ modelId: f.modelPk, autoGenerate: true, params: { useCharacterReference: true, allowTemporaryMedia: false, logoOverlays: [], duration: 29 } })
    await f.create({ params: { keep: true } })
    const untouched = f.rows()[1]
    const result = await f.bulk({ ids: [first.id], modelId: f.modelPk, modelAssignment: 'replace', params: { size: '1080P', seconds: '12' } })
    expect(result.status).toBe(200)
    expect(result.body.scenes[0]).toMatchObject({ autoGenerate: false, params: { mode: 'text', size: '720P', seconds: '12', aspectRatio: '16:9', n: 1, useCharacterReference: false, allowTemporaryMedia: false, logoOverlays: [] } })
    expect(result.body.scenes[0].params).not.toHaveProperty('duration')
    expect(f.rows()[1]).toEqual(untouched)
  })

  it('rejects unsafe contracts, invalid structural fields and durations without any writes', async () => {
    const f = await fixture()
    const scene = await f.create({ autoGenerate: true })
    const before = f.rows()
    for (const body of [
      { params: {} }, { params: {}, modelId: null },
      { modelId: f.modelPk, modelAssignment: 'replace', params: {} },
      { ids: [scene.id], modelId: f.modelPk, modelAssignment: 'replace' },
      { modelId: f.modelPk, params: {}, autoGenerate: true },
      ...['logoOverlays', 'allowTemporaryMedia', 'useCharacterReference', 'contextDocuments'].map(key => ({ modelId: f.modelPk, params: { [key]: null } })),
      { modelId: f.modelPk, params: { seconds: '3' }, approved: true },
      { modelId: f.modelPk, params: { seconds: '31' } },
      { modelId: f.modelPk, params: { n: 5 } },
      { modelId: f.modelPk, params: { generateAudio: 'yes' } },
      { modelId: f.modelPk, params: [], ids: [scene.id] },
    ]) {
      expect((await f.bulk(body)).status, JSON.stringify(body)).toBe(400)
      expect(f.rows()).toEqual(before)
    }
  })

  it('validates enabled owned video models and all explicit ids before changing flags', async () => {
    const f = await fixture()
    const scene = await f.create()
    const before = f.rows()
    const image = await seedProviderAndModel(ctx, 'image')
    ctx.db.prepare('UPDATE models SET enabled=0 WHERE id=?').run(f.modelPk)
    for (const body of [
      { modelId: 'missing', params: {} }, { modelId: image.modelPk, params: {} }, { modelId: f.modelPk, params: {} },
      { ids: [scene.id, scene.id], approved: true }, { ids: [scene.id, 'unknown'], approved: true },
    ]) {
      expect((await f.bulk({ approved: true, ...body })).status).toBe(400)
      expect(f.rows()).toEqual(before)
    }
    const other = await registerUser(ctx)
    const foreign = await seedProviderAndModel(ctx, 'video')
    await call(ctx, '/api/auth/login', { method: 'POST', body: { email: f.owner.email, password: 'matkhau-rat-dai-123' } })
    expect(other.userId).not.toBe(f.owner.userId)
    expect((await f.bulk({ modelId: foreign.modelPk, params: {}, approved: true })).status).toBe(400)
    expect(f.rows()).toEqual(before)
  })

  it('normalizes provider drafts and validates every actual Higgsfield prompt atomically', async () => {
    const f = await fixture()
    f.model('bytedance/seedance-2.5', 'higgsfield')
    await f.create()
    await f.create({ prompt: '' })
    const before = f.rows()
    const rejected = await f.bulk({ modelId: f.modelPk, params: {}, approved: true })
    expect(rejected.status).toBe(400)
    expect(rejected.body.error.message).toContain((before[1] as any).id)
    expect(f.rows()).toEqual(before)
    const result = await f.bulk({ modelId: f.modelPk, ids: [(before[0] as any).id], params: { duration: 9 } })
    expect(result.status).toBe(200)
    expect(result.body.scenes[0].params).toEqual({ mode: 'text', duration: 9, resolution: '720p', bitrateMode: 'high', generateAudio: true, aspectRatio: '16:9', outputFormat: 'mp4', useCharacterReference: false })
    const now = f.rows()
    for (const params of [{ duration: 31 }, { duration: 4.5 }, { resolution: '4k' }, { mode: 'image' }, { mode: 'text', imageUrl: 'https://example.com/frame.png' }]) {
      expect((await f.bulk({ ids: [(before[0] as any).id], modelAssignment: 'replace', modelId: f.modelPk, params })).status).toBe(400)
      expect(f.rows()).toEqual(now)
    }
  })

  it('checks Higgsfield upload and asset ownership, MIME, availability and lifecycle without paid calls', async () => {
    const f = await fixture()
    f.model('bytedance/seedance-2.5/image-to-video', 'higgsfield')
    const scene = await f.create({ autoGenerate: true })
    const ownUpload = upload(f.owner.userId)
    const ownAsset = asset(f.owner.userId)
    const badSources = [
      { imageUploadId: 'unknown' }, { imageUploadId: upload(f.owner.userId, 'video/mp4') },
      { imageUploadId: upload(f.owner.userId, 'image/png', false) },
      { imageAssetId: asset(f.owner.userId, { mime: 'video/mp4' }) },
      { imageAssetId: asset(f.owner.userId, { status: 'failed' }) },
      { imageAssetId: asset(f.owner.userId, { deleted: true }) },
      { imageAssetId: asset(f.owner.userId, { available: false }) },
    ]
    const other = await registerUser(ctx)
    await seedProviderAndModel(ctx, 'video')
    badSources.push({ imageUploadId: upload(other.userId) }, { imageAssetId: asset(other.userId) })
    await call(ctx, '/api/auth/login', { method: 'POST', body: { email: f.owner.email, password: 'matkhau-rat-dai-123' } })
    const before = f.rows()
    for (const source of badSources) {
      expect((await f.bulk({ ids: [scene.id], modelAssignment: 'replace', modelId: f.modelPk, approved: true, params: { mode: 'image', ...source } })).status, JSON.stringify(source)).toBe(400)
      expect(f.rows()).toEqual(before)
    }
    const result = await f.bulk({ ids: [scene.id], modelAssignment: 'replace', modelId: f.modelPk, params: { mode: 'image', imageUploadId: ownUpload, endImageAssetId: ownAsset } })
    expect(result.status).toBe(200)
    expect(result.body.scenes[0].params).toMatchObject({ mode: 'image', imageUploadId: ownUpload, endImageAssetId: ownAsset, useCharacterReference: false })
    expect(result.body.scenes[0].params).not.toHaveProperty('aspectRatio')
    expect(result.body.scenes[0].params).not.toHaveProperty('outputFormat')
    expect(result.body.scenes[0].autoGenerate).toBe(false)
  })

  it('rejects incompatible Agnes media and Flash duration atomically', async () => {
    const f = await fixture()
    f.model('agnes-video-2.5-flash', 'agnes')
    await f.create()
    const before = f.rows()
    for (const params of [{ seconds: '13' }, { seconds: 5 }, { mode: 'reference' }, { mode: 'keyframe' }, { mode: 'text', firstFrame: 'https://example.com/a.png' }, { videos: [] }, { mode: 'reference', referenceImages: ['file:///private.png'] }]) {
      expect((await f.bulk({ modelId: f.modelPk, approved: true, params })).status, JSON.stringify(params)).toBe(400)
      expect(f.rows()).toEqual(before)
    }
  })

  it('uses saved configuration for later direct generation and explicit auto-generation consent', async () => {
    // Isolate sweeper from legacy autoGenerate flags deliberately left by other cases.
    ctx.db.prepare('UPDATE scenes SET auto_generate=0').run()
    const f = await fixture()
    const direct = await f.create({ params: { staleField: 'remove' } })
    const swept = await f.create({ params: { quality: 'stale' } })
    const applied = await f.bulk({ ids: [direct.id, swept.id], modelId: f.modelPk, params: { seconds: '9', size: '720x1280' }, approved: true })
    expect(applied.status).toBe(200)
    expect(sweepAutoGenerate({ db: ctx.db, env: ctx.env, worker: ctx.worker })).toBe(0)
    const generated = await call(ctx, `/api/generations/scenes/${direct.id}/generate`, { method: 'POST', body: {} })
    expect(generated.status).toBe(202)
    const directRow = ctx.db.prepare('SELECT params_json FROM generations WHERE scene_id=?').get(direct.id) as { params_json: string }
    expect(JSON.parse(directRow.params_json)).toEqual({ seconds: '9', size: '720x1280' })
    const consent = await f.bulk({ ids: [swept.id], autoGenerate: true })
    expect(consent.status).toBe(200)
    expect(sweepAutoGenerate({ db: ctx.db, env: ctx.env, worker: ctx.worker })).toBe(1)
    const sweptRow = ctx.db.prepare('SELECT params_json FROM generations WHERE scene_id=?').get(swept.id) as { params_json: string }
    expect(JSON.parse(sweptRow.params_json)).toEqual({ seconds: '9', size: '720x1280' })
    expect((ctx.db.prepare('SELECT auto_generate FROM scenes WHERE id=?').get(swept.id) as { auto_generate: number }).auto_generate).toBe(0)
  })

  it('rejects unsupported non-Flash Agnes resolutions and includes scene identity', async () => {
    const f = await fixture()
    f.model('agnes-video-2.5', 'agnes')
    const scene = await f.create()
    const before = f.rows()
    const result = await f.bulk({ modelId: f.modelPk, params: { size: 'garbage' }, approved: true })
    expect(result.status).toBe(400)
    expect(result.body.error.message).toContain(scene.id)
    expect(f.rows()).toEqual(before)
  })

  it('preserves legacy model-only fill-only, flag and clear behavior', async () => {
    const f = await fixture()
    const other = await seedProviderAndModel(ctx, 'video')
    const first = await f.create({ params: { historical: 'unchanged' } })
    const second = await f.create({ modelId: other.modelPk, params: { seconds: '8' } })
    const result = await f.bulk({ modelId: f.modelPk, approved: true, autoGenerate: true })
    expect(result.status).toBe(200)
    expect(result.body.scenes).toMatchObject([
      { id: first.id, modelId: f.modelPk, approved: true, autoGenerate: true, params: { historical: 'unchanged' } },
      { id: second.id, modelId: other.modelPk, approved: true, autoGenerate: true, params: { seconds: '8' } },
    ])
    const cleared = await f.bulk({ ids: [first.id], modelId: null, approved: false })
    expect(cleared.status).toBe(200)
    expect(cleared.body.scenes[0]).toMatchObject({ modelId: null, approved: false, autoGenerate: true, params: { historical: 'unchanged' } })
  })
})
