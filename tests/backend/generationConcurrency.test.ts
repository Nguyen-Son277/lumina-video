import { createServer } from 'node:http'
import { expect, it, vi } from 'vitest'
import { call, registerUser, startTestServer } from './helpers'
import { MOCK_PNG_BYTES } from '../../server/generations/adapters/mock'

it.each(['incoming', 'queued', 'downloads'])('runs four %s image requests together without duplicates and drains on stop', async mode => {
  const received: string[] = []
  let downloads = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const fake = createServer((req, res) => {
    if (req.url === '/image.png') {
      downloads++
      void gate.then(() => { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(MOCK_PNG_BYTES) })
      return
    }
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString())
      received.push(body.prompt)
      const reply = () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [mode === 'downloads' ? { url: `http://127.0.0.1:${port}/image.png` } : { b64_json: Buffer.from(MOCK_PNG_BYTES).toString('base64') }] }))
      }
      if (mode === 'downloads') reply()
      else void gate.then(reply)
    })
  })
  const port = await new Promise<number>(resolve => fake.listen(0, '127.0.0.1', () => resolve((fake.address() as { port: number }).port)))
  const ctx = await startTestServer({ allowPrivate: true, providerMode: 'live' })
  ctx.env.MAX_CONCURRENT_JOBS_PER_USER = 4
  if (mode === 'downloads') ctx.env.MAX_USER_MEDIA_BYTES = Math.floor(MOCK_PNG_BYTES.byteLength * 2.5)
  try {
    await registerUser(ctx)
    const provider = await call(ctx, '/api/providers', { method: 'POST', body: { name: 'Concurrent images', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test' } })
    const model = await call(ctx, '/api/models', { method: 'POST', body: { providerId: provider.body.provider.id, kind: 'image', modelId: 'image-test', displayName: 'Image test' } })
    const wakeSpy = mode === 'queued' ? vi.spyOn(ctx.worker, 'wake').mockImplementation(() => {}) : null
    const ids: string[] = []
    for (let index = 0; index < 4; index++) {
      const created = await call(ctx, '/api/generations', { method: 'POST', body: { modelId: model.body.model.id, prompt: `Image ${index}` } })
      expect(created.status).toBe(202)
      ids.push(created.body.generation.id)
    }
    wakeSpy?.mockRestore()
    const ticking = mode === 'queued' ? ctx.worker.tick() : Promise.resolve()
    await vi.waitFor(() => expect(received).toHaveLength(4), { timeout: 2000 })
    if (mode === 'downloads') await vi.waitFor(() => expect(downloads).toBe(4), { timeout: 2000 })
    expect(new Set(received).size).toBe(4)
    expect(ctx.db.prepare("SELECT COUNT(*) AS total FROM generations WHERE status='running'").get()!.total).toBe(4)
    const overflow = await call(ctx, '/api/generations', { method: 'POST', body: { modelId: model.body.model.id, prompt: 'Over limit' } })
    expect(overflow.status).toBe(400)
    await Promise.all([ctx.worker.tick(), ctx.worker.tick()])
    expect(received).toHaveLength(4)
    let stopped = false
    const stopping = ctx.worker.stop().then(() => { stopped = true })
    await new Promise(resolve => setImmediate(resolve))
    expect(stopped).toBe(false)
    release()
    await stopping
    await ticking
    let succeeded = 0
    for (const id of ids) {
      const detail = await call(ctx, `/api/generations/${id}`)
      if (mode === 'downloads' && detail.body.generation.status === 'failed') {
        expect(detail.body.generation.errorCode).toBe('STORAGE_LIMIT')
      } else {
        expect(detail.body.generation.status).toBe('succeeded')
        expect(detail.body.generation.assets).toHaveLength(1)
        succeeded++
      }
    }
    expect(succeeded).toBe(mode === 'downloads' ? 2 : 4)
    expect(received).toHaveLength(4)
  } finally {
    release()
    await ctx.close()
    await new Promise<void>(resolve => fake.close(() => resolve()))
  }
})
