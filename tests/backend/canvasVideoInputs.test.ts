import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'
import type { CanvasGraph } from '../../shared/canvas'
import { resolveCanvasVideoInput } from '../../server/canvas/videoInputs'
import { enqueueGeneration } from '../../server/generations/enqueue'
import { buildVideoRequestBody, loadVideoInput } from '../../server/generations/adapters/video'
import { MOCK_PNG_BYTES } from '../../server/generations/adapters/mock'
let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { await ctx.close() })
async function setup(style: 'openai' | 'agnes' | 'higgsfield' = 'openai') {
  const { userId } = await registerUser(ctx)
  const projectId = (await call(ctx, '/api/projects', { method: 'POST', body: { name: 'Video inputs' } })).body.project.id as string
  const { modelPk } = await seedProviderAndModel(ctx, 'video')
  ctx.db.prepare('UPDATE models SET video_api_style=?, model_id=? WHERE id=?').run(style, style === 'agnes' ? 'agnes-video-2.5' : style === 'higgsfield' ? 'bytedance/seedance-2.5' : 'sora-test', modelPk)
  const uploadId = `upload-${userId}`
  const saved = ctx.mediaStore.saveUpload({ userId, uploadId, bytes: MOCK_PNG_BYTES, maxBytes: ctx.env.MAX_REFERENCE_BYTES })
  ctx.db.prepare('INSERT INTO uploads(id,user_id,relative_path,mime_type,byte_size,created_at) VALUES(?,?,?,?,?,?)').run(uploadId, userId, saved.relativePath, saved.mimeType, saved.byteSize, Date.now())
  return { userId, projectId, modelPk, uploadId }
}
function graph(uploadId: string): CanvasGraph {
  return { schemaVersion: 1, nodes: [{ id: 'u', kind: 'upload', x: 0, y: 0, data: { uploadId } }, { id: 'v', kind: 'video', x: 0, y: 0, data: {} }], edges: [{ id: 'e', source: 'u', sourcePort: 'image', target: 'v', targetPort: 'image' }] }
}
describe('provider-aware Canvas video images', () => {
  it('derives Higgsfield image mode for own text-default controls and removes text-only fields', async () => {
    const s = await setup('higgsfield')
    const scene = (await call(ctx, `/api/projects/${s.projectId}/scenes`, { method: 'POST', body: { title: 'Image scene', prompt: 'Motion', modelId: s.modelPk } })).body.scene
    const g = graph(s.uploadId)
    g.nodes[1]!.data = { modelId: s.modelPk, sceneId: scene.id, videoSettings: { modelId: s.modelPk, params: { mode: 'text', duration: 8, resolution: '1080p', aspectRatio: '16:9', outputFormat: 'mp4' } } }
    g.nodes.push({ id: 'p', kind: 'prompt', x: 0, y: 0, data: { text: 'Motion' } })
    g.edges.push({ id: 'pv', source: 'p', sourcePort: 'prompt', target: 'v', targetPort: 'prompt' })
    expect((await call(ctx, `/api/projects/${s.projectId}/canvas`, { method: 'PUT', body: { graph: g, baseRevision: 0 } })).status).toBe(200)
    const p = await call(ctx, `/api/projects/${s.projectId}/canvas/nodes/v/preview`, { method: 'POST', body: { kind: 'video' } })
    expect(p.body.preview.runnable).toBe(true)
    expect(p.body.preview.videoParams).toMatchObject({ mode: 'image', duration: 8, resolution: '1080p' })
    expect(p.body.preview.videoParams).not.toHaveProperty('aspectRatio')
    const r = await call(ctx, `/api/projects/${s.projectId}/canvas/nodes/v/run`, { method: 'POST', body: { kind: 'video', stamp: p.body.preview.stamp } })
    expect(r.status).toBe(202)
  })
  it('requires selection for multiple upstream images and rejects stale selection', async () => {
    const s = await setup(); const g = graph(s.uploadId); const v = g.nodes[1]!
    g.nodes.push({ ...g.nodes[0]!, id: 'u2' }); g.edges.push({ ...g.edges[0]!, id: 'e2', source: 'u2' })
    expect(() => resolveCanvasVideoInput(ctx.db, s.userId, s.projectId, g, v)).toThrow('nhiều ảnh')
    v.data.videoInputNodeId = 'u2'
    expect(resolveCanvasVideoInput(ctx.db, s.userId, s.projectId, g, v)?.nodeId).toBe('u2')
    v.data.videoInputNodeId = 'missing'
    expect(() => resolveCanvasVideoInput(ctx.db, s.userId, s.projectId, g, v)).toThrow('không còn nối')
  })
  it('never falls back from an invalid selected image run to an old upload', async () => {
    const s = await setup(); const g = graph(s.uploadId)
    g.nodes[0]!.kind = 'image'; g.nodes[0]!.data.selectedRunId = 'not-a-valid-run'
    expect(() => resolveCanvasVideoInput(ctx.db, s.userId, s.projectId, g, g.nodes[1]!)).toThrow('chưa thành công')
  })
  it('snapshots explicit OpenAI input and overrides disabled portrait reference without weakening generic guard', async () => {
    const s = await setup()
    expect(() => enqueueGeneration({ db: ctx.db, env: ctx.env, userId: s.userId, previewOnly: true, request: { data: { modelId: s.modelPk, prompt: 'Motion', params: {}, sourceUploadIds: [s.uploadId] } } })).toThrow('Chỉ model tạo ảnh')
    const result = enqueueGeneration({ db: ctx.db, env: ctx.env, worker: { wake() {} } as any, userId: s.userId, request: { data: { modelId: s.modelPk, prompt: 'Motion', params: { useCharacterReference: false } }, videoInput: { nodeId: 'u', uploadId: s.uploadId } } })
    const dataUrl = loadVideoInput({ generation: result.generation, mediaStore: ctx.mediaStore, env: ctx.env } as any)
    expect(dataUrl).toMatch(/^data:image\/png;base64,/)
    expect(buildVideoRequestBody('sora', 'Motion', { useCharacterReference: false }, 'portrait', dataUrl).input_reference).toEqual({ image_url: dataUrl })
  })
  it('Higgsfield maps explicit start frame and preserves end frame', async () => {
    const s = await setup('higgsfield')
    const result = enqueueGeneration({ db: ctx.db, env: ctx.env, worker: { wake() {} } as any, userId: s.userId, request: { data: { modelId: s.modelPk, prompt: 'Motion', params: { mode: 'image', imageUrl: 'https://example.com/old.png', endImageUrl: 'https://example.com/end.png' } }, videoInput: { nodeId: 'u', uploadId: s.uploadId } } })
    expect(JSON.parse(result.generation.params_json)).toMatchObject({ mode: 'image', imageUploadId: s.uploadId, endImageUrl: 'https://example.com/end.png' })
    expect(JSON.parse(result.generation.params_json).imageUrl).toBeUndefined()
    const preview = enqueueGeneration({ db: ctx.db, env: ctx.env, userId: s.userId, previewOnly: true, request: { data: { modelId: s.modelPk, prompt: 'Motion', params: { mode: 'image', endImageUrl: 'https://example.com/end.png' } }, videoInput: { nodeId: 'u', uploadId: s.uploadId } } })
    expect(preview.referenceCount).toBe(2)
    expect(preview.maxReferenceCount).toBe(2)
  })
  it('preview and run share the explicit source resolver and stamps bind frozen source identity', async () => {
    const s = await setup()
    const scene = (await call(ctx, `/api/projects/${s.projectId}/scenes`, { method: 'POST', body: { title: 'Video', modelId: s.modelPk, prompt: 'Motion' } })).body.scene
    const g = graph(s.uploadId); g.nodes[1]!.data = { modelId: s.modelPk, sceneId: scene.id }
    g.nodes.push({ id: 'p', kind: 'prompt', x: 0, y: 0, data: { text: 'Motion' } })
    g.edges.push({ id: 'ep', source: 'p', sourcePort: 'prompt', target: 'v', targetPort: 'prompt' })
    expect((await call(ctx, `/api/projects/${s.projectId}/canvas`, { method: 'PUT', body: { graph: g, baseRevision: 0 } })).status).toBe(200)
    const preview = await call(ctx, `/api/projects/${s.projectId}/canvas/nodes/v/preview`, { method: 'POST', body: { kind: 'video' } })
    expect(preview.body.preview.runnable).toBe(true)
    expect(preview.body.preview.inputs.find((input: any) => input.nodeId === 'u').sent).toBe(true)
    const run = await call(ctx, `/api/projects/${s.projectId}/canvas/nodes/v/run`, { method: 'POST', body: { kind: 'video', stamp: preview.body.preview.stamp } })
    expect(run.status).toBe(202)
    const stored = ctx.db.prepare('SELECT source_images_json FROM generations WHERE id=?').get(run.body.generation.id)!
    expect(JSON.parse(String(stored.source_images_json))[0].mime).toBe('image/png')
    ctx.db.prepare('UPDATE uploads SET relative_path=? WHERE id=?').run('changed.png', s.uploadId)
    const stale = await call(ctx, `/api/projects/${s.projectId}/canvas/nodes/v/run`, { method: 'POST', body: { kind: 'video', stamp: preview.body.preview.stamp } })
    expect(stale.status).toBe(400)
    expect(stale.body.error.messageKey).toBe('canvas.preview_stale')
  })
  it('scopes idempotency to execution provenance and never duplicates Canvas runs', async () => {
    const s = await setup()
    const scene = (await call(ctx, `/api/projects/${s.projectId}/scenes`, { method: 'POST', body: { title: 'Video', modelId: s.modelPk, prompt: 'Motion' } })).body.scene
    const g = graph(s.uploadId)
    g.nodes[1]!.data = { modelId: s.modelPk, sceneId: scene.id }
    g.nodes.push({ id: 'v2', kind: 'video', x: 0, y: 0, data: { modelId: s.modelPk, sceneId: scene.id } }, { id: 'p', kind: 'prompt', x: 0, y: 0, data: { text: 'Motion' } })
    for (const id of ['v', 'v2']) g.edges.push({ id: `prompt-${id}`, source: 'p', sourcePort: 'prompt', target: id, targetPort: 'prompt' })
    expect((await call(ctx, `/api/projects/${s.projectId}/canvas`, { method: 'PUT', body: { graph: g, baseRevision: 0 } })).status).toBe(200)
    const preview = async (id: string) => (await call(ctx, `/api/projects/${s.projectId}/canvas/nodes/${id}/preview`, { method: 'POST', body: { kind: 'video' } })).body.preview
    const run = (id: string, stamp: string) => call(ctx, `/api/projects/${s.projectId}/canvas/nodes/${id}/run`, { method: 'POST', body: { kind: 'video', stamp, idempotencyKey: 'same-client-key' } })
    const p1 = await preview('v')
    const first = await run('v', p1.stamp); const repeat = await run('v', p1.stamp)
    expect(first.status).toBe(202); expect(repeat.status).toBe(202)
    expect(repeat.body.generation.id).toBe(first.body.generation.id)
    expect(repeat.body.run.id).toBe(first.body.run.id)
    expect(ctx.db.prepare('SELECT COUNT(*) AS total FROM project_canvas_runs WHERE project_id=? AND node_id=?').get(s.projectId, 'v')!.total).toBe(1)
    const second = await run('v2', (await preview('v2')).stamp)
    expect(second.status).toBe(202)
    expect(second.body.generation.id).not.toBe(first.body.generation.id)
    expect(second.body.run.nodeId).toBe('v2')
  })
  it('Agnes refuses private images without consent and text mode never silently drops them', async () => {
    const s = await setup('agnes')
    const preview = (params: Record<string, unknown>, allowTemporaryMedia = false) => enqueueGeneration({ db: ctx.db, env: { ...ctx.env, APP_ORIGIN: 'https://public.example.com' }, userId: s.userId, previewOnly: true, request: { data: { modelId: s.modelPk, prompt: 'Motion', params, allowTemporaryMedia }, videoInput: { nodeId: 'u', uploadId: s.uploadId } } })
    expect(() => preview({})).toThrow('đồng ý')
    expect(() => preview({ mode: 'text' }, true)).toThrow('keyframe hoặc reference')
    expect(preview({ mode: 'keyframe' }, true).referenceCount).toBe(1)
    expect(preview({ mode: 'reference' }, true).referenceCount).toBe(1)
  })
})
