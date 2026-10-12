import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  registerUser,
  seedProviderAndModel,
  startTestServer,
  waitForGeneration,
  type TestContext,
} from './helpers'
import { MOCK_PNG_BYTES } from '../../server/generations/adapters/mock'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { if (ctx) await ctx.close() })

/** Nhân vật thư viện dùng chung kèm ảnh tham chiếu để kiểm tra dàn nhân vật. */
async function createCharacter(name: string, withReference = false): Promise<string> {
  const created = await call(ctx, '/api/shared-characters', {
    method: 'POST',
    body: { name, appearance: `Ngoại hình ${name}` },
  })
  expect(created.status).toBe(201)
  const id = created.body.character.id as string
  if (withReference) {
    const uploaded = await fetch(`${ctx.baseUrl}/api/shared-characters/${id}/reference`, {
      method: 'POST',
      headers: { Cookie: ctx.cookie, 'Content-Type': 'image/png' },
      body: MOCK_PNG_BYTES,
    })
    expect(uploaded.status).toBe(201)
  }
  return id
}

async function createSession(input: { title?: string; characterIds?: string[] } = {}) {
  const result = await call(ctx, '/api/quick-sessions', { method: 'POST', body: input })
  expect(result.status).toBe(201)
  return result.body.session as {
    id: string
    title: string
    characterIds: string[]
    generationCount: number
    activeCount: number
    coverAssetId: string | null
  }
}

function generationRow(id: string) {
  return ctx.db
    .prepare(
      'SELECT quick_session_id, character_references_json, source_images_json, prompt_snapshot_json FROM generations WHERE id = ?',
    )
    .get(id) as
    | {
        quick_session_id: string | null
        character_references_json: string | null
        source_images_json: string | null
        prompt_snapshot_json: string | null
      }
    | undefined
}

