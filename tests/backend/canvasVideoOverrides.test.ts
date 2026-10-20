import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CanvasGraph } from '../../shared/canvas'
import * as generationQueue from '../../server/generations/enqueue'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { await ctx.close() })

async function setup() {
  await registerUser(ctx)
  const project = await call(ctx, '/api/projects', { method: 'POST', body: { name: 'Canvas video overrides' } })
  expect(project.status).toBe(201)
  const projectId = project.body.project.id as string
  const { modelPk } = await seedProviderAndModel(ctx, 'video')
  ctx.db.prepare('UPDATE models SET model_id=?, video_api_style=? WHERE id=?').run('sora-upstream-name', 'openai', modelPk)
  const params = { size: '1920x1200', seconds: '19', useCharacterReference: false, customLegacyControl: 'preserve exactly' }
  const scene = await call(ctx, `/api/projects/${projectId}/scenes`, {
    method: 'POST', body: { title: 'Scene settings must not change', modelId: modelPk, prompt: 'Scene prompt', params },
  })
  expect(scene.status).toBe(201)
  const sceneId = scene.body.scene.id as string
  const graph: CanvasGraph = {
    schemaVersion: 1,
    nodes: [
      { id: 'p', kind: 'prompt', x: 0, y: 0, data: { text: 'A slow camera pan' } },
      { id: 'v', kind: 'video', x: 350, y: 0, data: { modelId: modelPk, sceneId } },
    ],
    edges: [{ id: 'pv', source: 'p', sourcePort: 'prompt', target: 'v', targetPort: 'prompt' }],
  }
  return { projectId, modelPk, sceneId, graph }
}

const save = (projectId: string, graph: CanvasGraph, baseRevision = 0) => call(ctx, `/api/projects/${projectId}/canvas`, { method: 'PUT', body: { graph, baseRevision } })
const preview = (projectId: string) => call(ctx, `/api/projects/${projectId}/canvas/nodes/v/preview`, { method: 'POST', body: { kind: 'video' } })
const run = (projectId: string, stamp: string) => call(ctx, `/api/projects/${projectId}/canvas/nodes/v/run`, { method: 'POST', body: { kind: 'video', stamp } })
function sceneParams(sceneId: string): string {
  return String(ctx.db.prepare('SELECT params_json FROM scenes WHERE id=?').get(sceneId)!.params_json)
}

