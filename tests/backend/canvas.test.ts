import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  registerUser,
  seedProviderAndModel,
  startTestServer,
  waitForGeneration,
  type TestContext,
} from './helpers'
import sharp from 'sharp'
import { MOCK_PNG_BYTES } from '../../server/generations/adapters/mock'
import { buildAliasIndex, compileCanvasPrompt, parseMentions } from '../../server/canvas/compiler'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { if (ctx) await ctx.close() })

async function setup(referenceBytes: Uint8Array = MOCK_PNG_BYTES) {
  await registerUser(ctx)
  const project = (await call(ctx, '/api/projects', { method: 'POST', body: { name: 'Canvas', style: 'điện ảnh' } })).body.project
  const character = (await call(ctx, '/api/shared-characters', { method: 'POST', body: { name: 'Lan', appearance: 'váy hồng' } })).body.character
  const reference = await fetch(`${ctx.baseUrl}/api/shared-characters/${character.id}/reference`, {
    method: 'POST',
    headers: { Cookie: ctx.cookie, 'Content-Type': 'image/png' },
    body: referenceBytes,
  })
  expect(reference.status).toBe(201)
  const item = (await call(ctx, `/api/projects/${project.id}/items`, {
    method: 'POST',
    body: { kind: 'product', name: 'Chai serum', description: 'chai thủy tinh nắp vàng' },
  })).body.item
  const itemReference = await fetch(`${ctx.baseUrl}/api/projects/${project.id}/items/${item.id}/reference`, {
    method: 'POST',
    headers: { Cookie: ctx.cookie, 'Content-Type': 'image/png' },
    body: referenceBytes,
  })
  expect(itemReference.status).toBe(201)
  const { modelPk } = await seedProviderAndModel(ctx, 'image')
  return { projectId: project.id as string, characterId: character.id as string, itemId: item.id as string, modelPk }
}

function graph(ids: { characterId: string; itemId: string; modelPk: string }) {
  return {
    schemaVersion: 1,
    nodes: [
      { id: 'p1', kind: 'prompt', x: 0, y: 0, data: { text: '@Lan cầm @Chai_serum' } },
      { id: 'c1', kind: 'character', x: 0, y: 140, data: { sourceId: ids.characterId } },
      { id: 'i1', kind: 'item', x: 0, y: 260, data: { sourceId: ids.itemId } },
      { id: 'g1', kind: 'image', x: 360, y: 140, data: { modelId: ids.modelPk, layout: { aspectRatio: '16:9', instances: [] } } },
    ],
    edges: [
      { id: 'e1', source: 'p1', sourcePort: 'prompt', target: 'g1', targetPort: 'prompt' },
      { id: 'e2', source: 'c1', sourcePort: 'object', target: 'g1', targetPort: 'context' },
      { id: 'e3', source: 'i1', sourcePort: 'object', target: 'g1', targetPort: 'context' },
    ],
  }
}

