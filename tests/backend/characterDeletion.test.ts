import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, startTestServer, type TestContext } from './helpers'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { if (ctx) await ctx.close() })

/** Dự án + nhân vật thư viện + một cảnh dùng nhân vật đó. */
async function setup(): Promise<{ projectId: string; characterId: string; sceneId: string }> {
  await registerUser(ctx)
  const project = (await call(ctx, '/api/projects', { method: 'POST', body: { name: 'Dự án xoá nhân vật' } })).body.project
  const character = (await call(ctx, '/api/shared-characters', {
    method: 'POST',
    body: { name: 'Lan', appearance: 'váy hồng', voice: {} },
  })).body.character
  const scene = (await call(ctx, `/api/projects/${project.id}/scenes`, {
    method: 'POST',
    body: { title: 'Cảnh 1', prompt: 'Lan đi dạo', characterId: character.id, characterIds: [character.id], dialogue: 'Chào' },
  })).body.scene
  return { projectId: project.id, characterId: character.id, sceneId: scene.id }
}

async function trash(projectId: string): Promise<void> {
  const response = await call(ctx, `/api/projects/${projectId}/trash`, { method: 'POST', body: { deleteResults: false } })
  expect(response.status).toBe(200)
}

async function archive(projectId: string): Promise<void> {
  const response = await call(ctx, `/api/projects/${projectId}`, { method: 'PATCH', body: { archived: true } })
  expect(response.status).toBe(200)
}

function usageOf(characterId: string) {
  const cast = ctx.db.prepare('SELECT COUNT(*) AS total FROM scene_characters WHERE character_id = ?').get(characterId) as { total: number }
  const speakers = ctx.db.prepare('SELECT COUNT(*) AS total FROM scenes WHERE character_id = ?').get(characterId) as { total: number }
  return { cast: Number(cast.total), speakers: Number(speakers.total) }
}

