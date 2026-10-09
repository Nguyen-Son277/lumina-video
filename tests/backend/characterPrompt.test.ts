import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  registerUser,
  seedProviderAndModel,
  startTestServer,
  waitForGeneration,
  type TestContext,
} from './helpers'
import { composeCharacterPrompt } from '../../server/characters/prompt'
import type { CharacterRow } from '../../server/projects/service'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { if (ctx) await ctx.close() })

function characterRow(overrides: Partial<CharacterRow> = {}): CharacterRow {
  return {
    id: 'c1',
    user_id: 'u1',
    project_id: null,
    name: 'An',
    appearance: 'Áo xanh, tóc ngắn',
    voice_json: JSON.stringify({ accent: 'Miền Nam', timbre: 'Ấm' }),
    reference_path: null,
    reference_mime: null,
    reference_bytes: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  }
}

/** Tạo một nhân vật thư viện và trả về bản ghi công khai. */
async function createCharacter(target: TestContext, name = 'An') {
  const created = await call(target, '/api/shared-characters', {
    method: 'POST',
    body: { name, appearance: 'Áo xanh, tóc ngắn', voice: { accent: 'Miền Nam' } },
  })
  expect(created.status).toBe(201)
  return created.body.character
}

/** Tạo một tác vụ ảnh đã hoàn tất để dùng làm nguồn ảnh tham chiếu. */
async function completedImageGeneration(target: TestContext) {
  const { modelPk } = await seedProviderAndModel(target, 'image')
  const created = await call(target, '/api/generations', {
    method: 'POST',
    body: { modelId: modelPk, prompt: 'Chân dung nhân vật An' },
  })
  expect(created.status).toBe(202)
  const done = await waitForGeneration(target, created.body.generation.id)
  expect(done.status).toBe('succeeded')
  expect(done.assets.length).toBeGreaterThan(0)
  return done
}

describe('Prompt nhân vật', () => {
  it('ghép tên, ngoại hình và hồ sơ giọng', () => {
    const prompt = composeCharacterPrompt(characterRow())
    expect(prompt).toContain('An')
    expect(prompt).toContain('Ngoại hình: Áo xanh, tóc ngắn')
    expect(prompt).toContain('Giọng nói:')
    expect(prompt).toContain('giọng vùng miền Miền Nam')
    expect(prompt).toContain('âm sắc Ấm')
    expect(prompt).toContain('Giữ nguyên ngoại hình và danh tính nhân vật')
    // Không nhắc tới thuộc tính giọng chưa được điền.
    expect(prompt).not.toContain('cao độ')
  })

  it('bỏ phần trống và vẫn có câu chốt nhất quán', () => {
    const prompt = composeCharacterPrompt(
      characterRow({ name: 'Bình', appearance: '', voice_json: '{}' }),
    )
    expect(prompt).toBe(
      'Bình. Giữ nguyên ngoại hình và danh tính nhân vật này trong mọi khung hình.',
    )
  })

  it('chịu được voice_json hỏng', () => {
    const prompt = composeCharacterPrompt(characterRow({ voice_json: 'không phải json' }))
    expect(prompt).toContain('An')
    expect(prompt).not.toContain('Giọng nói')
  })
})

describe('API xuất prompt nhân vật', () => {
  it('trả prompt của nhân vật thuộc tài khoản', async () => {
    await registerUser(ctx)
    const character = await createCharacter(ctx, 'An')

    const result = await call(ctx, `/api/shared-characters/${character.id}/prompt`)
    expect(result.status).toBe(200)
    expect(result.body.prompt).toContain('An')
    expect(result.body.prompt).toContain('Áo xanh, tóc ngắn')
    expect(result.body.character.id).toBe(character.id)
  })

  it('yêu cầu đăng nhập và tách biệt tài khoản', async () => {
    await registerUser(ctx)
    const character = await createCharacter(ctx, 'An')

    expect((await fetch(`${ctx.baseUrl}/api/shared-characters/${character.id}/prompt`)).status).toBe(401)

    await registerUser(ctx)
    expect((await call(ctx, `/api/shared-characters/${character.id}/prompt`)).status).toBe(404)
    expect((await call(ctx, '/api/shared-characters/khong-ton-tai/prompt')).status).toBe(404)
  })
})

