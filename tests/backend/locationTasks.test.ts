import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, seedProviderAndModel, waitForGeneration, startTestServer, type TestContext } from './helpers'
import { planLocationRoutes } from '../../server/planner/locationRoutes'
import { projectLocationRoutes } from '../../server/projects/locationRoutes'
import { fingerprintImageInput, getLatestImageTask } from '../../server/planner/imageTasks'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { if (ctx) await ctx.close() })

describe('location image task routes', () => {
  it('enqueues once, recovers through GET and attaches a result idempotently', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const session = await call(ctx, '/api/plans', { method: 'POST', body: {} })
    const id = session.body.session.id
    const added = await call(ctx, `/api/plans/${id}/locations`, { method: 'POST', body: { name: 'Rừng thông', stage: '', description: 'Nắng dịu', continuityNotes: '', imagePrompt: '' } })
    const location = added.body.locations[0]
    const root = `/api/plans/${id}/locations/${location.id}/reference`
    const first = await call(ctx, `${root}/generate`, { method: 'POST', body: { modelId: modelPk, requestKey: 'location-intent' } })
    expect(first.status).toBe(202)
    const duplicate = await call(ctx, `${root}/generate`, { method: 'POST', body: { modelId: modelPk, requestKey: 'location-intent' } })
    expect(duplicate.body.generation.id).toBe(first.body.generation.id)
    await waitForGeneration(ctx, first.body.generation.id)
    const latest = await call(ctx, `${root}/task`)
    expect(latest.body.generation.status).toBe('succeeded')
    const attach = () => call(ctx, `${root}/attach`, { method: 'POST', body: { generationId: first.body.generation.id, revision: location.revision } })
    const attached = await attach()
    expect(attached.status).toBe(200)
    expect(attached.body.locations[0].reference?.uploadId).toBeTruthy()
    const twice = await attach()
    expect(twice.status).toBe(200)
    expect(twice.body.locations[0].reference).toEqual(attached.body.locations[0].reference)
    expect(twice.body.locations[0].revision).toBe(attached.body.locations[0].revision)
  })

  it('registers durable task reconciliation and preserves legacy generation endpoints', () => {
    const paths = (router: unknown) => (router as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> }).stack
      .flatMap(layer => layer.route ? [`${Object.keys(layer.route.methods)[0]!.toUpperCase()} ${layer.route.path}`] : [])
    expect(paths(planLocationRoutes(ctx.db, ctx.env, ctx.mediaStore, ctx.worker))).toEqual(expect.arrayContaining([
      'GET /:id/locations/:locationId/reference/task',
      'POST /:id/locations/:locationId/reference',
      'POST /:id/locations/:locationId/reference/generate',
    ]))
    expect(paths(projectLocationRoutes(ctx.db, ctx.env, ctx.mediaStore, ctx.worker))).toEqual(expect.arrayContaining([
      'GET /:id/locations/:locationId/reference/task',
      'POST /:id/locations/:locationId/reference',
      'POST /:id/locations/:locationId/reference/generate',
    ]))
  })

  it('uses canonical location inputs and does not invent a task on reads', () => {
    expect(fingerprintImageInput({ prompt: 'empty station', modelId: 'm', params: { size: '1536x1024' } }))
      .toBe(fingerprintImageInput({ params: { size: '1536x1024' }, modelId: 'm', prompt: 'empty station' }))
    const userId = `location-task-${Date.now()}`
    const now = Date.now()
    ctx.db.prepare('INSERT INTO users(id,email,password_hash,password_salt,created_at) VALUES(?,?,?,?,?)').run(userId, `${userId}@test.invalid`, 'x', 'x', now)
    const sessionId = `${userId}-session`
    ctx.db.prepare("INSERT INTO plan_sessions(id,user_id,kind,title,status,created_at,updated_at) VALUES(?,?,'planner','','setup',?,?)").run(sessionId, userId, now, now)
    expect(getLatestImageTask(ctx.db, userId, 'planner', sessionId, 'location', 'location-1')).toBeNull()
  })
})
