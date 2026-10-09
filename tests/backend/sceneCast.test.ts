import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'

let ctx: TestContext
beforeAll(async () => {
  ctx = await startTestServer()
})
afterAll(async () => {
  if (ctx) await ctx.close()
})

type Character = { id: string; name: string }
type Project = { id: string }

/** Dự án + hai nhân vật thư viện + một model video. */
async function setup() {
  const { modelPk } = await seedProviderAndModel(ctx, 'video')
  const project = (await call(ctx, '/api/projects', { method: 'POST', body: { name: 'Dự án' } }))
    .body.project as Project

  const an = (
    await call(ctx, '/api/shared-characters', {
      method: 'POST',
      body: { name: 'An', appearance: 'Áo xanh, tóc ngắn', voice: {} },
    })
  ).body.character as Character

  const binh = (
    await call(ctx, '/api/shared-characters', {
      method: 'POST',
      body: { name: 'Bình', appearance: 'Áo đỏ, tóc dài', voice: {} },
    })
  ).body.character as Character

  return { modelPk, project, an, binh }
}

function createScene(projectId: string, body: Record<string, unknown>) {
  return call(ctx, `/api/projects/${projectId}/scenes`, { method: 'POST', body })
}

describe('Nhiều nhân vật trong một cảnh', () => {
  it('lưu danh sách nhân vật với người nói chính ở vị trí 0', async () => {
    await registerUser(ctx)
    const { modelPk, project, an, binh } = await setup()

    const scene = await createScene(project.id, {
      title: 'Cảnh 1',
      prompt: 'Hai người gặp nhau',
      characterId: an.id,
      characterIds: [an.id, binh.id],
      dialogue: 'Chào cậu',
      modelId: modelPk,
    })

    expect(scene.status).toBe(201)
    expect(scene.body.scene.characterIds).toEqual([an.id, binh.id])
    expect(scene.body.scene.characterId).toBe(an.id)
    // Cảnh mới mặc định CHƯA duyệt nên chưa thể tốn tiền.
    expect(scene.body.scene.approved).toBe(false)
  })

  it('đẩy người nói lên đầu kể cả khi gửi sau', async () => {
    await registerUser(ctx)
    const { modelPk, project, an, binh } = await setup()

    const scene = await createScene(project.id, {
      title: 'Cảnh 2',
      prompt: 'Bình nói trước',
      characterId: binh.id,
      characterIds: [an.id],
      modelId: modelPk,
    })

    expect(scene.body.scene.characterIds).toEqual([binh.id, an.id])
  })

  it('thay danh sách nhân vật bằng PATCH', async () => {
    await registerUser(ctx)
    const { modelPk, project, an, binh } = await setup()

    const scene = await createScene(project.id, {
      title: 'Cảnh 3',
      prompt: 'x',
      characterId: an.id,
      characterIds: [an.id],
      modelId: modelPk,
    })

    const updated = await call(ctx, `/api/projects/${project.id}/scenes/${scene.body.scene.id}`, {
      method: 'PATCH',
      body: { characterId: binh.id, characterIds: [binh.id, an.id] },
    })
    expect(updated.status).toBe(200)
    expect(updated.body.scene.characterIds).toEqual([binh.id, an.id])
    expect(updated.body.scene.characterId).toBe(binh.id)
  })

  it('bỏ người nói thì gỡ luôn khỏi cảnh', async () => {
    await registerUser(ctx)
    const { modelPk, project, an } = await setup()

    const scene = await createScene(project.id, {
      title: 'Cảnh 4',
      prompt: 'x',
      characterId: an.id,
      characterIds: [an.id],
      modelId: modelPk,
    })

    const cleared = await call(
      ctx,
      `/api/projects/${project.id}/scenes/${scene.body.scene.id}`,
      { method: 'PATCH', body: { characterId: null, dialogue: '' } },
    )
    expect(cleared.status).toBe(200)
    expect(cleared.body.scene.characterIds).toEqual([])

    // Đã gỡ khỏi cảnh thì xóa nhân vật được.
    expect((await call(ctx, `/api/shared-characters/${an.id}`, { method: 'DELETE' })).status).toBe(204)
  })

  it('chặn xóa nhân vật còn trong cảnh', async () => {
    await registerUser(ctx)
    const { modelPk, project, an, binh } = await setup()

    await createScene(project.id, {
      title: 'Cảnh 5',
      prompt: 'x',
      characterId: an.id,
      characterIds: [an.id, binh.id],
      modelId: modelPk,
    })

    // Bình tuy không phải người nói nhưng vẫn đang ở trong cảnh.
    const blocked = await call(ctx, `/api/shared-characters/${binh.id}`, { method: 'DELETE' })
    expect(blocked.status).toBe(400)
    expect(blocked.body.error.message).toContain('cảnh')
  })

  it('từ chối nhân vật không tồn tại trong danh sách cảnh', async () => {
    await registerUser(ctx)
    const { modelPk, project, an } = await setup()

    const bad = await createScene(project.id, {
      title: 'Cảnh 6',
      prompt: 'x',
      characterId: an.id,
      characterIds: [an.id, 'khong-ton-tai'],
      modelId: modelPk,
    })
    expect(bad.status).toBe(404)
  })

  it('xóa cảnh thì dọn luôn liên kết nhân vật', async () => {
    await registerUser(ctx)
    const { modelPk, project, an } = await setup()

    const scene = await createScene(project.id, {
      title: 'Cảnh 7',
      prompt: 'x',
      characterId: an.id,
      characterIds: [an.id],
      modelId: modelPk,
    })
    const sceneId = scene.body.scene.id as string

    expect(
      (await call(ctx, `/api/projects/${project.id}/scenes/${sceneId}`, { method: 'DELETE' }))
        .status,
    ).toBe(204)

    const left = ctx.db
      .prepare('SELECT COUNT(*) AS total FROM scene_characters WHERE scene_id = ?')
      .get(sceneId) as { total: number }
    expect(Number(left.total)).toBe(0)
  })

  it('prompt xem trước nêu bối cảnh và nhân vật phụ', async () => {
    await registerUser(ctx)
    const { modelPk, project, an, binh } = await setup()

    const scene = await createScene(project.id, {
      title: 'Cảnh 8',
      prompt: 'Hai người đi dạo',
      characterId: an.id,
      characterIds: [an.id, binh.id],
      dialogue: 'Trời đẹp nhỉ',
      modelId: modelPk,
      background: 'Công viên mùa thu',
    })

    const preview = await call(ctx, `/api/scenes/${scene.body.scene.id}/preview-prompt`, {
      method: 'POST',
      body: {},
    })
    expect(preview.status).toBe(200)
    expect(preview.body.effectivePrompt).toContain('Công viên mùa thu')
    expect(preview.body.effectivePrompt).toContain('Bình')
    expect(preview.body.effectivePrompt).toContain('Áo đỏ, tóc dài')
    // Ảnh tham chiếu của cả hai nhân vật được ghi vào snapshot.
    expect(preview.body.snapshot.cast).toHaveLength(1)
    expect(preview.body.snapshot.background).toBe('Công viên mùa thu')
  })
})

