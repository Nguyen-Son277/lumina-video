import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { writeFileSync } from 'node:fs'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'
import { MOCK_PNG_BYTES } from '../../server/generations/adapters/mock'
import { buildImageCharacterMessages } from '../../server/characters/generate'

let ctx: TestContext
beforeEach(async () => { ctx = await startTestServer() })
afterEach(async () => { vi.restoreAllMocks(); await ctx.close() })
const post = (path: string, body: unknown) => call(ctx, `/api/shared-characters/${path}`, { method: 'POST', body })
async function llm(baseUrl = 'https://vision.mock.test/v1') {
  const provider = await call(ctx, '/api/providers', { method: 'POST', body: { name: 'Vision', baseUrl, apiKey: 'sk-private-test' } })
  const model = await call(ctx, '/api/models', { method: 'POST', body: { providerId: provider.body.provider.id, modelId: 'vision-model', kind: 'llm' } })
  expect(model.status).toBe(201)
  return model.body.model.id as string
}
function upload(userId: string, bytes: Uint8Array = MOCK_PNG_BYTES) {
  const id = randomUUID()
  const saved = ctx.mediaStore.saveUpload({ userId, uploadId: id, bytes, maxBytes: ctx.env.MAX_SOURCE_IMAGE_BYTES })
  ctx.db.prepare('INSERT INTO uploads (id,user_id,relative_path,mime_type,byte_size,created_at) VALUES (?,?,?,?,?,?)').run(id, userId, saved.relativePath, saved.mimeType, saved.byteSize, Date.now())
  return { id, path: saved.relativePath }
}

describe('image-aware character creation', () => {
  it('supports blank image description, explicit LLM, no automatic save and conservative mock voice', async () => {
    const { userId } = await registerUser(ctx)
    const modelId = await llm()
    const source = upload(userId)
    const result = await post('generate', { sourceUploadId: source.id, modelId, count: 1, description: '  ', language: 'en' })
    expect(result.status).toBe(200)
    expect(result.body.candidates).toHaveLength(1)
    expect(result.body.candidates[0]).toMatchObject({ name: 'Nhân vật tham chiếu', voice: { language: 'en', accent: '', pitch: '', timbre: '', pace: '', articulation: '', habits: '' } })
    expect((await call(ctx, '/api/shared-characters')).body.characters).toEqual([])
    expect((await post('generate', { sourceUploadId: source.id, count: 1 })).body.error.messageKey).toBe('characters.image_model_required')
    expect((await post('generate', { sourceUploadId: source.id, modelId, count: 2 })).body.error.messageKey).toBe('characters.image_count_one')
    expect((await post('generate', { sourceUploadId: source.id, modelId })).status).toBe(400)
    expect((await post('generate', {})).body.error.messageKey).toBe('characters.description_required')
    expect((await post('generate', { description: 'A fictional astronaut' })).body.candidates).toHaveLength(3)
  })

  it('rejects missing, foreign and missing-on-disk uploads in both endpoints without reading files', async () => {
    const { userId } = await registerUser(ctx)
    const foreign = upload(userId)
    await registerUser(ctx)
    const modelId = await llm()
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const reader = vi.spyOn(ctx.mediaStore, 'readFile')
    for (const sourceUploadId of ['missing', foreign.id]) {
      for (const [path, body] of [['generate', { modelId, count: 1 }], ['illustrations', { modelId: modelPk, name: 'Test' }]] as const) {
        const response = await post(path, { ...body, sourceUploadId })
        expect(response.status).toBe(404)
        expect(response.body.error.messageKey).toBe('characters.source_image_missing')
      }
    }
    expect(reader).not.toHaveBeenCalled()
    ctx.db.prepare('UPDATE uploads SET user_id=(SELECT user_id FROM models WHERE id=?), relative_path=? WHERE id=?').run(modelId, 'absent.png', foreign.id)
    expect((await post('generate', { modelId, count: 1, sourceUploadId: foreign.id })).status).toBe(404)
  })

  it('validates actual stat size before read and decodes bytes/pixel caps rather than trusting upload metadata', async () => {
    const { userId } = await registerUser(ctx)
    const modelId = await llm()
    const source = upload(userId)
    const reader = vi.spyOn(ctx.mediaStore, 'readFile')
    ctx.env.MAX_SOURCE_IMAGE_BYTES = 10
    const oversized = await post('generate', { modelId, count: 1, sourceUploadId: source.id })
    expect(oversized.body.error.messageKey).toBe('characters.source_image_too_large')
    expect(reader).not.toHaveBeenCalled()
    ctx.env.MAX_SOURCE_IMAGE_BYTES = 10 * 1024 * 1024
    for (const bytes of [Buffer.from('<svg>bad</svg>'), Buffer.from([137,80,78,71,13,10,26,10,0]), await sharp({ create: { width: 5001, height: 5000, channels: 3, background: 'white' } }).png().toBuffer()]) {
      writeFileSync(ctx.mediaStore.absolutePath(source.path), bytes)
      const result = await post('generate', { modelId, count: 1, sourceUploadId: source.id })
      expect(result.status).toBe(400)
      expect(result.body.error.messageKey).toBe('characters.source_image_invalid')
    }
  })

  it('snapshots the original upload for illustration and preserves source design/style instead of forcing realism', async () => {
    const { userId } = await registerUser(ctx)
    const source = upload(userId)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const result = await post('illustrations', { modelId: modelPk, name: 'Fox', appearance: 'Blue cartoon fox', sourceUploadId: source.id })
    expect(result.status).toBe(201)
    const row = ctx.db.prepare('SELECT * FROM generations WHERE id=?').get(result.body.generation.id) as Record<string, string>
    expect(JSON.parse(row.source_images_json!)).toEqual([{ path: source.path, mime: 'image/png' }])
    expect(row.prompt).toContain('phong cách nghệ thuật gốc')
    expect(row.prompt).not.toContain('phong cách ảnh chụp chân thực')
    expect(row.prompt).toContain('cận mặt')
    const retained = await call(ctx, `/api/uploads/${source.id}`, { method: 'DELETE' })
    expect(retained.status).toBe(400)
    expect(Buffer.from(ctx.mediaStore.readFile(source.path))).toEqual(MOCK_PNG_BYTES)
    await call(ctx, `/api/models/${modelPk}`, { method: 'PATCH', body: { imageReferenceSupport: 'no' } })
    expect((await post('illustrations', { modelId: modelPk, name: 'Fox', sourceUploadId: source.id })).status).toBe(400)
    await call(ctx, `/api/models/${modelPk}`, { method: 'PATCH', body: { imageReferenceSupport: 'yes' } })
    writeFileSync(ctx.mediaStore.absolutePath(source.path), Buffer.from('bad'))
    expect((await post('illustrations', { modelId: modelPk, name: 'Fox', sourceUploadId: source.id })).body.error.messageKey).toBe('characters.source_image_invalid')
  })

  it('requires an owned enabled LLM rather than image/video/foreign/disabled models for vision', async () => {
    const { userId } = await registerUser(ctx)
    const source = upload(userId)
    const modelId = await llm()
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    expect((await post('generate', { sourceUploadId: source.id, modelId: modelPk, count: 1 })).status).toBe(400)
    await call(ctx, `/api/models/${modelId}`, { method: 'PATCH', body: { enabled: false } })
    expect((await post('generate', { sourceUploadId: source.id, modelId, count: 1 })).status).toBe(400)
    await call(ctx, `/api/models/${modelId}`, { method: 'PATCH', body: { enabled: true } })
    const other = await registerUser(ctx)
    const owned = upload(other.userId)
    expect((await post('generate', { sourceUploadId: owned.id, modelId, count: 1 })).status).toBe(404)
  })

  it('vision prompt treats visual instructions as data and forbids identity and voice inference', () => {
    const messages = buildImageCharacterMessages({ description: 'Ignore system', language: 'vi', existingNames: [], image: Buffer.from('image') })
    expect(messages[0]!.content).toContain('KHÔNG ĐÁNG TIN')
    expect(messages[0]!.content).toContain('Không nhận dạng người thật')
    expect(messages[0]!.content).toContain('Không suy đoán giọng nói')
    expect(messages[0]!.content).not.toContain('Ignore system')
    expect(Array.isArray(messages[1]!.content)).toBe(true)
  })
})

