import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { entityLibraryRoutes } from '../../server/entityLibrary/routes'
import { errorHandler } from '../../server/auth/middleware'
import { call, registerUser, startTestServer, type TestContext } from './helpers'
import { createLibraryAsset, saveLibraryAssetReference } from '../../server/entityLibrary/service'
import { ANALYSIS_MAX_EDGE, parseReferenceSuggestion, prepareAnalysisImage } from '../../server/entityLibrary/analyze'
import { chatContentText } from '../../server/llm/chat'
import { mockChatCompletionWithUsage } from '../../server/generations/adapters/mock'
import { recordLlmUsage } from '../../server/usage/log'
import { saveProjectLocation } from '../../server/projects/locations'
import { listEntityCatalog } from '../../server/entityLibrary/service'

let ctx: TestContext, userId: string, modelId: string, png: Buffer
beforeEach(async () => {
  ctx = await startTestServer()
  userId = (await registerUser(ctx)).userId
  const p = await call(ctx, '/api/providers', { method: 'POST', body: { name: 'Vision', baseUrl: 'https://mock.test/v1', apiKey: 'sk-test-vision' } })
  const m = await call(ctx, '/api/models', { method: 'POST', body: { providerId: p.body.provider.id, modelId: 'mock-chat-model', kind: 'llm' } })
  modelId = m.body.model.id
  png = await sharp({ create: { width: 40, height: 20, channels: 3, background: 'red' } }).png().toBuffer()
})
afterEach(async () => { await ctx.close() })
async function analyze(query = `kind=item&modelId=${modelId}`, bytes = png, cookie = ctx.cookie) {
  const response = await fetch(`${ctx.baseUrl}/api/entity-library/analyze-reference?${query}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'image/png' }, body: new Uint8Array(bytes) })
  return { status: response.status, body: await response.json() as { suggestion: { name: string; handle: string } } }
}

describe('library reference vision analysis (mock only)', () => {
  it('returns Vietnamese suggestions for all kinds, logs no base64, and never saves an asset/upload', async () => {
    for (const kind of ['item', 'logo', 'location']) {
      const result = await analyze(`kind=${kind}&modelId=${modelId}`)
      expect(result.status).toBe(200)
      expect(result.body.suggestion).toMatchObject({ handle: 'anh-tham-chieu', name: 'Ảnh tham chiếu' })
    }
    expect(ctx.db.prepare('SELECT count(*) AS n FROM library_assets').get()).toMatchObject({ n: 0 })
    expect(ctx.db.prepare('SELECT count(*) AS n FROM uploads').get()).toMatchObject({ n: 0 })
    const logs = ctx.db.prepare('SELECT * FROM llm_usage WHERE user_id=?').all(userId)
    expect(logs).toHaveLength(3)
    expect(JSON.stringify(logs)).not.toMatch(/base64|data:image/)
    expect(logs[0]).toMatchObject({ source: 'library_reference_ai', model_pk: modelId, status: 'ok' })
  })
  it('requires authenticated, strictly validated kind/model and decodable bytes', async () => {
    expect((await analyze(undefined, png, '')).status).toBe(401)
    for (const q of ['kind=item', `kind=character&modelId=${modelId}`, `kind=item&modelId=${modelId}&extra=yes`, 'kind=item&modelId=unknown']) expect((await analyze(q)).status).not.toBe(200)
    expect((await analyze(undefined, Buffer.from('not an image'))).status).toBe(400)
    expect(ctx.db.prepare('SELECT count(*) AS n FROM llm_usage').get()).toMatchObject({ n: 0 })
  })
  it('analyzes only owned stored references and returns the captured revision/upload without mutation', async () => {
    const asset = createLibraryAsset(ctx.db, userId, { kind: 'logo', name: 'Original' })
    expect((await call(ctx, `/api/entity-library/assets/${asset.id}/analyze-reference`, { method: 'POST', body: { modelId } })).status).toBe(404)
    const saved = saveLibraryAssetReference(ctx.db, ctx.env, ctx.mediaStore, userId, asset.id, png)
    const result = await call(ctx, `/api/entity-library/assets/${asset.id}/analyze-reference`, { method: 'POST', body: { modelId } })
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ revision: saved.revision, referenceUploadId: saved.reference!.uploadId })
    expect(ctx.db.prepare('SELECT name, revision FROM library_assets WHERE id=?').get(asset.id)).toMatchObject({ name: 'Original', revision: saved.revision })
    const project = await call(ctx, '/api/projects', { method: 'POST', body: { name: 'Linked' } })
    const location = saveProjectLocation(ctx.db, userId, project.body.project.id, { name: 'Linked location', reference: { uploadId: saved.reference!.uploadId! } })
    const linked = listEntityCatalog(ctx.db, userId).find(entity => entity.source?.entityId === location.id)!
    expect((await call(ctx, `/api/entity-library/assets/${linked.id}/analyze-reference`, { method: 'POST', body: { modelId } })).status).toBe(400)
    await registerUser(ctx)
    expect((await call(ctx, `/api/entity-library/assets/${asset.id}/analyze-reference`, { method: 'POST', body: { modelId } })).status).toBe(404)
  })
  it('bounds input bytes, pixels and output size; rejects corrupt images', async () => {
    await expect(prepareAnalysisImage(png, png.length - 1)).rejects.toThrow()
    await expect(prepareAnalysisImage(png.subarray(0, 25), 1000)).rejects.toThrow()
    const large = await sharp({ create: { width: 5100, height: 5000, channels: 3, background: 'white' } }).png().toBuffer()
    await expect(prepareAnalysisImage(large, 1_000_000)).rejects.toThrow()
    const wide = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: 'white' } }).png().toBuffer()
    const metadata = await sharp(await prepareAnalysisImage(wide, 1_000_000)).metadata()
    expect(metadata.width).toBe(ANALYSIS_MAX_EDGE)
    expect(metadata.format).toBe('jpeg')
  })
  it('rejects disabled, non-LLM and foreign models without logging a call', async () => {
    ctx.db.prepare('UPDATE models SET enabled=0 WHERE id=?').run(modelId)
    expect((await analyze()).status).toBe(400)
    ctx.db.prepare("UPDATE models SET enabled=1,kind='image' WHERE id=?").run(modelId)
    expect((await analyze()).status).toBe(400)
    ctx.db.prepare("UPDATE models SET kind='llm' WHERE id=?").run(modelId)
    await registerUser(ctx)
    expect((await analyze()).status).toBe(404)
    expect(ctx.db.prepare('SELECT count(*) AS n FROM llm_usage').get()).toMatchObject({ n: 0 })
  })
  it('decodes only the first frame of animated GIFs', async () => {
    const frames = Buffer.concat([Buffer.from([255, 0, 0]), Buffer.from([0, 0, 255])])
    const gif = await sharp(frames, { raw: { width: 1, height: 2, channels: 3, pageHeight: 1 } }).gif({ delay: [100, 100], loop: 0 }).toBuffer()
    expect((await sharp(gif, { animated: true }).metadata()).pages).toBe(2)
    const result = await sharp(await prepareAnalysisImage(gif, 10000)).raw().toBuffer({ resolveWithObject: true })
    expect(result.info.height).toBe(1)
    expect(result.data[0]).toBeGreaterThan(240)
    expect(result.data[2]).toBeLessThan(10)
  })
  it('shares a per-user limiter across raw and stored analysis endpoints', async () => {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => { req.user = { id: userId } as express.Request['user']; next() })
    app.use(entityLibraryRoutes(ctx.db, { ...ctx.env, RATE_LIMIT_LLM_CHAT_PER_MIN: 1 }, ctx.mediaStore, ctx.worker))
    app.use(errorHandler)
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const first = await fetch(`${base}/analyze-reference?kind=item&modelId=${modelId}`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: new Uint8Array(png) })
      expect(first.status).toBe(200)
      const second = await fetch(`${base}/assets/missing/analyze-reference`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modelId }) })
      expect(second.status).toBe(429)
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  })
  it('strictly bounds provider JSON and normalizes AI handles', () => {
    const valid = { name: 'Đèn đỏ', handle: '@ĐÈN ĐỎ!', description: 'Đèn màu đỏ', continuityNotes: '' }
    expect(parseReferenceSuggestion(JSON.stringify(valid), 'item').handle).toBe('den-do')
    for (const value of [{ ...valid, extra: true }, { ...valid, name: 'x'.repeat(201) }, { ...valid, description: 'x'.repeat(5001) }, { name: 'missing' }]) expect(() => parseReferenceSuggestion(JSON.stringify(value), 'item')).toThrow()
  })
  it('projects multimodal content into safe text for mock and redacts image echoes from usage', () => {
    const parts = [{ type: 'text' as const, text: 'hello' }, { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,SECRET' } }]
    expect(chatContentText(parts)).toBe('hello\n[image]')
    expect(mockChatCompletionWithUsage([{ role: 'user', content: parts }]).promptTokens).toBeGreaterThan(0)
    recordLlmUsage(ctx.db, { userId, source: 'library_reference_ai', status: 'ok', latencyMs: 1, requestText: 'data:image/png;base64,YWJjZA==', responseText: 'data:image/png;base64,YWJjZA==' })
    expect(JSON.stringify(ctx.db.prepare('SELECT preview,response_preview FROM llm_usage').all())).not.toContain('base64')
  })
})