describe('Canvas: vật phẩm và bảng node', () => {
  it('lưu và đọc lại bảng, giữ revision và bảng alias', async () => {
    const { projectId, characterId, itemId, modelPk } = await setup()
    const saved = await call(ctx, `/api/projects/${projectId}/canvas`, {
      method: 'PUT',
      body: { graph: graph({ characterId, itemId, modelPk }), baseRevision: 0 },
    })
    expect(saved.status).toBe(200)
    expect(saved.body.canvas.revision).toBe(1)

    const read = await call(ctx, `/api/projects/${projectId}/canvas`)
    expect(read.status).toBe(200)
    expect(read.body.canvas.revision).toBe(1)
    expect(read.body.canvas.graph.nodes).toHaveLength(4)
    expect(read.body.canvas.aliases.map((entry: { alias: string }) => entry.alias)).toEqual(['Lan', 'Chai_serum'])
    expect(read.body.canvas.limits.nodes).toBeGreaterThan(0)
  })

  it('từ chối ghi khi revision đã cũ', async () => {
    const { projectId, characterId, itemId, modelPk } = await setup()
    const body = { graph: graph({ characterId, itemId, modelPk }), baseRevision: 0 }
    expect((await call(ctx, `/api/projects/${projectId}/canvas`, { method: 'PUT', body })).status).toBe(200)
    const stale = await call(ctx, `/api/projects/${projectId}/canvas`, { method: 'PUT', body })
    expect(stale.status).toBe(400)
    expect(stale.body.error.messageKey).toBe('canvas.revision_conflict')
  })

  it('chặn dây nối sai kiểu và chu trình', async () => {
    const { projectId, characterId, itemId, modelPk } = await setup()
    const base = graph({ characterId, itemId, modelPk })
    const mismatch = {
      ...base,
      edges: [{ id: 'bad', source: 'p1', sourcePort: 'prompt', target: 'g1', targetPort: 'context' }],
    }
    const mismatchResult = await call(ctx, `/api/projects/${projectId}/canvas`, {
      method: 'PUT',
      body: { graph: mismatch, baseRevision: 0 },
    })
    expect(mismatchResult.status).toBe(400)
    expect(mismatchResult.body.error.messageKey).toBe('canvas.graph_invalid')

    const cyclic = {
      schemaVersion: 1,
      nodes: [
        { id: 'a', kind: 'image', x: 0, y: 0, data: {} },
        { id: 'b', kind: 'image', x: 0, y: 100, data: {} },
      ],
      edges: [
        { id: 'e1', source: 'a', sourcePort: 'image', target: 'b', targetPort: 'image' },
        { id: 'e2', source: 'b', sourcePort: 'image', target: 'a', targetPort: 'image' },
      ],
    }
    const cycleResult = await call(ctx, `/api/projects/${projectId}/canvas`, {
      method: 'PUT',
      body: { graph: cyclic, baseRevision: 0 },
    })
    expect(cycleResult.status).toBe(400)
  })

  it('cô lập dữ liệu giữa các tài khoản', async () => {
    const { projectId } = await setup()
    await registerUser(ctx)
    expect((await call(ctx, `/api/projects/${projectId}/canvas`)).status).toBe(404)
    expect((await call(ctx, `/api/projects/${projectId}/items`)).status).toBe(404)
  })

  it('chặn xoá nguồn đang được Canvas sử dụng', async () => {
    const { projectId, characterId, itemId, modelPk } = await setup()
    await call(ctx, `/api/projects/${projectId}/canvas`, {
      method: 'PUT',
      body: { graph: graph({ characterId, itemId, modelPk }), baseRevision: 0 },
    })
    const characterDelete = await call(ctx, `/api/shared-characters/${characterId}`, { method: 'DELETE' })
    expect(characterDelete.status).toBe(400)
    const itemDelete = await call(ctx, `/api/projects/${projectId}/items/${itemId}`, { method: 'DELETE' })
    expect(itemDelete.status).toBe(400)
  })
})

