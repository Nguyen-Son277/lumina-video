import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'
import { sweepAutoGenerate } from '../../server/generations/sweeper'
import { maintainProjectTrash } from '../../server/projectsTrash/service'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { if (ctx) await ctx.close() })
const DAY = 24 * 60 * 60 * 1000
async function project(name = 'Trash regression') {
  const result = await call(ctx, '/api/projects', { method: 'POST', body: { name } })
  expect(result.status).toBe(201)
  return result.body.project
}
function generation(id: string, userId: string, projectId: string, status = 'succeeded', path?: string) {
  ctx.db.prepare(`INSERT INTO generations (id,user_id,project_id,kind,prompt,snap_provider,snap_base_url,snap_model_id,status,created_at,updated_at) VALUES (?,?,?,'image','test','mock','https://mock.test','mock',?,1,1)`).run(id, userId, projectId, status)
  if (path) ctx.db.prepare(`INSERT INTO assets (id,generation_id,user_id,relative_path,mime_type,byte_size,created_at) VALUES (?,?,?,?,'image/png',1,1)`).run(`asset-${id}`, id, userId, path)
}
async function trash(id: string, deleteResults = false) {
  return call(ctx, `/api/projects/${id}/trash`, { method: 'POST', body: { deleteResults } })
}
function expire(id: string, now = Date.now()) {
  ctx.db.prepare('UPDATE projects SET purge_after=? WHERE id=?').run(now - 1, id)
  return now
}

