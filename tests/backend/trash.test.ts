import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { call, registerUser, seedProviderAndModel, startTestServer, waitForGeneration, type TestContext } from './helpers'
import * as mockProvider from '../../server/generations/adapters/mock'
import { maintainTrash, TRASH_RETENTION_MS, type TrashKind } from '../../server/trash/service'

let ctx: TestContext
let userId: string
beforeEach(async () => {
  ctx = await startTestServer({ providerMode: 'mock' })
  ;({ userId } = await registerUser(ctx))
})
afterEach(async () => {
  vi.restoreAllMocks()
  if (ctx) await ctx.close()
})

const kinds: TrashKind[] = ['project', 'character', 'generation', 'plan_session']
const tables = { project: 'projects', character: 'characters', generation: 'generations', plan_session: 'plan_sessions' } as const
function row(kind: TrashKind, id: string): any {
  return ctx.db.prepare(`SELECT * FROM ${tables[kind]} WHERE id=?`).get(id)
}
function deadline(kind: TrashKind, id: string) {
  const value = row(kind, id)
  return { deleted_at: value.deleted_at, purge_after: value.purge_after }
}
async function project() {
  const result = await call(ctx, '/api/projects', { method: 'POST', body: { name: 'Trash project' } })
  expect(result.status).toBe(201)
  return result.body.project
}
async function character(projectId?: string) {
  const result = await call(ctx, projectId ? `/api/projects/${projectId}/characters` : '/api/shared-characters', {
    method: 'POST', body: { name: 'Retained character', appearance: 'Blue coat', voice: { accent: 'Miền Nam' } },
  })
  expect(result.status).toBe(201)
  return result.body.character
}
// Reuse the raw-upload shape from characterReference/quickSessions tests, not the JSON call helper.
async function uploadReference(id: string, projectId?: string) {
  const path = projectId ? `/api/projects/${projectId}/characters/${id}/reference` : `/api/shared-characters/${id}/reference`
  const response = await fetch(`${ctx.baseUrl}${path}`, {
    method: 'POST', headers: { Cookie: ctx.cookie, 'Content-Type': 'image/png' }, body: mockProvider.MOCK_PNG_BYTES,
  })
  expect(response.status).toBe(201)
  return ((await response.json()) as { character: any }).character
}
async function plan(projectId?: string) {
  const result = await call(ctx, '/api/plans', {
    method: 'POST', body: { title: 'Retained plan', ...(projectId ? { kind: 'copilot', projectId } : {}) },
  })
  expect(result.status).toBe(201)
  return result.body.session
}
function seedGeneration(options: { projectId?: string; status?: string; path?: string } = {}) {
  const id = randomUUID()
  ctx.db.prepare(`INSERT INTO generations (id,user_id,project_id,kind,prompt,snap_provider,snap_base_url,snap_model_id,status,created_at,updated_at)
    VALUES (?,?,?,'image','Retained output','mock','https://mock.test/v1','mock',?,?,?)`)
    .run(id, userId, options.projectId ?? null, options.status ?? 'succeeded', Date.now(), Date.now())
  const saved = options.path ? { relativePath: options.path, mimeType: 'image/png', byteSize: 1 }
    : ctx.mediaStore.save({ userId, generationId: id, bytes: mockProvider.MOCK_PNG_BYTES })
  const assetId = randomUUID()
  ctx.db.prepare('INSERT INTO assets (id,generation_id,user_id,relative_path,mime_type,byte_size,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(assetId, id, userId, saved.relativePath, saved.mimeType, saved.byteSize, Date.now())
  return { id, assetId, path: saved.relativePath }
}
async function create(kind: TrashKind): Promise<string> {
  if (kind === 'project') return (await project()).id
  if (kind === 'character') return (await character()).id
  if (kind === 'plan_session') return (await plan()).id
  return seedGeneration().id
}
async function softDelete(kind: TrashKind, id: string, deleteResults = false) {
  if (kind === 'project') return call(ctx, `/api/projects/${id}/trash`, { method: 'POST', body: { deleteResults } })
  const route = kind === 'character' ? 'shared-characters' : kind === 'plan_session' ? 'plans' : 'generations'
  return call(ctx, `/api/${route}/${id}`, { method: 'DELETE' })
}
function restore(kind: TrashKind, id: string) {
  return call(ctx, `/api/trash/${kind}/${id}/restore`, { method: 'POST' })
}
function purge(kind: TrashKind, id: string) {
  return call(ctx, `/api/trash/${kind}/${id}`, { method: 'DELETE' })
}
function expireAt(kind: TrashKind, id: string, time: number) {
  ctx.db.prepare(`UPDATE ${tables[kind]} SET deleted_at=?,purge_after=? WHERE id=?`).run(time - TRASH_RETENTION_MS, time, id)
}
function seedBatch(sessionId: string, status = 'running', generationId?: string) {
  const id = randomUUID()
  ctx.db.prepare('INSERT INTO plan_image_batches (id,user_id,session_id,status,total,created_at,updated_at) VALUES (?,?,?,?,1,1,1)')
    .run(id, userId, sessionId, status)
  if (generationId) ctx.db.prepare(`INSERT INTO plan_image_batch_items (id,batch_id,frame_id,position,status,generation_id,created_at,updated_at)
    VALUES (?,?,'frame',0,'running',?,1,1)`).run(randomUUID(), id, generationId)
  return id
}

describe('unified trash HTTP contract', () => {
  it('returns items/counts/total across all kinds, filters and paginates without changing counts', async () => {
    const ids = await Promise.all(kinds.map(create))
    const times = kinds.map((_, index) => Date.now() - 1000 + index)
    for (const [index, kind] of kinds.entries()) {
      expect((await softDelete(kind, ids[index]!)).status).toBe(kind === 'project' ? 200 : 204)
      expireAt(kind, ids[index]!, times[index]! + TRASH_RETENTION_MS)
    }
    const result = await call(ctx, '/api/trash')
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ counts: { project: 1, character: 1, generation: 1, plan_session: 1 }, total: 4, retentionDays: 30 })
    expect(result.body.items.map((item: any) => item.id)).toEqual([...ids].reverse())
    for (const [index, kind] of kinds.entries()) {
      expect(result.body.items.find((item: any) => item.id === ids[index]!)).toMatchObject({
        kind, id: ids[index]!, title: expect.any(String), subtitle: expect.any(String),
        deletedAt: times[index]!, purgeAfter: times[index]! + TRASH_RETENTION_MS,
        meta: { projectId: null, mediaKind: kind === 'generation' ? 'image' : kind === 'plan_session' ? 'planner' : null },
      })
    }
    const paged = await call(ctx, '/api/trash?limit=2&offset=1')
    expect(paged.body.items.map((item: any) => item.id)).toEqual([...ids].reverse().slice(1, 3))
    expect(paged.body.total).toBe(4)
    const filtered = await call(ctx, '/api/trash?kind=generation')
    expect(filtered.body.items.map((item: any) => item.id)).toEqual([ids[2]!])
    expect(filtered.body.total).toBe(1)
    expect(filtered.body.counts).toEqual(result.body.counts)
    for (const query of ['kind=invalid', 'limit=0', 'limit=101', 'offset=-1', 'offset=1.5']) {
      expect((await call(ctx, `/api/trash?${query}`)).status).toBe(400)
    }
    expect((await call(ctx, '/api/trash/invalid/x/restore', { method: 'POST' })).status).toBe(400)
    expect((await call(ctx, '/api/trash/invalid/x', { method: 'DELETE' })).status).toBe(400)
    expect((await call(ctx, '/api/trash', { cookie: '' })).status).toBe(401)
  })

  it('keeps character reference metadata and media, hides deleted characters and restores without provider work', async () => {
    const p = await project()
    const c = await character(p.id)
    const uploaded = await uploadReference(c.id, p.id)
    const before = row('character', c.id)
    const imageCalls = vi.spyOn(mockProvider, 'mockImageResponse')
    const chatCalls = vi.spyOn(mockProvider, 'mockChatCompletionWithUsage')
    expect((await call(ctx, `/api/projects/${p.id}/characters/${c.id}`, { method: 'DELETE' })).status).toBe(204)
    expect(row('character', c.id)).toMatchObject({ reference_path: before.reference_path, reference_mime: before.reference_mime, reference_bytes: before.reference_bytes })
    expect(ctx.mediaStore.exists(before.reference_path)).toBe(true)
    expect((await call(ctx, `/api/projects/${p.id}/characters`)).body.characters.map((item: any) => item.id)).not.toContain(c.id)
    expect((await call(ctx, '/api/shared-characters')).body.characters.map((item: any) => item.id)).not.toContain(c.id)
    expect((await call(ctx, `/api/projects/${p.id}/characters/${c.id}`)).status).toBe(404)
    const trash = (await call(ctx, '/api/trash?kind=character')).body.items[0]
    expect(trash.thumbnailUrl).toBe(uploaded.referenceUrl)
    expect(await restore('character', c.id)).toMatchObject({ status: 200, body: { restored: { kind: 'character', id: c.id } } })
    const restored = await call(ctx, `/api/projects/${p.id}/characters/${c.id}`)
    expect(restored.body.character).toMatchObject({ id: c.id, name: c.name, appearance: c.appearance, voice: c.voice, referenceUrl: uploaded.referenceUrl })
    expect(deadline('character', c.id)).toEqual({ deleted_at: null, purge_after: null })
    const media = await fetch(`${ctx.baseUrl}${uploaded.referenceUrl}`, { headers: { Cookie: ctx.cookie } })
    expect(media.status).toBe(200)
    expect(Buffer.from(await media.arrayBuffer())).toEqual(Buffer.from(mockProvider.MOCK_PNG_BYTES))
    await ctx.worker.tick()
    expect(imageCalls).not.toHaveBeenCalled()
    expect(chatCalls).not.toHaveBeenCalled()
  })

  it('retains script, cast, timeline and chat through plan deletion/restore without rerunning providers', async () => {
    const provider = await call(ctx, '/api/providers', { method: 'POST', body: { name: 'Chat', baseUrl: 'https://llm.mock.test/v1', apiKey: 'sk-mock-chat-key' } })
    expect(provider.status).toBe(201)
    const model = await call(ctx, '/api/models', { method: 'POST', body: { providerId: provider.body.provider.id, modelId: 'mock-chat-model', kind: 'llm' } })
    expect(model.status).toBe(201)
    const session = await plan()
    expect((await call(ctx, `/api/plans/${session.id}/setup`, { method: 'PATCH', body: { chatModelId: model.body.model.id } })).status).toBe(200)
    expect((await call(ctx, `/api/plans/${session.id}/messages`, { method: 'POST', body: { content: 'A trip with two friends', target: 'script' } })).status).toBe(200)
    for (const artifact of ['script', 'cast', 'timeline']) {
      expect((await call(ctx, `/api/plans/${session.id}/${artifact}`, { method: 'POST' })).status).toBe(200)
    }
    const before = (await call(ctx, `/api/plans/${session.id}`)).body
    expect(before.session.script.scenes.length).toBeGreaterThan(0)
    expect(before.session.cast.length).toBeGreaterThan(0)
    expect(before.session.timeline.frames.length).toBeGreaterThan(0)
    expect(before.messages.length).toBeGreaterThan(0)
    const stored = row('plan_session', session.id)
    const chatCalls = vi.spyOn(mockProvider, 'mockChatCompletionWithUsage')
    const imageCalls = vi.spyOn(mockProvider, 'mockImageResponse')
    expect((await softDelete('plan_session', session.id)).status).toBe(204)
    expect(row('plan_session', session.id)).toMatchObject({ script_json: stored.script_json, cast_json: stored.cast_json, timeline_json: stored.timeline_json })
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM plan_messages WHERE session_id=?').get(session.id)).toEqual({ n: before.messages.length })
    expect((await call(ctx, '/api/plans')).body.sessions.map((item: any) => item.id)).not.toContain(session.id)
    expect((await call(ctx, `/api/plans/${session.id}`)).status).toBe(404)
    expect((await restore('plan_session', session.id)).status).toBe(200)
    const after = (await call(ctx, `/api/plans/${session.id}`)).body
    expect(after.session).toMatchObject({ script: before.session.script, cast: before.session.cast, timeline: before.session.timeline, status: before.session.status })
    expect(after.messages).toEqual(before.messages)
    await ctx.worker.tick()
    expect(chatCalls).not.toHaveBeenCalled()
    expect(imageCalls).not.toHaveBeenCalled()
  })

  it('retains generation assets, hides results and blocks sourceAssetIds until restore; no provider rerun', async () => {
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const created = await call(ctx, '/api/generations', { method: 'POST', body: { modelId: modelPk, prompt: 'A retained image' } })
    expect(created.status).toBe(202)
    const done = await waitForGeneration(ctx, created.body.generation.id)
    expect(done.status).toBe('succeeded')
    const id = done.id
    const assets = ctx.db.prepare('SELECT * FROM assets WHERE generation_id=? ORDER BY id').all(id)
    expect(assets.length).toBeGreaterThan(0)
    const imageCalls = vi.spyOn(mockProvider, 'mockImageResponse')
    expect((await softDelete('generation', id)).status).toBe(204)
    expect(ctx.db.prepare('SELECT * FROM assets WHERE generation_id=? ORDER BY id').all(id)).toEqual(assets)
    for (const asset of assets) expect(ctx.mediaStore.exists(String(asset.relative_path))).toBe(true)
    expect((await call(ctx, '/api/generations')).body.generations.map((item: any) => item.id)).not.toContain(id)
    expect((await call(ctx, `/api/generations/${id}`)).status).toBe(404)
    const blocked = await call(ctx, '/api/generations', { method: 'POST', body: { modelId: modelPk, prompt: 'Use deleted source', sourceAssetIds: [done.assets[0].id] } })
    expect(blocked.status).toBe(400)
    expect(blocked.body.error.messageKey).toBe('generations.source_image_not_owned')
    expect((await restore('generation', id)).status).toBe(200)
    await ctx.worker.tick()
    expect(imageCalls).not.toHaveBeenCalled()
    expect((await call(ctx, `/api/generations/${id}`)).body.generation).toMatchObject({ id, status: 'succeeded', assets: done.assets })
    expect((await call(ctx, '/api/generations')).body.generations.map((item: any) => item.id)).toContain(id)
    const derived = await call(ctx, '/api/generations', { method: 'POST', body: { modelId: modelPk, prompt: 'Use restored source', sourceAssetIds: [done.assets[0].id] } })
    expect(derived.status).toBe(202)
    expect((await waitForGeneration(ctx, derived.body.generation.id)).status).toBe('succeeded')
  })

  it('isolates listing, restore, permanent deletion and empty-trash between owners', async () => {
    const ids = await Promise.all(kinds.map(create))
    for (const [index, kind] of kinds.entries()) await softDelete(kind, ids[index]!)
    const ownerCookie = ctx.cookie
    await registerUser(ctx)
    expect((await call(ctx, '/api/trash')).body).toMatchObject({ items: [], total: 0, counts: { project: 0, character: 0, generation: 0, plan_session: 0 } })
    for (const [index, kind] of kinds.entries()) {
      expect((await restore(kind, ids[index]!)).status).toBe(404)
      expect((await purge(kind, ids[index]!)).status).toBe(404)
      expect((await softDelete(kind, ids[index]!)).status).toBe(404)
    }
    expect((await call(ctx, '/api/trash', { method: 'DELETE' })).body).toEqual({ purged: 0, blocked: 0, failed: 0 })
    for (const [index, kind] of kinds.entries()) expect(row(kind, ids[index]!)).toBeTruthy()
    ctx.cookie = ownerCookie
    expect((await call(ctx, '/api/trash')).body.total).toBe(4)
  })

  it.each(kinds)('repeated %s deletion keeps the original 30-day deadline', async (kind) => {
    const id = await create(kind)
    expect((await softDelete(kind, id)).status).toBe(kind === 'project' ? 200 : 204)
    const first = deadline(kind, id)
    expect(first.purge_after - first.deleted_at).toBe(TRASH_RETENTION_MS)
    // Move the original deletion into the past so a new Date.now() cannot accidentally compare equal.
    expireAt(kind, id, first.purge_after - 10_000)
    const original = deadline(kind, id)
    expect((await softDelete(kind, id, true)).status).toBe(kind === 'project' ? 200 : 204)
    expect(deadline(kind, id)).toEqual(original)
    if (kind === 'project') expect(row(kind, id).delete_results).toBe(0)
  })

  it('repeated project-character deletion is idempotent too', async () => {
    const p = await project(), c = await character(p.id)
    const path = `/api/projects/${p.id}/characters/${c.id}`
    expect((await call(ctx, path, { method: 'DELETE' })).status).toBe(204)
    const original = deadline('character', c.id)
    expireAt('character', c.id, original.purge_after - 10_000)
    const first = deadline('character', c.id)
    expect((await call(ctx, path, { method: 'DELETE' })).status).toBe(204)
    expect(deadline('character', c.id)).toEqual(first)
  })

  it.each(kinds)('permanent deletion rejects nontrashed %s and deletes only a trashed item', async (kind) => {
    const id = await create(kind)
    const rejected = await purge(kind, id)
    expect(rejected.status).toBe(400)
    expect(rejected.body.error.messageKey).toBe('trash.not_trashed')
    expect(row(kind, id)).toBeTruthy()
    expect((await softDelete(kind, id)).status).toBe(kind === 'project' ? 200 : 204)
    expect(await purge(kind, id)).toMatchObject({ status: 200, body: { purged: 1 } })
    expect(row(kind, id)).toBeUndefined()
    expect((await purge(kind, id)).status).toBe(404)
    expect((await restore(kind, id)).status).toBe(404)
    expect(ctx.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('empty-trash purges all four kinds but never touches nontrashed data', async () => {
    const active = await Promise.all(kinds.map(create))
    const deleted = await Promise.all(kinds.map(create))
    for (const [index, kind] of kinds.entries()) await softDelete(kind, deleted[index]!)
    expect(await call(ctx, '/api/trash', { method: 'DELETE' })).toMatchObject({ status: 200, body: { purged: 4, blocked: 0, failed: 0 } })
    for (const [index, kind] of kinds.entries()) {
      expect(row(kind, deleted[index]!)).toBeUndefined()
      expect(row(kind, active[index]!)).toBeTruthy()
    }
    expect((await call(ctx, '/api/trash')).body.total).toBe(0)
    expect((await call(ctx, '/api/trash', { method: 'DELETE' })).body).toEqual({ purged: 0, blocked: 0, failed: 0 })
  })

  it('requires restoring the parent project before restoring a project character', async () => {
    const p = await project(), c = await character(p.id)
    await uploadReference(c.id, p.id)
    expect((await call(ctx, `/api/projects/${p.id}/characters/${c.id}`, { method: 'DELETE' })).status).toBe(204)
    await softDelete('project', p.id)
    const first = deadline('character', c.id)
    const blocked = await restore('character', c.id)
    expect(blocked.status).toBe(400)
    expect(blocked.body.error.messageKey).toBe('trash.parent_required')
    expect(deadline('character', c.id)).toEqual(first)
    expect((await restore('project', p.id)).status).toBe(200)
    expect((await restore('character', c.id)).status).toBe(200)
    expect((await call(ctx, `/api/projects/${p.id}/characters/${c.id}`)).status).toBe(200)
  })
})

describe('busy trash safeguards', () => {
  it('permanent and empty-trash reject a trashed project whose work becomes active', async () => {
    const p = await project()
    const g = seedGeneration({ projectId: p.id })
    await softDelete('project', p.id, true)
    ctx.db.prepare("UPDATE generations SET status='running' WHERE id=?").run(g.id)
    const blocked = await purge('project', p.id)
    expect(blocked.status).toBe(400)
    expect(blocked.body.error.messageKey).toBe('trash.busy')
    expect((await call(ctx, '/api/trash', { method: 'DELETE' })).body).toEqual({ purged: 0, blocked: 1, failed: 0 })
    expect(row('project', p.id)).toBeTruthy()
    expect(row('generation', g.id)).toBeTruthy()
    ctx.db.prepare("UPDATE generations SET status='succeeded' WHERE id=?").run(g.id)
    expect((await purge('project', p.id)).status).toBe(200)
    expect(row('project', p.id)).toBeUndefined()
    expect(row('generation', g.id)).toBeUndefined()
  })

  it('guards a finished generation while an export is using it', async () => {
    const p = await project(), g = seedGeneration()
    const exportId = randomUUID()
    ctx.db.prepare(`INSERT INTO exports (id,user_id,project_id,status,spec_json,created_at,updated_at)
      VALUES (?,?,?,'running',?,1,1)`).run(exportId, userId, p.id, JSON.stringify({ generationId: g.id }))
    expect((await softDelete('generation', g.id)).status).toBe(400)
    ctx.db.prepare("UPDATE exports SET status='succeeded' WHERE id=?").run(exportId)
    expect((await softDelete('generation', g.id)).status).toBe(204)
    ctx.db.prepare("UPDATE exports SET status='queued' WHERE id=?").run(exportId)
    expect((await purge('generation', g.id)).status).toBe(400)
    expect((await call(ctx, '/api/trash', { method: 'DELETE' })).body).toEqual({ purged: 0, blocked: 1, failed: 0 })
    expect(ctx.mediaStore.exists(g.path)).toBe(true)
  })

  it.each(['queued', 'running', 'downloading', 'unknown'])('blocks soft/permanent/empty deletion of %s generations', async (status) => {
    const g = seedGeneration({ status })
    expect((await softDelete('generation', g.id)).status).toBe(400)
    expect(deadline('generation', g.id)).toEqual({ deleted_at: null, purge_after: null })
    // Simulate work becoming active after a delete; destructive paths must recheck activity.
    expireAt('generation', g.id, Date.now() + TRASH_RETENTION_MS)
    const permanent = await purge('generation', g.id)
    expect(permanent.status).toBe(400)
    expect(permanent.body.error.messageKey).toBe('trash.busy')
    expect((await call(ctx, '/api/trash', { method: 'DELETE' })).body).toEqual({ purged: 0, blocked: 1, failed: 0 })
    expect(row('generation', g.id)).toBeTruthy()
    expect(ctx.mediaStore.exists(g.path)).toBe(true)
  })

  it('guards a running plan batch even without a generation, then guards unresolved items in a stopped batch', async () => {
    const session = await plan()
    const batch = seedBatch(session.id)
    expect((await softDelete('plan_session', session.id)).status).toBe(400)
    expect(deadline('plan_session', session.id)).toEqual({ deleted_at: null, purge_after: null })
    ctx.db.prepare("UPDATE plan_image_batches SET status='stopped' WHERE id=?").run(batch)
    const g = seedGeneration({ status: 'unknown' })
    ctx.db.prepare(`INSERT INTO plan_image_batch_items (id,batch_id,frame_id,position,status,generation_id,created_at,updated_at)
      VALUES (?,?,'frame',0,'stopped',?,1,1)`).run(randomUUID(), batch, g.id)
    expect((await softDelete('plan_session', session.id)).status).toBe(400)
    ctx.db.prepare("UPDATE generations SET status='failed' WHERE id=?").run(g.id)
    expect((await softDelete('plan_session', session.id)).status).toBe(204)
    ctx.db.prepare("UPDATE generations SET status='running' WHERE id=?").run(g.id)
    expect((await purge('plan_session', session.id)).status).toBe(400)
    expect((await call(ctx, '/api/trash', { method: 'DELETE' })).body).toEqual({ purged: 0, blocked: 1, failed: 0 })
    ctx.db.prepare("UPDATE generations SET status='failed' WHERE id=?").run(g.id)
    expect((await purge('plan_session', session.id)).status).toBe(200)
    expect(ctx.db.prepare('SELECT id FROM plan_image_batches WHERE id=?').get(batch)).toBeUndefined()
    expect(row('generation', g.id)).toBeTruthy()
  })
})

describe('trash expiry and media maintenance', () => {
  it.each(kinds)('retains %s strictly before its deadline and permits restore', async (kind) => {
    const id = await create(kind)
    await softDelete(kind, id)
    const time = Date.now() + 60_000
    expireAt(kind, id, time)
    expect(maintainTrash({ db: ctx.db, mediaStore: ctx.mediaStore, now: time - 1 })).toEqual({ purged: 0, failed: 0, cleaned: 0 })
    expect(row(kind, id)).toBeTruthy()
    expect((await restore(kind, id)).status).toBe(200)
    expect(deadline(kind, id)).toEqual({ deleted_at: null, purge_after: null })
  })

  it.each(kinds.flatMap(kind => [0, 1].map(after => ({ kind, after }))))('purges $kind at deadline + $after ms and rejects expired restore', async ({ kind, after }) => {
    const id = await create(kind)
    await softDelete(kind, id)
    const time = Date.now() - after
    expireAt(kind, id, time)
    const blocked = await restore(kind, id)
    expect(blocked.status).toBe(400)
    expect(blocked.body.error.messageKey).toBe('trash.expired')
    expect(maintainTrash({ db: ctx.db, mediaStore: ctx.mediaStore, now: time + after }).purged).toBe(1)
    expect(row(kind, id)).toBeUndefined()
    expect((await call(ctx, '/api/trash')).body.total).toBe(0)
    expect(ctx.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('retries failed media cleanup after committing permanent deletion', async () => {
    const c = await character()
    await uploadReference(c.id)
    const path = row('character', c.id).reference_path
    await softDelete('character', c.id)
    const remove = vi.spyOn(ctx.mediaStore, 'removeByPath').mockImplementationOnce(() => { throw new Error('temporary filesystem failure') })
    expect((await purge('character', c.id)).status).toBe(200)
    expect(row('character', c.id)).toBeUndefined()
    expect(ctx.mediaStore.exists(path)).toBe(true)
    expect(ctx.db.prepare('SELECT path,last_error FROM media_cleanup_jobs').all()).toEqual([{ path, last_error: expect.stringContaining('temporary filesystem failure') }])
    const result = maintainTrash({ db: ctx.db, mediaStore: ctx.mediaStore, now: Date.now() + 1 })
    expect(result).toEqual({ purged: 0, failed: 0, cleaned: 1 })
    expect(remove).toHaveBeenCalledTimes(2)
    expect(ctx.mediaStore.exists(path)).toBe(false)
    expect(ctx.db.prepare('SELECT id FROM media_cleanup_jobs').all()).toEqual([])
  })

  it('keeps shared media paths referenced by active or trashed rows until the final owner is purged', async () => {
    const g = seedGeneration()
    const c = await character()
    ctx.db.prepare("UPDATE characters SET reference_path=?,reference_mime='image/png',reference_bytes=1 WHERE id=?").run(g.path, c.id)
    const remove = vi.spyOn(ctx.mediaStore, 'removeByPath')
    await softDelete('generation', g.id)
    expect((await purge('generation', g.id)).status).toBe(200)
    expect(ctx.mediaStore.exists(g.path)).toBe(true)
    expect(remove).not.toHaveBeenCalled()
    await softDelete('character', c.id)
    expect(maintainTrash({ db: ctx.db, mediaStore: ctx.mediaStore }).cleaned).toBe(0)
    expect(ctx.mediaStore.exists(g.path)).toBe(true)
    expect((await purge('character', c.id)).status).toBe(200)
    expect(remove).toHaveBeenCalledWith(g.path)
    expect(ctx.mediaStore.exists(g.path)).toBe(false)
    expect(ctx.db.prepare('SELECT id FROM media_cleanup_jobs').all()).toEqual([])
  })

  it('retains a purged asset path used by a source snapshot until the dependent generation is purged', async () => {
    const source = seedGeneration(), dependent = seedGeneration()
    ctx.db.prepare('UPDATE generations SET source_images_json=? WHERE id=?')
      .run(JSON.stringify([{ path: source.path, mime: 'image/png' }]), dependent.id)
    const remove = vi.spyOn(ctx.mediaStore, 'removeByPath')
    await softDelete('generation', source.id)
    expect((await purge('generation', source.id)).status).toBe(200)
    expect(row('generation', source.id)).toBeUndefined()
    expect(ctx.mediaStore.exists(source.path)).toBe(true)
    expect(remove).not.toHaveBeenCalled()
    await softDelete('generation', dependent.id)
    expect(maintainTrash({ db: ctx.db, mediaStore: ctx.mediaStore }).cleaned).toBe(0)
    expect(ctx.mediaStore.exists(source.path)).toBe(true)
    expect((await purge('generation', dependent.id)).status).toBe(200)
    expect(remove).toHaveBeenCalledWith(source.path)
    expect(remove).toHaveBeenCalledWith(dependent.path)
    expect(ctx.mediaStore.exists(source.path)).toBe(false)
    expect(ctx.db.prepare('SELECT id FROM media_cleanup_jobs').all()).toEqual([])
  })

  it('preserves independently trashed character/generation deadlines when their project is purged with deleteResults', async () => {
    const p = await project(), c = await character(p.id)
    await uploadReference(c.id, p.id)
    const charPath = row('character', c.id).reference_path
    const g = seedGeneration({ projectId: p.id })
    expect((await call(ctx, `/api/projects/${p.id}/characters/${c.id}`, { method: 'DELETE' })).status).toBe(204)
    await softDelete('generation', g.id)
    await softDelete('project', p.id, true)
    const time = Date.now() + 10_000
    expireAt('project', p.id, time)
    expireAt('character', c.id, time + 100)
    expireAt('generation', g.id, time + 200)
    const charDeadline = deadline('character', c.id), genDeadline = deadline('generation', g.id)
    expect(maintainTrash({ db: ctx.db, mediaStore: ctx.mediaStore, now: time }).purged).toBe(1)
    expect(row('project', p.id)).toBeUndefined()
    expect(row('character', c.id)).toMatchObject({ project_id: null, ...charDeadline })
    expect(row('generation', g.id)).toMatchObject({ project_id: null, ...genDeadline })
    expect(ctx.mediaStore.exists(charPath)).toBe(true)
    expect(ctx.mediaStore.exists(g.path)).toBe(true)
    expect(maintainTrash({ db: ctx.db, mediaStore: ctx.mediaStore, now: time + 99 }).purged).toBe(0)
    expect(maintainTrash({ db: ctx.db, mediaStore: ctx.mediaStore, now: time + 100 }).purged).toBe(1)
    expect(row('character', c.id)).toBeUndefined()
    expect(ctx.mediaStore.exists(charPath)).toBe(false)
    expect(row('generation', g.id)).toMatchObject(genDeadline)
    expect(ctx.mediaStore.exists(g.path)).toBe(true)
    expect(maintainTrash({ db: ctx.db, mediaStore: ctx.mediaStore, now: time + 200 }).purged).toBe(1)
    expect(row('generation', g.id)).toBeUndefined()
    expect(ctx.mediaStore.exists(g.path)).toBe(false)
    expect(ctx.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
})
