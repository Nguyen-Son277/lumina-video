import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'
import { MOCK_PNG_BYTES } from '../../server/generations/adapters/mock'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { if (ctx) await ctx.close() })

function uploadReference(characterId: string, bytes: Uint8Array, type = 'image/png') {
  return fetch(`${ctx.baseUrl}/api/shared-characters/${characterId}/reference`, {
    method: 'POST',
    headers: { Cookie: ctx.cookie, 'Content-Type': type },
    body: bytes,
  })
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])

describe('Thư viện nhân vật dùng chung', () => {
  it('tạo, sửa, xóa nhân vật và tải ảnh tham chiếu', async () => {
    await registerUser(ctx)

    const created = await call(ctx, '/api/shared-characters', {
      method: 'POST',
      body: { name: 'An', appearance: 'Áo xanh, tóc ngắn', voice: { accent: 'Miền Nam' } },
    })
    expect(created.status).toBe(201)
    expect(created.body.character.projectId).toBeNull()
    expect(created.body.character.referenceUrl).toBeNull()

    const id = created.body.character.id as string

    // Ảnh tham chiếu lưu riêng tư trong kho media và phục vụ qua endpoint xác thực.
    const uploaded = await uploadReference(id, MOCK_PNG_BYTES)
    expect(uploaded.status).toBe(201)
    const uploadedBody = (await uploaded.json()) as {
      character: { referenceUrl: string; referenceMime: string }
    }
    expect(uploadedBody.character.referenceMime).toBe('image/png')
    expect(uploadedBody.character.referenceUrl).toBe(`/api/characters/${id}/reference`)

    const row = ctx.db
      .prepare('SELECT reference_path AS path, user_id AS userId FROM characters WHERE id = ?')
      .get(id) as { path: string; userId: string }
    expect(ctx.mediaStore.exists(row.path)).toBe(true)
    expect(row.userId).toBeTruthy()

    const served = await fetch(`${ctx.baseUrl}${uploadedBody.character.referenceUrl}`, {
      headers: { Cookie: ctx.cookie },
    })
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await served.arrayBuffer())[0]).toBe(0x89)

    // Thay ảnh mới thì ảnh cũ bị xóa khỏi đĩa.
    expect((await uploadReference(id, JPEG, 'image/jpeg')).status).toBe(201)
    expect(ctx.mediaStore.exists(row.path)).toBe(false)

    const patched = await call(ctx, `/api/shared-characters/${id}`, {
      method: 'PATCH',
      body: { name: 'An Bình', appearance: 'Áo đỏ' },
    })
    expect(patched.body.character.name).toBe('An Bình')
    expect(patched.body.character.voice.accent).toBe('Miền Nam')

    const list = await call(ctx, '/api/shared-characters')
    expect(list.body.characters).toHaveLength(1)

    expect((await call(ctx, `/api/shared-characters/${id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await fetch(`${ctx.baseUrl}${uploadedBody.character.referenceUrl}`, {
      headers: { Cookie: ctx.cookie },
    })).status).toBe(404)
  })

  it('từ chối nội dung không phải ảnh và ảnh vượt dung lượng', async () => {
    await registerUser(ctx)
    const id = (await call(ctx, '/api/shared-characters', {
      method: 'POST',
      body: { name: 'Bình' },
    })).body.character.id as string

    const html = new TextEncoder().encode('<html>không phải ảnh</html>')
    expect((await uploadReference(id, html)).status).toBe(502)

    const big = new Uint8Array(ctx.env.MAX_REFERENCE_BYTES + 2048)
    big.set(MOCK_PNG_BYTES, 0)
    expect((await uploadReference(id, big)).status).toBe(413)

    const stored = ctx.db
      .prepare('SELECT reference_path AS path FROM characters WHERE id = ?')
      .get(id) as { path: string | null }
    expect(stored.path).toBeNull()
  })

  it('yêu cầu đăng nhập và tách biệt tài khoản', async () => {
    await registerUser(ctx)
    const id = (await call(ctx, '/api/shared-characters', {
      method: 'POST',
      body: { name: 'Lan' },
    })).body.character.id as string
    await uploadReference(id, MOCK_PNG_BYTES)

    expect((await fetch(`${ctx.baseUrl}/api/shared-characters`)).status).toBe(401)

    await registerUser(ctx)
    expect((await call(ctx, `/api/shared-characters/${id}`)).status).toBe(404)
    expect((await uploadReference(id, MOCK_PNG_BYTES)).status).toBe(404)
    expect(
      (await call(ctx, `/api/shared-characters/${id}`, { method: 'PATCH', body: { name: 'X' } })).status,
    ).toBe(404)
    expect((await call(ctx, `/api/shared-characters/${id}`, { method: 'DELETE' })).status).toBe(404)
    expect((await call(ctx, '/api/shared-characters')).body.characters).toHaveLength(0)
  })

  it('nhân vật dùng chung gắn được vào cảnh và dùng được trong dự án', async () => {
    await registerUser(ctx)
    const shared = (await call(ctx, '/api/shared-characters', {
      method: 'POST',
      body: { name: 'An', appearance: 'Áo xanh' },
    })).body.character
    await uploadReference(shared.id, MOCK_PNG_BYTES)

    const project = (await call(ctx, '/api/projects', {
      method: 'POST',
      body: { name: 'Phim', language: 'vi' },
    })).body.project

    // Danh sách nhân vật của dự án bao gồm cả nhân vật thư viện.
    const inProject = await call(ctx, `/api/projects/${project.id}/characters`)
    expect(inProject.body.characters.map((item: any) => item.id)).toContain(shared.id)

    const scene = await call(ctx, `/api/projects/${project.id}/scenes`, {
      method: 'POST',
      body: { title: 'Cảnh 1', characterId: shared.id, prompt: 'Rừng thông', dialogue: 'Chào' },
    })
    expect(scene.status).toBe(201)

    const preview = await call(ctx, `/api/scenes/${scene.body.scene.id}/preview-prompt`, {
      method: 'POST',
      body: { kind: 'video' },
    })
    expect(preview.body.effectivePrompt).toContain('Áo xanh')
    expect(preview.body.snapshot.character.hasReference).toBe(true)

    // Xóa nhân vật đang được cảnh dùng bị chặn.
    const blocked = await call(ctx, `/api/shared-characters/${shared.id}`, { method: 'DELETE' })
    expect(blocked.status).toBe(400)

    await call(ctx, `/api/projects/${project.id}/scenes/${scene.body.scene.id}`, {
      method: 'PATCH',
      body: { characterId: null, dialogue: '' },
    })
    expect((await call(ctx, `/api/shared-characters/${shared.id}`, { method: 'DELETE' })).status).toBe(204)
  })

  it('nhân vật dùng chung thuộc dự án khác không gắn được vào cảnh', async () => {
    await registerUser(ctx)
    const project = (await call(ctx, '/api/projects', {
      method: 'POST',
      body: { name: 'Dự án A' },
    })).body.project
    const other = (await call(ctx, '/api/projects', {
      method: 'POST',
      body: { name: 'Dự án B' },
    })).body.project
    const own = (await call(ctx, `/api/projects/${other.id}/characters`, {
      method: 'POST',
      body: { name: 'Riêng B' },
    })).body.character

    const result = await call(ctx, `/api/projects/${project.id}/scenes`, {
      method: 'POST',
      body: { title: 'Sai', characterId: own.id },
    })
    expect(result.status).toBe(404)
  })

  it('tạo được nội dung đơn lẻ với nhân vật dùng chung và lưu snapshot ảnh', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const shared = (await call(ctx, '/api/shared-characters', {
      method: 'POST',
      body: { name: 'An', appearance: 'Áo xanh' },
    })).body.character
    await uploadReference(shared.id, MOCK_PNG_BYTES)

    // Không có projectId: đây là luồng "Tạo nội dung đơn lẻ".
    const created = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, characterId: shared.id, prompt: 'An đi dạo' },
    })
    expect(created.status).toBe(202)
    expect(created.body.generation.projectId).toBeNull()
    expect(created.body.generation.effectivePrompt).toContain('Áo xanh')

    const row = ctx.db
      .prepare('SELECT character_reference_json AS json FROM generations WHERE id = ?')
      .get(created.body.generation.id) as { json: string | null }
    expect(row.json).toBeTruthy()
    expect(JSON.parse(row.json!)).toMatchObject({ mime: 'image/png' })
  })
})
