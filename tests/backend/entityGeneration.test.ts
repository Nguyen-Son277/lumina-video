import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  insertPromptMention, updatePromptDocument, type PromptDocument,
} from '../../shared/promptMentions'
import {
  createLibraryAsset, patchLibraryAsset, saveLibraryAssetReference,
  softDeleteLibraryAsset, updateEntityHandle, type CatalogEntity,
} from '../../server/entityLibrary/service'
import { issueMediaGrant } from '../../server/entityLibrary/mediaGrants'
import { enqueueGeneration, enqueueSchema } from '../../server/generations/enqueue'
import { createWorker } from '../../server/generations/worker'
import { MOCK_PNG_BYTES } from '../../server/generations/adapters/mock'
import type { GenerationRow } from '../../server/generations/types'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'

const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const OVERLAY = { x: 0, y: 0, width: 1, opacity: 0.7 }

/** Build actual persisted bindings using the shared editor API, never resolve by label. */
function documentFor(entities: Array<Pick<CatalogEntity, 'id' | 'kind' | 'handle'>>): PromptDocument {
  let document: PromptDocument = { version: 1, text: 'Photograph ', mentions: [] }
  for (const entity of entities) {
    document = insertPromptMention(document, document.text.length, document.text.length,
      { kind: entity.kind, id: entity.id }, entity.handle)
    document = updatePromptDocument(document, `${document.text} `)
  }
  return updatePromptDocument(document, `${document.text}in the studio.`)
}

