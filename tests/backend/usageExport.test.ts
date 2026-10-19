import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { csvCell, usageExportHeader, usageExportRow } from '../../server/usage/export'
import { iterateUsageExportEvents } from '../../server/usage/service'
import {
  call, ensureSuperAdmin, registerUser, seedProviderAndModel, startTestServer, waitForGeneration,
  type TestContext,
} from './helpers'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer({ superAdminEmails: 'usage-admin@gigone.com' }) })
afterAll(async () => { if (ctx) await ctx.close() })

async function csv(path: string, cookie = ctx.cookie) {
  const response = await fetch(`${ctx.baseUrl}${path}`, { headers: cookie ? { Cookie: cookie } : {} })
  return { status: response.status, headers: response.headers, text: await response.text() }
}

function rows(text: string): string[] {
  return text.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean)
}

describe('usage CSV export', () => {
  it('quotes and neutralizes CSV formula/control prefixes and supports blank/null fields', () => {
    for (const dangerous of ['=1+1', '+SUM(A1:A2)', '-1+2', '@cmd', '\t=1', '\r=1', '\n=1', ' \ufeff\u0000=1']) {
      const result = csvCell(dangerous)
      expect(result.startsWith('"')).toBe(true)
      expect(result.endsWith('"')).toBe(true)
      expect(result).not.toMatch(/^"[=+\-@\t\r\n]/)
    }
    expect(csvCell(null)).toBe('')
    expect(csvCell(0)).toBe('0')
    expect(csvCell('Tiếng Việt, "quoted"\nline')).toBe('"Tiếng Việt, ""quoted""\nline"')
    const userHeader = usageExportHeader(false)
    const adminHeader = usageExportHeader(true)
    expect(userHeader.split(',')).toEqual([
      'time_utc', 'name', 'kind', 'source', 'status', 'outcome', 'model_name', 'provider_name',
      'project_name', 'scene_name', 'session_name', 'latency_ms', 'cost', 'price_currency',
      'cost_unknown', 'preview', 'response_preview',
    ])
    expect(adminHeader.split(',')).toEqual([
      'time_utc', 'name', 'user_email', ...userHeader.split(',').slice(2),
    ])
    for (const absent of ['event_id', 'user_id', 'model_id', 'project_id', 'scene_id', 'session_id', 'bytes', 'prompt_tokens', 'completion_tokens', 'attempt_count']) {
      expect(userHeader).not.toContain(absent)
      expect(adminHeader).not.toContain(absent)
    }
  })

  it('serializes an event without collapsing unknown values into zero or losing currency', () => {
    const event = {
      id: 'evt', kind: 'image' as const, source: 'image', outcome: 'ok' as const, status: 'succeeded', createdAt: 1,
      userId: 'user', userEmail: 'export@gigone.com', userName: 'Export User', modelPk: null, modelName: null, providerName: null, projectId: null,
      projectName: null, sceneId: null, sceneTitle: null, planSessionId: null, sessionTitle: null,
      messageId: null, preview: 'safe', responsePreview: '', promptChars: 0, responseChars: 0,
      promptTokens: null, completionTokens: null, latencyMs: 0, attemptCount: 1, byteSize: 0,
      priceUnit: null, priceInput1k: null, priceOutput1k: null, cost: null, costUnknown: true,
      priceCurrency: null,
    }
    const unknown = usageExportRow(event, false)
    const knownZero = usageExportRow({ ...event, cost: 0, costUnknown: false, priceCurrency: 'USD' }, false)
    expect(unknown).not.toBe(knownZero)
    expect(unknown).toContain('""')
    expect(knownZero).toContain('USD')
    expect(unknown.split(',')).toHaveLength(usageExportHeader(false).split(',').length)
    expect(usageExportHeader(false).split(',').map((column, index) => [column, unknown.split(',')[index]]))
      .toContainEqual(['name', '"Export User"'])
    expect(usageExportRow(event, true).split(',')).toHaveLength(usageExportHeader(true).split(',').length)
    for (const dangerous of ['=1+1', '+SUM(A1:A2)', '-1+2', '@cmd']) {
      const safe = usageExportRow({ ...event, userName: dangerous }, false).split(',')[1]
      expect(safe).toBe(`"'${dangerous}"`)
    }
  })

  it('streams beyond 20,000 rows without pagination truncation', async () => {
    const user = await registerUser(ctx)
    const { providerId, modelPk } = await seedProviderAndModel(ctx, 'image')
    const now = Date.now()
    const insert = ctx.db.prepare(`INSERT INTO generations
      (id,user_id,model_pk,provider_id,kind,prompt,params_json,snap_provider,snap_base_url,snap_model_id,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    ctx.db.exec('BEGIN')
    try {
      for (let i = 0; i < 20_025; i++) insert.run(
        `export-${user.userId}-${i}`, user.userId, modelPk, providerId, 'image', `row ${i}`, '{}', 'Provider',
        'https://image.mock.test', 'mock-image-model', 'succeeded', now - i, now - i,
      )
      ctx.db.exec('COMMIT')
    } catch (error) {
      ctx.db.exec('ROLLBACK')
      throw error
    }
    let count = 0
    let previousTime = Infinity
    const ids = new Set<string>()
    for (const event of iterateUsageExportEvents(ctx.db, { userId: user.userId })) {
      expect(event.createdAt).toBeLessThanOrEqual(previousTime)
      previousTime = event.createdAt
      ids.add(event.id)
      count++
    }
    expect(count).toBe(20_025)
    expect(ids.size).toBe(count)
    const result = await csv('/api/usage/export')
    expect(result.status).toBe(200)
    expect(rows(result.text)).toHaveLength(20_026)
    const iterator = iterateUsageExportEvents(ctx.db, { userId: user.userId })[Symbol.iterator]()
    expect(iterator.next().done).toBe(false)
    iterator.return?.()
    expect(ctx.db.prepare('SELECT 1 AS ready').get()).toMatchObject({ ready: 1 })
  }, 30_000)

  it('protects both endpoints, scopes user exports, applies filters, and rejects pagination', async () => {
    const alice = await registerUser(ctx, 'export-alice@gigone.com', undefined, 'Nguyễn Diễn')
    const aliceCookie = ctx.cookie
    const { modelPk: aliceModel } = await seedProviderAndModel(ctx, 'image')
    const created = await call(ctx, '/api/generations', { method: 'POST', body: { modelId: aliceModel, prompt: 'csv media filter marker', params: {} } })
    await waitForGeneration(ctx, created.body.generation.id)
    const own = await csv('/api/usage/export', aliceCookie)
    expect(own.status).toBe(200)
    expect(own.text).toContain('"Nguyễn Diễn"')
    ctx.db.prepare('UPDATE users SET name=? WHERE id=?').run('', alice.userId)
    const fallback = await csv('/api/usage/export', aliceCookie)
    expect(fallback.text).toContain('"export-alice"')
    ctx.db.prepare('UPDATE users SET name=? WHERE id=?').run('Nguyễn Diễn', alice.userId)
    // Fetch's UTF-8 decoder may strip the BOM; check the wire bytes separately.
    const wire = await fetch(`${ctx.baseUrl}/api/usage/export`, { headers: { Cookie: aliceCookie } })
    expect(Array.from(new Uint8Array(await wire.arrayBuffer()).slice(0, 3))).toEqual([239, 187, 191])
    expect(own.headers.get('content-type')).toMatch(/text\/csv/i)
    expect(rows(own.text).length).toBeGreaterThan(1)
    expect(rows(own.text)[0]).toContain('time_utc')
    expect((await csv('/api/admin/usage/export', aliceCookie)).status).toBe(403)
    expect((await csv('/api/usage/export', '')).status).toBe(401)
    expect((await csv('/api/admin/usage/export', '')).status).toBe(401)
    expect((await csv('/api/usage/export?limit=1', aliceCookie)).status).toBe(400)
    expect((await csv('/api/usage/export?offset=0', aliceCookie)).status).toBe(400)
    expect((await csv('/api/usage/export?userId=someone', aliceCookie)).status).toBe(400)
    expect((await csv('/api/usage/export?from=2&to=1', aliceCookie)).status).toBe(400)
    expect((await csv('/api/usage/export?kind=bogus', aliceCookie)).status).toBe(400)
    const empty = await csv('/api/usage/export?to=1', aliceCookie)
    expect(empty.status).toBe(200)
    expect(rows(empty.text)).toHaveLength(1)
    const filtered = await csv('/api/usage/export?kind=image&outcome=ok&q=csv%20media%20filter%20marker&modelPk=' + aliceModel, aliceCookie)
    expect(filtered.status).toBe(200)
    expect(rows(filtered.text).length).toBe(2)

    const bob = await registerUser(ctx, 'export-bob@gigone.com')
    const bobCookie = ctx.cookie
    const { modelPk: bobModel } = await seedProviderAndModel(ctx, 'image')
    const bobCreated = await call(ctx, '/api/generations', { method: 'POST', body: { modelId: bobModel, prompt: 'other user secret', params: {} } })
    await waitForGeneration(ctx, bobCreated.body.generation.id)
    const selfOnly = await csv('/api/usage/export', aliceCookie)
    expect(selfOnly.text).not.toContain('other user secret')
    expect(bob.userId).not.toBe(alice.userId)

    await ensureSuperAdmin(ctx, 'usage-admin@gigone.com')
    const adminCookie = ctx.cookie
    const all = await csv('/api/admin/usage/export', adminCookie)
    expect(all.status).toBe(200)
    expect(rows(all.text)[0]).toContain('user_email')
    expect(all.text).toContain(alice.email)
    expect(all.text).toContain(bob.email)
    const selected = await csv(`/api/admin/usage/export?userId=${encodeURIComponent(alice.userId)}`, adminCookie)
    expect(selected.status).toBe(200)
    expect(selected.text).toContain(alice.email)
    expect(selected.text).not.toContain(bob.email)
    expect(bobCookie).toBeTruthy()
  })
})

void usageExportHeader
void usageExportRow
