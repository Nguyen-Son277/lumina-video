import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'
import { resolveImageSettings } from '../../server/models/imageSettings'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { if (ctx) await ctx.close() })

describe('image reference transport settings', () => {
  it('defaults transport, persists patch values, and resolves them alongside existing settings', async () => {
    const { userId } = await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')

    const initial = await call(ctx, '/api/models')
    expect(initial.body.models[0]).toMatchObject({
      imageReferenceTransport: 'provider_default',
      imageMaxReferences: null,
      imageSize: null,
      imageReferenceSupport: 'unknown',
    })
    expect(resolveImageSettings(ctx.db, modelPk, userId)).toMatchObject({
      params: {},
      referenceSupport: 'unknown',
      transport: 'provider_default',
      maxReferences: null,
    })

    const updated = await call(ctx, `/api/models/${modelPk}`, {
      method: 'PATCH',
      body: {
        imageSize: '1024x1024',
        imageReferenceSupport: 'yes',
        imageReferenceTransport: 'generations_images',
        imageMaxReferences: 12,
      },
    })
    expect(updated.status).toBe(200)
    expect(updated.body.model).toMatchObject({
      imageSize: '1024x1024',
      imageReferenceSupport: 'yes',
      imageReferenceTransport: 'generations_images',
      imageMaxReferences: 12,
    })
    expect(resolveImageSettings(ctx.db, modelPk, userId)).toMatchObject({
      params: { size: '1024x1024' },
      referenceSupport: 'yes',
      transport: 'generations_images',
      maxReferences: 12,
    })

    const cleared = await call(ctx, `/api/models/${modelPk}`, {
      method: 'PATCH',
      body: { imageMaxReferences: null },
    })
    expect(cleared.body.model.imageMaxReferences).toBeNull()
  })

  it('rejects invalid transports and maximum reference counts', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    for (const imageMaxReferences of [0, -1, 17, 1.5]) {
      const response = await call(ctx, `/api/models/${modelPk}`, {
        method: 'PATCH',
        body: { imageMaxReferences },
      })
      expect(response.status).toBe(400)
    }
    const invalidTransport = await call(ctx, `/api/models/${modelPk}`, {
      method: 'PATCH',
      body: { imageReferenceTransport: 'other' },
    })
    expect(invalidTransport.status).toBe(400)
  })
})