describe('Phiên tạo nội dung (quick sessions)', () => {
  it('tạo phiên, giữ đúng thứ tự nhân vật và đếm nội dung', async () => {
    await registerUser(ctx)
    const first = await createCharacter('An')
    const second = await createCharacter('Bình')

    const session = await createSession({ title: 'Buổi sáng Đà Lạt', characterIds: [second, first] })
    expect(session.title).toBe('Buổi sáng Đà Lạt')
    expect(session.characterIds).toEqual([second, first])
    expect(session.generationCount).toBe(0)
    expect(session.coverAssetId).toBeNull()

    const listed = await call(ctx, '/api/quick-sessions')
    expect(listed.status).toBe(200)
    expect(listed.body.sessions.map((item: { id: string }) => item.id)).toContain(session.id)

    const fetched = await call(ctx, `/api/quick-sessions/${session.id}`)
    expect(fetched.status).toBe(200)
    expect(fetched.body.session.characterIds).toEqual([second, first])
  })

  it('cô lập giữa các tài khoản', async () => {
    await registerUser(ctx)
    const session = await createSession({ title: 'Của A' })

    await registerUser(ctx)
    const read = await call(ctx, `/api/quick-sessions/${session.id}`)
    expect(read.status).toBe(404)
    const patched = await call(ctx, `/api/quick-sessions/${session.id}`, {
      method: 'PATCH',
      body: { title: 'Đổi trộm' },
    })
    expect(patched.status).toBe(404)
    const removed = await call(ctx, `/api/quick-sessions/${session.id}`, { method: 'DELETE' })
    expect(removed.status).toBe(404)
  })

  it('tác vụ trong phiên được gắn quickSessionId và lọc được theo phiên', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const first = await createSession({ title: 'Phiên 1' })
    const second = await createSession({ title: 'Phiên 2' })

    const created = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, prompt: 'Một ngôi nhà', quickSessionId: first.id },
    })
    expect(created.status).toBe(202)
    expect(created.body.generation.quickSessionId).toBe(first.id)
    expect(created.body.generation.modelId).toBe(modelPk)
    await waitForGeneration(ctx, created.body.generation.id)

    const filtered = await call(ctx, `/api/generations?quickSessionId=${first.id}`)
    expect(filtered.status).toBe(200)
    expect(filtered.body.generations).toHaveLength(1)
    expect(filtered.body.generations[0].id).toBe(created.body.generation.id)

    const other = await call(ctx, `/api/generations?quickSessionId=${second.id}`)
    expect(other.body.generations).toHaveLength(0)

    const refreshed = await call(ctx, `/api/quick-sessions/${first.id}`)
    expect(refreshed.body.session.generationCount).toBe(1)
    expect(refreshed.body.session.coverAssetId).toBeTruthy()
  })

  it('tác vụ kế thừa dàn nhân vật của phiên khi không gửi nhân vật', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const an = await createCharacter('An', true)
    const binh = await createCharacter('Bình', true)
    const session = await createSession({ characterIds: [an, binh] })

    const created = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, prompt: 'Hai người đi dạo', quickSessionId: session.id },
    })
    expect(created.status).toBe(202)
    const generation = await waitForGeneration(ctx, created.body.generation.id)
    expect(generation.status).toBe('succeeded')

    const row = generationRow(created.body.generation.id)!
    expect(row.quick_session_id).toBe(session.id)
    const references = JSON.parse(row.character_references_json!) as Array<{ path: string; mime: string }>
    expect(references).toHaveLength(2)
    const snapshot = JSON.parse(row.prompt_snapshot_json!) as {
      character: { name: string }
      cast?: Array<{ name: string }>
    }
    expect(snapshot.character.name).toBe('An')
    expect(snapshot.cast?.map((member) => member.name)).toEqual(['Bình'])
  })

  it('nhân vật gửi tường minh đứng trước, không trùng với phiên', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const an = await createCharacter('An', true)
    const binh = await createCharacter('Bình', true)
    const session = await createSession({ characterIds: [an, binh] })

    const created = await call(ctx, '/api/generations', {
      method: 'POST',
      body: {
        modelId: modelPk,
        prompt: 'Bình ở tiền cảnh',
        quickSessionId: session.id,
        characterId: binh,
        characterIds: [binh, an],
      },
    })
    expect(created.status).toBe(202)
    await waitForGeneration(ctx, created.body.generation.id)

    const row = generationRow(created.body.generation.id)!
    const references = JSON.parse(row.character_references_json!) as Array<{ path: string }>
    expect(references).toHaveLength(2)
    const snapshot = JSON.parse(row.prompt_snapshot_json!) as { character: { name: string } }
    expect(snapshot.character.name).toBe('Bình')
  })

  it('dùng ảnh đã tạo trong phiên làm ảnh nguồn (image-to-image)', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const session = await createSession({ title: 'Sửa ảnh' })

    const base = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, prompt: 'Ngôi nhà gỗ', quickSessionId: session.id },
    })
    const baseGeneration = await waitForGeneration(ctx, base.body.generation.id)
    expect(baseGeneration.status).toBe('succeeded')
    const assetId = baseGeneration.assets[0].id as string

    const edited = await call(ctx, '/api/generations', {
      method: 'POST',
      body: {
        modelId: modelPk,
        prompt: 'Ngôi nhà gỗ, trời mưa',
        quickSessionId: session.id,
        sourceAssetIds: [assetId],
      },
    })
    expect(edited.status).toBe(202)
    await waitForGeneration(ctx, edited.body.generation.id)

    const row = generationRow(edited.body.generation.id)!
    const sources = JSON.parse(row.source_images_json!) as Array<{ path: string; mime: string }>
    expect(sources).toHaveLength(1)
    const [firstSource] = sources
    const original = ctx.db
      .prepare('SELECT relative_path AS path FROM assets WHERE id = ?')
      .get(assetId) as { path: string }
    expect(firstSource?.path).toBe(original.path)

    const refreshed = await call(ctx, `/api/quick-sessions/${session.id}`)
    expect(refreshed.body.session.generationCount).toBe(2)
  })

  it('từ chối ảnh nguồn của tài khoản khác', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const session = await createSession({})
    const base = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, prompt: 'Ảnh của A', quickSessionId: session.id },
    })
    const baseGeneration = await waitForGeneration(ctx, base.body.generation.id)
    const assetId = baseGeneration.assets[0].id as string

    await registerUser(ctx)
    const { modelPk: otherModel } = await seedProviderAndModel(ctx, 'image')
    const stolen = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: otherModel, prompt: 'Ảnh của B', sourceAssetIds: [assetId] },
    })
    expect(stolen.status).toBe(400)
  })

  it('cập nhật tên và dàn nhân vật, chặn dữ liệu sai', async () => {
    await registerUser(ctx)
    const an = await createCharacter('An')
    const binh = await createCharacter('Bình')
    const session = await createSession({ characterIds: [an] })

    const renamed = await call(ctx, `/api/quick-sessions/${session.id}`, {
      method: 'PATCH',
      body: { title: 'Tên mới', characterIds: [binh, an] },
    })
    expect(renamed.status).toBe(200)
    expect(renamed.body.session.title).toBe('Tên mới')
    expect(renamed.body.session.characterIds).toEqual([binh, an])

    const empty = await call(ctx, `/api/quick-sessions/${session.id}`, { method: 'PATCH', body: {} })
    expect(empty.status).toBe(400)

    const unknown = await call(ctx, `/api/quick-sessions/${session.id}`, {
      method: 'PATCH',
      body: { characterIds: ['khong-ton-tai'] },
    })
    expect(unknown.status).toBe(404)

    const tooMany = await call(ctx, `/api/quick-sessions/${session.id}`, {
      method: 'PATCH',
      body: { characterIds: Array.from({ length: 7 }, (_, index) => `c${index}`) },
    })
    expect(tooMany.status).toBe(400)

    const duplicate = await call(ctx, `/api/quick-sessions/${session.id}`, {
      method: 'PATCH',
      body: { characterIds: [an, an] },
    })
    expect(duplicate.status).toBe(400)
  })

  it('xoá phiên vẫn giữ kết quả trong thư viện', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const session = await createSession({ title: 'Sắp xoá' })
    const created = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, prompt: 'Giữ lại nhé', quickSessionId: session.id },
    })
    const generation = await waitForGeneration(ctx, created.body.generation.id)
    expect(generation.status).toBe('succeeded')

    const removed = await call(ctx, `/api/quick-sessions/${session.id}`, { method: 'DELETE' })
    expect(removed.status).toBe(204)

    const row = generationRow(created.body.generation.id)!
    expect(row.quick_session_id).toBeNull()

    const library = await call(ctx, '/api/generations')
    expect(library.body.generations.map((item: { id: string }) => item.id)).toContain(
      created.body.generation.id,
    )
  })

  it('xoá nhân vật thì phiên tự bỏ nhân vật đó', async () => {
    await registerUser(ctx)
    const an = await createCharacter('An')
    const binh = await createCharacter('Bình')
    const session = await createSession({ characterIds: [an, binh] })

    const removed = await call(ctx, `/api/shared-characters/${binh}`, { method: 'DELETE' })
    expect(removed.status).toBe(204)

    const fetched = await call(ctx, `/api/quick-sessions/${session.id}`)
    expect(fetched.status).toBe(200)
    expect(fetched.body.session.characterIds).toEqual([an])
  })

  it('cột quick_session_id tồn tại và tác vụ cũ vẫn NULL', async () => {
    const columns = ctx.db.prepare('PRAGMA table_info(generations)').all() as unknown as Array<{
      name: string
    }>
    expect(columns.some((column) => column.name === 'quick_session_id')).toBe(true)

    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const detached = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, prompt: 'Không thuộc phiên nào' },
    })
    await waitForGeneration(ctx, detached.body.generation.id)
    expect(generationRow(detached.body.generation.id)!.quick_session_id).toBeNull()
  })
})