describe('Canvas video node override integration', () => {
  it('allows unrelated graph edits with an unchanged disabled model but blocks execution', async () => {
    const s = await setup()
    s.graph.nodes[1]!.data.videoSettings = { modelId: s.modelPk, params: { seconds: '8' } }
    expect((await save(s.projectId, s.graph)).status).toBe(200)
    ctx.db.prepare('UPDATE models SET enabled=0 WHERE id=?').run(s.modelPk)
    s.graph.nodes[0]!.x = 80
    expect((await save(s.projectId, s.graph, 1)).status).toBe(200)
    expect((await preview(s.projectId)).body.preview.runnable).toBe(false)
    s.graph.nodes[1]!.data.videoSettings!.params.seconds = '12'
    expect((await save(s.projectId, s.graph, 2)).status).toBe(400)
  })
  it('roundtrips a local model binding, previews/runs its own controls, and leaves scene params unchanged', async () => {
    const s = await setup()
    const originalSceneParams = sceneParams(s.sceneId)
    const settings = { modelId: s.modelPk, params: { size: '720x1280', seconds: '12' } }
    s.graph.nodes[1]!.data.videoSettings = settings
    expect(s.modelPk).not.toBe('sora-upstream-name')
    expect((await save(s.projectId, s.graph)).status).toBe(200)
    const restored = await call(ctx, `/api/projects/${s.projectId}/canvas`)
    expect(restored.status).toBe(200)
    expect(restored.body.canvas.graph.nodes[1].data.videoSettings).toEqual(settings)

    // Preview has no public params field: observe the real central enqueue call,
    // without replacing it, to verify preview and run receive the same controls.
    const enqueue = vi.spyOn(generationQueue, 'enqueueGeneration')
    try {
      const p = await preview(s.projectId)
      expect(p.status).toBe(200)
      expect(p.body.preview.runnable).toBe(true)
      expect(enqueue.mock.calls.find(([input]) => input.previewOnly)?.[0].request.data).toMatchObject({ modelId: s.modelPk, params: settings.params })
      const result = await run(s.projectId, p.body.preview.stamp)
      expect(result.status).toBe(202)
      const generation = ctx.db.prepare('SELECT model_pk, params_json FROM generations WHERE id=?').get(result.body.generation.id)!
      expect(generation.model_pk).toBe(s.modelPk)
      expect(JSON.parse(String(generation.params_json))).toMatchObject(settings.params)
      expect(sceneParams(s.sceneId)).toBe(originalSceneParams)
    } finally { enqueue.mockRestore() }
  })

  it('blocks an old preview stamp after only node settings are edited, then accepts a fresh preview', async () => {
    const s = await setup()
    s.graph.nodes[1]!.data.videoSettings = { modelId: s.modelPk, params: { size: '1280x720', seconds: '8' } }
    const saved = await save(s.projectId, s.graph)
    expect(saved.status).toBe(200)
    const p = await preview(s.projectId)
    expect(p.body.preview.runnable).toBe(true)
    s.graph.nodes[1]!.data.videoSettings!.params.seconds = '12'
    expect((await save(s.projectId, s.graph, saved.body.canvas.revision)).status).toBe(200)
    const stale = await run(s.projectId, p.body.preview.stamp)
    expect(stale.status).toBe(400)
    expect(stale.body.error.messageKey).toBe('canvas.preview_stale')
    expect(ctx.db.prepare('SELECT COUNT(*) AS total FROM project_canvas_runs WHERE project_id=?').get(s.projectId)!.total).toBe(0)
    const fresh = await preview(s.projectId)
    expect(fresh.body.preview.stamp).not.toBe(p.body.preview.stamp)
    expect((await run(s.projectId, fresh.body.preview.stamp)).status).toBe(202)
  })

  it('rejects foreign-account and image models on save without persisting the invalid graph', async () => {
    const s = await setup()
    const ownerCookie = ctx.cookie
    const { modelPk: imageModel } = await seedProviderAndModel(ctx, 'image')
    await registerUser(ctx)
    const { modelPk: foreignModel } = await seedProviderAndModel(ctx, 'video')
    ctx.cookie = ownerCookie
    for (const modelId of [foreignModel, imageModel]) {
      s.graph.nodes[1]!.data.modelId = modelId
      s.graph.nodes[1]!.data.videoSettings = { modelId, params: { size: '1280x720', seconds: '8' } }
      expect((await save(s.projectId, s.graph)).status).toBe(400)
      const stored = await call(ctx, `/api/projects/${s.projectId}/canvas`)
      expect(stored.body.canvas.revision).toBe(0)
      expect(stored.body.canvas.graph.nodes).toEqual([])
    }
  })

  it('keeps legacy graphs free of overrides and passes their exact scene params to preview and run', async () => {
    const s = await setup()
    const originalSceneParams = sceneParams(s.sceneId)
    const inherited = JSON.parse(originalSceneParams)
    expect((await save(s.projectId, s.graph)).status).toBe(200)
    const restored = await call(ctx, `/api/projects/${s.projectId}/canvas`)
    expect(restored.body.canvas.graph.nodes[1].data).not.toHaveProperty('videoSettings')
    const enqueue = vi.spyOn(generationQueue, 'enqueueGeneration')
    try {
      const p = await preview(s.projectId)
      expect(p.status).toBe(200)
      expect(p.body.preview.runnable).toBe(true)
      expect((await run(s.projectId, p.body.preview.stamp)).status).toBe(202)
      expect(enqueue.mock.calls).toHaveLength(2)
      for (const [input] of enqueue.mock.calls) expect(input.request.data.params).toEqual(inherited)
      expect(sceneParams(s.sceneId)).toBe(originalSceneParams)
    } finally { enqueue.mockRestore() }
  })
})