/** No provider, DNS fixture, or outside HTTP server is used by this suite. */
describe('central entity generation: stable identities, real references and temporary media', () => {
  let ctx: TestContext
  let userId: string
  let imageModel: string

  beforeEach(async () => {
    ctx = await startTestServer({ providerMode: 'mock' })
    await ctx.worker.stop() // inspect queued snapshots without enqueue.wake racing assertions
    ;({ userId } = await registerUser(ctx))
    ;({ modelPk: imageModel } = await seedProviderAndModel(ctx, 'image'))
    const localFetch = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input)
      if (!url.startsWith(`${ctx.baseUrl}/`)) throw new Error(`Unexpected non-local HTTP request: ${url}`)
      return localFetch(input, init)
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await ctx.close()
  })

  function row(id: string): GenerationRow {
    return ctx.db.prepare('SELECT * FROM generations WHERE id=?').get(id) as GenerationRow
  }
  function counts() {
    return {
      generations: Number((ctx.db.prepare('SELECT COUNT(*) AS total FROM generations').get() as { total: number }).total),
      grants: Number((ctx.db.prepare('SELECT COUNT(*) AS total FROM temporary_media_grants').get() as { total: number }).total),
    }
  }
  function asset(kind: 'item' | 'logo', name: string, reference = true): CatalogEntity {
    const created = createLibraryAsset(ctx.db, userId, {
      kind, name, description: `${name} original design`, continuityNotes: `Keep the ${name} silhouette`,
    })
    return reference ? saveLibraryAssetReference(ctx.db, ctx.env, ctx.mediaStore, userId, created.id, MOCK_PNG_BYTES) : created
  }
  function payload(modelId: string, document: PromptDocument, extra: Record<string, unknown> = {}) {
    return { modelId, prompt: document.text, promptDocument: document, params: {}, ...extra }
  }
  async function videoModel(agnes = false) {
    const { providerId, modelPk } = await seedProviderAndModel(ctx, 'video')
    if (!agnes) return modelPk
    const model = await call(ctx, '/api/models', { method: 'POST', body: {
      providerId, modelId: 'agnes-video-2.5-flash', kind: 'video',
    } })
    expect(model.status).toBe(201)
    expect(model.body.model.videoApiStyle).toBe('agnes')
    return model.body.model.id as string
  }
  function character(name: string) {
    const id = randomUUID(), now = Date.now()
    const saved = ctx.mediaStore.saveUpload({ userId, uploadId: randomUUID(), bytes: MOCK_PNG_BYTES, maxBytes: ctx.env.MAX_REFERENCE_BYTES })
    ctx.db.prepare(`INSERT INTO characters
      (id,user_id,name,appearance,voice_json,reference_path,reference_mime,reference_bytes,created_at,updated_at)
      VALUES (?,?,?,?,'{}',?,?,?,?,?)`).run(id, userId, name, `${name} distinct appearance`, saved.relativePath, saved.mimeType, saved.byteSize, now, now)
    return updateEntityHandle(ctx.db, userId, { kind: 'character', id }, name)
  }
  function noPrivateSerialization(body: unknown, paths: string[], tokens: string[] = []) {
    const text = JSON.stringify(body)
    expect(text).not.toContain(ctx.dir)
    expect(text).not.toContain('sk-mock-key-for-tests')
    expect(text).not.toContain('/api/provider-media/')
    for (const path of paths) expect(text).not.toContain(path)
    for (const token of tokens) expect(text).not.toContain(token)
  }

  it('pure preview validates ID-bound item/logo references without a worker or paid task', () => {
    const item = asset('item', 'Camera'), logo = asset('logo', 'Acme')
    const document = documentFor([item, logo]), before = counts()
    const preview = enqueueGeneration({ db: ctx.db, env: ctx.env, userId,
      request: { data: enqueueSchema.parse(payload(imageModel, document)) }, previewOnly: true })
    expect(preview.referenceCount).toBe(2)
    expect(preview.maxReferenceCount).toBe(ctx.env.MAX_SOURCE_IMAGES)
    expect(preview.entities).toEqual([
      expect.objectContaining({ id: item.id, kind: 'item', revision: item.revision, referenceMode: 'sent' }),
      expect.objectContaining({ id: logo.id, kind: 'logo', revision: logo.revision, referenceMode: 'sent' }),
    ])
    expect(preview.prompt).toContain(item.description)
    expect(preview.prompt).toContain(logo.continuityNotes)
    noPrivateSerialization(preview, [item.reference!.path, logo.reference!.path])
    expect(counts()).toEqual(before)
  })

  it('HTTP preview and enqueue agree; actual item/logo photo paths and bytes are snapshotted', async () => {
    const item = asset('item', 'Camera'), logo = asset('logo', 'Acme')
    const document = documentFor([item, logo])
    const preview = await call(ctx, '/api/generations/preview', { method: 'POST', body: payload(imageModel, document) })
    expect(preview.status).toBe(200)
    expect(counts()).toEqual({ generations: 0, grants: 0 })
    const created = await call(ctx, '/api/generations', { method: 'POST', body: payload(imageModel, document) })
    expect(created.status).toBe(202)
    const queued = row(created.body.generation.id)
    expect(queued.status).toBe('queued')
    expect(queued.attempt_count).toBe(0)
    expect(queued.effective_prompt).toBe(preview.body.preview.prompt)
    expect(JSON.parse(queued.prompt_document_json!)).toEqual(document)
    expect(JSON.parse(queued.source_images_json!)).toEqual([
      { path: item.reference!.path, mime: 'image/png' }, { path: logo.reference!.path, mime: 'image/png' },
    ])
    expect(JSON.parse(queued.entity_references_json!).map((e: any) => e.referenceMode)).toEqual(['sent', 'sent'])
    for (const entity of [item, logo]) expect(Buffer.from(ctx.mediaStore.readFile(entity.reference!.path))).toEqual(MOCK_PNG_BYTES)
    expect(created.body.generation.sourceImageCount).toBe(2)
    noPrivateSerialization(created.body, [item.reference!.path, logo.reference!.path])
    noPrivateSerialization((await call(ctx, `/api/generations/${queued.id}`)).body, [item.reference!.path, logo.reference!.path])
    noPrivateSerialization((await call(ctx, '/api/generations')).body, [item.reference!.path, logo.reference!.path])
  })

  it('rename and handle edits keep the frozen occurrence bound to the same ID; queued snapshots stay unchanged', async () => {
    const original = asset('item', 'Camera'), document = documentFor([original])
    const created = await call(ctx, '/api/generations', { method: 'POST', body: payload(imageModel, document) })
    expect(created.status).toBe(202)
    const before = row(created.body.generation.id)
    patchLibraryAsset(ctx.db, userId, original.id, { name: 'Renamed Camera', description: 'Revised appearance' })
    const renamed = updateEntityHandle(ctx.db, userId, { kind: 'item', id: original.id }, 'new-camera')
    const replacement = asset('item', 'Camera') // former visible label now belongs to another ID
    expect(replacement.handle).toBe(original.handle)
    const preview = await call(ctx, '/api/generations/preview', { method: 'POST', body: payload(imageModel, document) })
    expect(preview.status).toBe(200)
    expect(preview.body.preview.entities).toEqual([expect.objectContaining({
      id: original.id, name: 'Renamed Camera', handle: 'new-camera', revision: renamed.revision,
    })])
    expect(preview.body.preview.prompt).toContain('Revised appearance')
    expect(preview.body.preview.entities.some((e: any) => e.id === replacement.id)).toBe(false)
    expect(row(before.id).prompt_document_json).toBe(before.prompt_document_json)
    expect(row(before.id).entity_references_json).toBe(before.entity_references_json)
    expect(row(before.id).effective_prompt).toBe(before.effective_prompt)
  })

  it('delete then recreate the same handle never rebinds an old document or creates paid work', async () => {
    const old = asset('item', 'Camera'), document = documentFor([old])
    softDeleteLibraryAsset(ctx.db, userId, old.id)
    const replacement = asset('item', 'Camera')
    expect(replacement.handle).toBe(old.handle)
    expect(replacement.id).not.toBe(old.id)
    const before = counts()
    for (const endpoint of ['/api/generations/preview', '/api/generations']) {
      const result = await call(ctx, endpoint, { method: 'POST', body: payload(imageModel, document) })
      expect(result.status).toBe(404)
    }
    expect(counts()).toEqual(before)
  })

  it('rejects raw/unbound/mismatched mentions before preview or enqueue, rather than looking up a handle', async () => {
    const item = asset('item', 'Camera'), document = documentFor([item])
    const invalid = [
      { modelId: imageModel, prompt: document.text, params: {} },
      payload(imageModel, { ...document, mentions: [] }),
      { ...payload(imageModel, document), prompt: 'different prompt' },
    ]
    for (const body of invalid) for (const endpoint of ['/api/generations/preview', '/api/generations']) {
      expect((await call(ctx, endpoint, { method: 'POST', body })).status).toBe(400)
    }
    expect(counts()).toEqual({ generations: 0, grants: 0 })
  })

  it('rejects an entity bound to another account by ID before creating a task', async () => {
    const other = await registerUser(ctx, 'entity-other@gigone.com')
    const foreign = createLibraryAsset(ctx.db, other.userId, { kind: 'logo', name: 'Private Crest' })
    const ownerLogin = await call(ctx, '/api/auth/login', { method: 'POST', body: {
      email: (ctx.db.prepare('SELECT email FROM users WHERE id=?').get(userId) as { email: string }).email,
      password: 'matkhau-rat-dai-123',
    } })
    expect(ownerLogin.status).toBe(200)
    const result = await call(ctx, '/api/generations', { method: 'POST', body: payload(imageModel, documentFor([foreign])) })
    expect(result.status).toBe(404)
    expect(counts()).toEqual({ generations: 0, grants: 0 })
  })

  it('image reference overflow rejects preview and create without truncation or paid task', async () => {
    const entities = Array.from({ length: ctx.env.MAX_SOURCE_IMAGES + 1 }, (_, i) => asset('item', `Prop ${i}`))
    const body = payload(imageModel, documentFor(entities))
    for (const endpoint of ['/api/generations/preview', '/api/generations']) {
      expect((await call(ctx, endpoint, { method: 'POST', body })).status).toBe(400)
    }
    expect(counts()).toEqual({ generations: 0, grants: 0 })
  })

  it('logo overlay is not a provider reference; queued snapshot is pinned and native PNG creates a separate derived variant', async () => {
    const item = asset('item', 'Camera'), logo = asset('logo', 'Acme')
    const oldPath = logo.reference!.path
    const overlays = [{ entityId: logo.id, ...OVERLAY }]
    const body = payload(imageModel, documentFor([item, logo]), { logoOverlays: overlays })
    const preview = await call(ctx, '/api/generations/preview', { method: 'POST', body })
    expect(preview.status).toBe(200)
    expect(preview.body.preview.referenceCount).toBe(1)
    expect(preview.body.preview.entities.map((e: any) => e.referenceMode)).toEqual(['sent', 'overlay'])
    const created = await call(ctx, '/api/generations', { method: 'POST', body })
    expect(created.status).toBe(202)
    const queued = row(created.body.generation.id)
    expect(JSON.parse(queued.source_images_json!)).toEqual([{ path: item.reference!.path, mime: 'image/png' }])
    expect(JSON.parse(queued.logo_overlays_json!)).toEqual([{ ...overlays[0], path: oldPath, mime: 'image/png' }])
    noPrivateSerialization(created.body, [oldPath, item.reference!.path])
    const replacement = saveLibraryAssetReference(ctx.db, ctx.env, ctx.mediaStore, userId, logo.id, MOCK_PNG_BYTES)
    expect(replacement.reference!.path).not.toBe(oldPath)
    expect(JSON.parse(row(queued.id).logo_overlays_json!)[0].path).toBe(oldPath)
    const worker = createWorker({ db: ctx.db, env: ctx.env, mediaStore: ctx.mediaStore })
    try { await worker.tick() } finally { await worker.stop() }
    const completed = row(queued.id)
    expect(completed.status).toBe('succeeded')
    expect(completed.postprocess_status).toBe('succeeded')
    const outputs = ctx.db.prepare('SELECT * FROM assets WHERE generation_id=? ORDER BY created_at,id').all(queued.id) as Array<{
      id: string; variant: string; source_asset_id: string | null; relative_path: string; mime_type: string;
    }>
    const original = outputs.find(a => a.variant === 'original')!, derived = outputs.find(a => a.variant === 'logo_overlay')!
    expect(outputs).toHaveLength(2)
    expect(derived.source_asset_id).toBe(original.id)
    expect(derived.relative_path).not.toBe(original.relative_path)
    expect(derived.mime_type).toBe('image/png')
    expect(Buffer.from(ctx.mediaStore.readFile(original.relative_path))).toEqual(MOCK_PNG_BYTES)
    expect(Buffer.from(ctx.mediaStore.readFile(oldPath))).toEqual(MOCK_PNG_BYTES)
    expect(ctx.mediaStore.readFile(derived.relative_path).byteLength).toBeGreaterThan(8)
    const publicResult = await call(ctx, `/api/generations/${queued.id}`)
    expect(publicResult.body.generation.assets).toHaveLength(2)
    noPrivateSerialization(publicResult.body, [oldPath, original.relative_path, derived.relative_path])
  })

  it('invalid overlay geometry and missing logo image reject before paid work', async () => {
    const logo = asset('logo', 'Acme', false)
    for (const overlay of [{ entityId: logo.id, ...OVERLAY }, { entityId: logo.id, ...OVERLAY, width: 0 }]) {
      const body = payload(imageModel, documentFor([logo]), { logoOverlays: [overlay] })
      for (const endpoint of ['/api/generations/preview', '/api/generations']) {
        expect((await call(ctx, endpoint, { method: 'POST', body })).status).toBe(400)
      }
    }
    expect(counts()).toEqual({ generations: 0, grants: 0 })
  })

  it('description-only video object references are truthful; OpenAI sends one character and never source uploads', async () => {
    const modelId = await videoModel(), main = character('Pilot'), secondary = character('Co Pilot')
    const item = asset('item', 'Camera'), logo = asset('logo', 'Acme')
    const body = payload(modelId, documentFor([main, secondary, item, logo]))
    const preview = await call(ctx, '/api/generations/preview', { method: 'POST', body })
    expect(preview.status).toBe(200)
    expect(preview.body.preview.referenceCount).toBe(1)
    expect(preview.body.preview.entities.map((e: any) => e.referenceMode)).toEqual(['sent', 'description-only', 'description-only', 'description-only'])
    expect(preview.body.preview.warnings.length).toBeGreaterThan(0)
    const created = await call(ctx, '/api/generations', { method: 'POST', body })
    expect(created.status).toBe(202)
    expect(row(created.body.generation.id).source_images_json).toBeNull()
    expect(JSON.parse(row(created.body.generation.id).character_reference_json!)).toEqual({ path: main.reference!.path, mime: 'image/png' })
    expect(JSON.parse(row(created.body.generation.id).entity_references_json!).map((e: any) => e.referenceMode))
      .toEqual(['sent', 'description-only', 'description-only', 'description-only'])
    const uploadId = item.reference!.uploadId!
    const rejected = await call(ctx, '/api/generations', { method: 'POST', body: { ...body, sourceUploadIds: [uploadId] } })
    expect(rejected.status).toBe(400)
    expect(counts()).toEqual({ generations: 1, grants: 0 })
  })

  it('Agnes private references without opt-in stay description-only and issue no grants', async () => {
    const modelId = await videoModel(true), item = asset('item', 'Camera'), logo = asset('logo', 'Acme')
    const body = payload(modelId, documentFor([item, logo]))
    const preview = await call(ctx, '/api/generations/preview', { method: 'POST', body })
    expect(preview.status).toBe(200)
    expect(preview.body.preview.referenceCount).toBe(0)
    expect(preview.body.preview.entities.map((e: any) => e.referenceMode)).toEqual(['description-only', 'description-only'])
    const result = await call(ctx, '/api/generations', { method: 'POST', body })
    expect(result.status).toBe(202)
    expect(JSON.parse(row(result.body.generation.id).params_json).referenceImages ?? []).toEqual([])
    expect(counts()).toEqual({ generations: 1, grants: 0 })
  })

  it('Agnes opt-in produces hash-only grants, unauthenticated raster fetch, public redaction and owner revocation', async () => {
    ctx.env.APP_ORIGIN = 'https://studio.acme.com' // pure validation only: no DNS/live provider calls
    const modelId = await videoModel(true), item = asset('item', 'Camera'), logo = asset('logo', 'Acme')
    const body = payload(modelId, documentFor([item, logo]), { allowTemporaryMedia: true, params: { mode: 'reference' } })
    const preview = await call(ctx, '/api/generations/preview', { method: 'POST', body })
    expect(preview.status).toBe(200)
    expect(preview.body.preview.referenceCount).toBe(2)
    expect(preview.body.preview.entities.map((e: any) => e.referenceMode)).toEqual(['sent', 'sent'])
    expect(counts()).toEqual({ generations: 0, grants: 0 })
    const created = await call(ctx, '/api/generations', { method: 'POST', body })
    expect(created.status).toBe(202)
    const id = created.body.generation.id, queued = row(id), params = JSON.parse(queued.params_json)
    expect(params).toMatchObject({ allowTemporaryMedia: true, mode: 'reference' })
    expect(params.referenceImages).toHaveLength(2)
    const grants = ctx.db.prepare('SELECT * FROM temporary_media_grants WHERE generation_id=? ORDER BY created_at,id').all(id) as Array<{
      id: string; token_hash: string; relative_path: string; content_sha256: string | null;
    }>
    expect(grants).toHaveLength(2)
    expect(grants.map(g => g.relative_path).sort()).toEqual([item.reference!.path, logo.reference!.path].sort())
    const tokens = params.referenceImages.map((url: string) => {
      expect(url).toMatch(/^https:\/\/studio\.acme\.com\/api\/provider-media\/[a-f0-9]{64}$/)
      return new URL(url).pathname.split('/').at(-1)!
    })
    for (const token of tokens) {
      expect(grants.some(g => g.token_hash === sha256(token))).toBe(true)
      expect(JSON.stringify(grants)).not.toContain(token)
      const response = await fetch(`${ctx.baseUrl}/api/provider-media/${token}`) // deliberately no Cookie
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('image/png')
      expect(response.headers.get('cache-control')).toContain('no-store')
      expect(Buffer.from(await response.arrayBuffer())).toEqual(MOCK_PNG_BYTES)
    }
    expect(JSON.parse(queued.entity_references_json!).map((e: any) => e.referenceMode)).toEqual(['sent', 'sent'])
    for (const result of [created, await call(ctx, `/api/generations/${id}`), await call(ctx, '/api/generations')]) {
      noPrivateSerialization(result.body, grants.map(g => g.relative_path), tokens)
    }
    expect(created.body.generation.params.referenceImages).toEqual([])
    // Explicit store-backed issuance pins content; central no-store issuance still sniffs on GET.
    const pinned = issueMediaGrant({ db: ctx.db, appOrigin: ctx.env.APP_ORIGIN, userId, generationId: id,
      path: item.reference!.path, mime: item.reference!.mime, mediaStore: ctx.mediaStore })
    expect((ctx.db.prepare('SELECT content_sha256 FROM temporary_media_grants WHERE id=?').get(pinned.id) as { content_sha256: string }).content_sha256).toBe(sha256(MOCK_PNG_BYTES))
    const pinnedLocalUrl = `${ctx.baseUrl}${new URL(pinned.url).pathname}`
    expect((await fetch(pinnedLocalUrl)).status).toBe(200)
    const readFile = ctx.mediaStore.readFile.bind(ctx.mediaStore)
    const changedBytes = Buffer.from(MOCK_PNG_BYTES)
    changedBytes[changedBytes.length - 1] = changedBytes[changedBytes.length - 1]! ^ 1 // still raster magic, but not the pinned content
    const changedReader = vi.spyOn(ctx.mediaStore, 'readFile').mockImplementation(path =>
      path === item.reference!.path ? changedBytes : readFile(path))
    try { expect((await fetch(pinnedLocalUrl)).status).toBe(404) }
    finally { changedReader.mockRestore() }
    const ownerCookie = ctx.cookie
    await registerUser(ctx, 'grant-stranger@gigone.com')
    expect((await call(ctx, `/api/generations/${id}/revoke-media`, { method: 'POST' })).status).toBe(404)
    ctx.cookie = ownerCookie
    expect((await call(ctx, `/api/generations/${id}/revoke-media`, { method: 'POST' })).body.revoked).toBe(3)
    expect((await call(ctx, `/api/generations/${id}/revoke-media`, { method: 'POST' })).body.revoked).toBe(0)
    for (const token of [...tokens, new URL(pinned.url).pathname.split('/').at(-1)!]) {
      expect((await fetch(`${ctx.baseUrl}/api/provider-media/${token}`)).status).toBe(404)
    }
    expect(Buffer.from(ctx.mediaStore.readFile(item.reference!.path))).toEqual(MOCK_PNG_BYTES)
  })

  it('sixth Flash temporary reference is rejected before inserting any generation or grant', async () => {
    ctx.env.APP_ORIGIN = 'https://studio.acme.com'
    const modelId = await videoModel(true)
    const entities = Array.from({ length: 6 }, (_, i) => asset('item', `Prop ${i}`))
    const body = payload(modelId, documentFor(entities), { allowTemporaryMedia: true, params: { mode: 'reference' } })
    for (const endpoint of ['/api/generations/preview', '/api/generations']) {
      expect((await call(ctx, endpoint, { method: 'POST', body })).status).toBe(400)
    }
    expect(counts()).toEqual({ generations: 0, grants: 0 })
  })

  it('scene enqueue honors persisted temporary-media opt-in and its ID-bound prompt document', async () => {
    ctx.env.APP_ORIGIN = 'https://studio.acme.com'
    const modelId = await videoModel(true), item = asset('item', 'Camera'), document = documentFor([item])
    const projectId = randomUUID(), sceneId = randomUUID(), now = Date.now()
    ctx.db.prepare('INSERT INTO projects (id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(projectId, userId, 'Scene project', now, now)
    ctx.db.prepare(`INSERT INTO scenes
      (id,project_id,title,prompt,model_id,params_json,prompt_document_json,position,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,0,?,?)`).run(sceneId, projectId, 'Scene', document.text, modelId,
      JSON.stringify({ mode: 'reference', allowTemporaryMedia: true }), JSON.stringify(document), now, now)
    const result = await call(ctx, `/api/generations/scenes/${sceneId}/generate`, { method: 'POST', body: {} })
    expect(result.status).toBe(202)
    const queued = row(result.body.generation.id)
    expect(queued.scene_id).toBe(sceneId)
    expect(JSON.parse(queued.prompt_document_json!)).toEqual(document)
    expect(JSON.parse(queued.params_json)).toMatchObject({ allowTemporaryMedia: true, mode: 'reference' })
    expect(JSON.parse(queued.params_json).referenceImages).toHaveLength(1)
    expect(JSON.parse(queued.entity_references_json!)[0]).toMatchObject({ id: item.id, referenceMode: 'sent' })
    expect(counts()).toEqual({ generations: 1, grants: 1 })
    noPrivateSerialization(result.body, [item.reference!.path])
  })
})