describe('Xoá nhân vật không bế tắc theo trạng thái dự án', () => {
  it('xoá được khi nhân vật chỉ nằm trong dự án ở Thùng rác, và gỡ tham chiếu', async () => {
    const { projectId, characterId, sceneId } = await setup()
    await trash(projectId)

    const removed = await call(ctx, `/api/shared-characters/${characterId}`, { method: 'DELETE' })
    expect(removed.status, JSON.stringify(removed.body)).toBe(200)
    expect(removed.body.detached.scenes).toBe(1)
    expect(removed.body.detached.projects[0]).toMatchObject({ id: projectId, state: 'trashed' })

    expect(usageOf(characterId)).toEqual({ cast: 0, speakers: 0 })
    expect(ctx.db.prepare('SELECT deleted_at FROM characters WHERE id = ?').get(characterId)).toMatchObject({ deleted_at: expect.any(Number) })
    expect((await call(ctx, `/api/shared-characters/${characterId}`)).status).toBe(404)
    // Lời thoại của cảnh được giữ nguyên, chỉ mất người nói.
    const scene = ctx.db.prepare('SELECT dialogue FROM scenes WHERE id = ?').get(sceneId) as { dialogue: string }
    expect(scene.dialogue).toBe('Chào')
  })

  it('xoá được khi dự án đã lưu trữ', async () => {
    const { projectId, characterId } = await setup()
    await archive(projectId)

    const removed = await call(ctx, `/api/shared-characters/${characterId}`, { method: 'DELETE' })
    expect(removed.status, JSON.stringify(removed.body)).toBe(200)
    expect(removed.body.detached.projects[0].state).toBe('archived')
    expect(usageOf(characterId)).toEqual({ cast: 0, speakers: 0 })
  })

  it('chặn khi dự án còn sửa được và nêu rõ nơi đang dùng', async () => {
    const { projectId, characterId, sceneId } = await setup()

    const blocked = await call(ctx, `/api/shared-characters/${characterId}`, { method: 'DELETE' })
    expect(blocked.status).toBe(400)
    expect(blocked.body.error.messageKey).toBe('characters.in_use')
    expect(blocked.body.error.message).toContain('cảnh')
    const usage = blocked.body.error.details.usage as { scenes: Array<{ projectId: string; sceneId: string; projectState: string; role: string }> }
    expect(usage.scenes[0]).toMatchObject({ projectId, sceneId, projectState: 'active', role: 'speaker' })

    // Chặn thì không được thay đổi gì.
    expect(ctx.db.prepare('SELECT id FROM characters WHERE id = ?').get(characterId)).toBeTruthy()
    expect(usageOf(characterId)).toEqual({ cast: 1, speakers: 1 })

    // Gỡ khỏi cảnh rồi xoá vẫn chạy được như trước.
    await call(ctx, `/api/projects/${projectId}/scenes/${sceneId}`, { method: 'PATCH', body: { characterId: null, dialogue: '', characterIds: [] } })
    expect((await call(ctx, `/api/shared-characters/${characterId}`, { method: 'DELETE' })).status).toBe(204)
  })

  it('detach=1 gỡ ở mọi nơi rồi xoá, kể cả khi còn dự án đang dùng', async () => {
    const { projectId, characterId } = await setup()
    // Một dự án nữa đã vào Thùng rác cũng đang dùng cùng nhân vật.
    const other = (await call(ctx, '/api/projects', { method: 'POST', body: { name: 'Dự án phụ' } })).body.project
    await call(ctx, `/api/projects/${other.id}/scenes`, {
      method: 'POST',
      body: { title: 'Cảnh phụ', prompt: 'x', characterId, characterIds: [characterId] },
    })
    await trash(other.id)

    const blocked = await call(ctx, `/api/shared-characters/${characterId}`, { method: 'DELETE' })
    expect(blocked.status).toBe(400)
    expect((blocked.body.error.details.usage as { scenes: unknown[] }).scenes).toHaveLength(2)

    const forced = await call(ctx, `/api/shared-characters/${characterId}?detach=1`, { method: 'DELETE' })
    expect(forced.status, JSON.stringify(forced.body)).toBe(200)
    expect(forced.body.detached.scenes).toBe(2)
    expect(usageOf(characterId)).toEqual({ cast: 0, speakers: 0 })
    expect(ctx.db.prepare('SELECT deleted_at FROM characters WHERE id = ?').get(characterId)).toMatchObject({ deleted_at: expect.any(Number) })
    expect((await call(ctx, `/api/shared-characters/${characterId}`)).status).toBe(404)
    expect(projectId).toBeTruthy()
  })

  it('gỡ luôn node Canvas khi xoá nhân vật ở dự án trong Thùng rác', async () => {
    await registerUser(ctx)
    const project = (await call(ctx, '/api/projects', { method: 'POST', body: { name: 'Canvas trong thùng rác' } })).body.project
    const character = (await call(ctx, '/api/shared-characters', { method: 'POST', body: { name: 'Minh', appearance: 'áo xanh' } })).body.character
    const graph = {
      schemaVersion: 1,
      nodes: [
        { id: 'c1', kind: 'character', x: 0, y: 0, data: { sourceId: character.id } },
        { id: 'g1', kind: 'image', x: 300, y: 0, data: { modelId: null, layout: { aspectRatio: '16:9', instances: [{ id: 'p1', sourceNodeId: 'c1', imageUploadId: null, x: 0.1, y: 0.1, width: 0.3, height: 0.3, rotation: 0, flipX: false, z: 0 }] } } },
      ],
      edges: [{ id: 'e1', source: 'c1', sourcePort: 'object', target: 'g1', targetPort: 'context' }],
    }
    const saved = await call(ctx, `/api/projects/${project.id}/canvas`, { method: 'PUT', body: { graph, baseRevision: 0 } })
    expect(saved.status).toBe(200)
    const before = saved.body.canvas.revision as number
    await call(ctx, `/api/projects/${project.id}/trash`, { method: 'POST', body: { deleteResults: false } })

    const removed = await call(ctx, `/api/shared-characters/${character.id}`, { method: 'DELETE' })
    expect(removed.status, JSON.stringify(removed.body)).toBe(200)
    expect(removed.body.detached.canvasNodes).toBe(1)

    const row = ctx.db.prepare('SELECT graph_json, revision FROM project_canvases WHERE project_id = ?').get(project.id) as { graph_json: string; revision: number }
    const after = JSON.parse(row.graph_json) as { nodes: Array<{ id: string }>; edges: unknown[]; }
    expect(after.nodes.map((node) => node.id)).toEqual(['g1'])
    expect(after.edges).toHaveLength(0)
    expect(row.revision).toBeGreaterThan(before)
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM project_canvas_links WHERE project_id = ?').get(project.id)).toEqual({ n: 0 })
    const layout = JSON.parse(row.graph_json).nodes[0].data.layout
    expect(layout.instances).toHaveLength(0)
  })

  it('vẫn chặn khi node Canvas thuộc dự án đang hoạt động, và detach=1 thì gỡ được', async () => {
    await registerUser(ctx)
    const project = (await call(ctx, '/api/projects', { method: 'POST', body: { name: 'Canvas đang mở' } })).body.project
    const character = (await call(ctx, '/api/shared-characters', { method: 'POST', body: { name: 'Nhân viên', appearance: 'đồng phục' } })).body.character
    await call(ctx, `/api/projects/${project.id}/canvas`, {
      method: 'PUT',
      body: {
        baseRevision: 0,
        graph: {
          schemaVersion: 1,
          nodes: [{ id: 'c1', kind: 'character', x: 0, y: 0, data: { sourceId: character.id } }],
          edges: [],
        },
      },
    })

    const blocked = await call(ctx, `/api/shared-characters/${character.id}`, { method: 'DELETE' })
    expect(blocked.status).toBe(400)
    expect(blocked.body.error.message).toContain('Canvas')

    const forced = await call(ctx, `/api/shared-characters/${character.id}?detach=1`, { method: 'DELETE' })
    expect(forced.status, JSON.stringify(forced.body)).toBe(200)
    expect(forced.body.detached.canvasNodes).toBe(1)
    expect(ctx.db.prepare('SELECT deleted_at FROM characters WHERE id = ?').get(character.id)).toMatchObject({ deleted_at: expect.any(Number) })
  })
})
