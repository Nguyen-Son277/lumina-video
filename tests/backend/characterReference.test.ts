import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, startTestServer, type TestContext } from './helpers'
import { MOCK_PNG_BYTES } from '../../server/generations/adapters/mock'
import { buildVideoRequestBody, loadCharacterReference } from '../../server/generations/adapters/video'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { if (ctx) await ctx.close() })

async function setup() {
  const { userId } = await registerUser(ctx)
  const project = (await call(ctx, '/api/projects', {
    method: 'POST',
    body: { name: 'Phim', language: 'vi' },
  })).body.project
  const character = (await call(ctx, `/api/projects/${project.id}/characters`, {
    method: 'POST',
    body: { name: 'An', appearance: 'Áo xanh', voice: { accent: 'Miền Nam' } },
  })).body.character
  return { userId, project, character }
}

function uploadReference(characterId: string, projectId: string, bytes: Uint8Array, type = 'image/png') {
  return fetch(`${ctx.baseUrl}/api/projects/${projectId}/characters/${characterId}/reference`, {
    method: 'POST',
    headers: { Cookie: ctx.cookie, 'Content-Type': type },
    body: bytes,
  })
}

describe('Ảnh tham chiếu của nhân vật', () => {
  it('tải lên PNG, lưu riêng tư và trả về referenceUrl', async () => {
    const { project, character } = await setup()
    expect(character.referenceUrl).toBeNull()

    const response = await uploadReference(character.id, project.id, MOCK_PNG_BYTES)
    expect(response.status).toBe(201)
    const body = (await response.json()) as { character: any }
    expect(body.character.referenceUrl).toBe(`/api/characters/${character.id}/reference`)
    expect(body.character.referenceMime).toBe('image/png')

    // Tệp nằm trong thư mục riêng của người dùng, không phải thư mục public.
    const row = ctx.db
      .prepare('SELECT reference_path AS path FROM characters WHERE id = ?')
      .get(character.id) as { path: string }
    expect(row.path).toContain('characters')
    expect(ctx.mediaStore.exists(row.path)).toBe(true)

    // Tải lại được qua endpoint có xác thực.
    const served = await fetch(`${ctx.baseUrl}${body.character.referenceUrl}`, {
      headers: { Cookie: ctx.cookie },
    })
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/png')
    expect(served.headers.get('x-content-type-options')).toBe('nosniff')
    const bytes = new Uint8Array(await served.arrayBuffer())
    expect(bytes[0]).toBe(0x89)
  })

  it('từ chối nội dung không phải ảnh, kể cả khi khai báo là ảnh', async () => {
    const { project, character } = await setup()
    const html = new TextEncoder().encode('<html><body>không phải ảnh</body></html>')

    const response = await uploadReference(character.id, project.id, html)
    expect(response.status).toBe(502)

    // Không có gì được ghi vào database.
    const row = ctx.db
      .prepare('SELECT reference_path AS path FROM characters WHERE id = ?')
      .get(character.id) as { path: string | null }
    expect(row.path).toBeNull()
  })

  it('từ chối ảnh vượt giới hạn dung lượng', async () => {
    const { project, character } = await setup()
    // Ảnh PNG hợp lệ về magic bytes nhưng vượt giới hạn của cấu hình test.
    const big = new Uint8Array(ctx.env.MAX_REFERENCE_BYTES + 1024)
    big.set(MOCK_PNG_BYTES, 0)

    const response = await uploadReference(character.id, project.id, big)
    expect(response.status).toBe(413)
  })

  it('thay ảnh mới sẽ thay thế ảnh cũ', async () => {
    const { project, character } = await setup()
    await uploadReference(character.id, project.id, MOCK_PNG_BYTES)
    const first = (ctx.db
      .prepare('SELECT reference_path AS path, reference_bytes AS size FROM characters WHERE id = ?')
      .get(character.id)) as { path: string; size: number }

    // JPEG hợp lệ tối thiểu.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
    const response = await uploadReference(character.id, project.id, jpeg, 'image/jpeg')
    expect(response.status).toBe(201)

    const second = (ctx.db
      .prepare('SELECT reference_path AS path, reference_mime AS mime FROM characters WHERE id = ?')
      .get(character.id)) as { path: string; mime: string }
    expect(second.mime).toBe('image/jpeg')
    expect(second.path).not.toBe(first.path)
    // Ảnh cũ đã bị xóa khỏi đĩa.
    expect(ctx.mediaStore.exists(first.path)).toBe(false)
  })

  it('xóa ảnh tham chiếu và xóa nhân vật đều dọn tệp', async () => {
    const { project, character } = await setup()
    await uploadReference(character.id, project.id, MOCK_PNG_BYTES)
    const path = (ctx.db
      .prepare('SELECT reference_path AS path FROM characters WHERE id = ?')
      .get(character.id)) as { path: string }

    const removed = await call(ctx, `/api/projects/${project.id}/characters/${character.id}/reference`, {
      method: 'DELETE',
    })
    expect(removed.status).toBe(200)
    expect(removed.body.character.referenceUrl).toBeNull()
    expect(ctx.mediaStore.exists(path.path)).toBe(false)

    // Nhân vật không còn ảnh thì endpoint trả 404.
    const served = await fetch(`${ctx.baseUrl}/api/characters/${character.id}/reference`, {
      headers: { Cookie: ctx.cookie },
    })
    expect(served.status).toBe(404)

    // Xóa nhân vật cũng dọn thư mục ảnh.
    await uploadReference(character.id, project.id, MOCK_PNG_BYTES)
    const again = (ctx.db
      .prepare('SELECT reference_path AS path FROM characters WHERE id = ?')
      .get(character.id)) as { path: string }
    expect((await call(ctx, `/api/projects/${project.id}/characters/${character.id}`, { method: 'DELETE' })).status).toBe(204)
    expect(ctx.mediaStore.exists(again.path)).toBe(false)
  })

  it('tài khoản khác không tải được ảnh tham chiếu', async () => {
    const { project, character } = await setup()
    await uploadReference(character.id, project.id, MOCK_PNG_BYTES)

    await registerUser(ctx)
    const stranger = await fetch(`${ctx.baseUrl}/api/characters/${character.id}/reference`, {
      headers: { Cookie: ctx.cookie },
    })
    expect(stranger.status).toBe(404)

    // Không tải lên được ảnh cho nhân vật của người khác.
    const upload = await uploadReference(character.id, project.id, MOCK_PNG_BYTES)
    expect(upload.status).toBe(404)
  })

  it('yêu cầu đăng nhập', async () => {
    const { project, character } = await setup()
    await uploadReference(character.id, project.id, MOCK_PNG_BYTES)
    const anonymous = await fetch(`${ctx.baseUrl}/api/characters/${character.id}/reference`)
    expect(anonymous.status).toBe(401)
  })
})