describe('Cổng duyệt và xếp hàng tạo nội dung', () => {
  it('cảnh chưa duyệt không bao giờ được xếp hàng', async () => {
    await registerUser(ctx)
    const { modelPk, project, an } = await setup()

    const scene = await createScene(project.id, {
      title: 'Chưa duyệt',
      prompt: 'Nội dung',
      characterId: an.id,
      modelId: modelPk,
      autoGenerate: true,
    })
    expect(scene.status).toBe(201)

    await ctx.worker.tick()

    const queued = ctx.db
      .prepare('SELECT COUNT(*) AS total FROM generations WHERE scene_id = ?')
      .get(scene.body.scene.id) as { total: number }
    expect(Number(queued.total)).toBe(0)

    // Cờ vẫn còn để duyệt xong là vào hàng ngay.
    const row = ctx.db
      .prepare('SELECT auto_generate FROM scenes WHERE id = ?')
      .get(scene.body.scene.id) as { auto_generate: number }
    expect(row.auto_generate).toBe(1)
  })

  it('duyệt cảnh thì được xếp hàng, không vượt giới hạn đồng thời', async () => {
    await registerUser(ctx)
    const { modelPk, project, an } = await setup()

    const sceneIds: string[] = []
    for (let index = 0; index < 3; index += 1) {
      const scene = await createScene(project.id, {
        title: `Cảnh ${index}`,
        prompt: 'Nội dung',
        characterId: an.id,
        modelId: modelPk,
        autoGenerate: true,
      })
      sceneIds.push(scene.body.scene.id as string)

      const approved = await call(
        ctx,
        `/api/projects/${project.id}/scenes/${scene.body.scene.id}`,
        { method: 'PATCH', body: { approved: true } },
      )
      expect(approved.body.scene.approved).toBe(true)
    }

    await ctx.worker.tick()

    const placeholders = sceneIds.map(() => '?').join(', ')
    const created = ctx.db
      .prepare(`SELECT COUNT(*) AS total FROM generations WHERE scene_id IN (${placeholders})`)
      .get(...sceneIds) as { total: number }
    expect(Number(created.total)).toBe(ctx.env.MAX_CONCURRENT_JOBS_PER_USER)

    // Cảnh đã vào hàng được hạ cờ; phần còn lại giữ cờ để vòng sau chạy tiếp.
    const stillPending = ctx.db
      .prepare(
        `SELECT COUNT(*) AS total FROM scenes WHERE id IN (${placeholders}) AND auto_generate = 1`,
      )
      .get(...sceneIds) as { total: number }
    expect(Number(stillPending.total)).toBe(3 - ctx.env.MAX_CONCURRENT_JOBS_PER_USER)

    // Sửa nội dung cảnh đã duyệt thì phải duyệt lại.
    const edited = await call(ctx, `/api/projects/${project.id}/scenes/${sceneIds[0]}`, {
      method: 'PATCH',
      body: { prompt: 'Nội dung đã đổi' },
    })
    expect(edited.body.scene.approved).toBe(false)
  })

  it('cảnh không có model vẫn chờ, không chặn cảnh khác', async () => {
    await registerUser(ctx)
    const { modelPk, project, an } = await setup()

    const noModel = await createScene(project.id, {
      title: 'Thiếu model',
      prompt: 'Nội dung',
      characterId: an.id,
      autoGenerate: true,
    })
    await call(ctx, `/api/projects/${project.id}/scenes/${noModel.body.scene.id}`, {
      method: 'PATCH',
      body: { approved: true },
    })

    const withModel = await createScene(project.id, {
      title: 'Có model',
      prompt: 'Nội dung',
      characterId: an.id,
      modelId: modelPk,
      autoGenerate: true,
    })
    await call(ctx, `/api/projects/${project.id}/scenes/${withModel.body.scene.id}`, {
      method: 'PATCH',
      body: { approved: true },
    })

    await ctx.worker.tick()

    const missing = ctx.db
      .prepare('SELECT COUNT(*) AS total FROM generations WHERE scene_id = ?')
      .get(noModel.body.scene.id) as { total: number }
    expect(Number(missing.total)).toBe(0)

    const created = ctx.db
      .prepare('SELECT COUNT(*) AS total FROM generations WHERE scene_id = ?')
      .get(withModel.body.scene.id) as { total: number }
    expect(Number(created.total)).toBe(1)
  })
})
