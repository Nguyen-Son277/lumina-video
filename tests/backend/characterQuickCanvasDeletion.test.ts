import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, startTestServer, type TestContext } from './helpers'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { if (ctx) await ctx.close() })

describe('character deletion with quick canvas references', () => {
  it.each(['node', 'mention'])('blocks deletion and detach for a quick %s, then allows it after removal', async kind => {
    const { userId } = await registerUser(ctx)
    const character = (await call(ctx, '/api/shared-characters', { method: 'POST', body: { name: 'Quick character', appearance: 'blue coat' } })).body.character
    const session = (await call(ctx, '/api/quick-sessions', { method: 'POST', body: { title: 'Logo review session' } })).body.session
    expect(session?.id).toBeTruthy()
    const graph = { schemaVersion: 1, nodes: [kind === 'node'
      ? { id: 'character-node', kind: 'character', x: 0, y: 0, data: { sourceId: character.id } }
      : { id: 'prompt-node', kind: 'prompt', x: 0, y: 0, data: { text: '@person', promptDocument: { version: 1, text: '@person', mentions: [{ id: 'mention', start: 0, end: 7, label: 'person', entity: { kind: 'character', id: character.id } }] } } }], edges: [] }
    ctx.db.prepare('INSERT INTO quick_canvases(session_id,user_id,graph_json,revision,created_at,updated_at) VALUES(?,?,?,1,?,?)').run(session.id,userId,JSON.stringify(graph),Date.now(),Date.now())
    for (const suffix of ['', '?detach=1']) {
      const result = await call(ctx, `/api/shared-characters/${character.id}${suffix}`, { method: 'DELETE' })
      expect(result.status, JSON.stringify(result.body)).toBe(400)
      expect(result.body.error.messageKey).toBe('characters.in_use')
      expect(result.body.error.details.usage.quickCanvas).toEqual([{ sessionId: session.id, sessionTitle: 'Logo review session', nodeId: graph.nodes[0]!.id }])
      expect(result.body.error.message).toContain('Canvas phiên')
      expect(ctx.db.prepare('SELECT deleted_at FROM characters WHERE id=?').get(character.id)).toMatchObject({ deleted_at: null })
    }
    expect((await call(ctx, `/api/quick-sessions/${session.id}/canvas`)).status).toBe(200)
    const cleared = await call(ctx, `/api/quick-sessions/${session.id}/canvas`, { method: 'PUT', body: { baseRevision: 1, graph: { schemaVersion: 1, nodes: [], edges: [] } } })
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200)
    expect((await call(ctx, `/api/shared-characters/${character.id}?detach=1`, { method: 'DELETE' })).status).toBe(204)
  })
})
