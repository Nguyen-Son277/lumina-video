import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'
import { insertPromptMention, type PromptDocument } from '../../shared/promptMentions'
import type { CanvasGraph } from '../../shared/canvas'
import { MOCK_PNG_BYTES } from '../../server/generations/adapters/mock'
import { compileCanvasPrompt, buildAliasIndex } from '../../server/canvas/compiler'
import { resolveCanvasObjects } from '../../server/canvas/resolve'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { await ctx.close() })
async function setup() {
  await registerUser(ctx)
  const project = (await call(ctx, '/api/projects', { method: 'POST', body: { name: 'Bound Canvas' } })).body.project
  const asset = (await call(ctx, '/api/entity-library/assets', { method: 'POST', body: { kind: 'item', name: 'Bottle', description: 'original gold bottle' } })).body.asset
  const { modelPk } = await seedProviderAndModel(ctx, 'image')
  const document = insertPromptMention({ version: 1, text: '', mentions: [] }, 0, 0, { kind: 'item', id: asset.id }, asset.handle, () => 'binding-1')
  return { projectId: project.id as string, asset, modelPk, document }
}
function graph(modelId: string, document: PromptDocument): CanvasGraph {
  return { schemaVersion: 1, nodes: [
    { id: 'p', kind: 'prompt', x: 0, y: 0, data: { text: document.text, promptDocument: document } },
    { id: 'g', kind: 'image', x: 300, y: 0, data: { modelId } },
  ], edges: [{ id: 'e', source: 'p', sourcePort: 'prompt', target: 'g', targetPort: 'prompt' }] }
}
async function save(projectId: string, graph: CanvasGraph, baseRevision = 0) {
  const result = await call(ctx, `/api/projects/${projectId}/canvas`, { method: 'PUT', body: { graph, baseRevision } })
  expect(result.status, JSON.stringify(result.body)).toBe(200)
  return result
}
async function preview(projectId: string) {
  const result = await call(ctx, `/api/projects/${projectId}/canvas/nodes/g/preview`, { method: 'POST', body: { kind: 'image' } })
  expect(result.status, JSON.stringify(result.body)).toBe(200)
  return result.body.preview
}
describe('Canvas identity-bound account mentions', () => {
  it('binds an account item without graph edges, persists lifecycle links and keeps exact document in generation', async () => {
    const { projectId, asset, modelPk, document } = await setup()
    await save(projectId, graph(modelPk, document))
    const link = ctx.db.prepare('SELECT library_asset_id, role FROM project_canvas_links WHERE project_id=? AND node_id=?').get(projectId, 'p') as any
    expect(link).toMatchObject({ library_asset_id: asset.id, role: 'library' })
    const before = await preview(projectId)
    expect(before.unresolved).toEqual([])
    expect(before.prompt).toContain('original gold bottle')
    const run = await call(ctx, `/api/projects/${projectId}/canvas/nodes/g/run`, { method: 'POST', body: { kind: 'image', stamp: before.stamp } })
    expect(run.status, JSON.stringify(run.body)).toBe(202)
    const snapshot = JSON.parse((ctx.db.prepare('SELECT prompt_snapshot_json FROM generations WHERE id=?').get(run.body.generation.id) as any).prompt_snapshot_json)
    expect(snapshot.contextDocuments).toContainEqual(document)
    expect(snapshot.entities).toContainEqual(expect.objectContaining({ id: asset.id, kind: 'item' }))
  })
  it('rename/handle change keeps identity but invalidates an older preview stamp', async () => {
    const { projectId, asset, modelPk, document } = await setup()
    await save(projectId, graph(modelPk, document))
    const before = await preview(projectId)
    expect((await call(ctx, `/api/entity-library/assets/${asset.id}`, { method: 'PATCH', body: { name: 'Renamed Bottle', description: 'new blue bottle' } })).status).toBe(200)
    expect((await call(ctx, `/api/entity-library/item/${asset.id}/handle`, { method: 'PATCH', body: { handle: 'renamed-bottle' } })).status).toBe(200)
    const after = await preview(projectId)
    expect(after.stamp).not.toBe(before.stamp)
    expect(after.prompt).toContain('new blue bottle')
    expect(after.userText).toBe('@bottle')
    expect(after.unresolved).toEqual([])
    const stale = await call(ctx, `/api/projects/${projectId}/canvas/nodes/g/run`, { method: 'POST', body: { kind: 'image', stamp: before.stamp } })
    expect(stale.status).toBe(400)
    expect(stale.body.error.messageKey).toBe('canvas.preview_stale')
  })
  it('never replaces a missing ID with a recreated same-name/handle entity', async () => {
    const { projectId, asset, modelPk, document } = await setup()
    await save(projectId, graph(modelPk, document))
    const user = ctx.db.prepare('SELECT user_id FROM library_assets WHERE id=?').get(asset.id) as any
    // Simulate retained historical graph, without relying on deletion API policy.
    ctx.db.prepare('UPDATE library_assets SET deleted_at=?, revision=revision+1 WHERE id=?').run(Date.now(), asset.id)
    ctx.db.prepare('UPDATE entity_handles SET active=0 WHERE entity_id=?').run(asset.id)
    const replacement = (await call(ctx, '/api/entity-library/assets', { method: 'POST', body: { kind: 'item', name: 'Bottle', description: 'wrong replacement' } })).body.asset
    expect(replacement.id).not.toBe(asset.id)
    const after = await preview(projectId)
    expect(after.unresolved).toEqual(['bottle'])
    expect(after.prompt).not.toContain('wrong replacement')
    const blocked = await call(ctx, `/api/projects/${projectId}/canvas/nodes/g/run`, { method: 'POST', body: { kind: 'image', stamp: after.stamp } })
    expect(blocked.status).toBe(400)
    expect(blocked.body.error.messageKey).toBe('canvas.mention_unresolved')
    expect(user.user_id).toBeTruthy()
  })
  it('rejects raw legacy mentions instead of inferring from catalog names', async () => {
    const { projectId, modelPk } = await setup()
    const legacy = graph(modelPk, { version: 1, text: '@bottle', mentions: [] })
    delete legacy.nodes[0]!.data.promptDocument
    await save(projectId, legacy)
    expect((await preview(projectId)).unresolved).toEqual(['bottle'])
  })
  it('library node reference upload changes stamp and deduplicates same entity sources', async () => {
    const { projectId, asset, modelPk, document } = await setup()
    const board = graph(modelPk, document)
    board.nodes.push({ id: 'asset', kind: 'library', x: 0, y: 200, data: { sourceId: asset.id, entityKind: 'item' } })
    board.edges.push({ id: 'context', source: 'asset', sourcePort: 'object', target: 'g', targetPort: 'context' })
    await save(projectId, board)
    const first = await preview(projectId)
    const response = await fetch(`${ctx.baseUrl}/api/entity-library/assets/${asset.id}/reference`, { method: 'POST', headers: { Cookie: ctx.cookie, 'Content-Type': 'image/png' }, body: MOCK_PNG_BYTES })
    expect(response.status).toBe(201)
    const second = await preview(projectId)
    expect(second.stamp).not.toBe(first.stamp)
    expect(second.inputs).toHaveLength(1)
    expect(second.inputs[0].sent).toBe(true)
    expect(second.limits.sentImages).toBe(1)
    const aliases = (await call(ctx, `/api/projects/${projectId}/canvas`)).body.canvas.aliases
    expect(JSON.stringify(aliases)).not.toContain('relative_path')
    expect(JSON.stringify(aliases)).not.toContain('referenceIdentity')
  })
  it('video preview reports library image as description-only using central capabilities', async () => {
    const { projectId, asset, document } = await setup()
    const { modelPk } = await seedProviderAndModel(ctx, 'video')
    const scene = (await call(ctx, `/api/projects/${projectId}/scenes`, { method: 'POST', body: { title: 'Video', modelId: modelPk, prompt: 'Product scene' } })).body.scene
    const response = await fetch(`${ctx.baseUrl}/api/entity-library/assets/${asset.id}/reference`, { method: 'POST', headers: { Cookie: ctx.cookie, 'Content-Type': 'image/png' }, body: MOCK_PNG_BYTES })
    expect(response.status).toBe(201)
    const board = graph(modelPk, document)
    board.nodes[1]!.kind = 'video'
    board.nodes[1]!.data.sceneId = scene.id
    await save(projectId, board)
    const result = await call(ctx, `/api/projects/${projectId}/canvas/nodes/g/preview`, { method: 'POST', body: { kind: 'video' } })
    expect(result.status, JSON.stringify(result.body)).toBe(200)
    expect(result.body.preview.runnable).toBe(true)
    expect(result.body.preview.inputs).toHaveLength(1)
    expect(result.body.preview.inputs[0].sent).toBe(false)
    expect(result.body.preview.limits.sentImages).toBe(0)
    expect(result.body.preview.warnings.length).toBeGreaterThan(0)
  })
  it('rejects document/text mismatch and cross-account identities on save', async () => {
    const { projectId, modelPk, document } = await setup()
    const mismatch = graph(modelPk, document)
    mismatch.nodes[0]!.data.text = 'different'
    expect((await call(ctx, `/api/projects/${projectId}/canvas`, { method: 'PUT', body: { graph: mismatch, baseRevision: 0 } })).status).toBe(400)
    const foreign = graph(modelPk, { ...document, mentions: document.mentions.map(binding => ({ ...binding, entity: { ...binding.entity, id: 'foreign-id' } })) })
    expect((await call(ctx, `/api/projects/${projectId}/canvas`, { method: 'PUT', body: { graph: foreign, baseRevision: 0 } })).status).toBe(404)
  })
  it('uses the complete board alias index instead of regenerating aliases from a context subset', async () => {
    const { projectId, modelPk, document } = await setup()
    const board = graph(modelPk, document)
    const objects = resolveCanvasObjects(ctx.db, (ctx.db.prepare('SELECT user_id FROM projects WHERE id=?').get(projectId) as any).user_id, projectId, board)
    const compiled = compileCanvasPrompt({ graph: board, node: board.nodes[1]!, objects })
    expect(compiled.mentions[0]?.recordId).toBe(document.mentions[0]?.entity.id)
    expect(buildAliasIndex(objects)[0]?.alias).toBe('bottle')
    const local = [
      { nodeId: 'first', recordId: 'local-1', kind: 'item' as const, name: 'Bottle', description: 'unused first', continuityNotes: '', reference: null },
      { nodeId: 'second', recordId: 'local-2', kind: 'item' as const, name: 'Bottle', description: 'connected second', continuityNotes: '', reference: null },
    ]
    const plain = graph(modelPk, { version: 1, text: 'Product photo', mentions: [] })
    plain.edges.push({ id: 'context', source: 'second', sourcePort: 'object', target: 'g', targetPort: 'context' })
    const indexed = compileCanvasPrompt({ graph: plain, node: plain.nodes[1]!, objects: local })
    expect(indexed.mentions.map(entry => entry.alias)).toEqual(['Bottle2'])
  })
})
