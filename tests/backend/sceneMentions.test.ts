import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PromptDocument } from '../../shared/promptMentions'
import { sceneGenerationContext } from '../../server/projects/service'
import { sweepAutoGenerate } from '../../server/generations/sweeper'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { if (ctx) await ctx.close() })

function document(text: string, entityId?: string): PromptDocument {
  return { version: 1, text, mentions: entityId ? [{ id: 'binding-1', start: 0, end: 3, label: 'an', entity: { kind: 'character', id: entityId } }] : [] }
}
async function setup() {
  const { userId } = await registerUser(ctx)
  const { modelPk } = await seedProviderAndModel(ctx, 'video')
  const project = (await call(ctx, '/api/projects', { method: 'POST', body: { name: 'Mention studio' } })).body.project
  const character = (await call(ctx, '/api/shared-characters', { method: 'POST', body: { name: 'An', appearance: 'Blue jacket', voice: {} } })).body.character
  const create = (body: Record<string, unknown>) => call(ctx, `/api/projects/${project.id}/scenes`, { method: 'POST', body: { title: 'Scene', modelId: modelPk, ...body } })
  const patch = (id: string, body: Record<string, unknown>) => call(ctx, `/api/projects/${project.id}/scenes/${id}`, { method: 'PATCH', body })
  return { userId, project, character, create, patch }
}

