import { randomUUID } from 'node:crypto'
import type { CanvasGraph } from '../../shared/canvas'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, seedProviderAndModel, startTestServer, waitForGeneration, type TestContext } from './helpers'

// The export API/worker test only needs deterministic probing and an output file;
// the native encoder behavior is covered by exportsNative.test.ts.
const FAKE_FFMPEG = `#!/bin/sh
for last in "$@"; do :; done
printf 'CANVAS_CHAIN_MP4' > "$last"
exit 0
`
const FAKE_FFPROBE = `#!/bin/sh
printf '%s\\n' '{"streams":[{"codec_type":"video","width":1280,"height":720,"duration":"1"}],"format":{"duration":"1"}}'
exit 0
`

let toolDir = ''
let ffmpegPath = ''
let context: TestContext

beforeAll(async () => {
  toolDir = mkdtempSync(join(tmpdir(), 'lumina-canvas-export-tools-'))
  ffmpegPath = join(toolDir, 'ffmpeg')
  writeFileSync(ffmpegPath, FAKE_FFMPEG)
  writeFileSync(join(toolDir, 'ffprobe'), FAKE_FFPROBE)
  chmodSync(ffmpegPath, 0o755)
  chmodSync(join(toolDir, 'ffprobe'), 0o755)
  context = await startTestServer({ ffmpegPath })
})

afterAll(async () => {
  await context.close()
  rmSync(toolDir, { recursive: true, force: true })
})

