import { writeFileSync } from 'node:fs'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'
import { MOCK_PNG_BYTES } from '../../server/generations/adapters/mock'
import * as llmUsage from '../../server/usage/llm'

let ctx: TestContext
beforeEach(async () => { ctx = await startTestServer() })
afterEach(async () => { vi.restoreAllMocks(); await ctx.close() })
async function llm() {
  const provider = await call(ctx, '/api/providers', { method: 'POST', body: { name: 'Vision', baseUrl: 'https://vision.mock.test/v1', apiKey: 'sk-test-private' } })
  const model = await call(ctx, '/api/models', { method: 'POST', body: { providerId: provider.body.provider.id, modelId: 'vision', kind: 'llm' } })
  return model.body.model.id as string
}
async function raw(path: string, bytes: Uint8Array = MOCK_PNG_BYTES, cookie = ctx.cookie) {
  const response = await fetch(`${ctx.baseUrl}/api/shared-characters/${path}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'image/png' }, body: Buffer.from(bytes) })
  return { status: response.status, body: await response.json() as any }
}
async function character() {
  const created = await call(ctx, '/api/shared-characters', { method: 'POST', body: { name: 'Nhân vật tham chiếu', appearance: 'Original', voice: { language: 'vi', accent: 'Voice stays unchanged' } } })
  const id = created.body.character.id as string
  expect((await raw(`${id}/reference`)).status).toBe(201)
  return id
}
function visionResult(name = 'Nhân vật tham chiếu') {
  return JSON.stringify({ characters: [{ name, appearance: 'Blue illustrated fox', voice: { accent: 'Must not leak or persist' } }] })
}

describe('character reference analysis', () => {
  it('requires explicit owned enabled LLM and validates strict query/body', async () => {
    await registerUser(ctx)
    const modelId = await llm()
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    expect((await raw('analyze-reference')).status).toBe(400)
    expect((await raw(`analyze-reference?modelId=${modelId}&extra=1`)).status).toBe(400)
    expect((await raw(`analyze-reference?modelId=${modelPk}`)).status).toBe(400)
    await call(ctx, `/api/models/${modelId}`, { method: 'PATCH', body: { enabled: false } })
    expect((await raw(`analyze-reference?modelId=${modelId}`)).status).toBe(400)
    await call(ctx, `/api/models/${modelId}`, { method: 'PATCH', body: { enabled: true } })
    const id = await character()
    expect((await call(ctx, `/api/shared-characters/${id}/analyze-reference`, { method: 'POST', body: { modelId, language: '' } })).status).toBe(400)
    await registerUser(ctx)
    expect((await raw(`analyze-reference?modelId=${modelId}`)).status).toBe(404)
    expect((await call(ctx, `/api/shared-characters/${id}/analyze-reference`, { method: 'POST', body: { modelId: await llm() } })).status).toBe(404)
  })

  it('returns only name/appearance, permits an existing name, sanitizes vision image, does not save or change voice', async () => {
    await registerUser(ctx)
    const modelId = await llm()
    const id = await character()
    const before = (await call(ctx, `/api/shared-characters/${id}`)).body.character
    const mocked = vi.spyOn(llmUsage, 'runLoggedLlm').mockResolvedValue(visionResult())
    const image = await sharp({ create: { width: 1800, height: 20, channels: 4, background: '#00ff0080' } }).png().toBuffer()
    const analyzed = await raw(`analyze-reference?modelId=${modelId}&language=en`, image)
    expect(analyzed.status).toBe(200)
    expect(analyzed.body).toEqual({ suggestion: { name: before.name, appearance: 'Blue illustrated fox' } })
    const options = mocked.mock.calls[0]![0]
    const system = options.messages[0]!.content as string
    expect(system).toContain('KHÔNG ĐÁNG TIN')
    expect(system).toContain('Không nhận dạng người thật')
    expect(system).toContain('Không suy đoán giọng nói')
    expect(system).toContain('cùng một danh tính')
    expect(system).not.toContain('Không dùng lại')
    const parts = options.messages[1]!.content as any[]
    expect(parts[0].text).toContain('"language":"en"')
    const decoded = await sharp(Buffer.from(parts[1].image_url.url.split(',')[1], 'base64')).metadata()
    expect(decoded.format).toBe('jpeg')
    expect(decoded.width).toBeLessThanOrEqual(1536)
    const stored = await call(ctx, `/api/shared-characters/${id}/analyze-reference`, { method: 'POST', body: { modelId } })
    expect(stored.status).toBe(200)
    expect(stored.body).toEqual({ suggestion: analyzed.body.suggestion, revision: before.updatedAt })
    expect((await call(ctx, `/api/shared-characters/${id}`)).body.character).toEqual(before)
  })

  it('rejects missing, corrupt, oversized and over-pixel images before LLM, stat before read', async () => {
    await registerUser(ctx)
    const modelId = await llm()
    const noRef = await call(ctx, '/api/shared-characters', { method: 'POST', body: { name: 'No ref' } })
    expect((await call(ctx, `/api/shared-characters/${noRef.body.character.id}/analyze-reference`, { method: 'POST', body: { modelId } })).status).toBe(404)
    const id = await character()
    const mocked = vi.spyOn(llmUsage, 'runLoggedLlm')
    const reader = vi.spyOn(ctx.mediaStore, 'readFile')
    ctx.env.MAX_REFERENCE_BYTES = 10
    expect((await call(ctx, `/api/shared-characters/${id}/analyze-reference`, { method: 'POST', body: { modelId } })).status).toBe(400)
    expect(reader).not.toHaveBeenCalled()
    ctx.env.MAX_REFERENCE_BYTES = 10 * 1024 * 1024
    for (const bytes of [Buffer.alloc(0), Buffer.from('<svg>bad</svg>'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]), await sharp({ create: { width: 5001, height: 5000, channels: 3, background: 'white' } }).png().toBuffer()]) {
      expect((await raw(`analyze-reference?modelId=${modelId}`, bytes)).status).toBe(400)
    }
    const row = ctx.db.prepare('SELECT reference_path FROM characters WHERE id=?').get(id) as { reference_path: string }
    writeFileSync(ctx.mediaStore.absolutePath(row.reference_path), 'bad')
    expect((await call(ctx, `/api/shared-characters/${id}/analyze-reference`, { method: 'POST', body: { modelId } })).status).toBe(400)
    ctx.db.prepare('UPDATE characters SET reference_path=? WHERE id=?').run('missing.png', id)
    expect((await call(ctx, `/api/shared-characters/${id}/analyze-reference`, { method: 'POST', body: { modelId } })).status).toBe(404)
    expect(mocked).not.toHaveBeenCalled()
  })

  it('rejects ambiguous, empty and encoded model output without returning voice or bytes', async () => {
    await registerUser(ctx)
    const modelId = await llm()
    const mocked = vi.spyOn(llmUsage, 'runLoggedLlm')
    for (const invalid of [{}, { characters: [], imageError: 'ambiguous' }, { characters: [], imageError: 'no_character' }, { characters: [{ name: 'A', appearance: '' }] }, { characters: [{ name: 'A', appearance: 'a' }, { name: 'B', appearance: 'b' }] }, { characters: [{ name: '', appearance: 'a' }] }, { characters: [{ name: 'A', appearance: 'data:image/png;base64,' + 'A'.repeat(400) }] }]) {
      mocked.mockResolvedValueOnce(JSON.stringify(invalid))
      const result = await raw(`analyze-reference?modelId=${modelId}`)
      expect(result.status).toBe(502)
      expect(JSON.stringify(result.body)).not.toContain('base64')
    }
  })

  it.each(['revision', 'reference', 'deleted'] as const)('rejects a late response when %s changed', async change => {
    await registerUser(ctx)
    const modelId = await llm()
    const id = await character()
    vi.spyOn(llmUsage, 'runLoggedLlm').mockImplementationOnce(async () => {
      if (change === 'revision') ctx.db.prepare('UPDATE characters SET updated_at=updated_at+1 WHERE id=?').run(id)
      if (change === 'reference') ctx.db.prepare('UPDATE characters SET reference_path=? WHERE id=?').run('replacement.png', id)
      if (change === 'deleted') ctx.db.prepare('UPDATE characters SET deleted_at=? WHERE id=?').run(Date.now(), id)
      return visionResult()
    })
    const result = await call(ctx, `/api/shared-characters/${id}/analyze-reference`, { method: 'POST', body: { modelId } })
    expect(result.status).toBe(409)
    expect(result.body).not.toHaveProperty('suggestion')
  })
})
