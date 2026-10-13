import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'
import { createLibraryAsset, patchLibraryAsset, saveLibraryAssetReference, softDeleteLibraryAsset } from '../../server/entityLibrary/service'
import * as llm from '../../server/usage/llm'
import { entityPromptToken } from '../../server/planner/mentions'
import { insertPromptMention, updatePromptDocument, type PromptDocument } from '../../shared/promptMentions'
import { normalizeBlocking, type CastMember } from '../../server/planner/artifacts'

let ctx: TestContext
let userId: string
beforeAll(async () => { ctx = await startTestServer(); userId = (await registerUser(ctx)).userId })
afterAll(async () => { if (ctx) await ctx.close() })
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64')
function bound(id: string, kind: 'character' | 'item' | 'logo' = 'item'): PromptDocument {
  return insertPromptMention({ version: 1, text: 'Use ', mentions: [] }, 4, 4, { kind, id }, 'object', () => `binding-${id}`)
}
function frame(document: PromptDocument) { return { id: 'frame-a', title: 'Scene', action: document.text, context: 'Room', beats: '', shotNotes: '', backgroundPrompt: 'Room', dialogue: '', speaker: '', characters: [], durationSeconds: 8, blocking: [], mentionDocuments: { action: document } } }
async function session() {
  const { modelPk } = await seedProviderAndModel(ctx, 'image')
  const created = await call(ctx, '/api/plans', { method: 'POST', body: { kind: 'planner' } })
  expect(created.status).toBe(201)
  const id = created.body.session.id
  expect((await call(ctx, `/api/plans/${id}/setup`, { method: 'PATCH', body: { imageModelId: modelPk } })).status).toBe(200)
  return id as string
}

