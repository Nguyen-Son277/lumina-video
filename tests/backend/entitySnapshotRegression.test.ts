import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { insertPromptMention, updatePromptDocument, validatePromptDocument, type PromptDocument } from '../../shared/promptMentions'
import { createLibraryAsset, patchLibraryAsset, resolveEntity, saveLibraryAssetReference, softDeleteLibraryAsset, updateEntityHandle, type CatalogEntity } from '../../server/entityLibrary/service'
import { DEFAULT_MEDIA_GRANT_TTL_MS } from '../../server/entityLibrary/mediaGrants'
import { enqueueGeneration, enqueueSchema, type EnqueueRequest } from '../../server/generations/enqueue'
import { MOCK_PNG_BYTES } from '../../server/generations/adapters/mock'
import type { GenerationRow } from '../../server/generations/types'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function appendMention(document: PromptDocument, entity: CatalogEntity, label = entity.handle): PromptDocument {
  return insertPromptMention(document, document.text.length, document.text.length, { kind: entity.kind, id: entity.id }, label)
}
function documentFor(entities: CatalogEntity[]): PromptDocument {
  let document: PromptDocument = { version: 1, text: 'Show ', mentions: [] }
  for (const entity of entities) {
    document = appendMention(document, entity)
    document = updatePromptDocument(document, `${document.text} `)
  }
  return updatePromptDocument(document, `${document.text}in a quiet studio.`)
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(child => freeze(child))
    Object.freeze(value)
  }
  return value
}

