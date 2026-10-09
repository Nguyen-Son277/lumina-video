import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildCharacterSheetPrompt } from '../../server/characters/portrait'
import {
  call,
  registerUser,
  seedProviderAndModel,
  startTestServer,
  waitForGeneration,
  type TestContext,
} from './helpers'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { if (ctx) await ctx.close() })

describe('Prompt ảnh tham chiếu dạng sheet', () => {
  it('gồm cận mặt và bốn góc nhìn, giữ nguyên nhân vật ở mọi ô', () => {
    const prompt = buildCharacterSheetPrompt({ name: 'Lan', appearance: 'Áo đỏ, tóc dài' })

    expect(prompt).toContain('Lan')
    expect(prompt).toContain('Áo đỏ, tóc dài')
    expect(prompt).toContain('character sheet')
    // Bốn góc nhìn + cận mặt.
    expect(prompt).toContain('cận mặt')
    expect(prompt).toContain('trước')
    expect(prompt).toContain('sau')
    expect(prompt).toContain('trái')
    expect(prompt).toContain('phải')
    // Không cho chữ/watermark và không thêm người khác.
    expect(prompt).toContain('watermark')
    expect(prompt).toContain('không thêm người khác')
  })

  it('vẫn dùng được khi chưa có mô tả ngoại hình', () => {
    const prompt = buildCharacterSheetPrompt({ name: 'Bình', appearance: '' })
    expect(prompt).toContain('Bình')
    expect(prompt).not.toContain('Ngoại hình:')
  })
})

describe('Sinh ảnh sheet cho nhân vật mẫu', () => {
  it('từ chối dữ liệu thiếu, sai phân loại và model của tài khoản khác', async () => {
    await registerUser(ctx)
    const { modelPk: imageModel } = await seedProviderAndModel(ctx, 'image')
    const { modelPk: videoModel } = await seedProviderAndModel(ctx, 'video')

    // Thiếu model.
    expect(
      (await call(ctx, '/api/shared-characters/illustrations', {
        method: 'POST',
        body: { name: 'Lan' },
      })).status,
    ).toBe(400)

    // Model video không dùng được cho ảnh.
    expect(
      (await call(ctx, '/api/shared-characters/illustrations', {
        method: 'POST',
        body: { modelId: videoModel, name: 'Lan' },
      })).status,
    ).toBe(400)

    // Model ảnh đang bị tắt.
    await call(ctx, `/api/models/${imageModel}`, { method: 'PATCH', body: { enabled: false } })
    expect(
      (await call(ctx, '/api/shared-characters/illustrations', {
        method: 'POST',
        body: { modelId: imageModel, name: 'Lan' },
      })).status,
    ).toBe(400)
    await call(ctx, `/api/models/${imageModel}`, { method: 'PATCH', body: { enabled: true } })

    // Model của tài khoản khác không dùng được.
    await registerUser(ctx)
    expect(
      (await call(ctx, '/api/shared-characters/illustrations', {
        method: 'POST',
        body: { modelId: imageModel, name: 'Lan' },
      })).status,
    ).toBe(400)
  })

  it('xếp hàng tác vụ ảnh với prompt sheet do server dựng', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')

    const created = await call(ctx, '/api/shared-characters/illustrations', {
      method: 'POST',
      body: { modelId: modelPk, name: 'Lan', appearance: 'Áo đỏ, tóc dài' },
    })
    expect(created.status).toBe(201)
    expect(created.body.generation.id).toBeTruthy()

    // Prompt lưu trong tác vụ là prompt sheet, không phải prompt client gửi lên.
    const row = ctx.db
      .prepare('SELECT prompt FROM generations WHERE id = ?')
      .get(created.body.generation.id) as { prompt: string }
    expect(row.prompt).toContain('character sheet')
    expect(row.prompt).toContain('cận mặt')
    expect(row.prompt).toContain('Áo đỏ, tóc dài')

    // Chạy nền bằng mock rồi lấy được ảnh.
    const done = await waitForGeneration(ctx, created.body.generation.id)
    expect(done.status).toBe('succeeded')
    expect(done.assets.length).toBeGreaterThan(0)
  })
})