describe('Scene mention document integration', () => {
  it('round-trips identity-bound documents and exposes generation context', async () => {
    const { userId, character, create, patch } = await setup()
    const promptDocument = document('@an walks', character.id)
    const contextDocuments = [document('@an in frame', character.id)]
    const result = await create({ prompt: promptDocument.text, promptDocument, contextDocuments })
    expect(result.status).toBe(201)
    expect(result.body.scene.promptDocument).toEqual(promptDocument)
    expect(result.body.scene.contextDocuments).toEqual(contextDocuments)
    const context = sceneGenerationContext(ctx.db, userId, result.body.scene.id)
    expect(context.promptDocument).toEqual(promptDocument)
    expect(context.contextDocuments).toEqual(contextDocuments)
    const titleOnly = await patch(result.body.scene.id, { title: 'Renamed scene' })
    expect(titleOnly.body.scene.promptDocument).toEqual(promptDocument)
    expect(titleOnly.body.scene.contextDocuments).toEqual(contextDocuments)
  })

  it('allows unresolved drafts but rejects malformed spans and mismatched text before saving', async () => {
    const { create } = await setup()
    const unresolved = document('@unknown walks')
    const saved = await create({ prompt: unresolved.text, promptDocument: unresolved })
    expect(saved.status).toBe(201)
    expect((await call(ctx, `/api/scenes/${saved.body.scene.id}/preview-prompt`, { method: 'POST' })).status).toBe(400)
    expect((await create({ prompt: 'different text', promptDocument: unresolved })).status).toBe(400)
    const malformed = { ...unresolved, mentions: [{ id: 'b', start: 0, end: 4, label: 'unknown', entity: { kind: 'character', id: 'missing' } }] }
    expect((await create({ prompt: unresolved.text, promptDocument: malformed })).status).toBe(400)
    expect((await create({ prompt: 'ordinary scene', contextDocuments: [malformed] })).status).toBe(400)
  })

  it('drops bindings on raw prompt edits and keeps legacy prompts nullable', async () => {
    const { character, create, patch } = await setup()
    const legacy = await create({ prompt: 'plain legacy prompt' })
    expect(legacy.body.scene.promptDocument).toBeNull()
    expect(legacy.body.scene.contextDocuments).toEqual([])
    const original = document('@an walks', character.id)
    const result = await create({ prompt: original.text, promptDocument: original })
    const changed = await patch(result.body.scene.id, { prompt: '@an runs' })
    expect(changed.status).toBe(200)
    expect(changed.body.scene.promptDocument).toEqual(document('@an runs'))
    expect((await call(ctx, `/api/scenes/${result.body.scene.id}/preview-prompt`, { method: 'POST' })).status).toBe(400)
    const mismatch = await patch(result.body.scene.id, { prompt: 'new text', promptDocument: original })
    expect(mismatch.status).toBe(400)
    expect((await patch(result.body.scene.id, { promptDocument: null })).body.scene.promptDocument).toBeNull()
  })

  it('exposes planner params fallback and migrates it when saved without losing documents', async () => {
    const { userId, character, create, patch } = await setup()
    const contextDocuments = [document('@an waits', character.id)]
    const result = await create({ prompt: 'planner generated scene', params: { contextDocuments, seconds: '5' } })
    // Simulate planner apply's INSERT path before it writes canonical document columns.
    ctx.db.prepare("UPDATE scenes SET context_documents_json='[]',params_json=? WHERE id=?").run(JSON.stringify({ contextDocuments, seconds: '5' }), result.body.scene.id)
    expect((await call(ctx, `/api/projects/${result.body.scene.projectId}/scenes/${result.body.scene.id}`)).body.scene.contextDocuments).toEqual(contextDocuments)
    expect(sceneGenerationContext(ctx.db, userId, result.body.scene.id).contextDocuments).toEqual(contextDocuments)
    const changed = await patch(result.body.scene.id, { params: { seconds: '8' } })
    expect(changed.body.scene.contextDocuments).toEqual(contextDocuments)
    const cleared = await patch(result.body.scene.id, { contextDocuments: [] })
    expect(cleared.body.scene.contextDocuments).toEqual([])
    expect(cleared.body.scene.params.contextDocuments).toBeUndefined()
  })

  it('sweeper carries binding and context documents through central enqueue', async () => {
    const { character, create } = await setup()
    const promptDocument = document('@an moves', character.id)
    const contextDocuments = [document('@an waits', character.id)]
    const scene = (await create({ prompt: promptDocument.text, promptDocument, contextDocuments, approved: true, autoGenerate: true })).body.scene
    expect(sweepAutoGenerate({ db: ctx.db, env: ctx.env, worker: ctx.worker })).toBe(1)
    const row = ctx.db.prepare('SELECT prompt_document_json,effective_prompt,prompt_snapshot_json FROM generations WHERE scene_id=?').get(scene.id) as { prompt_document_json: string; effective_prompt: string; prompt_snapshot_json: string }
    expect(JSON.parse(row.prompt_document_json)).toEqual(promptDocument)
    expect(row.effective_prompt).toContain('Blue jacket')
    expect(JSON.parse(row.prompt_snapshot_json).contextDocuments).toEqual(expect.arrayContaining(contextDocuments))
  })

  it('previews current entity descriptions by ID, not frozen display names', async () => {
    const { character, create } = await setup()
    const promptDocument = document('@an smiles', character.id)
    const scene = (await create({ prompt: promptDocument.text, promptDocument })).body.scene
    await call(ctx, `/api/shared-characters/${character.id}`, { method: 'PATCH', body: { name: 'Renamed', appearance: 'Red jacket' } })
    const preview = await call(ctx, `/api/scenes/${scene.id}/preview-prompt`, { method: 'POST' })
    expect(preview.status).toBe(200)
    expect(preview.body.effectivePrompt).toContain('Red jacket')
    expect(preview.body.effectivePrompt).toContain('Renamed')
    const persisted = (await call(ctx, `/api/projects/${scene.projectId}/scenes/${scene.id}`)).body.scene
    expect(persisted.promptDocument.mentions[0].entity.id).toBe(character.id)
    expect(persisted.promptDocument.mentions[0].label).toBe('an')
    expect(preview.body.effectivePrompt).not.toContain('A reference image')
    expect(ctx.db.prepare('SELECT COUNT(*) AS count FROM generations WHERE scene_id=?').get(scene.id)).toEqual({ count: 0 })
  })
})