/** Local-only requests, stopped worker, valid native PNG fixtures; no provider calls. */
describe('entity snapshot regressions at the central enqueue boundary', () => {
  let ctx: TestContext
  let userId: string
  let imageModel: string
  let outsideRequests: string[]
  let changedPng: Buffer

  beforeEach(async () => {
    ctx = await startTestServer({ providerMode: 'mock' })
    await ctx.worker.stop()
    outsideRequests = []
    const localFetch = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (!url.startsWith(`${ctx.baseUrl}/`)) {
        outsideRequests.push(url)
        throw new Error(`Unexpected non-local HTTP request: ${url}`)
      }
      return localFetch(input, init)
    })
    ;({ userId } = await registerUser(ctx))
    ;({ modelPk: imageModel } = await seedProviderAndModel(ctx, 'image'))
    changedPng = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 240, g: 30, b: 90, alpha: 1 } } }).png().toBuffer()
    expect(changedPng.equals(MOCK_PNG_BYTES)).toBe(false)
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await ctx.close()
    expect(outsideRequests).toEqual([])
  })

  function row(id: string): GenerationRow {
    return ctx.db.prepare('SELECT * FROM generations WHERE id=?').get(id) as GenerationRow
  }
  function counts() {
    return {
      generations: ctx.db.prepare('SELECT COUNT(*) AS n FROM generations').get()!.n,
      grants: ctx.db.prepare('SELECT COUNT(*) AS n FROM temporary_media_grants').get()!.n,
    }
  }
  async function uploadCharacter(id: string, bytes: Buffer) {
    const response = await fetch(`${ctx.baseUrl}/api/shared-characters/${id}/reference`, {
      method: 'POST', headers: { Cookie: ctx.cookie, 'Content-Type': 'image/png' }, body: new Uint8Array(bytes),
    })
    expect(response.status).toBe(201)
  }
  async function character(name: string, appearance: string) {
    const result = await call(ctx, '/api/shared-characters', { method: 'POST', body: { name, appearance, voice: {} } })
    expect(result.status).toBe(201)
    await uploadCharacter(result.body.character.id, MOCK_PNG_BYTES)
    return resolveEntity(ctx.db, userId, { kind: 'character', id: result.body.character.id })
  }
  function enqueue(request: EnqueueRequest) {
    return enqueueGeneration({ db: ctx.db, env: ctx.env, mediaStore: ctx.mediaStore, worker: ctx.worker, userId, request }).generation
  }
  async function project() {
    const result = await call(ctx, '/api/projects', { method: 'POST', body: { name: 'Synthetic snapshot project' } })
    expect(result.status).toBe(201)
    return result.body.project.id as string
  }

  it('frozen context entities supply old primary and cast bytes, names and appearances after live character edits', async () => {
    const primary = await character('Character A original', 'OLD_APPEARANCE_A blue coat and silver hair')
    const secondary = await character('Character B original', 'OLD_APPEARANCE_B red scarf and green eyes')
    const contextDocument = documentFor([primary, secondary])
    // Exactly the server-side resolve-at-batch-creation contract, not handcrafted overrides.
    const frozenEntities = freeze(structuredClone([primary, secondary].map(entity => resolveEntity(ctx.db, userId, { kind: entity.kind, id: entity.id }))))
    const request: EnqueueRequest = freeze({
      data: enqueueSchema.parse({ modelId: imageModel, prompt: 'A quiet studio portrait.', characterIds: [primary.id, secondary.id], params: {} }),
      contextDocuments: [structuredClone(contextDocument)], resolvedContextEntities: frozenEntities,
    })
    const originalRequest = JSON.stringify(request)
    for (const [entity, suffix] of [[primary, 'A'], [secondary, 'B']] as const) {
      const patched = await call(ctx, `/api/shared-characters/${entity.id}`, { method: 'PATCH', body: {
        name: `LIVE_NEW_NAME_${suffix}`, appearance: `LIVE_NEW_APPEARANCE_${suffix} orange helmet`,
      } })
      expect(patched.status).toBe(200)
      await uploadCharacter(entity.id, changedPng)
      const live = resolveEntity(ctx.db, userId, { kind: 'character', id: entity.id })
      expect(live.reference!.path).not.toBe(entity.reference!.path)
      expect(Buffer.from(ctx.mediaStore.readFile(live.reference!.path))).toEqual(changedPng)
    }
    const queued = enqueue(request)
    const stored = row(queued.id)
    expect(stored.status).toBe('queued')
    expect(stored.attempt_count).toBe(0)
    expect(JSON.parse(stored.character_references_json!)).toEqual(frozenEntities.map(entity => ({ path: entity.reference!.path, mime: 'image/png' })))
    expect(JSON.parse(stored.character_reference_json!)).toEqual({ path: primary.reference!.path, mime: 'image/png' })
    for (const reference of JSON.parse(stored.character_references_json!)) {
      expect(Buffer.from(ctx.mediaStore.readFile(reference.path))).toEqual(MOCK_PNG_BYTES)
      expect(sha256(ctx.mediaStore.readFile(reference.path))).toBe(sha256(MOCK_PNG_BYTES))
    }
    const snapshot = JSON.parse(stored.prompt_snapshot_json!)
    expect(snapshot.character).toMatchObject({ id: primary.id, name: primary.name, appearance: primary.description, hasReference: true })
    expect(snapshot.cast).toEqual([{ id: secondary.id, name: secondary.name, appearance: secondary.description }])
    expect(snapshot.contextDocuments).toEqual([contextDocument])
    expect(snapshot.entities).toEqual(frozenEntities.map(entity => expect.objectContaining({
      id: entity.id, kind: 'character', name: entity.name, revision: entity.revision, reference: entity.reference, referenceMode: 'sent',
    })))
    for (const entity of frozenEntities) {
      expect(stored.effective_prompt).toContain(entity.name)
      expect(stored.effective_prompt).toContain(entity.description)
      expect(stored.effective_prompt).toContain(`[character:${entity.id}]`)
    }
    expect(stored.effective_prompt).not.toContain('LIVE_NEW_NAME_')
    expect(stored.effective_prompt).not.toContain('LIVE_NEW_APPEARANCE_')
    expect(stored.effective_prompt).not.toContain('@character-')
    expect(JSON.stringify(request)).toBe(originalRequest)
    expect(counts()).toEqual({ generations: 1, grants: 0 })
  })

  it('renders two frozen same-label occurrences by their distinct item IDs after rename and handle reuse', () => {
    const original = createLibraryAsset(ctx.db, userId, { kind: 'item', name: 'Camera', description: 'Original vintage camera' })
    let document = appendMention({ version: 1, text: 'Compare ', mentions: [] }, original)
    document = updatePromptDocument(document, `${document.text} beside `)
    patchLibraryAsset(ctx.db, userId, original.id, { name: 'Renamed vintage camera' })
    updateEntityHandle(ctx.db, userId, { kind: 'item', id: original.id }, 'vintage-camera')
    const replacement = createLibraryAsset(ctx.db, userId, { kind: 'item', name: 'Camera', description: 'Replacement digital camera' })
    expect(replacement.handle).toBe(original.handle)
    expect(replacement.id).not.toBe(original.id)
    document = appendMention(document, replacement)
    document = updatePromptDocument(document, `${document.text}.`)
    expect(validatePromptDocument(document)).toEqual([])
    expect(document.text).toBe('Compare @camera beside @camera.')
    expect(document.mentions.map(mention => mention.label)).toEqual(['camera', 'camera'])
    expect(document.mentions[0]!.id).not.toBe(document.mentions[1]!.id)
    expect(document.mentions.map(mention => mention.entity.id)).toEqual([original.id, replacement.id])
    const stored = row(enqueue({ data: enqueueSchema.parse({ modelId: imageModel, prompt: document.text, promptDocument: document, params: {} }) }).id)
    expect(JSON.parse(stored.prompt_document_json!)).toEqual(document)
    expect(stored.prompt).toBe(document.text)
    expect(stored.effective_prompt).toContain(`Compare Renamed vintage camera [item:${original.id}] beside Camera [item:${replacement.id}].`)
    expect(stored.effective_prompt).not.toContain('@camera')
    expect(stored.effective_prompt!.match(/\[item:[^\]]+\]/g)).toEqual([`[item:${original.id}]`, `[item:${replacement.id}]`])
    expect(JSON.parse(stored.entity_references_json!).map((entity: CatalogEntity) => entity.id)).toEqual([original.id, replacement.id])
  })

  it.each([30 * 60 * 1000, 3 * 60 * 60 * 1000])('central temporary grants pin content and use max(2h, poll timeout + 15m) for timeout %i', async timeout => {
    ctx.env.APP_ORIGIN = 'https://studio.acme.com' // syntax validation only; never fetch this host
    ctx.env.VIDEO_POLL_TIMEOUT_MS = timeout
    const { providerId } = await seedProviderAndModel(ctx, 'video')
    const model = await call(ctx, '/api/models', { method: 'POST', body: { providerId, modelId: 'agnes-video-2.5-flash', kind: 'video' } })
    expect(model.status).toBe(201)
    const asset = saveLibraryAssetReference(ctx.db, ctx.env, ctx.mediaStore, userId,
      createLibraryAsset(ctx.db, userId, { kind: 'item', name: 'Grant camera' }).id, MOCK_PNG_BYTES)
    const document = documentFor([asset])
    const queued = enqueue({ data: enqueueSchema.parse({ modelId: model.body.model.id, prompt: document.text, promptDocument: document,
      allowTemporaryMedia: true, params: { mode: 'reference' } }) })
    const grants = ctx.db.prepare('SELECT * FROM temporary_media_grants WHERE generation_id=?').all(queued.id)
    expect(grants).toHaveLength(1)
    const grant = grants[0]!
    expect(grant.content_sha256).toBe(sha256(MOCK_PNG_BYTES))
    expect(grant.content_sha256).not.toBeNull()
    expect(Number(grant.expires_at) - Number(grant.created_at)).toBe(Math.max(DEFAULT_MEDIA_GRANT_TTL_MS, timeout + 15 * 60 * 1000))
    expect(grant.relative_path).toBe(asset.reference!.path)
    const params = JSON.parse(row(queued.id).params_json)
    expect(params.referenceImages).toHaveLength(1)
    const url = new URL(params.referenceImages[0])
    expect(url.origin).toBe('https://studio.acme.com')
    const localUrl = `${ctx.baseUrl}${url.pathname}`
    const first = await fetch(localUrl) // unauthenticated local GET; no provider calls
    expect(first.status).toBe(200)
    expect(Buffer.from(await first.arrayBuffer())).toEqual(MOCK_PNG_BYTES)
    const originalReader = ctx.mediaStore.readFile.bind(ctx.mediaStore)
    const forged = vi.spyOn(ctx.mediaStore, 'readFile').mockImplementation(path => path === asset.reference!.path ? changedPng : originalReader(path))
    try {
      expect((await sharp(changedPng).metadata()).format).toBe('png')
      expect((await fetch(localUrl)).status).toBe(404)
    } finally { forged.mockRestore() }
    expect((await fetch(localUrl)).status).toBe(200)
    expect(row(queued.id).attempt_count).toBe(0)
    expect(counts()).toEqual({ generations: 1, grants: 1 })
  })

  it.each(['promptDocument', 'contextDocuments'] as const)('rejects structurally valid cross-owner scene %s before persistence', async field => {
    const projectId = await project()
    const ownerCookie = ctx.cookie
    const other = await registerUser(ctx)
    const foreign = createLibraryAsset(ctx.db, other.userId, { kind: 'item', name: 'Foreign camera' })
    const document = documentFor([foreign])
    expect(validatePromptDocument(document)).toEqual([])
    ctx.cookie = ownerCookie
    const response = await call(ctx, `/api/projects/${projectId}/scenes`, { method: 'POST', body: {
      title: 'Rejected foreign draft', prompt: field === 'promptDocument' ? document.text : 'A quiet studio.',
      ...(field === 'promptDocument' ? { promptDocument: document } : { contextDocuments: [document] }),
    } })
    expect(response.status).toBe(400)
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM scenes WHERE project_id=?').get(projectId)!.n).toBe(0)
    expect(counts()).toEqual({ generations: 0, grants: 0 })
  })

  it.each(['trashed', 'purged'] as const)('persists an owned %s scene mention as a draft when the identity registry has a tombstone', async state => {
    const projectId = await project()
    const entity = createLibraryAsset(ctx.db, userId, { kind: 'item', name: 'Retired camera' })
    const document = documentFor([entity])
    softDeleteLibraryAsset(ctx.db, userId, entity.id)
    expect(ctx.db.prepare('SELECT * FROM entity_handles WHERE entity_id=? AND user_id=?').get(entity.id, userId))
      .toMatchObject({ active: 0, kind: 'item', entity_id: entity.id })
    if (state === 'purged') ctx.db.prepare('DELETE FROM library_assets WHERE id=?').run(entity.id)
    else expect(ctx.db.prepare('SELECT deleted_at FROM library_assets WHERE id=?').get(entity.id)!.deleted_at).not.toBeNull()
    const response = await call(ctx, `/api/projects/${projectId}/scenes`, { method: 'POST', body: {
      title: 'Owned retired draft', prompt: document.text, promptDocument: document, contextDocuments: [document],
    } })
    expect(response.status).toBe(201)
    const stored = ctx.db.prepare('SELECT * FROM scenes WHERE id=?').get(response.body.scene.id)!
    expect(JSON.parse(String(stored.prompt_document_json))).toEqual(document)
    expect(JSON.parse(String(stored.context_documents_json))).toEqual([document])
    expect(counts()).toEqual({ generations: 0, grants: 0 })
    // Draft retention is not permission to generate paid work from a deleted entity.
    expect(() => enqueue({ data: enqueueSchema.parse({ modelId: imageModel, projectId, prompt: document.text, promptDocument: document, params: {} }) })).toThrow()
    expect(counts()).toEqual({ generations: 0, grants: 0 })
  })
})
