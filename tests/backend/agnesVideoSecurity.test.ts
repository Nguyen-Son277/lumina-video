import { afterEach, expect, it, vi } from 'vitest'
import { callProvider, readProviderError } from '../../server/providers/client'
import { guardProviderUrl } from '../../server/providers/urlGuard'
import { call, registerUser, seedProviderAndModel, startTestServer } from './helpers'
import { MOCK_PNG_BYTES } from '../../server/generations/adapters/mock'
import { downloadAgnesVideo } from '../../server/generations/adapters/agnes'

afterEach(() => vi.restoreAllMocks())

it('redacts keys before truncation even across diagnostic boundary', async () => {
  const secret = 'sk-secret-long-1234567890'
  for (const text of ['x'.repeat(495) + secret, JSON.stringify({ message: 'x'.repeat(495) + secret })]) {
    const response = { status: 503, ok: false, headers: new Headers(), body: null, text: async () => text, json: async () => ({}) }
    const detail = await readProviderError(response, [secret])
    expect(detail.length).toBeLessThanOrEqual(500)
    expect(detail).not.toContain('sk-se')
  }
  expect(await readProviderError({ status: 503, ok: false, headers: new Headers(), body: null, text: async () => { throw new Error('read failed') }, json: async () => ({}) }, [secret])).toContain('503')
})

it('public HTTP download pins vetted DNS and never forwards key across origins or follows redirect', async () => {
  const calls: Array<{ url: any; init: any }> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => { calls.push({ url, init }); return new Response('redirect', { status: 302, headers: { Location: 'http://127.0.0.1/private' } }) })
  await expect(callProvider({ baseUrl: 'https://provider.test/v1', apiKey: 'sk-secret-123', allowPrivate: true }, '', { absoluteUrl: 'http://8.8.8.8/movie.mp4', publicMedia: true })).rejects.toThrow('chuyển hướng')
  expect(calls).toHaveLength(1)
  expect(calls[0]!.init.headers.Authorization).toBeUndefined()
  expect(calls[0]!.init.redirect).toBe('manual')
  expect(calls[0]!.init.dispatcher).toBeDefined()
  await expect(callProvider({ baseUrl: 'https://provider.test/v1', apiKey: 'sk-secret-123', allowPrivate: true }, '', { absoluteUrl: 'http://127.0.0.1/movie.mp4', publicMedia: true })).rejects.toThrow('nội bộ')
  expect(calls).toHaveLength(1)
  await expect(guardProviderUrl('http://8.8.8.8/a', { allowPrivate: false })).rejects.toThrow('https') // provider defaults unchanged
})

it('streaming download enforces actual per-video/per-user limits and MP4 magic', async () => {
  const ctx = await startTestServer()
  try {
    const { userId } = await registerUser(ctx)
    const generation: any = { id: 'security', user_id: userId, provider_result_url: 'http://8.8.8.8/movie.mp4' }
    const context = { generation, provider: { baseUrl: 'https://provider.test/v1', apiKey: 'sk-secret-123', allowPrivate: true }, db: ctx.db, mediaStore: ctx.mediaStore, env: ctx.env }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(Buffer.alloc(30), { headers: { 'content-type': 'video/mp4' } }))
    await expect(downloadAgnesVideo(context)).rejects.toThrow('not MP4')
    ctx.env.MAX_VIDEO_BYTES = 20
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(Buffer.alloc(30), { headers: { 'content-type': 'video/mp4' } }))
    await expect(downloadAgnesVideo(context)).rejects.toThrow('dung lượng')
    ctx.env.MAX_VIDEO_BYTES = 100
    ctx.env.MAX_USER_MEDIA_BYTES = 20
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(Buffer.alloc(30), { headers: { 'content-type': 'video/mp4' } }))
    await expect(downloadAgnesVideo(context)).rejects.toThrow('dung lượng')
  } finally { await ctx.close() }
})

it('Agnes never attaches private character refs or falsely claims attached input_reference', async () => {
  const ctx = await startTestServer()
  try {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'video')
    ctx.db.prepare("UPDATE models SET model_id='agnes-video-2.5-flash',video_api_style='agnes' WHERE id=?").run(modelPk)
    const project = (await call(ctx, '/api/projects', { method: 'POST', body: { name: 'Film', language: 'vi' } })).body.project
    const character = (await call(ctx, `/api/projects/${project.id}/characters`, { method: 'POST', body: { name: 'An', appearance: 'Blue shirt' } })).body.character
    const upload = await fetch(`${ctx.baseUrl}/api/projects/${project.id}/characters/${character.id}/reference`, { method: 'POST', headers: { Cookie: ctx.cookie, 'Content-Type': 'image/png' }, body: MOCK_PNG_BYTES })
    expect(upload.status).toBe(201)
    vi.spyOn(ctx.worker, 'wake').mockImplementation(() => {})
    const input = { projectId: project.id, characterId: character.id, modelId: modelPk, prompt: 'Walking' }
    expect((await call(ctx, '/api/generations', { method: 'POST', body: { ...input, params: { useCharacterReference: true } } })).status).toBe(400)
    for (const params of [{}, { useCharacterReference: false }]) {
      const created = await call(ctx, '/api/generations', { method: 'POST', body: { ...input, params } })
      expect(created.status).toBe(202)
      expect(created.body.generation.params.useCharacterReference).toBe(false)
      expect(created.body.generation.effectivePrompt).not.toContain('attached as input_reference')
      const row = ctx.db.prepare('SELECT * FROM generations WHERE id=?').get(created.body.generation.id)!
      expect(row.character_reference_json).toBeNull()
      expect(row.character_references_json).toBeNull()
    }
  } finally { await ctx.close() }
})
