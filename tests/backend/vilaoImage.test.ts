import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { buildImageEditForm } from '../../server/generations/adapters/image'
import { isVilaoBaseUrl } from '../../server/providers/vilao'
import * as client from '../../server/providers/client'
import { MOCK_PNG_BYTES } from '../../server/generations/adapters/mock'
import { call, registerUser, startTestServer, waitForGeneration } from './helpers'

// All provider calls terminate here; these tests never send a paid request.
vi.mock('../../server/providers/client', async importOriginal => {
  const original = await importOriginal<typeof import('../../server/providers/client')>()
  return {
    ...original,
    callProvider: vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: Buffer.from(MOCK_PNG_BYTES).toString('base64') }],
    }), { headers: { 'Content-Type': 'application/json' } })),
  }
})

const source = { bytes: MOCK_PNG_BYTES, mimeType: 'image/png' }

describe('Vilao documented image contract', () => {
  it('matches the API host without applying Vilao behavior to lookalike hosts', () => {
    for (const url of ['https://api.vilao.ai/v1', 'https://API.VILAO.AI/v1/']) {
      expect(isVilaoBaseUrl(url)).toBe(true)
    }
    for (const url of ['https://api.vilao.ai.evil.test/v1', 'https://evil.test/api.vilao.ai', 'https://api.vilao.ai@evil.test/v1', 'https://vilao.ai/v1', 'invalid']) {
      expect(isVilaoBaseUrl(url)).toBe(false)
    }
  })

  it('uses image for one reference and repeated image[] files for several references', async () => {
    const single = buildImageEditForm({ modelId: 'gpt-image-2', prompt: 'Edit', params: {}, sources: [source], providerBaseUrl: 'https://api.vilao.ai/v1' })
    expect(single.getAll('image')).toHaveLength(1)
    expect(single.has('image[]')).toBe(false)
    const multiple = buildImageEditForm({ modelId: 'gpt-image-2', prompt: 'Combine', params: { n: 2, size: '1536x1024', quality: 'high' }, sources: [source, source], providerBaseUrl: 'https://api.vilao.ai/v1' })
    expect(multiple.has('image')).toBe(false)
    expect(multiple.getAll('image[]')).toHaveLength(2)
    expect(multiple.get('model')).toBe('gpt-image-2')
    expect(multiple.get('n')).toBe('2')
    expect(multiple.get('size')).toBe('1536x1024')
    expect(multiple.get('quality')).toBe('high')
    for (const file of multiple.getAll('image[]')) {
      expect(file).toBeInstanceOf(File)
      expect(new Uint8Array(await (file as File).arrayBuffer())).toEqual(new Uint8Array(MOCK_PNG_BYTES))
    }
  })

  it('preserves repeated image fields for other providers', () => {
    const form = buildImageEditForm({ modelId: 'gpt-image-2', prompt: 'Combine', params: {}, sources: [source, source], providerBaseUrl: 'https://other.example/v1' })
    expect(form.getAll('image')).toHaveLength(2)
    expect(form.has('image[]')).toBe(false)
  })

  it('migrates only Vilao settings and preserves image capabilities and generation history', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec(`CREATE TABLE provider_connections (id TEXT PRIMARY KEY, base_url TEXT, image_api_style TEXT);
        CREATE TABLE models (id TEXT PRIMARY KEY, provider_id TEXT, image_reference_transport TEXT, image_reference_support TEXT, image_max_references INTEGER, kind TEXT);
        CREATE TABLE generations (id TEXT PRIMARY KEY, snap_image_reference_transport TEXT, snap_image_style TEXT);`)
      const urls = ['https://api.vilao.ai/v1', 'https://api.vilao.ai/v1/', 'https://api.vilao.ai.evil.test/v1', 'https://other.test/api.vilao.ai', 'https://other.test/v1']
      urls.forEach((url, i) => {
        db.prepare('INSERT INTO provider_connections VALUES (?, ?, ?)').run(String(i), url, 'extra_body')
        db.prepare('INSERT INTO models VALUES (?, ?, ?, ?, ?, ?)').run(String(i), String(i), 'generations_images', 'yes', 8, 'image')
      })
      db.prepare('INSERT INTO generations VALUES (?, ?, ?)').run('historical', 'generations_images', 'extra_body')
      db.exec(readFileSync(new URL('../../server/db/migrations/056_vilao_image_transport.sql', import.meta.url), 'utf8'))
      for (let i = 0; i < urls.length; i++) {
        const vilao = i < 2
        expect(db.prepare('SELECT image_api_style FROM provider_connections WHERE id=?').get(String(i))).toEqual({ image_api_style: vilao ? 'openai' : 'extra_body' })
        expect(db.prepare('SELECT image_reference_transport, image_reference_support, image_max_references FROM models WHERE id=?').get(String(i))).toEqual({ image_reference_transport: vilao ? 'provider_default' : 'generations_images', image_reference_support: 'yes', image_max_references: 8 })
      }
      expect(db.prepare('SELECT * FROM generations').get()).toEqual({ id: 'historical', snap_image_reference_transport: 'generations_images', snap_image_style: 'extra_body' })
    } finally { db.close() }
  })

  it('uses documented multipart edits despite legacy settings and preserves normal text generation', async () => {
    const ctx = await startTestServer({ providerMode: 'live' })
    const mocked = vi.mocked(client.callProvider)
    mocked.mockClear()
    try {
      await registerUser(ctx)
      const provider = await call(ctx, '/api/providers', { method: 'POST', body: { name: 'Vilao fixture', baseUrl: 'https://api.vilao.ai/v1', apiKey: 'fixture-only', imageApiStyle: 'extra_body' } })
      expect(provider.status).toBe(201)
      const model = await call(ctx, '/api/models', { method: 'POST', body: { providerId: provider.body.provider.id, modelId: 'gpt-image-2', kind: 'image' } })
      expect(model.status).toBe(201)
      await call(ctx, `/api/models/${model.body.model.id}`, { method: 'PATCH', body: { imageReferenceTransport: 'generations_images', imageReferenceSupport: 'yes' } })
      const uploaded = await fetch(`${ctx.baseUrl}/api/uploads`, { method: 'POST', headers: { Cookie: ctx.cookie, 'Content-Type': 'image/png' }, body: MOCK_PNG_BYTES })
      expect(uploaded.status).toBe(201)
      const upload = await uploaded.json() as { upload: { id: string } }
      for (const references of [true, false]) {
        mocked.mockClear()
        const created = await call(ctx, '/api/generations', { method: 'POST', body: { modelId: model.body.model.id, prompt: 'Documented Vilao image', params: { quality: 'high', size: '1024x1024' }, ...(references ? { sourceUploadIds: [upload.upload.id] } : {}) } })
        expect(created.status).toBe(202)
        const done = await waitForGeneration(ctx, created.body.generation.id)
        expect(done.status).toBe('succeeded')
        expect(done.assets).toHaveLength(1)
        expect(mocked).toHaveBeenCalledTimes(1)
        const [, endpoint, request] = mocked.mock.calls[0]!
        expect(endpoint).toBe(references ? 'images/edits' : 'images/generations')
        if (references) {
          expect(request?.body).toBeUndefined()
          expect(request?.formData?.get('quality')).toBe('high')
          expect(request?.formData?.getAll('image')).toHaveLength(1)
        } else {
          expect(request?.formData).toBeUndefined()
          expect(request?.body).toMatchObject({ model: 'gpt-image-2', quality: 'high', size: '1024x1024' })
          expect(request?.body).not.toHaveProperty('extra_body')
        }
      }
    } finally { await ctx.close() }
  })
})
