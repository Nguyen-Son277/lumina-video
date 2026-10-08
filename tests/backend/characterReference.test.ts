import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, seedProviderAndModel, startTestServer, waitForGeneration, type TestContext } from './helpers'
import { MOCK_PNG_BYTES } from '../../server/generations/adapters/mock'
import {
  buildExtraBodyImageRequest,
  buildImageEditForm,
  readCharacterReference,
} from '../../server/generations/adapters/image'
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

describe('Đồng bộ nhân vật khi tạo ảnh trong dự án', () => {
  async function imageSetup() {
    const { userId } = await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const project = (await call(ctx, '/api/projects', {
      method: 'POST',
      body: { name: 'Album', style: 'Điện ảnh' },
    })).body.project
    const character = (await call(ctx, `/api/projects/${project.id}/characters`, {
      method: 'POST',
      body: { name: 'Lan', appearance: 'Áo đỏ, tóc dài' },
    })).body.character
    return { userId, modelPk, project, character }
  }

  it('lưu snapshot ảnh tham chiếu và giữ nguyên sau khi nhân vật đổi ảnh', async () => {
    const { modelPk, project, character } = await imageSetup()
    await uploadReference(character.id, project.id, MOCK_PNG_BYTES)

    const created = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, projectId: project.id, characterId: character.id, prompt: 'Lan ở Đà Lạt' },
    })
    expect(created.status).toBe(202)

    const row = ctx.db
      .prepare('SELECT character_reference_json AS json FROM generations WHERE id = ?')
      .get(created.body.generation.id) as { json: string | null }
    const snapshot = readCharacterReference(row.json)
    expect(snapshot?.mime).toBe('image/png')
    expect(snapshot?.path).toContain('characters')

    // Prompt ảnh nêu chỉ dẫn giữ ngoại hình nhưng không kèm nội dung giọng nói.
    expect(created.body.generation.effectivePrompt).toContain('Áo đỏ, tóc dài')
    expect(created.body.generation.effectivePrompt).toContain('canonical appearance')
    expect(created.body.generation.effectivePrompt).not.toMatch(/Voice |Dialogue/)

    // Thay ảnh mới của nhân vật không làm đổi snapshot của tác vụ đã tạo.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
    expect((await uploadReference(character.id, project.id, jpeg, 'image/jpeg')).status).toBe(201)
    const after = ctx.db
      .prepare('SELECT character_reference_json AS json FROM generations WHERE id = ?')
      .get(created.body.generation.id) as { json: string | null }
    expect(readCharacterReference(after.json)).toEqual(snapshot)

    expect((await waitForGeneration(ctx, created.body.generation.id)).status).toBe('succeeded')
  })

  it('tắt gửi ảnh tham chiếu thì tác vụ không lưu snapshot', async () => {
    const { modelPk, project, character } = await imageSetup()
    await uploadReference(character.id, project.id, MOCK_PNG_BYTES)

    const created = await call(ctx, '/api/generations', {
      method: 'POST',
      body: {
        modelId: modelPk,
        projectId: project.id,
        characterId: character.id,
        prompt: 'Không gửi ảnh',
        params: { useCharacterReference: false },
      },
    })
    expect(created.status).toBe(202)

    const row = ctx.db
      .prepare('SELECT character_reference_json AS json FROM generations WHERE id = ?')
      .get(created.body.generation.id) as { json: string | null }
    expect(readCharacterReference(row.json)).toBeNull()
    expect(created.body.generation.effectivePrompt).not.toContain('canonical appearance')
    // Tùy chọn phải sống sót qua schema để adapter đọc được.
    expect(created.body.generation.params.useCharacterReference).toBe(false)
  })

  it('ảnh tham chiếu tính vào giới hạn ảnh đầu vào mỗi lần tạo', async () => {
    const { modelPk, project, character } = await imageSetup()
    await uploadReference(character.id, project.id, MOCK_PNG_BYTES)

    const ids: string[] = []
    for (let index = 0; index < ctx.env.MAX_SOURCE_IMAGES; index += 1) {
      const response = await fetch(`${ctx.baseUrl}/api/uploads`, {
        method: 'POST',
        headers: { Cookie: ctx.cookie, 'Content-Type': 'image/png' },
        body: MOCK_PNG_BYTES,
      })
      ids.push(((await response.json()) as { upload: { id: string } }).upload.id)
    }

    const tooMany = await call(ctx, '/api/generations', {
      method: 'POST',
      body: {
        modelId: modelPk,
        projectId: project.id,
        characterId: character.id,
        prompt: 'Quá nhiều ảnh',
        sourceUploadIds: ids,
      },
    })
    expect(tooMany.status).toBe(400)
    expect(tooMany.body.error.message).toContain('ảnh tham chiếu nhân vật')

    // Bớt một ảnh nguồn thì vừa giới hạn và tạo được.
    const ok = await call(ctx, '/api/generations', {
      method: 'POST',
      body: {
        modelId: modelPk,
        projectId: project.id,
        characterId: character.id,
        prompt: 'Vừa giới hạn',
        sourceUploadIds: ids.slice(0, -1),
      },
    })
    expect(ok.status).toBe(202)
  })

  it('nhân vật không có ảnh thì tác vụ vẫn tạo được bằng mô tả ngoại hình', async () => {
    const { modelPk, project, character } = await imageSetup()

    const created = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, projectId: project.id, characterId: character.id, prompt: 'Chỉ mô tả' },
    })
    expect(created.status).toBe(202)
    const row = ctx.db
      .prepare('SELECT character_reference_json AS json FROM generations WHERE id = ?')
      .get(created.body.generation.id) as { json: string | null }
    expect(readCharacterReference(row.json)).toBeNull()
    expect(created.body.generation.effectivePrompt).toContain('Áo đỏ, tóc dài')
    expect(created.body.generation.effectivePrompt).not.toContain('canonical appearance')
  })

  it('từ chối nhân vật thuộc dự án khác, nhưng cho phép tạo đơn lẻ có nhân vật', async () => {
    const { modelPk, character } = await imageSetup()
    const other = (await call(ctx, '/api/projects', {
      method: 'POST',
      body: { name: 'Dự án khác' },
    })).body.project

    const wrongProject = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, projectId: other.id, characterId: character.id, prompt: 'Sai dự án' },
    })
    expect(wrongProject.status).toBe(404)

    // Không có dự án nghĩa là luồng "Tạo nội dung đơn lẻ": nhân vật vẫn dùng được
    // miễn thuộc đúng tài khoản.
    const standalone = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, characterId: character.id, prompt: 'Đơn lẻ' },
    })
    expect(standalone.status).toBe(202)
    expect(standalone.body.generation.projectId).toBeNull()
    expect(standalone.body.generation.effectivePrompt).toContain('Áo đỏ, tóc dài')
  })

  it('dựng đúng hợp đồng gửi ảnh tham chiếu cho cả hai kiểu API', async () => {
    const { project, character } = await imageSetup()
    await uploadReference(character.id, project.id, MOCK_PNG_BYTES)
    const path = (ctx.db
      .prepare('SELECT reference_path AS path FROM characters WHERE id = ?')
      .get(character.id)) as { path: string }
    const bytes = ctx.mediaStore.readFile(path.path)

    // Chuẩn OpenAI: ảnh nhân vật nằm trong multipart /images/edits.
    const form = buildImageEditForm({
      modelId: 'gpt-image-1',
      prompt: 'p',
      params: {},
      sources: [{ bytes, mimeType: 'image/png' }],
    })
    const images = form.getAll('image') as Blob[]
    expect(images).toHaveLength(1)
    expect(images[0]!.type).toBe('image/png')

    // extra_body: ảnh nhân vật nằm trong extra_body.image dạng Data URI.
    const body = buildExtraBodyImageRequest({
      modelId: 'agnes-image-2.0-flash',
      prompt: 'p',
      params: {},
      sources: [{ bytes, mimeType: 'image/png' }],
    }) as { extra_body: { image: string[] } }
    expect(body.extra_body.image).toHaveLength(1)
    expect(body.extra_body.image[0]).toMatch(/^data:image\/png;base64,/)
  })
})
