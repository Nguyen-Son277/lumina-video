import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'
import { insertPromptMention, type PromptDocument } from '../../shared/promptMentions'
import { assertMentionsResolved, compileCanvasPrompt } from '../../server/canvas/compiler'
import type { CanvasGraph } from '../../shared/canvas'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { if (ctx) await ctx.close() })
const empty = (text = ''): PromptDocument => ({ version: 1, text, mentions: [] })

describe('# backend prompt integration', () => {
  it('round-trips selected hex handles and renders current entity identity in generation preview', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const asset = (await call(ctx, '/api/entity-library/assets', { method: 'POST', body: { kind: 'item', name: 'Bottle', description: 'Golden bottle' } })).body.asset
    expect((await call(ctx, `/api/entity-library/item/${asset.id}/handle`, { method: 'PATCH', body: { handle: 'abc' } })).status).toBe(200)
    const doc = insertPromptMention(empty('😀 '), 3, 3, { kind: 'item', id: asset.id }, 'abc', () => 'hex', '#')
    const session = await call(ctx, '/api/quick-sessions', { method: 'POST', body: { title: 'Hashes', promptDocument: doc } })
    expect(session.status).toBe(201)
    expect(session.body.session.promptDocument).toEqual(doc)
    expect((await call(ctx, `/api/quick-sessions/${session.body.session.id}`)).body.session.promptDocument).toEqual(doc)
    const preview = await call(ctx, '/api/generations/preview', { method: 'POST', body: { modelId: modelPk, prompt: doc.text, promptDocument: doc } })
    expect(preview.status, JSON.stringify(preview.body)).toBe(200)
    expect(JSON.stringify(preview.body)).toContain('Golden bottle')
    expect(JSON.stringify(preview.body)).toContain(`item:${asset.id}`)
  })

  it('rejects bound #character on persistence and unbound hashtags on generation', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const invalid: PromptDocument = { version: 1, text: '#lan', mentions: [{ id: 'bad', start: 0, end: 4, label: 'lan', entity: { kind: 'character', id: 'character' } }] }
    expect((await call(ctx, '/api/quick-sessions', { method: 'POST', body: { promptDocument: invalid } })).status).toBe(400)
    const raw = await call(ctx, '/api/generations/preview', { method: 'POST', body: { modelId: modelPk, prompt: '#unknown' } })
    expect(raw.status).toBe(400)
    expect(raw.body.error.message).toContain('#')
    const doc = await call(ctx, '/api/generations/preview', { method: 'POST', body: { modelId: modelPk, prompt: '#unknown', promptDocument: empty('#unknown') } })
    expect(doc.status).toBe(400)
    expect(doc.body.error.details.mentions).toContainEqual({ start: 0, end: 8, label: 'unknown', prefix: '#', reason: 'unbound' })
  })
})

describe('# compiler diagnostics', () => {
  function compile(doc: PromptDocument) {
    const graph: CanvasGraph = { schemaVersion: 1, nodes: [
      { id: 'p', kind: 'prompt', x: 0, y: 0, data: { text: doc.text, promptDocument: doc } },
      { id: 'g', kind: 'image', x: 300, y: 0, data: {} },
    ], edges: [{ id: 'edge', source: 'p', sourcePort: 'prompt', target: 'g', targetPort: 'prompt' }] }
    return compileCanvasPrompt({ graph, node: graph.nodes[1]!, objects: [] })
  }
  it('retains bare-label API and distinguishes missing prefixes in diagnostics', () => {
    const compiled = compile(empty('@unknown #unknown #prop'))
    expect(compiled.unresolved).toEqual(['unknown', 'prop'])
    expect(compiled.unresolvedTokens).toEqual(['@unknown', '#unknown', '#prop'])
    expect(() => assertMentionsResolved(compiled)).toThrow('@unknown, #unknown, #prop')
  })
  it('reports explicitly bound missing hex entities with #', () => {
    const compiled = compile(insertPromptMention(empty(), 0, 0, { kind: 'item', id: 'deleted' }, 'abc', () => 'hex', '#'))
    expect(compiled.unresolved).toEqual(['abc'])
    expect(compiled.unresolvedTokens).toEqual(['#abc'])
    expect(() => assertMentionsResolved(compiled)).toThrow('#abc')
  })
})