describe('project trash API', () => {
  it('isolates owners, hides trash normally, and preserves the first deadline/options', async () => {
    await registerUser(ctx)
    const p = await project()
    const ownerCookie = ctx.cookie
    await registerUser(ctx)
    expect((await trash(p.id)).status).toBe(404)
    expect((await call(ctx, `/api/projects/${p.id}/restore`, { method: 'POST' })).status).toBe(404)
    ctx.cookie = ownerCookie
    const first = await trash(p.id)
    expect(first.status).toBe(200)
    expect(first.body.project.deleteResults).toBe(false)
    expect(first.body.project.purgeAfter - first.body.project.deletedAt).toBe(30 * DAY)
    expect((await trash(p.id, true)).body.project).toEqual(first.body.project)
    expect((await call(ctx, '/api/projects')).body.projects.map((v: any) => v.id)).not.toContain(p.id)
    expect((await call(ctx, '/api/projects?trash=true')).body.projects.map((v: any) => v.id)).toContain(p.id)
  })
  it('restores archived state but disables automatic generation; expires at the deadline', async () => {
    await registerUser(ctx)
    const p = await project()
    ctx.db.prepare('UPDATE projects SET archived=1 WHERE id=?').run(p.id)
    ctx.db.prepare(`INSERT INTO scenes (id,project_id,title,position,auto_generate,approved,created_at,updated_at) VALUES (?,?, 'pending',0,1,1,1,1)`).run(`scene-${p.id}`, p.id)
    await trash(p.id)
    const restored = await call(ctx, `/api/projects/${p.id}/restore`, { method: 'POST' })
    expect(restored.status).toBe(200)
    expect(restored.body.project.archived).toBe(true)
    expect(restored.body.project.deletedAt).toBeNull()
    expect(restored.body.project.purgeAfter).toBeNull()
    expect(ctx.db.prepare('SELECT auto_generate FROM scenes WHERE project_id=?').get(p.id)).toEqual({ auto_generate: 0 })
    expect((await call(ctx, `/api/projects/${p.id}/restore`, { method: 'POST' })).status).toBe(400)
    await trash(p.id)
    expire(p.id)
    expect((await call(ctx, `/api/projects/${p.id}/restore`, { method: 'POST' })).status).toBe(400)
  })
  it.each(['queued', 'running', 'downloading', 'unknown'])('rejects trash while generation is %s', async (status) => {
    const { userId } = await registerUser(ctx)
    const p = await project()
    generation(`busy-${p.id}`, userId, p.id, status)
    expect((await trash(p.id)).status).toBe(400)
    expect(ctx.db.prepare('SELECT deleted_at FROM projects WHERE id=?').get(p.id)).toEqual({ deleted_at: null })
    ctx.db.prepare("UPDATE generations SET status='failed' WHERE project_id=?").run(p.id)
  })
  it.each(['queued', 'running'])('rejects trash while export is %s', async (status) => {
    const { userId } = await registerUser(ctx)
    const p = await project()
    ctx.db.prepare(`INSERT INTO exports (id,user_id,project_id,status,spec_json,created_at,updated_at) VALUES (?,?,?,?,'{}',1,1)`).run(`export-${p.id}`, userId, p.id, status)
    expect((await trash(p.id)).status).toBe(400)
    ctx.db.prepare("UPDATE exports SET status='failed' WHERE project_id=?").run(p.id)
  })
  it('blocks detached active batch generations, then stops pending batch work on trash', async () => {
    const { userId } = await registerUser(ctx)
    const p = await project()
    const session = `session-${p.id}`
    const batch = `batch-${p.id}`
    ctx.db.prepare(`INSERT INTO plan_sessions (id,user_id,kind,project_id,created_at,updated_at) VALUES (?,?,'copilot',?,1,1)`).run(session, userId, p.id)
    ctx.db.prepare(`INSERT INTO plan_image_batches (id,user_id,session_id,status,total,created_at,updated_at) VALUES (?,?,?,'running',2,1,1)`).run(batch, userId, session)
    generation(`batch-gen-${p.id}`, userId, p.id, 'running')
    ctx.db.prepare('UPDATE generations SET project_id=NULL WHERE id=?').run(`batch-gen-${p.id}`)
    const insert = ctx.db.prepare(`INSERT INTO plan_image_batch_items (id,batch_id,frame_id,position,status,generation_id,created_at,updated_at) VALUES (?,?,?, ?,?,?,1,1)`)
    insert.run(`running-${p.id}`, batch, 'frame-1', 0, 'running', `batch-gen-${p.id}`)
    insert.run(`pending-${p.id}`, batch, 'frame-2', 1, 'pending', null)
    expect((await trash(p.id)).status).toBe(400)
    ctx.db.prepare("UPDATE generations SET status='failed' WHERE id=?").run(`batch-gen-${p.id}`)
    expect((await trash(p.id)).status).toBe(200)
    expect(ctx.db.prepare('SELECT status FROM plan_image_batches WHERE id=?').get(batch)).toEqual({ status: 'stopped' })
    expect(ctx.db.prepare('SELECT status FROM plan_image_batch_items WHERE id=?').get(`pending-${p.id}`)).toEqual({ status: 'stopped' })
  })
  it('skips approved automatic scenes in trash without blocking active project scenes', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'video')
    const doomed = await project()
    const active = await project()
    await trash(doomed.id)
    const insert = ctx.db.prepare(`INSERT INTO scenes (id,project_id,title,prompt,model_id,position,auto_generate,approved,created_at,updated_at) VALUES (?,?,'auto','a landscape',?,0,1,1,1,1)`)
    insert.run(`auto-trash-${doomed.id}`, doomed.id, modelPk)
    insert.run(`auto-active-${active.id}`, active.id, modelPk)
    const worker = { wake: () => {} } as unknown as TestContext['worker']
    expect(sweepAutoGenerate({ db: ctx.db, env: ctx.env, worker })).toBe(1)
    expect(ctx.db.prepare('SELECT id FROM generations WHERE project_id=?').all(doomed.id)).toEqual([])
    expect(ctx.db.prepare('SELECT id FROM generations WHERE project_id=?').all(active.id)).toHaveLength(1)
    expect(ctx.db.prepare('SELECT auto_generate FROM scenes WHERE project_id=?').get(doomed.id)).toEqual({ auto_generate: 1 })
  })
  it('validates destructive options strictly', async () => {
    await registerUser(ctx)
    const p = await project()
    for (const body of [{ deleteResults: 'true' }, { deleteResults: true, deleteEverything: true }]) {
      expect((await call(ctx, `/api/projects/${p.id}/trash`, { method: 'POST', body })).status).toBe(400)
    }
  })
})