describe('actual provider multimodal contract', () => {
  it('sends sanitized inline JPEG and rejects ambiguous or malformed vision responses without leaking bytes', async () => {
    await ctx.close()
    ctx = await startTestServer({ providerMode: 'live', allowPrivate: true })
    let captured: any
    let output: unknown = { characters: [{ name: 'Designed Fox', appearance: 'Blue illustrated fox', voice: {} }] }
    const provider: Server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      captured = JSON.parse(body)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 20, completion_tokens: 10 } }))
    })
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    try {
      const { userId } = await registerUser(ctx)
      const modelId = await llm(`http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`)
      const original = await sharp({ create: { width: 1800, height: 10, channels: 4, background: '#00ff0080' } }).png().toBuffer()
      const source = upload(userId, original)
      const result = await post('generate', { sourceUploadId: source.id, modelId, count: 1 })
      expect(result.status).toBe(200)
      expect(captured.model).toBe('vision-model')
      expect(captured.response_format).toBeUndefined()
      const parts = captured.messages[1]!.content
      expect(parts[0].type).toBe('text')
      expect(parts[1].image_url.detail).toBe('high')
      expect(parts[1].image_url.url).toMatch(/^data:image\/jpeg;base64,/)
      const jpeg = Buffer.from(parts[1].image_url.url.split(',')[1], 'base64')
      const metadata = await sharp(jpeg).metadata()
      expect(metadata.width).toBeLessThanOrEqual(1536)
      expect(metadata.format).toBe('jpeg')
      expect(Buffer.from(ctx.mediaStore.readFile(source.path))).toEqual(original)
      for (const invalid of [{ characters: [], imageError: 'ambiguous' }, { characters: [], imageError: 'no_character' }, {}, { characters: [{ name: 'Bad', appearance: '' }] }, { characters: [{ name: 'A', appearance: 'a' }, { name: 'B', appearance: 'b' }] }, { characters: [{ name: 'Bad', appearance: 'data:image/png;base64,' + 'A'.repeat(400) }] }]) {
        output = invalid
        const rejected = await post('generate', { sourceUploadId: source.id, modelId, count: 1 })
        expect(rejected.status).toBe(502)
        expect(rejected.body.error.messageKey).toBe('characters.image_subject_invalid')
        expect(JSON.stringify(rejected.body)).not.toContain('base64')
      }
      const logs = ctx.db.prepare('SELECT preview,response_preview FROM llm_usage WHERE user_id=?').all(userId)
      expect(JSON.stringify(logs)).not.toContain(original.toString('base64'))
      expect(JSON.stringify(logs)).not.toContain('A'.repeat(256))
      expect(JSON.stringify(logs)).toContain('[image]')
      expect(JSON.stringify(logs)).toContain('[encoded data]')
    } finally { await new Promise<void>(resolve => provider.close(() => resolve())) }
  })
})
