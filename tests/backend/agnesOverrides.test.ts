import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'
import { pollAgnesVideo } from '../../server/generations/adapters/agnes'
import type { GenerationContext } from '../../server/generations/types'
let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { await ctx.close() })
describe('Persisted video API classification', () => {
  it('honors aliases, unrelated updates, sync and explicit OpenAI override', async () => {
    await registerUser(ctx)
    const { modelPk, providerId } = await seedProviderAndModel(ctx, 'video')
    const patched = await call(ctx, `/api/models/${modelPk}`, { method: 'PATCH', body: { videoApiStyle: 'agnes' } })
    expect(patched.status).toBe(200)
    expect(patched.body.model.videoApiStyle).toBe('agnes')
    await call(ctx, `/api/models/${modelPk}`, { method: 'PATCH', body: { priceUnit: 1 } })
    await call(ctx, `/api/providers/${providerId}/sync-models`, { method: 'POST' })
    expect((await call(ctx, '/api/models')).body.models.find((model: any) => model.id === modelPk).videoApiStyle).toBe('agnes')
    const alias = await call(ctx, '/api/generations', { method: 'POST', body: { modelId: modelPk, prompt: 'test' } })
    expect(alias.status).toBe(202)
    expect(ctx.db.prepare('SELECT snap_video_style FROM generations WHERE id=?').get(alias.body.generation.id)?.snap_video_style).toBe('agnes')
    const created = await call(ctx, '/api/models', { method: 'POST', body: { providerId, modelId: 'agnes-video-2.5-flash', kind: 'video' } })
    const id = created.body.model.id
    await call(ctx, `/api/models/${id}`, { method: 'PATCH', body: { videoApiStyle: 'openai' } })
    const openai = await call(ctx, '/api/generations', { method: 'POST', body: { modelId: id, prompt: 'test', params: { size: '1280x720', seconds: '4' } } })
    expect(openai.status).toBe(202)
    expect(ctx.db.prepare('SELECT snap_video_style FROM generations WHERE id=?').get(openai.body.generation.id)?.snap_video_style).toBe('openai')
  })
  it('does not echo secret-bearing invalid provider result URL', async () => {
    const key = 'secret-agnes-key-123'
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: 'completed', url: `http://${key}@127.0.0.1/result.mp4` }), { headers: { 'content-type': 'application/json' } }))
    try {
      const context = {
        db: ctx.db, mediaStore: ctx.mediaStore, env: ctx.env,
        generation: { id: 'no-row', snap_model_id: 'agnes-video-2.5-flash', provider_job_id: 'v', provider_result_url: null },
        provider: { baseUrl: 'http://127.0.0.1:8080/v1', apiKey: key, allowPrivate: true },
      } as unknown as GenerationContext
      let message = ''
      try { await pollAgnesVideo(context) } catch (error) { message = (error as Error).message }
      expect(message).toContain('result URL')
      expect(message).not.toContain(key)
      expect(message).not.toContain('127.0.0.1')
    } finally { spy.mockRestore() }
  })
})
