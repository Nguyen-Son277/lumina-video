import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { await ctx.close() })

describe('legacy Timeline Canvas initialization HTTP contract', () => {
  it('requires explicit confirmation, preserves legacy artifacts, links once, and isolates owners', async () => {
    await registerUser(ctx)
    const provider = await call(ctx, '/api/providers', { method: 'POST', body: { name: 'Timeline LLM', baseUrl: 'https://llm.mock.test/v1', apiKey: 'sk-llm-abcd1234' } })
    expect(provider.status).toBe(201)
    const chat = await call(ctx, '/api/models', { method: 'POST', body: { providerId: provider.body.provider.id, modelId: 'mock-chat-model', kind: 'llm' } })
    expect(chat.status).toBe(201)
    const { modelPk: imageModelId } = await seedProviderAndModel(ctx, 'image')
    const { modelPk: videoModelId } = await seedProviderAndModel(ctx, 'video')
    const created = await call(ctx, '/api/plans', { method: 'POST', body: { kind: 'planner' } })
    expect(created.status).toBe(201)
    const sessionId = created.body.session.id as string
    const root = `/api/plans/${sessionId}`
    expect((await call(ctx, `${root}/setup`, { method: 'PATCH', body: { chatModelId: chat.body.model.id, imageModelId, videoModelId } })).status).toBe(200)
    expect((await call(ctx, `${root}/messages`, { method: 'POST', body: { content: 'Làm video ngắn về một chuyến đi của hai người bạn.', target: 'script' } })).status).toBe(200)
    for (const action of ['script', 'cast', 'timeline']) expect((await call(ctx, `${root}/${action}`, { method: 'POST' })).status).toBe(200)
    const applied = await call(ctx, `${root}/apply`, { method: 'POST', body: { modelId: videoModelId, autoGenerate: false } })
    expect(applied.status).toBe(201)
    const projectId = applied.body.project.id as string
    const canvasRoot = `/api/projects/${projectId}/canvas`
    const before = (await call(ctx, canvasRoot)).body.canvas
    const oldSceneIds = (ctx.db.prepare('SELECT id FROM scenes WHERE project_id=?').all(projectId) as { id: string }[]).map(row => row.id)
    expect(oldSceneIds.length).toBeGreaterThan(0)
    const legacyNodeIds = before.graph.nodes.map((node: { id: string }) => node.id)
    ctx.db.prepare('DELETE FROM timeline_canvas_sessions WHERE session_id=?').run(sessionId)
    expect((await call(ctx, root)).body.session.canvasLinked).toBe(false)
    expect((await call(ctx, `${root}/canvas/initialize`, { method: 'POST', body: { confirmed: false } })).status).toBe(400)
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM scenes WHERE project_id=?').get(projectId)!.n).toBe(oldSceneIds.length)
    const initialized = await call(ctx, `${root}/canvas/initialize`, { method: 'POST', body: { confirmed: true } })
    expect(initialized.status).toBe(201)
    expect(initialized.body.session.projectId).toBe(projectId)
    expect(initialized.body.session.canvasLinked).toBe(true)
    const after = (await call(ctx, canvasRoot)).body.canvas
    expect(after.graph.groups.length).toBeGreaterThan(before.graph.groups.length)
    expect(after.graph.nodes.map((node: { id: string }) => node.id)).toEqual(expect.arrayContaining(legacyNodeIds))
    const sceneIds = (ctx.db.prepare('SELECT id FROM scenes WHERE project_id=?').all(projectId) as { id: string }[]).map(row => row.id)
    expect(sceneIds.length).toBeGreaterThan(oldSceneIds.length)
    expect(sceneIds).toEqual(expect.arrayContaining(oldSceneIds))
    expect((await call(ctx, `${root}/canvas/initialize`, { method: 'POST', body: { confirmed: true } })).status).toBe(200)
    expect((await call(ctx, canvasRoot)).body.canvas).toEqual(after)
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM scenes WHERE project_id=?').get(projectId)!.n).toBe(sceneIds.length)
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM generations').get()!.n).toBe(0)
    await registerUser(ctx)
    expect((await call(ctx, `${root}/canvas/initialize`, { method: 'POST', body: { confirmed: true } })).status).toBe(404)
  })
})
