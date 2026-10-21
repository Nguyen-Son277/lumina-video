import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { illustrationSizeSchema, assetIllustrationSchema } from '../../shared/entityCreation'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { await ctx.close() })

describe('illustration image settings', () => {
  it('bounds custom dimensions and strictly accepts only supported quality values', () => {
    for (const size of ['1024x1024', '1536x1024', '64x64', '8192x4096']) expect(illustrationSizeSchema.safeParse(size).success).toBe(true)
    for (const size of ['', '0x1024', '32x1024', '8193x1024', '8192x8192', '99999x99999', '1024x1024\n', 'auto', '1024X1024']) expect(illustrationSizeSchema.safeParse(size).success).toBe(false)
    for (const quality of ['', 'low', 'medium', 'high']) expect(assetIllustrationSchema.safeParse({ kind: 'item', modelId: 'm', name: 'A', description: '', quality }).success).toBe(true)
    expect(assetIllustrationSchema.safeParse({ kind: 'item', modelId: 'm', name: 'A', description: '', quality: 'auto' }).success).toBe(false)
  })

  it('enqueues character and all asset kinds with custom size/quality, omitting empty quality', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const targets = [
      { path: '/api/shared-characters/illustrations', body: { name: 'Lan', appearance: '' } },
      ...['item', 'location', 'logo'].map(kind => ({ path: '/api/entity-library/illustrations', body: { kind, name: 'Asset', description: '' } })),
    ]
    for (const { path, body } of targets) {
      const created = await call(ctx, path, { method: 'POST', body: { ...body, modelId: modelPk, size: '1536x1024', quality: 'high' } })
      expect(created.status).toBe(201)
      const row = ctx.db.prepare('SELECT params_json FROM generations WHERE id=?').get(created.body.generation.id) as { params_json: string }
      expect(JSON.parse(row.params_json)).toMatchObject({ size: '1536x1024', quality: 'high', n: 1 })
      const empty = await call(ctx, path, { method: 'POST', body: { ...body, modelId: modelPk, quality: '' } })
      expect(empty.status).toBe(201)
      const emptyRow = ctx.db.prepare('SELECT params_json FROM generations WHERE id=?').get(empty.body.generation.id) as { params_json: string }
      expect(JSON.parse(emptyRow.params_json)).not.toHaveProperty('quality')
      for (const invalid of [{ size: '99999x99999' }, { size: '1024x1024\n' }, { quality: 'auto' }]) {
        expect((await call(ctx, path, { method: 'POST', body: { ...body, modelId: modelPk, ...invalid } })).status).toBe(400)
      }
    }
  })
})