async function waitForExport(id: string): Promise<any> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    await context.worker.tick()
    const result = await call(context, `/api/exports/${id}`)
    const status = result.body?.export?.status
    if (status === 'succeeded' || status === 'failed') return result.body.export
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Canvas export ${id} did not finish`)
}

describe('Canvas video chain exports', () => {
  it('orders a Studio chain from a selected middle node and freezes media IDs', async () => {
    await registerUser(context)
    const { modelPk } = await seedProviderAndModel(context, 'video')
    const project = await call(context, '/api/projects', { method: 'POST', body: { name: 'Canvas export project' } })
    const projectId = project.body.project.id as string
    const sceneIds: string[] = []
    const generationIds: string[] = []
    for (const title of ['A', 'B', 'C']) {
      const scene = await call(context, `/api/projects/${projectId}/scenes`, { method: 'POST', body: { title, prompt: title, modelId: modelPk } })
      const sceneId = scene.body.scene.id as string
      sceneIds.push(sceneId)
      const queued = await call(context, `/api/scenes/${sceneId}/generate`, { method: 'POST', body: { idempotencyKey: `canvas-chain-${title}` } })
      const finished = await waitForGeneration(context, queued.body.generation.id)
      generationIds.push(finished.id as string)
    }

    const nodeIds = ['video-a', 'video-b', 'video-c']
    const graph = {
      schemaVersion: 1,
      nodes: nodeIds.map((id, index) => ({ id, kind: 'video' as const, x: index * 300, y: 0, data: { modelId: modelPk, sceneId: sceneIds[index] } })),
      edges: [
        { id: 'ab', source: 'video-a', sourcePort: 'video', target: 'video-b', targetPort: 'sequence' },
        { id: 'bc', source: 'video-b', sourcePort: 'video', target: 'video-c', targetPort: 'sequence' },
      ],
    }
    const saved = await call(context, `/api/projects/${projectId}/canvas`, { method: 'PUT', body: { baseRevision: 0, graph } })
    expect(saved.status).toBe(200)
    for (const [index, nodeId] of nodeIds.entries()) {
      context.db.prepare('INSERT INTO project_canvas_runs (id,project_id,node_id,kind,generation_id,input_stamp,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(`run-${nodeId}`, projectId, nodeId, 'video', generationIds[index]!, `stamp-${nodeId}`, Date.now() + index)
    }

    const preview = await call(context, `/api/projects/${projectId}/canvas/exports/preview`, { method: 'POST', body: { nodeId: 'video-b', baseRevision: 1 } })
    expect(preview.status).toBe(200)
    expect(preview.body.preview.ready).toBe(true)
    expect(preview.body.preview.items.map((item: { generationId: string }) => item.generationId)).toEqual(generationIds)

    const created = await call(context, `/api/projects/${projectId}/canvas/exports`, { method: 'POST', body: {
      nodeId: 'video-b', baseRevision: 1, stamp: preview.body.preview.stamp,
    } })
    expect(created.status).toBe(202)
    const finished = await waitForExport(created.body.export.id)
    expect(finished.status).toBe('succeeded')
    expect(finished.projectId).toBe(projectId)
    expect(finished.source).toBe('canvas-chain')
    expect(finished.byteSize).toBeGreaterThan(0)
    const spec = context.db.prepare('SELECT spec_json FROM exports WHERE id=?').get(finished.id) as { spec_json: string }
    expect(JSON.parse(spec.spec_json).items.map((item: { generationId: string }) => item.generationId)).toEqual(generationIds)
  })

  it('exports a Quick Canvas chain, rejects stale previews and isolates ownership', async () => {
    const owner = await registerUser(context)
    const { modelPk } = await seedProviderAndModel(context, 'video')
    const session = await call(context, '/api/quick-sessions', { method: 'POST', body: { title: 'Quick chain' } })
    const sessionId = session.body.session.id as string
    const graph = {
      schemaVersion: 1,
      nodes: [
        { id: 'quick-a', kind: 'prompt' as const, x: 0, y: 0, data: { text: 'A' } },
        { id: 'quick-b', kind: 'prompt' as const, x: 0, y: 200, data: { text: 'B' } },
        { id: 'quick-v-a', kind: 'video' as const, x: 300, y: 0, data: { modelId: modelPk } },
        { id: 'quick-v-b', kind: 'video' as const, x: 600, y: 0, data: { modelId: modelPk } },
      ],
      edges: [
        { id: 'prompt-a', source: 'quick-a', sourcePort: 'prompt', target: 'quick-v-a', targetPort: 'prompt' },
        { id: 'prompt-b', source: 'quick-b', sourcePort: 'prompt', target: 'quick-v-b', targetPort: 'prompt' },
        { id: 'quick-sequence', source: 'quick-v-a', sourcePort: 'video', target: 'quick-v-b', targetPort: 'sequence' },
      ],
    }
    const saved = await call(context, `/api/quick-sessions/${sessionId}/canvas`, { method: 'PUT', body: { baseRevision: 0, graph } })
    expect(saved.status).toBe(200)
    for (const nodeId of ['quick-v-a', 'quick-v-b']) {
      const preview = await call(context, `/api/quick-sessions/${sessionId}/canvas/nodes/${nodeId}/preview`, { method: 'POST', body: { kind: 'video' } })
      expect(preview.status).toBe(200)
      const run = await call(context, `/api/quick-sessions/${sessionId}/canvas/nodes/${nodeId}/run`, { method: 'POST', body: { kind: 'video', stamp: preview.body.preview.stamp } })
      expect(run.status).toBe(202)
      await waitForGeneration(context, run.body.generation.id)
    }
    const preview = await call(context, `/api/quick-sessions/${sessionId}/canvas/exports/preview`, { method: 'POST', body: { nodeId: 'quick-v-b', baseRevision: 1 } })
    expect(preview.status).toBe(200)
    expect(preview.body.preview.items).toHaveLength(2)

    const changedGraph = { ...graph, edges: graph.edges.filter(edge => edge.id !== 'quick-sequence') }
    expect((await call(context, `/api/quick-sessions/${sessionId}/canvas`, { method: 'PUT', body: { baseRevision: 1, graph: changedGraph } })).status).toBe(200)
    const stale = await call(context, `/api/quick-sessions/${sessionId}/canvas/exports`, { method: 'POST', body: { nodeId: 'quick-v-b', baseRevision: 1, stamp: preview.body.preview.stamp } })
    expect(stale.status).toBe(409)

    await registerUser(context)
    expect((await call(context, `/api/quick-sessions/${sessionId}/canvas/exports`)).status).toBe(404)
    context.cookie = ''
    await call(context, '/api/auth/login', { method: 'POST', body: { email: owner.email, password: 'matkhau-rat-dai-123' } })
  })

  it.each(['projects', 'quick-sessions'] as const)('checks selected versions, same-node fallback, missing media and stale stamps for %s', async scope => {
    const { userId } = await registerUser(context)
    const quick = scope === 'quick-sessions'
    const created = await call(context, `/api/${scope}`, { method: 'POST', body: quick ? { title: 'Fallback' } : { name: 'Fallback' } })
    const scopeId = created.body[quick ? 'session' : 'project'].id as string
    const root = `/api/${scope}/${scopeId}/canvas`
    const scene = quick ? null : (await call(context, `/api/projects/${scopeId}/scenes`, { method: 'POST', body: { title: 'Shared scene', prompt: 'Pan' } })).body.scene
    const seed = (nodeId: string, timestamp: number) => {
      const id = randomUUID(), runId = randomUUID(), assetId = randomUUID()
      context.db.prepare(`INSERT INTO generations(id,user_id,project_id,quick_session_id,scene_id,kind,prompt,snap_provider,snap_base_url,snap_model_id,status,created_at,updated_at,completed_at)
        VALUES (?,?,?,?,?,'video','Clip','mock','https://mock.test/v1','mock','succeeded',?,?,?)`)
        .run(id,userId,quick ? null : scopeId,quick ? scopeId : null,scene?.id ?? null,timestamp,timestamp,timestamp)
      const saved = context.mediaStore.save({ userId, generationId: id, bytes: Buffer.from('000000186674797069736f6d', 'hex') })
      context.db.prepare('INSERT INTO assets(id,generation_id,user_id,relative_path,mime_type,byte_size,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(assetId,id,userId,saved.relativePath,saved.mimeType,saved.byteSize,timestamp)
      const table = quick ? 'quick_canvas_runs' : 'project_canvas_runs', column = quick ? 'session_id' : 'project_id'
      context.db.prepare(`INSERT INTO ${table}(id,${column},node_id,kind,generation_id,input_stamp,created_at) VALUES(?,?,?,'video',?,'stamp',?)`)
        .run(runId,scopeId,nodeId,id,timestamp)
      return { id, runId, assetId, path: saved.relativePath }
    }
    const old = seed('a',1), latest = seed('a',2), otherNode = seed('b',3)
    const graph: CanvasGraph = { schemaVersion: 1, nodes: ['a','b','missing'].map(id => ({ id,kind:'video',x:0,y:0,data:{ ...(scene ? { sceneId:scene.id } : {}), ...(id==='a' ? { selectedRunId:old.runId } : {}) } })),
      edges:[{id:'ab',source:'a',sourcePort:'video',target:'b',targetPort:'sequence'}] }
    expect((await call(context,root,{method:'PUT',body:{baseRevision:0,graph}})).status).toBe(200)
    const preview = async (nodeId='a') => (await call(context,`${root}/exports/preview`,{method:'POST',body:{nodeId,baseRevision:1}})).body.preview
    const selected = await preview()
    expect(selected.items[0]).toMatchObject({ generationId:old.id,assetId:old.assetId,fallback:false,issue:null })
    expect(selected.items[1].generationId).toBe(otherNode.id)
    expect((await preview('missing')).items[0]).toMatchObject({ nodeId:'missing',generationId:null,issue:'missing_video' })
    const wrongSelection = { ...graph, nodes:graph.nodes.map(node => node.id==='missing' ? {...node,data:{...node.data,selectedRunId:old.runId}} : node) }
    expect((await call(context,root,{method:'PUT',body:{baseRevision:1,graph:wrongSelection}})).status).toBe(400)
    const invalidGraph = { ...graph, edges:[...graph.edges,{id:'branch',source:'a',sourcePort:'video',target:'missing',targetPort:'sequence'}] }
    expect((await call(context,root,{method:'PUT',body:{baseRevision:1,graph:invalidGraph}})).status).toBe(400)
    // An unavailable selected version falls back within node a, despite node b being newer.
    context.db.prepare('UPDATE generations SET deleted_at=1 WHERE id=?').run(old.id)
    const fallback = await preview()
    expect(fallback.items[0]).toMatchObject({generationId:latest.id,fallback:true,issue:null})
    const stale = await call(context,`${root}/exports`,{method:'POST',body:{nodeId:'a',baseRevision:1,stamp:selected.stamp}})
    expect(stale.status).toBe(409)
    expect(stale.body.error.messageKey).toBe('exports.chain_stale')
    context.db.prepare("UPDATE generations SET postprocess_status='queued' WHERE id=?").run(latest.id)
    const pending = await preview()
    expect(pending.ready).toBe(false)
    expect(pending.items[0].issue).toBe('logo_pending')
    expect((await call(context,`${root}/exports`,{method:'POST',body:{nodeId:'a',baseRevision:1,stamp:pending.stamp}})).status).toBe(400)
    context.db.prepare('UPDATE generations SET postprocess_status=NULL WHERE id=?').run(latest.id)
    context.mediaStore.remove(latest.path)
    const missing = await preview()
    expect(missing.ready).toBe(false)
    expect(missing.items[0].issue).toBe('media_missing')
    const previousMax = context.env.EXPORT_MAX_SCENES
    context.env.EXPORT_MAX_SCENES=1
    try { expect((await call(context,`${root}/exports/preview`,{method:'POST',body:{nodeId:'a',baseRevision:1}})).status).toBe(400) }
    finally { context.env.EXPORT_MAX_SCENES=previousMax }
    const cookie=context.cookie
    await registerUser(context)
    for (const path of [`${root}/exports`,`${root}/exports/preview`]) expect((await call(context,path,{method:'POST',body:{nodeId:'a',baseRevision:1,stamp:selected.stamp}})).status).toBe(404)
    context.cookie=cookie
  })
})
