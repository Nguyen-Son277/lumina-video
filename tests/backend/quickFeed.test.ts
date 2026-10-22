import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, startTestServer, type TestContext } from './helpers'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { if (ctx) await ctx.close() })

function session(id: string, userId: string) {
  ctx.db.prepare('INSERT INTO quick_sessions (id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?)').run(id, userId, id, 1, 1)
  return id
}

function generation(id: string, userId: string, quickSessionId: string | null, createdAt: number, options: {
  kind?: 'image' | 'video'; projectId?: string; deletedAt?: number; status?: 'queued' | 'running' | 'succeeded' | 'failed'
} = {}) {
  ctx.db.prepare(`INSERT INTO generations
    (id,user_id,kind,prompt,params_json,snap_provider,snap_base_url,snap_model_id,status,created_at,updated_at,quick_session_id,project_id,deleted_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, userId, options.kind ?? 'image', id, '{}', 'mock', 'https://mock.test', 'mock-model', options.status ?? 'succeeded', createdAt, createdAt, quickSessionId, options.projectId ?? null, options.deletedAt ?? null)
}

const ids = (result: { body: { generations: Array<{ id: string }> } }) => result.body.generations.map(row => row.id)
const cursorFor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

describe('quick generation feed', () => {
  it('requires authentication and rejects invalid scope, incompatible filters, and malformed cursors', async () => {
    await registerUser(ctx)
    expect((await call(ctx, '/api/generations?scope=quick', { cookie: '' })).status).toBe(401)
    for (const query of [
      'scope=other', 'scope=', 'scope=quick&scope=quick', 'cursor=abc', 'q=prompt', 'scope=quick&q=a&q=b',
      'scope=quick&projectId=x', 'scope=quick&sceneId=x', 'scope=quick&quickSessionId=x',
      'scope=quick&latestPerScene=true', 'scope=quick&latestPerScene=false',
      'scope=quick&kind=other', 'scope=quick&kind=', 'scope=quick&kind=image&kind=video',
      'scope=quick&cursor=', 'scope=quick&cursor=not-a-cursor', 'scope=quick&cursor=***',
      'scope=quick&cursor=x&cursor=y',
      ...[null, {}, [], [1], ['1', 'id'], [-1, 'id'], [1.5, 'id'], [1, ''], [1, 2], [1, 'id', 'extra']].map(value => `scope=quick&cursor=${cursorFor(value)}`),
    ]) {
      expect((await call(ctx, `/api/generations?${query}`)).status, query).toBe(400)
    }
  })

  it('includes only owned linked quick sessions and excludes deleted generations and projects', async () => {
    const { userId: otherId } = await registerUser(ctx)
    const otherSession = session('visibility-other-session', otherId)
    const { userId } = await registerUser(ctx)
    const ownSession = session('visibility-own-session', userId)
    const deletedSession = session('visibility-deleted-session', userId)
    const project = (await call(ctx, '/api/projects', { method: 'POST', body: { name: 'Deleted project' } })).body.project
    const activeProject = (await call(ctx, '/api/projects', { method: 'POST', body: { name: 'Active project' } })).body.project
    generation('visible-image', userId, ownSession, 10)
    generation('hidden-active-project', userId, ownSession, 11, { projectId: activeProject.id })
    generation('visible-running-video', userId, ownSession, 12, { kind: 'video', status: 'running' })
    generation('visible-queued', userId, ownSession, 13, { status: 'queued' })
    generation('visible-failed', userId, ownSession, 14, { status: 'failed' })
    generation('hidden-unlinked', userId, null, 100)
    generation('hidden-foreign-generation', otherId, otherSession, 100)
    generation('hidden-foreign-session', userId, otherSession, 100)
    generation('hidden-deleted-generation', userId, ownSession, 100, { deletedAt: 101 })
    generation('hidden-deleted-project', userId, ownSession, 100, { projectId: project.id })
    generation('hidden-deleted-session', userId, deletedSession, 100)
    ctx.db.prepare('UPDATE projects SET deleted_at = ? WHERE id = ?').run(101, project.id)
    ctx.db.prepare('DELETE FROM quick_sessions WHERE id = ?').run(deletedSession)
    ctx.db.prepare('INSERT INTO assets (id,generation_id,user_id,relative_path,mime_type,byte_size,created_at) VALUES (?,?,?,?,?,?,?)').run('quick-feed-asset', 'visible-image', userId, 'image.png', 'image/png', 123, 10)

    const result = await call(ctx, '/api/generations?scope=quick')
    expect(result.status).toBe(200)
    expect(ids(result)).toEqual(['visible-failed', 'visible-queued', 'visible-running-video', 'visible-image'])
    expect(result.body.nextCursor).toBeNull()
    expect(result.body.generations.at(-1).assets).toEqual([{ id: 'quick-feed-asset', mimeType: 'image/png', byteSize: 123, variant: 'original', sourceAssetId: null, url: '/api/assets/quick-feed-asset' }])
    expect(ids(await call(ctx, '/api/generations?scope=quick&kind=video'))).toEqual(['visible-running-video'])
    expect(ids(await call(ctx, '/api/generations?scope=quick&kind=image'))).not.toContain('visible-running-video')
    expect(ids(await call(ctx, '/api/generations?scope=quick&q=failed'))).toEqual(['visible-failed'])
    expect(ids(await call(ctx, '/api/generations?scope=quick&q=running'))).toEqual(['visible-running-video'])
    expect(ids(await call(ctx, '/api/generations?scope=quick&q=mock-model'))).toHaveLength(4)
  })

  it('paginates by immutable createdAt and id without duplicates when inserts, updates, or deletes occur', async () => {
    const { userId } = await registerUser(ctx)
    const quickSessionId = session('pagination-session', userId)
    for (const id of ['page-a', 'page-b', 'page-c', 'page-d']) generation(id, userId, quickSessionId, 20)
    generation('page-old', userId, quickSessionId, 10)
    const first = await call(ctx, '/api/generations?scope=quick&limit=2')
    expect(ids(first)).toEqual(['page-d', 'page-c'])
    expect(typeof first.body.nextCursor).toBe('string')

    generation('page-new', userId, quickSessionId, 30)
    generation('page-z', userId, quickSessionId, 20)
    ctx.db.prepare('UPDATE generations SET updated_at = ?, status = ? WHERE id = ?').run(999, 'running', 'page-a')
    // Continuation uses the cursor values, not a lookup of the last row.
    ctx.db.prepare('UPDATE generations SET deleted_at = ? WHERE id = ?').run(100, 'page-c')
    const second = await call(ctx, `/api/generations?scope=quick&limit=2&cursor=${first.body.nextCursor}`)
    expect(ids(second)).toEqual(['page-b', 'page-a'])
    expect(typeof second.body.nextCursor).toBe('string')
    const last = await call(ctx, `/api/generations?scope=quick&limit=2&cursor=${second.body.nextCursor}`)
    expect(ids(last)).toEqual(['page-old'])
    expect(last.body.nextCursor).toBeNull()
    const empty = await call(ctx, `/api/generations?scope=quick&cursor=${cursorFor([0, 'missing'])}`)
    expect(ids(empty)).toEqual([])
    expect(empty.body.nextCursor).toBeNull()
    expect(ids(await call(ctx, '/api/generations?scope=quick&limit=2'))).toEqual(['page-new', 'page-z'])
  })

  it('retains bounded limits, kind filtering across pages, and the legacy response shape', async () => {
    const { userId } = await registerUser(ctx)
    const quickSessionId = session('limits-session', userId)
    for (let index = 0; index < 105; index++) generation(`limit-${index}`, userId, quickSessionId, index + 1, { kind: index % 2 ? 'video' : 'image' })
    const defaultPage = await call(ctx, '/api/generations?scope=quick')
    expect(defaultPage.body.generations).toHaveLength(30)
    expect(typeof defaultPage.body.nextCursor).toBe('string')
    const maxPage = await call(ctx, '/api/generations?scope=quick&limit=999')
    expect(maxPage.body.generations).toHaveLength(100)
    expect((await call(ctx, '/api/generations?scope=quick&limit=0')).body.generations).toHaveLength(1)
    const firstImage = await call(ctx, '/api/generations?scope=quick&kind=image&limit=2')
    expect(ids(firstImage)).toEqual(['limit-104', 'limit-102'])
    expect(ids(await call(ctx, `/api/generations?scope=quick&kind=image&limit=2&cursor=${firstImage.body.nextCursor}`))).toEqual(['limit-100', 'limit-98'])
    const legacy = await call(ctx, `/api/generations?quickSessionId=${quickSessionId}&kind=video&limit=2`)
    expect(legacy.status).toBe(200)
    expect(ids(legacy)).toEqual(['limit-103', 'limit-101'])
    expect(legacy.body).not.toHaveProperty('nextCursor')
    expect((await call(ctx, '/api/generations')).body.generations).toHaveLength(30)
  })
})
