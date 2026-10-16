import { expect, it } from 'vitest'
import { createServer } from 'node:http'
import sharp from 'sharp'
import { call, registerUser, startTestServer, waitForGeneration } from './helpers'
import { composeReferenceSheet, referenceSheetPrompt } from '../../server/generations/adapters/referenceSheet'
import { buildGenerationsImagesRequest } from '../../server/generations/adapters/image'

it('builds generations JSON with ordered data URLs and no edits fields', () => {
  const body = buildGenerationsImagesRequest({ modelId: 'gateway-image', prompt: 'scene', params: {}, sources: [{ bytes: new Uint8Array([1,2]), mimeType: 'image/jpeg' }] })
  expect(body.images).toEqual(['data:image/jpeg;base64,AQI='])
  expect(body).not.toHaveProperty('extra_body')
  expect(body).not.toHaveProperty('referenceSheet')
})

it('composes a bounded sheet preserving every tile and source order', async () => {
  const red = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ff0000' } }).png().toBuffer()
  const blue = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#0000ff' } }).png().toBuffer()
  const sheet = await composeReferenceSheet([{ bytes: red, mimeType: 'image/png' }, { bytes: blue, mimeType: 'image/png' }])
  const metadata = await sharp(sheet).metadata()
  expect(metadata.width).toBe(1536)
  expect(metadata.height).toBe(768)
  const left = await sharp(sheet).extract({ left: 100, top: 100, width: 1, height: 1 }).raw().toBuffer()
  const right = await sharp(sheet).extract({ left: 900, top: 100, width: 1, height: 1 }).raw().toBuffer()
  expect([...left].slice(0, 3)).toEqual([255,0,0])
  expect([...right].slice(0, 3)).toEqual([0,0,255])
  expect(referenceSheetPrompt('scene', 2)).toContain('source 2: row 1, column 2')
  await expect(composeReferenceSheet([])).rejects.toThrow()
})

it('sends exactly one generations JSON POST using enqueued snapshot after model changes', async () => {
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ff0000' } }).png().toBuffer()
  const captures: Array<{ path: string; type: string; body: any }> = []
  const fake = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      captures.push({ path: req.url ?? '', type: req.headers['content-type'] ?? '', body: JSON.parse(Buffer.concat(chunks).toString()) })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
    })
  })
  await new Promise<void>(resolve => fake.listen(0, '127.0.0.1', resolve))
  const port = (fake.address() as { port: number }).port
  const ctx = await startTestServer({ allowPrivate: true, providerMode: 'live' })
  try {
    const { userId } = await registerUser(ctx)
    const provider = await call(ctx, '/api/providers', { method: 'POST', body: { name: 'Gateway', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'mock-gateway-key' } })
    const model = await call(ctx, '/api/models', { method: 'POST', body: { providerId: provider.body.provider.id, modelId: 'gateway-image', kind: 'image' } })
    const modelId = model.body.model.id
    await call(ctx, `/api/models/${modelId}`, { method: 'PATCH', body: { imageReferenceTransport: 'generations_images', imageMaxReferences: 1 } })
    const sourceIds = ['red-a', 'red-b']
    for (const id of sourceIds) {
      const saved = ctx.mediaStore.saveUpload({ userId, uploadId: id, bytes: png, maxBytes: ctx.env.MAX_REFERENCE_BYTES })
      ctx.db.prepare('INSERT INTO uploads(id,user_id,relative_path,mime_type,byte_size,created_at) VALUES(?,?,?,?,?,?)').run(id,userId,saved.relativePath,saved.mimeType,saved.byteSize,Date.now())
    }
    const blocked = await call(ctx, '/api/generations', { method: 'POST', body: { modelId, prompt: 'scene', sourceUploadIds: sourceIds } })
    expect(blocked.status).toBe(400)
    expect(captures).toHaveLength(0)
    const created = await call(ctx, '/api/generations', { method: 'POST', body: { modelId, prompt: 'scene', sourceUploadIds: sourceIds, params: { referenceSheet: true } } })
    expect(created.status).toBe(202)
    await call(ctx, `/api/models/${modelId}`, { method: 'PATCH', body: { imageReferenceTransport: 'provider_default', imageMaxReferences: 8 } })
    const done = await waitForGeneration(ctx, created.body.generation.id)
    expect(done.status).toBe('succeeded')
    expect(captures).toHaveLength(1)
    expect(captures[0]!.path).toBe('/v1/images/generations')
    expect(captures[0]!.type).toContain('application/json')
    expect(captures[0]!.body.images).toHaveLength(1)
    expect(captures[0]!.body.prompt).toContain('contact sheet')
  } finally { await ctx.close(); await new Promise<void>(resolve => fake.close(() => resolve())) }
})
