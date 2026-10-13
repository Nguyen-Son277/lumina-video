import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validateCanvasGraph, type CanvasGraph } from '../../shared/canvas'
import { createLibraryAsset, saveLibraryAssetReference } from '../../server/entityLibrary/service'
import { retainedPathReferenced, uploadReferenced } from '../../server/entityLibrary/lifecycle'
import { buildSpec, videoAssetFor } from '../../server/exports/service'
import { cleanMediaJobs, maintainProjectTrash } from '../../server/projectsTrash/service'
import { purgeTrashItem } from '../../server/trash/service'
import { MOCK_PNG_BYTES } from '../../server/generations/adapters/mock'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'

/** Synthetic local fixtures only: stopped worker and a fail-closed HTTP guard. */
describe('entity hardening: confirmed Canvas runs and retained local media', () => {
  let ctx: TestContext
  let userId: string
  let outsideRequests: string[]

  beforeEach(async () => {
    ctx = await startTestServer({ providerMode: 'mock' })
    await ctx.worker.stop()
    ;({ userId } = await registerUser(ctx))
    outsideRequests = []
    const localFetch = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (!url.startsWith(`${ctx.baseUrl}/`)) {
        outsideRequests.push(url)
        throw new Error('Unexpected non-local HTTP request in synthetic test')
      }
      return localFetch(input, init)
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    if (ctx) await ctx.close()
    expect(outsideRequests).toEqual([])
  })

  async function project() {
    const created = await call(ctx, '/api/projects', { method: 'POST', body: { name: 'Hardening fixture', style: 'cinematic' } })
    expect(created.status).toBe(201)
    return created.body.project.id as string
  }

  async function canvas(kind: 'image' | 'video', withReference = false) {
    const projectId = await project()
    const { modelPk } = await seedProviderAndModel(ctx, kind)
    let sceneId: string | undefined
    if (kind === 'video') {
      const result = await call(ctx, `/api/projects/${projectId}/scenes`, { method: 'POST', body: {
        title: 'Synthetic scene', prompt: 'A quiet studio', dialogue: '', modelId: modelPk,
        params: { seconds: 5, useCharacterReference: false },
      } })
      expect(result.status).toBe(201)
      sceneId = result.body.scene.id
    }
    const graph: CanvasGraph = {
      schemaVersion: 1,
      nodes: [
        { id: 'prompt', kind: 'prompt', x: 0, y: 0, data: { text: 'Photograph a quiet studio' } },
        { id: 'output', kind, x: 300, y: 0, data: { modelId: modelPk, ...(sceneId ? { sceneId } : {}) } },
      ],
      edges: [{ id: 'text', source: 'prompt', sourcePort: 'prompt', target: 'output', targetPort: 'prompt' }],
    }
    let referencePath: string | undefined
    let entityId: string | undefined
    if (withReference) {
      const entity = saveLibraryAssetReference(ctx.db, ctx.env, ctx.mediaStore, userId,
        createLibraryAsset(ctx.db, userId, { kind: 'item', name: 'Synthetic camera' }).id, MOCK_PNG_BYTES)
      referencePath = entity.reference!.path
      entityId = entity.id
      graph.nodes.push({ id: 'item', kind: 'library', x: 0, y: 160, data: { entityKind: 'item', sourceId: entity.id } })
      graph.edges.push({ id: 'context', source: 'item', sourcePort: 'object', target: 'output', targetPort: 'context' })
    }
    expect((await call(ctx, `/api/projects/${projectId}/canvas`, { method: 'PUT', body: { graph, baseRevision: 0 } })).status).toBe(200)
    const preview = await call(ctx, `/api/projects/${projectId}/canvas/nodes/output/preview`, { method: 'POST', body: { kind } })
    expect(preview.status).toBe(200)
    expect(preview.body.preview.stamp).toEqual(expect.any(String))
    return { projectId, modelPk, sceneId, graph, referencePath, entityId, stamp: preview.body.preview.stamp as string }
  }

  function queueCounts() {
    return {
      generations: Number(ctx.db.prepare('SELECT COUNT(*) AS n FROM generations').get()!.n),
      runs: Number(ctx.db.prepare('SELECT COUNT(*) AS n FROM project_canvas_runs').get()!.n),
      grants: Number(ctx.db.prepare('SELECT COUNT(*) AS n FROM temporary_media_grants').get()!.n),
    }
  }

  it.each(['scene params', 'scene dialogue', 'project style'] as const)(
    'rejects a confirmed video preview after %s changes without enqueueing work', async change => {
      const fixture = await canvas('video')
      const before = queueCounts()
      const result = change === 'project style'
        ? await call(ctx, `/api/projects/${fixture.projectId}`, { method: 'PATCH', body: { style: 'watercolour' } })
        : await call(ctx, `/api/projects/${fixture.projectId}/scenes/${fixture.sceneId}`, { method: 'PATCH', body:
          change === 'scene params' ? { params: { seconds: 8, useCharacterReference: false } } : { dialogue: 'Revised dialogue' } })
      expect(result.status).toBe(200)
      const run = await call(ctx, `/api/projects/${fixture.projectId}/canvas/nodes/output/run`, { method: 'POST', body: {
        kind: 'video', modelId: fixture.modelPk, stamp: fixture.stamp,
      } })
      expect(run.status).toBe(400)
      expect(run.body.error.messageKey).toBe('canvas.preview_stale')
      expect(queueCounts()).toEqual(before)
    },
  )

  it.each(['image', 'video'] as const)('returns a public %s generation and sanitized synthetic reference manifest', async kind => {
    const fixture = await canvas(kind, true)
    const endpoint = `/api/projects/${fixture.projectId}/canvas/nodes/output/run`
    const body = { kind, modelId: fixture.modelPk, stamp: fixture.stamp, idempotencyKey: randomUUID() }
    const first = await call(ctx, endpoint, { method: 'POST', body })
    expect(first.status).toBe(202)
    expect(first.body.generation).toMatchObject({ kind, modelId: fixture.modelPk, status: 'queued' })
    expect(first.body.generation.id).toEqual(expect.any(String))
    expect(JSON.stringify(first.body)).not.toContain(fixture.referencePath)
    const id = first.body.generation.id as string
    const stored = ctx.db.prepare('SELECT * FROM generations WHERE id=?').get(id)!
    expect(stored.attempt_count).toBe(0)
    expect(String(stored.entity_references_json)).toContain(fixture.referencePath)

    // Replay the same local idempotency result with synthetic internal metadata.
    // No provider URL is fetched, and no secret belongs to an external service.
    const token = 'synthetic-media-token-not-a-real-credential'
    const temporaryUrl = `${ctx.env.APP_ORIGIN}/api/provider-media/${token}`
    const params = { ...JSON.parse(String(stored.params_json)), referenceImages: [temporaryUrl] }
    const manifest = [{ id: fixture.entityId, kind: 'item', name: 'Synthetic camera', referenceMode: 'sent', reference: { path: fixture.referencePath, mime: 'image/png' } }]
    const snapshot = { ...JSON.parse(String(stored.prompt_snapshot_json)), entities: manifest }
    ctx.db.prepare('UPDATE generations SET params_json=?,entity_references_json=?,prompt_snapshot_json=?,source_images_json=?,provider_result_url=? WHERE id=?')
      .run(JSON.stringify(params), JSON.stringify(manifest), JSON.stringify(snapshot), JSON.stringify([{ path: fixture.referencePath, mime: 'image/png' }]), temporaryUrl, id)
    const replay = await call(ctx, endpoint, { method: 'POST', body })
    expect(replay.status).toBe(202)
    expect(replay.body.generation).toMatchObject({ id, kind, modelId: fixture.modelPk, status: 'queued', sourceImageCount: 1 })
    expect(replay.body.generation.promptSnapshot.entities).toEqual([
      expect.objectContaining({ id: fixture.entityId, kind: 'item', referenceMode: 'sent' }),
    ])
    expect(replay.body.generation.promptSnapshot.entities[0]).not.toHaveProperty('reference')
    for (const key of ['params_json', 'entity_references_json', 'source_images_json', 'provider_result_url', 'user_id', 'snap_base_url']) {
      expect(replay.body.generation).not.toHaveProperty(key)
    }
    const serialized = JSON.stringify(replay.body)
    for (const privateValue of [fixture.referencePath!, ctx.dir, token, '/api/provider-media/', 'sk-mock-key-for-tests']) {
      expect(serialized).not.toContain(privateValue)
    }
    expect(ctx.db.prepare('SELECT attempt_count FROM generations WHERE id=?').get(id)!.attempt_count).toBe(0)
    expect(queueCounts().generations).toBe(1)
  })

  function syntheticVideo(projectId: string, sceneId: string) {
    const id = randomUUID(), originalId = randomUUID(), derivedId = randomUUID(), now = Date.now()
    ctx.db.prepare(`INSERT INTO generations (id,user_id,project_id,scene_id,kind,prompt,snap_provider,snap_base_url,snap_model_id,status,postprocess_status,created_at,updated_at,completed_at)
      VALUES (?,?,?,?,'video','Synthetic clip','mock','https://mock.test/v1','mock','succeeded','succeeded',?,?,?)`)
      .run(id, userId, projectId, sceneId, now, now, now)
    const originalPath = `${userId}/synthetic/original.mp4`, derivedPath = `${userId}/synthetic/logo-overlay.mp4`
    ctx.db.prepare("INSERT INTO assets (id,generation_id,user_id,relative_path,mime_type,byte_size,variant,created_at) VALUES (?,?,?,?,'video/mp4',10,'original',?)")
      .run(originalId, id, userId, originalPath, now)
    ctx.db.prepare("INSERT INTO assets (id,generation_id,user_id,relative_path,mime_type,byte_size,variant,source_asset_id,created_at) VALUES (?,?,?,?,'video/mp4',10,'logo_overlay',?,?)")
      .run(derivedId, id, userId, derivedPath, originalId, now + 1)
    ctx.db.prepare('UPDATE scenes SET selected_generation_id=? WHERE id=?').run(id, sceneId)
    return { id, originalId, derivedId, originalPath, derivedPath }
  }

  async function exportFixture() {
    const projectId = await project(), sceneId = randomUUID()
    ctx.db.prepare("INSERT INTO scenes (id,project_id,title,position,created_at,updated_at) VALUES (?,?,'Synthetic export scene',0,1,1)").run(sceneId, projectId)
    return { projectId, sceneId, ...syntheticVideo(projectId, sceneId) }
  }

  it('resolves automatic and explicit export specs to the derived logo overlay, not the original', async () => {
    const fixture = await exportFixture()
    const items = [{ sceneId: fixture.sceneId, generationId: fixture.id }]
    for (const requested of [undefined, items]) {
      const spec = buildSpec(ctx.db, userId, fixture.projectId, requested, 30)
      expect(spec.items).toEqual([{ ...items[0], assetId: fixture.derivedId }])
      const selected = videoAssetFor(ctx.db, userId, spec.items[0]!.sceneId, spec.items[0]!.generationId, spec.items[0]!.assetId)
      expect(selected).toEqual({ id: fixture.derivedId, path: fixture.derivedPath, mime: 'video/mp4' })
      expect(selected.path).not.toBe(fixture.originalPath)
    }
  })

  it.each(['queued', 'running'])('rejects export specs while local logo postprocess is %s', async status => {
    const fixture = await exportFixture()
    ctx.db.prepare('UPDATE generations SET postprocess_status=? WHERE id=?').run(status, fixture.id)
    const items = [{ sceneId: fixture.sceneId, generationId: fixture.id }]
    expect(() => videoAssetFor(ctx.db, userId, fixture.sceneId, fixture.id)).toThrow()
    expect(() => buildSpec(ctx.db, userId, fixture.projectId, items, 30)).toThrow()
    expect(() => buildSpec(ctx.db, userId, fixture.projectId, undefined, 30)).toThrow()
  })

  it.each(['queued', 'running'])('blocks explicit and maintenance project purge while logo postprocess is %s', async status => {
    const fixture = await exportFixture(), now = Date.now()
    ctx.db.prepare('UPDATE projects SET deleted_at=?,purge_after=?,delete_results=1 WHERE id=?').run(now - 1000, now - 1, fixture.projectId)
    ctx.db.prepare('UPDATE generations SET postprocess_status=? WHERE id=?').run(status, fixture.id)
    expect(() => purgeTrashItem(ctx.db, userId, 'project', fixture.projectId, now)).toThrow()
    expect(maintainProjectTrash({ db: ctx.db, mediaStore: ctx.mediaStore, now }).purged).toBe(0)
    expect(ctx.db.prepare('SELECT id FROM projects WHERE id=?').get(fixture.projectId)).toBeDefined()
    expect(ctx.db.prepare('SELECT id FROM generations WHERE id=?').get(fixture.id)).toBeDefined()
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM media_cleanup_jobs').get()!.n).toBe(0)
    ctx.db.prepare("UPDATE generations SET postprocess_status='succeeded' WHERE id=?").run(fixture.id)
    expect(maintainProjectTrash({ db: ctx.db, mediaStore: ctx.mediaStore, now }).purged).toBe(1)
    expect(ctx.db.prepare('SELECT id FROM projects WHERE id=?').get(fixture.projectId)).toBeUndefined()
  })

  it.each(['pending', 'done'])('retains source upload referenced only by a %s plan-image-batch snapshot', async status => {
    const uploadId = randomUUID(), sessionId = randomUUID(), batchId = randomUUID(), itemId = randomUUID(), now = Date.now()
    const saved = ctx.mediaStore.saveUpload({ userId, uploadId, bytes: MOCK_PNG_BYTES, maxBytes: ctx.env.MAX_SOURCE_IMAGE_BYTES })
    ctx.db.prepare('INSERT INTO uploads (id,user_id,relative_path,mime_type,byte_size,created_at) VALUES (?,?,?,?,?,?)')
      .run(uploadId, userId, saved.relativePath, saved.mimeType, saved.byteSize, now)
    ctx.db.prepare('INSERT INTO plan_sessions (id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?)').run(sessionId, userId, 'Retained batch', now, now)
    ctx.db.prepare("INSERT INTO plan_image_batches (id,user_id,session_id,status,total,created_at,updated_at) VALUES (?,?,?,'done',1,?,?)")
      .run(batchId, userId, sessionId, now, now)
    ctx.db.prepare('INSERT INTO plan_image_batch_items (id,batch_id,frame_id,position,status,snapshot_json,created_at,updated_at) VALUES (?,?,?,0,?,?,?,?)')
      .run(itemId, batchId, 'synthetic-frame', status, JSON.stringify({ sourceUploadIds: [uploadId], sourceImages: [{ path: saved.relativePath, mime: saved.mimeType }] }), now, now)
    ctx.db.prepare("INSERT INTO media_cleanup_jobs (id,user_id,kind,target_id,path,created_at) VALUES (?,?,'orphan_upload',?,?,?)")
      .run(randomUUID(), userId, uploadId, saved.relativePath, now)
    expect(uploadReferenced(ctx.db, uploadId, saved.relativePath, now)).toBe(true)
    expect(retainedPathReferenced(ctx.db, saved.relativePath, now)).toBe(true)
    expect((await call(ctx, `/api/uploads/${uploadId}`, { method: 'DELETE' })).status).toBe(400)
    expect(cleanMediaJobs({ db: ctx.db, mediaStore: ctx.mediaStore, now }).cleaned).toBe(0)
    expect(ctx.db.prepare('SELECT id FROM uploads WHERE id=?').get(uploadId)).toBeDefined()
    expect(ctx.mediaStore.exists(saved.relativePath)).toBe(true)
    ctx.db.prepare('DELETE FROM plan_image_batch_items WHERE id=?').run(itemId)
    expect(uploadReferenced(ctx.db, uploadId, saved.relativePath, now)).toBe(false)
    expect(cleanMediaJobs({ db: ctx.db, mediaStore: ctx.mediaStore, now: now + 1 }).cleaned).toBe(1)
    expect(ctx.db.prepare('SELECT id FROM uploads WHERE id=?').get(uploadId)).toBeUndefined()
    expect(ctx.mediaStore.exists(saved.relativePath)).toBe(false)
  })
})

describe('prototype-safe Canvas vocabulary validation', () => {
  it.each(['constructor', 'toString'])('rejects inherited object key %s as a node kind without throwing', kind => {
    const graph = { schemaVersion: 1, nodes: [{ id: 'node', kind, x: 0, y: 0, data: {} }], edges: [] }
    expect(() => validateCanvasGraph(graph)).not.toThrow()
    expect(validateCanvasGraph(graph)).toContainEqual(expect.objectContaining({ code: 'node_unknown_kind', id: 'node' }))
  })

  it.each(['sourcePort', 'targetPort'] as const)('rejects inherited %s names without throwing or accepting a wire', field => {
    const graph = {
      schemaVersion: 1,
      nodes: [
        { id: 'text', kind: 'prompt', x: 0, y: 0, data: {} },
        { id: 'image', kind: 'image', x: 200, y: 0, data: {} },
      ],
      edges: [{ id: 'wire', source: 'text', sourcePort: 'prompt', target: 'image', targetPort: 'prompt', [field]: 'toString' }],
    }
    expect(() => validateCanvasGraph(graph)).not.toThrow()
    expect(validateCanvasGraph(graph)).toContainEqual(expect.objectContaining({ code: 'edge_port_missing', id: 'wire' }))
  })
})