describe('Gắn ảnh đã tạo làm ảnh tham chiếu nhân vật', () => {
  it('sao chép ảnh của tác vụ sang nhân vật và phục vụ được', async () => {
    await registerUser(ctx)
    const character = await createCharacter(ctx, 'An')
    expect(character.referenceUrl).toBeNull()

    const generation = await completedImageGeneration(ctx)

    const attached = await call(ctx, `/api/shared-characters/${character.id}/reference/from-generation`, {
      method: 'POST',
      body: { generationId: generation.id },
    })
    expect(attached.status).toBe(201)
    expect(attached.body.character.referenceUrl).toBe(`/api/characters/${character.id}/reference`)
    expect(attached.body.character.referenceMime).toBe('image/png')
    expect(attached.body.character.referenceBytes).toBeGreaterThan(0)

    // Ảnh phục vụ được qua endpoint có xác thực, đúng magic bytes PNG.
    const served = await fetch(`${ctx.baseUrl}${attached.body.character.referenceUrl}`, {
      headers: { Cookie: ctx.cookie },
    })
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await served.arrayBuffer())[0]).toBe(0x89)

    // Ảnh tham chiếu nằm trong thư mục riêng của người dùng.
    const row = ctx.db
      .prepare('SELECT reference_path AS path FROM characters WHERE id = ?')
      .get(character.id) as { path: string }
    expect(row.path).toContain('characters')
  })

  it('gắn ảnh mới sẽ thay ảnh tham chiếu cũ', async () => {
    await registerUser(ctx)
    const character = await createCharacter(ctx, 'An')
    const first = await completedImageGeneration(ctx)

    await call(ctx, `/api/shared-characters/${character.id}/reference/from-generation`, {
      method: 'POST',
      body: { generationId: first.id },
    })
    const before = ctx.db
      .prepare('SELECT reference_path AS path FROM characters WHERE id = ?')
      .get(character.id) as { path: string }

    const second = await completedImageGeneration(ctx)
    const replaced = await call(ctx, `/api/shared-characters/${character.id}/reference/from-generation`, {
      method: 'POST',
      body: { generationId: second.id },
    })
    expect(replaced.status).toBe(201)

    const after = ctx.db
      .prepare('SELECT reference_path AS path FROM characters WHERE id = ?')
      .get(character.id) as { path: string }
    expect(after.path).toBe(before.path)
    expect(ctx.mediaStore.exists(after.path)).toBe(true)
  })

  it('từ chối tác vụ chưa xong, tác vụ của tài khoản khác và nhân vật không thuộc mình', async () => {
    await registerUser(ctx)
    const character = await createCharacter(ctx, 'An')
    const generation = await completedImageGeneration(ctx)

    // Chưa hoàn tất: tạo tác vụ rồi đặt lại trạng thái đang chạy.
    const pending = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: (await call(ctx, '/api/models')).body.models[0].id, prompt: 'đang chạy' },
    })
    ctx.db
      .prepare("UPDATE generations SET status = 'running' WHERE id = ?")
      .run(pending.body.generation.id)
    const notDone = await call(ctx, `/api/shared-characters/${character.id}/reference/from-generation`, {
      method: 'POST',
      body: { generationId: pending.body.generation.id },
    })
    expect(notDone.status).toBe(400)
    expect(notDone.body.error.message).toContain('chưa hoàn tất')

    // Thiếu generationId.
    expect(
      (await call(ctx, `/api/shared-characters/${character.id}/reference/from-generation`, {
        method: 'POST',
        body: {},
      })).status,
    ).toBe(400)

    // Tác vụ không tồn tại.
    expect(
      (await call(ctx, `/api/shared-characters/${character.id}/reference/from-generation`, {
        method: 'POST',
        body: { generationId: 'khong-ton-tai' },
      })).status,
    ).toBe(404)

    // Tài khoản khác không gắn được vào nhân vật này, cũng không dùng được tác vụ của mình.
    await registerUser(ctx)
    expect(
      (await call(ctx, `/api/shared-characters/${character.id}/reference/from-generation`, {
        method: 'POST',
        body: { generationId: generation.id },
      })).status,
    ).toBe(404)
  })

  it('yêu cầu đăng nhập', async () => {
    await registerUser(ctx)
    const character = await createCharacter(ctx, 'An')
    const response = await fetch(
      `${ctx.baseUrl}/api/shared-characters/${character.id}/reference/from-generation`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ generationId: 'x' }),
      },
    )
    expect(response.status).toBe(401)
  })
})