describe('Planner ID-bound mention documents', () => {
  it('saves exact script/field documents and rejects forged text or foreign IDs', async () => {
    const id = await session()
    const item = createLibraryAsset(ctx.db, userId, { kind: 'item', name: 'Object', description: 'red prop' })
    const document = bound(item.id)
    const saved = await call(ctx, `/api/plans/${id}/script`, { method: 'PUT', body: { text: document.text, promptDocument: document, scenes: [frame(document)] } })
    expect(saved.status).toBe(200)
    expect(saved.body.session.script.promptDocument).toEqual(document)
    expect(saved.body.session.script.scenes[0].mentionDocuments.action).toEqual(document)
    const bad = await call(ctx, `/api/plans/${id}/timeline`, { method: 'PUT', body: { frames: [{ ...frame(document), action: 'different' }] } })
    expect(bad.status).toBe(400)
    const foreign = bound('not-owned')
    expect((await call(ctx, `/api/plans/${id}/timeline`, { method: 'PUT', body: { frames: [frame(foreign)] } })).status).toBe(400)
    // Real cross-account identity (not merely a missing ID) also fails on save.
    const ownerCookie = ctx.cookie
    const other = await registerUser(ctx)
    const otherItem = createLibraryAsset(ctx.db, other.userId, { kind: 'item', name: 'Private object' })
    ctx.cookie = ownerCookie
    expect((await call(ctx, `/api/plans/${id}/timeline`, { method: 'PUT', body: { frames: [frame(bound(otherItem.id))] } })).status).toBe(400)
    expect((await call(ctx, `/api/plans/${id}/cast`, { method: 'PUT', body: { cast: [{ name: 'Foreign', reuseCharacterId: 'foreign-character' }] } })).status).toBe(400)
    const savedFrame = await call(ctx, `/api/plans/${id}/timeline`, { method: 'PUT', body: { frames: [frame(document)] } })
    expect(savedFrame.status).toBe(200)
    expect(savedFrame.body.session.timeline.frames[0].mentionDocuments.action).toEqual(document)
    // A legacy client changing text cannot accidentally retain a stale binding.
    const changed = { ...savedFrame.body.session.timeline.frames[0], action: 'Changed' }
    delete changed.mentionDocuments
    const result = await call(ctx, `/api/plans/${id}/timeline`, { method: 'PUT', body: { frames: [changed] } })
    expect(result.status).toBe(200)
    expect(result.body.session.timeline.frames[0].mentionDocuments.action).toEqual({ version: 1, text: 'Changed', mentions: [] })
  })

  it('blocks unbound/deleted single and batch generation while permitting drafts', async () => {
    const id = await session()
    const document: PromptDocument = { version: 1, text: 'Use @unknown', mentions: [] }
    expect((await call(ctx, `/api/plans/${id}/timeline`, { method: 'PUT', body: { frames: [frame(document)] } })).status).toBe(200)
    const count = Number((ctx.db.prepare('SELECT COUNT(*) AS n FROM generations').get() as { n: number }).n)
    expect((await call(ctx, `/api/plans/${id}/timeline/frame-a/background`, { method: 'POST' })).status).toBe(400)
    expect((await call(ctx, `/api/plans/${id}/image-batch`, { method: 'POST' })).status).toBe(400)
    expect(Number((ctx.db.prepare('SELECT COUNT(*) AS n FROM generations').get() as { n: number }).n)).toBe(count)
    const item = createLibraryAsset(ctx.db, userId, { kind: 'item', name: 'Deleted item' })
    const deletedDoc = bound(item.id)
    softDeleteLibraryAsset(ctx.db, userId, item.id)
    expect((await call(ctx, `/api/plans/${id}/timeline`, { method: 'PUT', body: { frames: [frame(deletedDoc)] } })).status).toBe(200)
    expect((await call(ctx, `/api/plans/${id}/timeline/frame-a/background`, { method: 'POST' })).status).toBe(404)
  })

  it('single and batch storyboard enqueue bound description/reference snapshots', async () => {
    const item = createLibraryAsset(ctx.db, userId, { kind: 'item', name: 'Stable item', description: 'bright purple glass bottle' })
    const entity = saveLibraryAssetReference(ctx.db, ctx.env, ctx.mediaStore, userId, item.id, png)
    const document = bound(item.id)
    for (const batch of [false, true]) {
      const id = await session()
      expect((await call(ctx, `/api/plans/${id}/timeline`, { method: 'PUT', body: { frames: [frame(document)] } })).status).toBe(200)
      const result = await call(ctx, batch ? `/api/plans/${id}/image-batch` : `/api/plans/${id}/timeline/frame-a/background`, { method: 'POST' })
      expect(result.status).toBe(202)
      const generationId = batch ? (ctx.db.prepare('SELECT generation_id FROM plan_image_batch_items WHERE batch_id = ?').get(result.body.batch.id) as { generation_id: string }).generation_id : result.body.generation.id
      const row = ctx.db.prepare('SELECT * FROM generations WHERE id = ?').get(generationId) as Record<string, any>
      expect(row.effective_prompt).toContain('bright purple glass bottle')
      expect(JSON.stringify(JSON.parse(row.prompt_snapshot_json))).toContain(item.id)
      expect(JSON.stringify(JSON.parse(row.prompt_snapshot_json))).toContain(entity.reference!.uploadId)
      ctx.db.prepare("UPDATE generations SET status = 'failed' WHERE id = ?").run(generationId)
    }
  })

  it('freezes description, revision and media before delayed batch items start', async () => {
    const id = await session()
    const item = createLibraryAsset(ctx.db, userId, { kind: 'item', name: 'Batch frozen object', description: 'original copper kettle', continuityNotes: 'keep the blue handle' })
    const original = saveLibraryAssetReference(ctx.db, ctx.env, ctx.mediaStore, userId, item.id, png)
    const document = bound(item.id)
    expect((await call(ctx, `/api/plans/${id}/timeline`, { method: 'PUT', body: { frames: [frame(document), { ...frame(document), id: 'frame-b', title: 'Second' }] } })).status).toBe(200)
    const created = await call(ctx, `/api/plans/${id}/image-batch`, { method: 'POST' })
    expect(created.status).toBe(202)
    const items = ctx.db.prepare('SELECT id, generation_id, snapshot_json FROM plan_image_batch_items WHERE batch_id = ? ORDER BY position').all(created.body.batch.id) as Array<{ id: string; generation_id: string | null; snapshot_json: string }>
    const frozen = JSON.parse(items[1]!.snapshot_json).resolvedContextEntities
    expect(frozen).toEqual([original])
    patchLibraryAsset(ctx.db, userId, item.id, { description: 'changed green mug', continuityNotes: 'new red handle' })
    const changed = saveLibraryAssetReference(ctx.db, ctx.env, ctx.mediaStore, userId, item.id, png)
    expect(changed.reference!.path).not.toBe(original.reference!.path)
    ctx.db.prepare("UPDATE generations SET status = 'failed' WHERE id = ?").run(items[0]!.generation_id)
    expect((await call(ctx, `/api/plans/${id}/image-batch/${created.body.batch.id}`)).status).toBe(200)
    const queued = ctx.db.prepare('SELECT g.* FROM generations g JOIN plan_image_batch_items i ON i.generation_id = g.id WHERE i.id = ?').get(items[1]!.id) as Record<string, any>
    expect(queued).toBeTruthy()
    expect(queued.effective_prompt).toContain('original copper kettle')
    expect(queued.effective_prompt).toContain('keep the blue handle')
    expect(queued.effective_prompt).not.toContain('changed green mug')
    expect(JSON.parse(queued.prompt_snapshot_json).entities).toContainEqual(expect.objectContaining({ id: item.id, revision: original.revision }))
    expect(queued.prompt_snapshot_json).toContain(original.reference!.path)
    expect(queued.prompt_snapshot_json).not.toContain(changed.reference!.path)
    const retained = JSON.parse((ctx.db.prepare('SELECT snapshot_json FROM plan_image_batch_items WHERE id = ?').get(items[1]!.id) as { snapshot_json: string }).snapshot_json)
    expect(retained.resolvedContextEntities).toEqual(frozen)
    ctx.db.prepare("UPDATE generations SET status = 'failed' WHERE id = ?").run(queued.id)
  })

  it('LLM consumes explicit resolved script entities and transfers only preserved ID tokens', async () => {
    const id = await session()
    const provider = await call(ctx, '/api/providers', { method: 'POST', body: { name: 'Planner text', baseUrl: 'https://llm.mock.test/v1', apiKey: 'sk-test-key' } })
    const model = await call(ctx, '/api/models', { method: 'POST', body: { providerId: provider.body.provider.id, modelId: 'mock-chat-model', kind: 'llm' } })
    expect((await call(ctx, `/api/plans/${id}/setup`, { method: 'PATCH', body: { chatModelId: model.body.model.id } })).status).toBe(200)
    const item = createLibraryAsset(ctx.db, userId, { kind: 'item', name: 'Context vessel', description: 'a silver vessel with emerald rim', continuityNotes: 'never change the rim' })
    const logo = createLibraryAsset(ctx.db, userId, { kind: 'logo', name: 'Context mark', description: 'an orange triangular brand mark' })
    const unused = createLibraryAsset(ctx.db, userId, { kind: 'item', name: 'Unused object', description: 'unrelated pink bicycle' })
    const character = await call(ctx, '/api/shared-characters', { method: 'POST', body: { name: 'Explicit actor', appearance: 'wears an ivory jacket', voice: {} } })
    const selectedCharacter = { kind: 'character' as const, id: character.body.character.id }
    let document = bound(item.id)
    document = updatePromptDocument(document, document.text + ' ')
    document = insertPromptMention(document, document.text.length, document.text.length, { kind: logo.kind, id: logo.id }, logo.handle)
    document = updatePromptDocument(document, document.text + ' ')
    document = insertPromptMention(document, document.text.length, document.text.length, selectedCharacter, 'actor')
    const scriptSaved = await call(ctx, `/api/plans/${id}/script`, { method: 'PUT', body: { text: document.text, promptDocument: document, scenes: [] } })
    expect(scriptSaved.status, JSON.stringify(scriptSaved.body)).toBe(200)
    const spy = vi.spyOn(llm, 'runLoggedLlm').mockResolvedValue(JSON.stringify({ reply: 'Ready', characters: [], scenes: [{ title: 'Bound scene', action: `Present ${entityPromptToken(item)}`, background: 'Room', durationSeconds: 8 }, { title: 'Unbound scene', action: 'An empty room', background: 'Room', durationSeconds: 8 }] }))
    try {
      expect((await call(ctx, `/api/plans/${id}/cast`, { method: 'POST' })).status).toBe(200)
      const castPrompt = spy.mock.calls[0]![0].messages.find(message => message.role === 'system')!.content
      expect(castPrompt).toContain(item.description)
      expect(castPrompt).toContain(item.continuityNotes)
      expect(castPrompt).toContain(logo.description)
      expect(castPrompt).toContain('wears an ivory jacket')
      expect(castPrompt).toContain(entityPromptToken(item))
      expect(castPrompt).not.toContain(unused.description)
      const timeline = await call(ctx, `/api/plans/${id}/timeline`, { method: 'POST' })
      expect(timeline.status).toBe(200)
      const boundFrame = timeline.body.session.timeline.frames[0]
      expect(boundFrame.action).toContain(`@${item.handle}`)
      expect(boundFrame.mentionDocuments.action.mentions[0].entity).toEqual({ kind: 'item', id: item.id })
      expect(timeline.body.session.timeline.frames[1].mentionDocuments).toBeUndefined()
      const generated = await call(ctx, `/api/plans/${id}/timeline/${boundFrame.id}/background`, { method: 'POST' })
      expect(generated.status).toBe(202)
      const snapshot = (ctx.db.prepare('SELECT prompt_snapshot_json FROM generations WHERE id = ?').get(generated.body.generation.id) as { prompt_snapshot_json: string }).prompt_snapshot_json
      expect(snapshot).toContain(item.id)
      expect(snapshot).not.toContain(logo.id)
      expect(snapshot).not.toContain(selectedCharacter.id)
      ctx.db.prepare("UPDATE generations SET status = 'failed' WHERE id = ?").run(generated.body.generation.id)
      spy.mockClear()
      const unbound: PromptDocument = { version: 1, text: 'Use @missing', mentions: [] }
      expect((await call(ctx, `/api/plans/${id}/script`, { method: 'PUT', body: { text: unbound.text, promptDocument: unbound, scenes: [] } })).status).toBe(200)
      expect((await call(ctx, `/api/plans/${id}/cast`, { method: 'POST' })).status).toBe(400)
      expect((await call(ctx, `/api/plans/${id}/timeline`, { method: 'POST' })).status).toBe(400)
      expect(spy).not.toHaveBeenCalled()
      softDeleteLibraryAsset(ctx.db, userId, logo.id)
      const deleted = bound(logo.id, 'logo')
      expect((await call(ctx, `/api/plans/${id}/script`, { method: 'PUT', body: { text: deleted.text, promptDocument: deleted, scenes: [] } })).status).toBe(200)
      expect((await call(ctx, `/api/plans/${id}/cast`, { method: 'POST' })).status).toBe(404)
      expect(spy).not.toHaveBeenCalled()
    } finally { spy.mockRestore() }
  })

  it('apply preserves context docs and cast/speaker IDs without library name auto reuse', async () => {
    const id = await session()
    const existing = await call(ctx, '/api/shared-characters', { method: 'POST', body: { name: 'Same', appearance: 'original', voice: {} } })
    expect(existing.status).toBe(201)
    const member = { id: 'cast-one', name: 'Same', appearance: 'new', role: '', voice: {}, storage: 'library', reuseCharacterId: null }
    expect((await call(ctx, `/api/plans/${id}/cast`, { method: 'PUT', body: { cast: [member] } })).status).toBe(200)
    const item = createLibraryAsset(ctx.db, userId, { kind: 'item', name: 'Apply item' })
    const document = bound(item.id)
    const scene = { ...frame(document), speaker: 'Same', speakerCastId: member.id, characters: ['Same'], blocking: [{ castId: member.id, action: '', expression: '', position: 'center' }] }
    expect((await call(ctx, `/api/plans/${id}/timeline`, { method: 'PUT', body: { frames: [scene] } })).status).toBe(200)
    const result = await call(ctx, `/api/plans/${id}/apply`, { method: 'POST', body: { newProjectName: 'Mentions project' } })
    expect(result.status).toBe(201)
    const row = ctx.db.prepare('SELECT character_id, context_documents_json FROM scenes WHERE id = ?').get(result.body.scenes[0].id) as { character_id: string; context_documents_json: string }
    expect(row.character_id).not.toBe(existing.body.character.id)
    expect(JSON.parse(row.context_documents_json)).toContainEqual(document)
  })

  it('explicitly reused character retains its existing portrait when planner applies', async () => {
    const id = await session()
    const created = await call(ctx, '/api/shared-characters', { method: 'POST', body: { name: 'Reused', appearance: 'original', voice: {} } })
    const characterId = created.body.character.id
    const reference = ctx.mediaStore.saveCharacterReference({ userId, characterId, bytes: png, maxBytes: ctx.env.MAX_REFERENCE_BYTES })
    ctx.db.prepare('UPDATE characters SET reference_path = ?, reference_mime = ?, reference_bytes = ? WHERE id = ?').run(reference.relativePath, reference.mimeType, reference.byteSize, characterId)
    const member = { id: 'reuse-cast', name: 'Reused', appearance: 'planner variant', role: '', voice: {}, storage: 'library', reuseCharacterId: characterId }
    expect((await call(ctx, `/api/plans/${id}/cast`, { method: 'PUT', body: { cast: [member] } })).status).toBe(200)
    const item = createLibraryAsset(ctx.db, userId, { kind: 'item', name: 'Other portrait' })
    const entity = saveLibraryAssetReference(ctx.db, ctx.env, ctx.mediaStore, userId, item.id, png)
    const stored = ctx.db.prepare('SELECT cast_json FROM plan_sessions WHERE id = ?').get(id) as { cast_json: string }
    const cast = JSON.parse(stored.cast_json)
    cast[0].portrait = { uploadId: entity.reference!.uploadId }
    if (cast[0].variants) for (const variant of cast[0].variants) variant.portrait = cast[0].portrait
    ctx.db.prepare('UPDATE plan_sessions SET cast_json = ? WHERE id = ?').run(JSON.stringify(cast), id)
    const scene = { ...frame({ version: 1, text: 'Walk', mentions: [] }), speakerCastId: member.id, characters: ['Reused'], blocking: [{ castId: member.id, action: '', expression: '', position: 'center' }] }
    expect((await call(ctx, `/api/plans/${id}/timeline`, { method: 'PUT', body: { frames: [scene] } })).status).toBe(200)
    const applied = await call(ctx, `/api/plans/${id}/apply`, { method: 'POST', body: {} })
    expect(applied.status).toBe(201)
    expect((ctx.db.prepare('SELECT reference_path FROM characters WHERE id = ?').get(characterId) as { reference_path: string }).reference_path).toBe(reference.relativePath)
    expect((ctx.db.prepare('SELECT character_id FROM scenes WHERE id = ?').get(applied.body.scenes[0].id) as { character_id: string }).character_id).toBe(characterId)
  })

  it('AI timeline preserves explicit cast IDs even when local names are duplicates', async () => {
    const id = await session()
    const provider = await call(ctx, '/api/providers', { method: 'POST', body: { name: 'IDs LLM', baseUrl: 'https://ids.mock.test/v1', apiKey: 'sk-test-key' } })
    const model = await call(ctx, '/api/models', { method: 'POST', body: { providerId: provider.body.provider.id, modelId: 'mock-chat-model', kind: 'llm' } })
    await call(ctx, `/api/plans/${id}/setup`, { method: 'PATCH', body: { chatModelId: model.body.model.id } })
    expect((await call(ctx, `/api/plans/${id}/script`, { method: 'PUT', body: { text: 'Two actors in a room', scenes: [] } })).status).toBe(200)
    const cast = ['cast-a', 'cast-b'].map(id => ({ id, name: 'Same', appearance: id, voice: {}, storage: 'library' }))
    expect((await call(ctx, `/api/plans/${id}/cast`, { method: 'PUT', body: { cast } })).status).toBe(200)
    const spy = vi.spyOn(llm, 'runLoggedLlm').mockResolvedValue(JSON.stringify({ reply: 'Ready', scenes: [{ title: 'Same-name scene', action: 'Wave', background: 'Room', speaker: 'Same', speakerCastId: 'cast-b', characters: ['Same'], blocking: [{ castId: 'cast-b', name: 'Same', action: 'waves right hand', expression: 'smiles', position: 'right' }], durationSeconds: 8 }] }))
    try {
      const result = await call(ctx, `/api/plans/${id}/timeline`, { method: 'POST' })
      expect(result.status).toBe(200)
      expect(result.body.session.timeline.frames[0].speakerCastId).toBe('cast-b')
      expect(result.body.session.timeline.frames[0].blocking).toEqual([expect.objectContaining({ castId: 'cast-b', action: 'waves right hand' })])
      expect(spy.mock.calls[0]![0].messages[0]!.content).toContain('speakerCastId')
    } finally { spy.mockRestore() }
  })

  it('normalizes duplicate local names only through explicit cast IDs', () => {
    const cast = [{ id: 'a', name: 'Same' }, { id: 'b', name: 'Same' }] as CastMember[]
    const aligned = normalizeBlocking({ blocking: [{ castId: 'b' }], speaker: 'Same', speakerCastId: 'b' }, cast)
    expect(aligned.speakerCastId).toBe('b')
    expect(aligned.blocking[0]?.castId).toBe('b')
    expect(normalizeBlocking({ characters: ['Same'], speaker: 'Same' }, cast).blocking).toEqual([])
  })
})
