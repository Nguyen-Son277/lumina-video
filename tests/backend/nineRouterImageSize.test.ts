import { createServer } from 'node:http'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { IMAGE_RATIOS, IMAGE_RESOLUTIONS, imageSizeFor } from '../../shared/imageControls'
import { imageSizeForModel } from '../../server/generations/adapters/imageSize'
import { buildGenerationsImagesRequest, buildImageRequestBody } from '../../server/generations/adapters/image'
import { call, registerUser, startTestServer, waitForGeneration } from './helpers'

// Exact sizeToAspectRatio contract used by 9Router's Antigravity adapter.
const tokens = {
  '1:1': '1024x1024', '16:9': '1792x1024', '9:16': '1024x1792',
  '3:2': '1536x1024', '2:3': '1024x1536',
} as const
const modelId = 'ag/gemini-3.1-flash-image'

describe('9Router Antigravity aspect ratio compatibility', () => {
  it('encodes every UI ratio and resolution using recognized gateway tokens', () => {
    for (const ratio of IMAGE_RATIOS) for (const resolution of IMAGE_RESOLUTIONS) {
      const params = { size: imageSizeFor(ratio, resolution) }
      expect(buildImageRequestBody(modelId, 'scene', params).size).toBe(tokens[ratio])
      expect(buildGenerationsImagesRequest({ modelId, prompt: 'scene', params, sources: [] }).size).toBe(tokens[ratio])
    }
  })

  it('preserves supported legacy tokens and default omission', () => {
    for (const size of Object.values(tokens)) expect(imageSizeForModel(modelId, size)).toBe(size)
    expect(buildImageRequestBody(modelId, 'scene', {})).not.toHaveProperty('size')
    expect(imageSizeForModel('antigravity/gemini-3-pro-image-preview', '576x1024')).toBe('1024x1792')
  })

  it('never changes sizes for unrelated providers or routes', () => {
    for (const model of ['gemini/gemini-3.1-flash-image', 'cx/gpt-image-2', 'gpt-image-1', 'agnes-image-2.5-flash', 'ag/not-an-image-model']) {
      expect(buildImageRequestBody(model, 'scene', { size: '2304x4096' }).size).toBe('2304x4096')
    }
  })

  it('rejects unrepresentable custom sizes rather than silently generating a square', () => {
    for (const size of ['600x1900', '1920x1200', 'auto', 'bad-size']) {
      expect(() => imageSizeForModel(modelId, size)).toThrow('chỉ nhận tỉ lệ')
    }
  })

  it('posts the portrait token once and saves the provider image without square conversion', async () => {
    const captures: Array<{ path: string; body: Record<string, unknown> }> = []
    const portrait = await sharp({ create: { width: 90, height: 160, channels: 3, background: '#5588aa' } }).png().toBuffer()
    const square = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#5588aa' } }).png().toBuffer()
    const fake = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString())
        captures.push({ path: req.url ?? '', body })
        // Reproduce the gateway failure: noncanonical sizes fall back to 1:1.
        const bytes = body.size === tokens['9:16'] ? portrait : square
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] }))
      })
    })
    await new Promise<void>(resolve => fake.listen(0, '127.0.0.1', resolve))
    const ctx = await startTestServer({ allowPrivate: true, providerMode: 'live' })
    try {
      await registerUser(ctx)
      const port = (fake.address() as { port: number }).port
      const provider = await call(ctx, '/api/providers', { method: 'POST', body: { name: '9Router fixture', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'fixture-key' } })
      const model = await call(ctx, '/api/models', { method: 'POST', body: { providerId: provider.body.provider.id, modelId, kind: 'image' } })
      await call(ctx, `/api/models/${model.body.model.id}`, { method: 'PATCH', body: { imageReferenceTransport: 'generations_images', imageReferenceSupport: 'no' } })
      const created = await call(ctx, '/api/generations', { method: 'POST', body: { modelId: model.body.model.id, prompt: 'portrait', params: { size: '1152x2048', n: 1 } } })
      expect(created.status).toBe(202)
      expect((await waitForGeneration(ctx, created.body.generation.id)).status).toBe('succeeded')
      expect(captures).toHaveLength(1)
      expect(captures[0]).toMatchObject({ path: '/v1/images/generations', body: { model: modelId, size: '1024x1792', n: 1 } })
      const asset = ctx.db.prepare('SELECT relative_path FROM assets WHERE generation_id = ?').get(created.body.generation.id) as { relative_path: string }
      const metadata = await sharp(ctx.mediaStore.readFile(asset.relative_path)).metadata()
      expect([metadata.width, metadata.height]).toEqual([90, 160])
      // Snapshot keeps the user's requested resolution; wire tokens are not a
      // promise that the provider generated that many pixels.
      const snapshot = ctx.db.prepare('SELECT params_json FROM generations WHERE id = ?').get(created.body.generation.id) as { params_json: string }
      expect(JSON.parse(snapshot.params_json).size).toBe('1152x2048')
    } finally {
      await ctx.close()
      await new Promise<void>(resolve => fake.close(() => resolve()))
    }
  })
})
