import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'
import { resolveImageSettings } from '../../server/models/imageSettings'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { if (ctx) await ctx.close() })

describe('per-model image settings', () => {
  it('persists optional size and reference support through model API', async () => {
    const { userId } = await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const initial = await call(ctx, '/api/models')
    expect(initial.body.models[0]).toMatchObject({ imageSize: null, imageReferenceSupport: 'unknown' })
    const updated = await call(ctx, `/api/models/${modelPk}`, { method: 'PATCH', body: { imageSize: '1024x1024', imageReferenceSupport: 'yes' } })
    expect(updated.body.model).toMatchObject({ imageSize: '1024x1024', imageReferenceSupport: 'yes' })
    expect(resolveImageSettings(ctx.db, modelPk, userId).params).toEqual({ size: '1024x1024' })
    expect(resolveImageSettings(ctx.db, modelPk, userId, { hasReferences: true }).warning).toBeUndefined()
    const generation = await call(ctx, '/api/generations', { method: 'POST', body: { modelId: modelPk, prompt: 'test image defaults' } })
    expect(generation.status).toBe(202)
    expect(generation.body.generation.params.size).toBe('1024x1024')
  })

  it('omits size by default, warns when reference support is unknown, and rejects explicit no', async () => {
    const { userId } = await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    expect(resolveImageSettings(ctx.db, modelPk, userId)).toMatchObject({ params: {}, referenceSupport: 'unknown' })
    expect(resolveImageSettings(ctx.db, modelPk, userId, { hasReferences: true }).warning).toBe('reference_support_unknown')
    await call(ctx, `/api/models/${modelPk}`, { method: 'PATCH', body: { imageReferenceSupport: 'no' } })
    expect(() => resolveImageSettings(ctx.db, modelPk, userId, { hasReferences: true })).toThrow(/không hỗ trợ/)
  })
})