describe('expired project purge safeguards', () => {
  it('does not purge early and defaults to retaining library generations/media', async () => {
    const { userId } = await registerUser(ctx)
    const p = await project()
    generation(`keep-${p.id}`, userId, p.id, 'succeeded', `${userId}/keep.png`)
    await trash(p.id)
    const removed: string[] = []
    const mediaStore = { removeByPath: (path: string) => { removed.push(path) } }
    maintainProjectTrash({ db: ctx.db, mediaStore, now: Date.now() })
    expect(ctx.db.prepare('SELECT id FROM projects WHERE id=?').get(p.id)).toBeTruthy()
    maintainProjectTrash({ db: ctx.db, mediaStore, now: expire(p.id) })
    expect(ctx.db.prepare('SELECT id FROM projects WHERE id=?').get(p.id)).toBeUndefined()
    expect(ctx.db.prepare('SELECT project_id FROM generations WHERE id=?').get(`keep-${p.id}`)).toEqual({ project_id: null })
    expect(removed).not.toContain(`${userId}/keep.png`)
    expect(ctx.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
  it('preserves a generation used as a source snapshot by retained work', async () => {
    const { userId } = await registerUser(ctx)
    const doomed = await project()
    const retained = await project()
    const sourceId = `source-${doomed.id}`
    const path = `${userId}/source.png`
    generation(sourceId, userId, doomed.id, 'succeeded', path)
    generation(`derived-${retained.id}`, userId, retained.id)
    ctx.db.prepare('UPDATE generations SET source_images_json=? WHERE id=?').run(JSON.stringify([{ generationId: sourceId, assetId: `asset-${sourceId}`, relativePath: path, mimeType: 'image/png' }]), `derived-${retained.id}`)
    await trash(doomed.id, true)
    const removed: string[] = []
    maintainProjectTrash({ db: ctx.db, now: expire(doomed.id), mediaStore: { removeByPath: (value: string) => { removed.push(value) } } })
    expect(ctx.db.prepare('SELECT project_id FROM generations WHERE id=?').get(sourceId)).toEqual({ project_id: null })
    expect(ctx.db.prepare('SELECT id FROM assets WHERE generation_id=?').get(sourceId)).toBeTruthy()
    expect(removed).not.toContain(path)
    expect(ctx.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
  it('removes private characters but keeps library and cross-project characters and their media', async () => {
    const { userId } = await registerUser(ctx)
    const doomed = await project()
    const other = await project()
    const insert = ctx.db.prepare(`INSERT INTO characters (id,user_id,project_id,name,reference_path,created_at,updated_at) VALUES (?,?,?,'character',?,1,1)`)
    insert.run(`private-${doomed.id}`, userId, doomed.id, `${userId}/private.png`)
    insert.run(`linked-${doomed.id}`, userId, doomed.id, `${userId}/linked.png`)
    insert.run(`library-${doomed.id}`, userId, null, `${userId}/library.png`)
    ctx.db.prepare(`INSERT INTO scenes (id,project_id,title,position,character_id,created_at,updated_at) VALUES (?,?, 'cast',0,?,1,1)`).run(`cast-${other.id}`, other.id, `linked-${doomed.id}`)
    ctx.db.prepare('INSERT INTO scene_characters (scene_id,character_id,position) VALUES (?,?,0)').run(`cast-${other.id}`, `linked-${doomed.id}`)
    await trash(doomed.id, true)
    const removed: string[] = []
    maintainProjectTrash({ db: ctx.db, now: expire(doomed.id), mediaStore: { removeByPath: (path: string) => { removed.push(path) } } })
    expect(ctx.db.prepare('SELECT id FROM characters WHERE id=?').get(`private-${doomed.id}`)).toBeUndefined()
    expect(ctx.db.prepare('SELECT project_id FROM characters WHERE id=?').get(`linked-${doomed.id}`)).toEqual({ project_id: null })
    expect(ctx.db.prepare('SELECT id FROM characters WHERE id=?').get(`library-${doomed.id}`)).toBeTruthy()
    expect(removed).toContain(`${userId}/private.png`)
    expect(removed).not.toContain(`${userId}/linked.png`)
    expect(removed).not.toContain(`${userId}/library.png`)
    expect(ctx.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
  it('deletes opted-in exclusive results, preserves shared paths and cross-project selection, retries cleanup', async () => {
    const { userId } = await registerUser(ctx)
    const doomed = await project('doomed')
    const other = await project('other')
    const exclusivePath = `${userId}/exclusive.png`
    const sharedPath = `${userId}/shared.png`
    generation(`exclusive-${doomed.id}`, userId, doomed.id, 'succeeded', exclusivePath)
    generation(`selected-${doomed.id}`, userId, doomed.id, 'succeeded', `${userId}/selected.png`)
    generation(`shared-${doomed.id}`, userId, doomed.id, 'succeeded', sharedPath)
    generation(`other-${other.id}`, userId, other.id, 'succeeded', sharedPath)
    ctx.db.prepare(`INSERT INTO scenes (id,project_id,title,position,selected_generation_id,created_at,updated_at) VALUES (?,?, 'shared selection',0,?,1,1)`).run(`other-scene-${other.id}`, other.id, `selected-${doomed.id}`)
    await trash(doomed.id, true)
    const now = expire(doomed.id)
    const removed: string[] = []
    const first = maintainProjectTrash({ db: ctx.db, now, mediaStore: { removeByPath: () => { throw new Error('temporary filesystem failure') } } })
    expect(first.failed).toBeGreaterThan(0)
    expect(ctx.db.prepare('SELECT id FROM generations WHERE id=?').get(`exclusive-${doomed.id}`)).toBeUndefined()
    expect(ctx.db.prepare('SELECT project_id FROM generations WHERE id=?').get(`selected-${doomed.id}`)).toEqual({ project_id: null })
    maintainProjectTrash({ db: ctx.db, now: now + DAY, mediaStore: { removeByPath: (path: string) => { removed.push(path) } } })
    expect(removed).toContain(exclusivePath)
    expect(removed).not.toContain(sharedPath)
    expect(removed).not.toContain(`${userId}/selected.png`)
    expect(ctx.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
})