describe('Ghép ảnh tham chiếu vào yêu cầu tạo video', () => {
  it('thêm input_reference khi có ảnh và người dùng không tắt', () => {
    const dataUrl = 'data:image/png;base64,AAAA'
    const withReference = buildVideoRequestBody('m', 'p', {}, dataUrl)
    expect(withReference.input_reference).toEqual({ image_url: dataUrl })

    const disabled = buildVideoRequestBody('m', 'p', { useCharacterReference: false }, dataUrl)
    expect(disabled.input_reference).toBeUndefined()

    const noReference = buildVideoRequestBody('m', 'p', {})
    expect(noReference.input_reference).toBeUndefined()
  })

  it('đọc ảnh tham chiếu của nhân vật trong cảnh và dựng data URL', async () => {
    const { project, character } = await setup()
    await uploadReference(character.id, project.id, MOCK_PNG_BYTES)

    // Tạo cảnh gắn nhân vật rồi lấy context của worker.
    const scene = (await call(ctx, `/api/projects/${project.id}/scenes`, {
      method: 'POST',
      body: { title: 'Cảnh', characterId: character.id, prompt: 'Rừng thông' },
    })).body.scene

    const row = ctx.db
      .prepare('SELECT * FROM generations WHERE id = ?')
      .get('không-tồn-tại') as undefined
    expect(row).toBeUndefined()

    const reference = loadCharacterReference({
      generation: { scene_id: scene.id } as never,
      provider: { baseUrl: 'https://x.test', apiKey: 'k', allowPrivate: false },
      db: ctx.db,
      mediaStore: ctx.mediaStore,
      env: ctx.env,
    })

    expect(reference).toMatch(/^data:image\/png;base64,/)
    expect(Buffer.from(reference!.split(',')[1]!, 'base64').subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    )
  })

  it('trả null khi cảnh không có nhân vật hoặc nhân vật chưa có ảnh', async () => {
    const { project, character } = await setup()
    const withoutImage = (await call(ctx, `/api/projects/${project.id}/scenes`, {
      method: 'POST',
      body: { title: 'Không ảnh', characterId: character.id, prompt: 'x' },
    })).body.scene

    const base = {
      provider: { baseUrl: 'https://x.test', apiKey: 'k', allowPrivate: false },
      db: ctx.db,
      mediaStore: ctx.mediaStore,
      env: ctx.env,
    }

    expect(loadCharacterReference({ ...base, generation: { scene_id: withoutImage.id } as never })).toBeNull()

    const noCharacter = (await call(ctx, `/api/projects/${project.id}/scenes`, {
      method: 'POST',
      body: { title: 'Không nhân vật', prompt: 'x' },
    })).body.scene
    expect(loadCharacterReference({ ...base, generation: { scene_id: noCharacter.id } as never })).toBeNull()

    // Tác vụ không thuộc cảnh nào cũng không có ảnh tham chiếu.
    expect(loadCharacterReference({ ...base, generation: { scene_id: null } as never })).toBeNull()
  })

  it('prompt nêu rõ có ảnh tham chiếu và snapshot ghi nhận', async () => {
    const { project, character } = await setup()
    await uploadReference(character.id, project.id, MOCK_PNG_BYTES)

    const scene = (await call(ctx, `/api/projects/${project.id}/scenes`, {
      method: 'POST',
      body: { title: 'Cảnh', characterId: character.id, prompt: 'Rừng thông', dialogue: 'Chào' },
    })).body.scene

    const preview = await call(ctx, `/api/scenes/${scene.id}/preview-prompt`, {
      method: 'POST',
      body: { kind: 'video' },
    })
    expect(preview.status).toBe(200)
    expect(preview.body.effectivePrompt).toContain('input_reference')
    expect(preview.body.snapshot.character.hasReference).toBe(true)
  })
})
