import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { if (ctx) await ctx.close() })

const imageSettings = (modelId: string) => ({ modelId, size: '1536x1024', quality: 'high', count: 2 })
const videoSettings = (modelId: string) => ({ modelId, params: { seconds: '8' } })

describe('account-scoped quick generation preferences API', () => {
  it('requires authentication for reads and writes', async () => {
    const response = await call(ctx, '/api/quick-generation-preferences', { cookie: '' })
    expect(response.status).toBe(401)
    const save = await call(ctx, '/api/quick-generation-preferences/image', {
      method: 'PUT', cookie: '', body: { version: 1, settings: imageSettings('model') },
    })
    expect(save.status).toBe(401)
  })

  it('returns null defaults, saves image and video independently, and persists sanitized values', async () => {
    await registerUser(ctx)
    const cookie = ctx.cookie
    const imageModel = await seedProviderAndModel(ctx, 'image')
    const videoModel = await seedProviderAndModel(ctx, 'video')

    expect((await call(ctx, '/api/quick-generation-preferences')).body.preferences).toEqual({ image: null, video: null })
    const image = await call(ctx, '/api/quick-generation-preferences/image', {
      method: 'PUT', body: { version: 1, settings: imageSettings(imageModel.modelPk) },
    })
    expect(image.status).toBe(200)
    expect(image.body.settings).toEqual(imageSettings(imageModel.modelPk))
    expect((await call(ctx, '/api/quick-generation-preferences')).body.preferences).toEqual({
      image: imageSettings(imageModel.modelPk), video: null,
    })

    const video = await call(ctx, '/api/quick-generation-preferences/video', {
      method: 'PUT', body: { version: 1, settings: videoSettings(videoModel.modelPk) },
    })
    expect(video.status).toBe(200)
    const readBack = await call(ctx, '/api/quick-generation-preferences', { cookie })
    expect(readBack.body.preferences).toEqual({
      image: imageSettings(imageModel.modelPk),
      video: { modelId: videoModel.modelPk, params: { size: '1280x720', seconds: '8' } },
    })
    expect(ctx.db.prepare('SELECT COUNT(*) AS count FROM generations').get()).toMatchObject({ count: 0 })
  })

  it('isolates preferences by account and rejects a foreign account model', async () => {
    await registerUser(ctx)
    const firstCookie = ctx.cookie
    const first = await seedProviderAndModel(ctx, 'image')
    const saved = await call(ctx, '/api/quick-generation-preferences/image', {
      method: 'PUT', body: { version: 1, settings: imageSettings(first.modelPk) },
    })
    expect(saved.status).toBe(200)

    await registerUser(ctx)
    const secondCookie = ctx.cookie
    expect((await call(ctx, '/api/quick-generation-preferences')).body.preferences).toEqual({ image: null, video: null })
    const foreign = await call(ctx, '/api/quick-generation-preferences/image', {
      method: 'PUT', body: { version: 1, settings: imageSettings(first.modelPk) },
    })
    expect(foreign.status).toBe(400)
    expect((await call(ctx, '/api/quick-generation-preferences', { cookie: firstCookie })).body.preferences.image)
      .toEqual(imageSettings(first.modelPk))
    expect((await call(ctx, '/api/quick-generation-preferences', { cookie: secondCookie })).body.preferences)
      .toEqual({ image: null, video: null })
  })

  it('round-trips actual provider model ids across OpenAI, Agnes, and Higgsfield protocols', async () => {
    await registerUser(ctx)
    const openai = await seedProviderAndModel(ctx, 'video')
    const agnes = await seedProviderAndModel(ctx, 'video')
    const higgsfield = await seedProviderAndModel(ctx, 'video')
    // Keep database primary keys distinct from the provider-facing model ids.
    ctx.db.prepare('UPDATE models SET model_id = ?, video_api_style = ? WHERE id = ?')
      .run('agnes-video-2.5-flash', 'agnes', agnes.modelPk)
    ctx.db.prepare('UPDATE models SET model_id = ?, video_api_style = ? WHERE id = ?')
      .run('bytedance/seedance-2.5', 'higgsfield', higgsfield.modelPk)
    ctx.db.prepare('UPDATE models SET model_id = ? WHERE id = ?').run('sora-2', openai.modelPk)

    const cases = [
      { id: openai.modelPk, expected: { modelId: openai.modelPk, params: { size: '1280x720', seconds: '8' } } },
      { id: agnes.modelPk, expected: { modelId: agnes.modelPk, params: { mode: 'text', size: '720P', seconds: '8', n: 1 } } },
      { id: higgsfield.modelPk, expected: { modelId: higgsfield.modelPk, params: { mode: 'image', duration: 5, resolution: '720p', bitrateMode: 'high', generateAudio: true } } },
    ]
    const params = [{ seconds: '8' }, { seconds: '8' }, { mode: 'image' }]
    for (let index = 0; index < cases.length; index++) {
      const saved = await call(ctx, '/api/quick-generation-preferences/video', {
        method: 'PUT', body: { version: 1, settings: { modelId: cases[index]!.id, params: params[index] } },
      })
      expect(saved.status).toBe(200)
      expect(saved.body.settings).toEqual(cases[index]!.expected)
      expect((await call(ctx, '/api/quick-generation-preferences')).body.preferences.video).toEqual(cases[index]!.expected)
    }
  })

  it('keeps the saved model id readable after its owned model is disabled or deleted', async () => {
    await registerUser(ctx)
    const disabled = await seedProviderAndModel(ctx, 'image')
    const deleted = await seedProviderAndModel(ctx, 'image')
    for (const model of [disabled, deleted]) {
      expect((await call(ctx, '/api/quick-generation-preferences/image', {
        method: 'PUT', body: { version: 1, settings: imageSettings(model.modelPk) },
      })).status).toBe(200)
    }
    await call(ctx, `/api/models/${disabled.modelPk}`, { method: 'PATCH', body: { enabled: false } })
    expect((await call(ctx, '/api/quick-generation-preferences')).body.preferences.image).toEqual(imageSettings(deleted.modelPk))
    const removal = await call(ctx, `/api/models/${deleted.modelPk}`, { method: 'DELETE' })
    expect(removal.status).toBe(204)
    expect((await call(ctx, '/api/quick-generation-preferences')).body.preferences.image).toEqual(imageSettings(deleted.modelPk))
  })

  it('rejects invalid Flash values, transient media keys, large extra keys, and extra top-level body keys', async () => {
    await registerUser(ctx)
    const flash = await seedProviderAndModel(ctx, 'video')
    ctx.db.prepare("UPDATE models SET model_id = 'agnes-video-2.5-flash', video_api_style = 'agnes' WHERE id = ?").run(flash.modelPk)
    for (const params of [{ seconds: '13' }, { seconds: '3' }, { size: '1080P' }]) {
      expect((await call(ctx, '/api/quick-generation-preferences/video', {
        method: 'PUT', body: { version: 1, settings: { modelId: flash.modelPk, params } },
      })).status).toBe(400)
    }

    const image = await seedProviderAndModel(ctx, 'image')
    for (const settings of [
      { ...imageSettings(image.modelPk), firstFrame: 'https://example.com/frame.png' },
      { ...imageSettings(image.modelPk), referenceImages: [] },
      { ...imageSettings(image.modelPk), imageUploadId: 'upload-id' },
    ]) {
      expect((await call(ctx, '/api/quick-generation-preferences/image', {
        method: 'PUT', body: { version: 1, settings },
      })).status).toBe(400)
    }
    expect((await call(ctx, '/api/quick-generation-preferences/image', {
      method: 'PUT', body: { version: 1, settings: imageSettings(image.modelPk), unexpected: true },
    })).status).toBe(400)
    expect((await call(ctx, '/api/quick-generation-preferences/image', {
      method: 'PUT', body: { version: 1, settings: { ...imageSettings(image.modelPk), extra: 'x'.repeat(16 * 1024) } },
    })).status).toBe(400)
  })

  it('rejects invalid schemas, transient media, disabled models, and models of the wrong kind', async () => {
    await registerUser(ctx)
    const image = await seedProviderAndModel(ctx, 'image')
    const video = await seedProviderAndModel(ctx, 'video')
    const invalid = [
      { modelId: image.modelPk, prompt: 'transient' },
      { modelId: image.modelPk, uploadId: 'upload' },
      { modelId: image.modelPk, assetId: 'asset' },
      { modelId: image.modelPk, references: ['ref'] },
      { modelId: image.modelPk, count: 5 },
      { modelId: image.modelPk, size: 'auto' },
    ]
    for (const settings of invalid) {
      expect((await call(ctx, '/api/quick-generation-preferences/image', {
        method: 'PUT', body: { version: 1, settings },
      })).status).toBe(400)
    }
    expect((await call(ctx, '/api/quick-generation-preferences/other', {
      method: 'PUT', body: { version: 1, settings: imageSettings(image.modelPk) },
    })).status).toBe(400)
    expect((await call(ctx, '/api/quick-generation-preferences/image', {
      method: 'PUT', body: { version: 2, settings: imageSettings(image.modelPk) },
    })).status).toBe(400)
    expect((await call(ctx, '/api/quick-generation-preferences/video', {
      method: 'PUT', body: { version: 1, settings: { ...videoSettings(video.modelPk), prompt: 'transient' } },
    })).status).toBe(400)

    ctx.db.prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(image.modelPk)
    expect((await call(ctx, '/api/quick-generation-preferences/image', {
      method: 'PUT', body: { version: 1, settings: imageSettings(image.modelPk) },
    })).status).toBe(400)
    expect((await call(ctx, '/api/quick-generation-preferences/image', {
      method: 'PUT', body: { version: 1, settings: imageSettings(video.modelPk) },
    })).status).toBe(400)
    expect(ctx.db.prepare('SELECT COUNT(*) AS count FROM generations').get()).toMatchObject({ count: 0 })
  })

  it('applies the preferences schema migration with per-user and per-mode uniqueness', () => {
    const columns = ctx.db.prepare('PRAGMA table_info(quick_generation_preferences)').all() as Array<{ name: string; pk: number; notnull: number }>
    expect(columns.map((column) => column.name)).toEqual(['user_id', 'mode', 'version', 'settings_json', 'updated_at'])
    expect(columns.find((column) => column.name === 'user_id')).toMatchObject({ pk: 1, notnull: 1 })
    expect(columns.find((column) => column.name === 'mode')).toMatchObject({ pk: 2, notnull: 1 })
    expect(columns.find((column) => column.name === 'version')?.notnull).toBe(1)
    expect(ctx.db.prepare('PRAGMA foreign_key_list(quick_generation_preferences)').all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ table: 'users', from: 'user_id', to: 'id', on_delete: 'CASCADE' })]),
    )
  })
})