describe('Canvas: mention và chạy node', () => {
  it('phân giải alias và giữ alias ổn định khi trùng tên', () => {
    const entries = buildAliasIndex([
      { nodeId: 'a', recordId: 'a', kind: 'character', name: 'Lan', description: '', continuityNotes: '', reference: null },
      { nodeId: 'b', recordId: 'b', kind: 'character', name: 'Lan', description: '', continuityNotes: '', reference: null },
      { nodeId: 'c', recordId: 'c', kind: 'item', name: 'Chai serum', description: '', continuityNotes: '', reference: null },
    ])
    expect(entries.map((entry) => entry.alias)).toEqual(['Lan', 'Lan2', 'Chai_serum'])
    const index = new Map(entries.map((entry) => [entry.alias.toLowerCase(), entry]))
    const parsed = parseMentions('@Lan2 cầm @Chai_serum, không phải \\@KhongCo', index)
    expect(parsed.resolved.map((entry) => entry.nodeId)).toEqual(['b', 'c'])
    expect(parsed.unresolved).toEqual([])
  })

  it('dựng prompt có mô tả đối tượng, bố trí và chỉ dẫn nền', () => {
    const compiled = compileCanvasPrompt({
      graph: {
        schemaVersion: 1,
        nodes: [
          { id: 'p1', kind: 'prompt', x: 0, y: 0, data: { text: '@Lan đứng cạnh @Chai_serum' } },
          { id: 'g1', kind: 'image', x: 0, y: 0, data: { layout: { aspectRatio: '9:16', backgroundNodeId: null, instances: [] } } },
        ],
        edges: [{ id: 'e1', source: 'p1', sourcePort: 'prompt', target: 'g1', targetPort: 'prompt' }],
      },
      node: { id: 'g1', kind: 'image', x: 0, y: 0, data: { layout: { aspectRatio: '9:16', backgroundNodeId: null, instances: [] } } },
      objects: [
        { nodeId: 'c1', recordId: 'char-1', kind: 'character', name: 'Lan', description: 'váy hồng', continuityNotes: '', reference: null },
        { nodeId: 'i1', recordId: 'item-1', kind: 'item', name: 'Chai serum', description: 'chai thủy tinh', continuityNotes: 'giữ nguyên nắp vàng', reference: null },
      ],
      projectStyle: 'điện ảnh',
      aspectRatio: '9:16',
    })
    expect(compiled.prompt).toContain('váy hồng')
    expect(compiled.prompt).toContain('giữ nguyên nắp vàng')
    expect(compiled.prompt).toContain('9:16')
    expect(compiled.unresolved).toEqual([])
    expect(compiled.inputRefs).toEqual([])
  })

  it('preview trả prompt, ảnh gửi và chặn chạy khi mention hỏng', async () => {
    const { projectId, characterId, itemId, modelPk } = await setup()
    await call(ctx, `/api/projects/${projectId}/canvas`, {
      method: 'PUT',
      body: { graph: graph({ characterId, itemId, modelPk }), baseRevision: 0 },
    })

    const preview = await call(ctx, `/api/projects/${projectId}/canvas/nodes/g1/preview`, { method: 'POST', body: { kind: 'image' } })
    expect(preview.status).toBe(200)
    expect(preview.body.preview.prompt).toContain('chai thủy tinh nắp vàng')
    expect(preview.body.preview.mentions.map((entry: { alias: string }) => entry.alias).sort()).toEqual(['Chai_serum', 'Lan'])
    expect(preview.body.preview.inputs.filter((input: { sent: boolean }) => input.sent)).toHaveLength(2)
    expect(preview.body.preview.unresolved).toEqual([])
    expect(preview.body.preview.stamp).toBeTruthy()

    const broken = graph({ characterId, itemId, modelPk })
    broken.nodes[0]!.data = { text: '@KhongTonTai đứng một mình' }
    await call(ctx, `/api/projects/${projectId}/canvas`, { method: 'PUT', body: { graph: broken, baseRevision: 1 } })
    const brokenPreview = await call(ctx, `/api/projects/${projectId}/canvas/nodes/g1/preview`, { method: 'POST', body: { kind: 'image' } })
    expect(brokenPreview.body.preview.unresolved).toEqual(['KhongTonTai'])
    const blocked = await call(ctx, `/api/projects/${projectId}/canvas/nodes/g1/run`, {
      method: 'POST',
      body: { kind: 'image', modelId: modelPk, stamp: brokenPreview.body.preview.stamp },
    })
    expect(blocked.status).toBe(400)
    expect(blocked.body.error.messageKey).toBe('canvas.mention_unresolved')
  })

  it('từ chối chạy khi preview đã cũ', async () => {
    const { projectId, characterId, itemId, modelPk } = await setup()
    await call(ctx, `/api/projects/${projectId}/canvas`, {
      method: 'PUT',
      body: { graph: graph({ characterId, itemId, modelPk }), baseRevision: 0 },
    })
    const stale = await call(ctx, `/api/projects/${projectId}/canvas/nodes/g1/run`, {
      method: 'POST',
      body: { kind: 'image', modelId: modelPk, stamp: 'khong-dung' },
    })
    expect(stale.status).toBe(400)
    expect(stale.body.error.messageKey).toBe('canvas.preview_stale')
  })

  it('ghép bố trí thành ảnh nguồn mới và giữ riêng tư theo tài khoản', async () => {
    // Fixture 1x1 của provider giả lập không giải mã được bằng sharp, nên bài ghép
    // ảnh dùng một PNG thật do sharp tạo.
    const realPng = new Uint8Array(await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 210, g: 60, b: 90, alpha: 1 } },
    }).png().toBuffer())
    const { projectId, characterId, itemId, modelPk } = await setup(realPng)
    const layoutGraph = graph({ characterId, itemId, modelPk })
    layoutGraph.nodes[3]!.data = {
      modelId: modelPk,
      layout: {
        aspectRatio: '16:9',
        backgroundNodeId: 'i1',
        instances: [{ id: 'pl1', sourceNodeId: 'c1', imageUploadId: null, x: 0.2, y: 0.3, width: 0.4, height: 0.6, rotation: 0, flipX: false, z: 0 }],
      },
    } as never
    await call(ctx, `/api/projects/${projectId}/canvas`, { method: 'PUT', body: { graph: layoutGraph, baseRevision: 0 } })

    const composed = await call(ctx, `/api/projects/${projectId}/canvas/nodes/g1/composite`, { method: 'POST', body: {} })
    expect(composed.status, JSON.stringify(composed.body)).toBe(201)
    expect(composed.body.upload.url).toContain('/api/uploads/')
    expect(composed.body.upload.width).toBe(1024)

    const served = await fetch(`${ctx.baseUrl}${composed.body.upload.url}`, { headers: { Cookie: ctx.cookie } })
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/png')
    const bites = new Uint8Array(await served.arrayBuffer())
    expect(bites[0]).toBe(0x89)

    // Node ảnh dùng bản ghép làm ảnh nguồn: ảnh phải được kế thừa vào lần tạo.
    layoutGraph.nodes[3]!.data = { ...(layoutGraph.nodes[3]!.data as object), uploadId: composed.body.upload.id } as never
    await call(ctx, `/api/projects/${projectId}/canvas`, { method: 'PUT', body: { graph: layoutGraph, baseRevision: 1 } })
    const preview = await call(ctx, `/api/projects/${projectId}/canvas/nodes/g1/preview`, { method: 'POST', body: { kind: 'image' } })
    expect(preview.body.preview.inputs.some((input: { reason: string }) => input.reason === 'source')).toBe(true)

    // Ảnh ghép là tài sản riêng của tài khoản đã tạo.
    await registerUser(ctx)
    const stolen = await fetch(`${ctx.baseUrl}${composed.body.upload.url}`, { headers: { Cookie: ctx.cookie } })
    expect(stolen.status).toBe(404)
  })

  it('chạy node ảnh gửi đúng nguồn và ghi snapshot Canvas', async () => {
    const { projectId, characterId, itemId, modelPk } = await setup()
    await call(ctx, `/api/projects/${projectId}/canvas`, {
      method: 'PUT',
      body: { graph: graph({ characterId, itemId, modelPk }), baseRevision: 0 },
    })
    const preview = await call(ctx, `/api/projects/${projectId}/canvas/nodes/g1/preview`, { method: 'POST', body: { kind: 'image' } })
    const run = await call(ctx, `/api/projects/${projectId}/canvas/nodes/g1/run`, {
      method: 'POST',
      body: { kind: 'image', modelId: modelPk, stamp: preview.body.preview.stamp, idempotencyKey: 'canvas-run-1' },
    })
    expect(run.status, JSON.stringify(run.body)).toBe(202)
    expect(run.body.run.nodeId).toBe('g1')
    const generation = await waitForGeneration(ctx, run.body.generation.id)
    expect(generation.status).toBe('succeeded')

    const row = ctx.db.prepare('SELECT prompt_snapshot_json, source_images_json, character_references_json, project_id FROM generations WHERE id = ?')
      .get(run.body.generation.id) as { prompt_snapshot_json: string; source_images_json: string | null; character_references_json: string | null; project_id: string }
    expect(row.project_id).toBe(projectId)
    const snapshot = JSON.parse(row.prompt_snapshot_json) as { canvas?: { nodeId?: string; mentions?: Array<{ alias: string }> } }
    expect(snapshot.canvas?.nodeId).toBe('g1')
    expect(snapshot.canvas?.mentions?.map((entry) => entry.alias).sort()).toEqual(['Chai_serum', 'Lan'])
    expect(JSON.parse(row.source_images_json ?? '[]').length).toBe(1)
    expect(JSON.parse(row.character_references_json ?? '[]').length).toBe(1)

    const runs = await call(ctx, `/api/projects/${projectId}/canvas/runs`)
    expect(runs.body.runs).toHaveLength(1)
  })
})
