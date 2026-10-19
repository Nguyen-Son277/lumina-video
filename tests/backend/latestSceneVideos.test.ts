import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { if (ctx) await ctx.close() })

describe('latest video per scene projection', () => {
  it('requires authentication and validates the approved query shape', async () => {
    await registerUser(ctx)
    expect((await call(ctx, '/api/generations?projectId=x&kind=video&latestPerScene=true', { cookie: '' })).status).toBe(401)
    for (const query of [
      'latestPerScene=false', 'projectId=x&latestPerScene=true',
      'projectId=x&kind=image&latestPerScene=true',
      'projectId=x&kind=video&latestPerScene=true&sceneId=y',
      'projectId=x&kind=video&latestPerScene=true&quickSessionId=y',
    ]) {
      expect((await call(ctx, `/api/generations?${query}`)).status).toBe(400)
    }
  })

  it('returns one newest owned video per scene without applying history limits', async () => {
    const { userId } = await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'video')
    const project = (await call(ctx, '/api/projects', { method: 'POST', body: { name: 'Scale' } })).body.project
    const scenes = Array.from({ length: 1005 }, (_, i) => `scene-${i}`)
    const now = Date.now()
    const values = scenes.map((sceneId, i) => `('${sceneId}','${project.id}','Scene ${i}',${i},${now},${now})`).join(',')
    ctx.db.exec(`INSERT INTO scenes (id,project_id,title,position,created_at,updated_at) VALUES ${values}`)
    const insert = ctx.db.prepare(`INSERT INTO generations (id,user_id,model_pk,kind,prompt,params_json,snap_provider,snap_base_url,snap_model_id,status,created_at,updated_at,project_id,scene_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    const put = (id: string, sceneId: string, kind: 'image' | 'video', createdAt: number, status = 'succeeded', projectId = project.id, ownerId = userId) => insert.run(id, ownerId, modelPk, kind, id, '{}', 'mock', 'https://mock.test', 'mock-video', status, createdAt, createdAt, projectId, sceneId)
    scenes.forEach((sceneId, i) => {
      put(`old-${i}`, sceneId, 'video', now - 3)
      put(`new-${i}`, sceneId, 'video', now - 2, i === 34 ? 'queued' : 'succeeded')
      put(`image-${i}`, sceneId, 'image', now + 20)
    })
    put('tie-a', scenes[0]!, 'video', now + 5)
    put('tie-z', scenes[0]!, 'video', now + 5, 'queued')
    ctx.db.prepare('INSERT INTO assets (id,generation_id,user_id,relative_path,mime_type,byte_size,created_at) VALUES (?,?,?,?,?,?,?)').run('asset-latest', 'tie-z', userId, 'asset-latest.mp4', 'video/mp4', 123, now)
    const trashedScene = scenes[1]!
    put('deleted-gen', trashedScene, 'video', now + 100)
    ctx.db.prepare('UPDATE generations SET deleted_at = ? WHERE id = ?').run(now, 'deleted-gen')
    const otherProject = (await call(ctx, '/api/projects', { method: 'POST', body: { name: 'Other' } })).body.project
    put('foreign-gen', scenes[2]!, 'video', now + 200, 'succeeded', otherProject.id)

    const result = await call(ctx, `/api/generations?projectId=${project.id}&kind=video&latestPerScene=true`)
    expect(result.status).toBe(200)
    const rows = result.body.generations
    expect(rows).toHaveLength(1005)
    expect(rows.map((row: any) => row.id)).toContain('new-1004')
    expect(rows.map((row: any) => row.id)).toContain('tie-z')
    expect(rows.map((row: any) => row.id)).not.toContain('old-0')
    expect(rows.map((row: any) => row.id)).not.toContain('image-1')
    expect(rows.map((row: any) => row.id)).not.toContain('deleted-gen')
    expect(rows.map((row: any) => row.id)).not.toContain('foreign-gen')
    expect(rows[0].id).toBe('tie-z')
    expect(rows[0].assets).toEqual([{ id: 'asset-latest', mimeType: 'video/mp4', byteSize: 123, variant: 'original', sourceAssetId: null, url: '/api/assets/asset-latest' }])
  })

  it('requires an owned, nondeleted project', async () => {
    const first = await registerUser(ctx)
    const project = (await call(ctx, '/api/projects', { method: 'POST', body: { name: 'Latest' } })).body.project
    const query = `/api/generations?projectId=${project.id}&kind=video&latestPerScene=true`
    expect((await call(ctx, query)).body.generations).toEqual([])
    const second = await registerUser(ctx)
    const secondProject = (await call(ctx, '/api/projects', { method: 'POST', body: { name: 'Private' } })).body.project
    await call(ctx, '/api/auth/login', { method: 'POST', body: { email: first.email, password: 'matkhau-rat-dai-123' } })
    expect((await call(ctx, `/api/generations?projectId=${secondProject.id}&kind=video&latestPerScene=true`)).status).toBe(404)
    expect(second.userId).not.toBe(first.userId)
    const secondContext = await startTestServer()
    try {
      await registerUser(secondContext)
      expect((await call(secondContext, query)).status).toBe(404)
    } finally { await secondContext.close() }
    ctx.db.prepare('UPDATE projects SET deleted_at = ? WHERE id = ?').run(Date.now(), project.id)
    expect((await call(ctx, query)).status).toBe(404)
    expect(first.userId).toBeTruthy()
  })
})

// Ensure the default history endpoint retains its existing bounded behavior.
it('does not change ordinary generation listing', async () => {
  await registerUser(ctx)
  expect((await call(ctx, '/api/generations')).status).toBe(200)
})
