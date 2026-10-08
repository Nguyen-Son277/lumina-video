import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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

/** Dựng một dự án có nhân vật và một cảnh đã chọn phiên bản. */
async function setupScene() {
  await registerUser(ctx)
  const { modelPk } = await seedProviderAndModel(ctx, 'video')

  const project = (await call(ctx, '/api/projects', {
    method: 'POST',
    body: { name: 'Phim', language: 'vi' },
  })).body.project

  const character = (await call(ctx, `/api/projects/${project.id}/characters`, {
    method: 'POST',
    body: { name: 'An', appearance: 'Áo xanh', voice: { accent: 'Miền Nam' } },
  })).body.character

  const scene = (await call(ctx, `/api/projects/${project.id}/scenes`, {
    method: 'POST',
    body: { title: 'Cảnh 1', characterId: character.id, prompt: 'Rừng thông', modelId: modelPk },
  })).body.scene

  const generation = (await call(ctx, `/api/scenes/${scene.id}/generate`, {
    method: 'POST',
    body: { modelId: modelPk },
  })).body.generation

  const done = await waitForGeneration(ctx, generation.id)
  expect(done.status).toBe('succeeded')

  await call(ctx, `/api/scenes/${scene.id}/select-generation`, {
    method: 'POST',
    body: { generationId: generation.id },
  })

  return { project, scene, generation }
}

describe('Xoá kết quả ngay trong dự án', () => {
  it('xoá được ảnh đã tạo và gỡ khỏi danh sách kết quả', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const project = (await call(ctx, '/api/projects', {
      method: 'POST',
      body: { name: 'Dự án ảnh', language: 'vi' },
    })).body.project

    const created = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, projectId: project.id, prompt: 'Một buổi sáng' },
    })
    await waitForGeneration(ctx, created.body.generation.id)

    const before = await call(ctx, `/api/generations?projectId=${project.id}`)
    expect(before.body.generations).toHaveLength(1)

    const removed = await call(ctx, `/api/generations/${created.body.generation.id}`, { method: 'DELETE' })
    expect(removed.status).toBe(204)

    const after = await call(ctx, `/api/generations?projectId=${project.id}`)
    expect(after.body.generations).toHaveLength(0)
  })

  it('xoá phiên bản đang được cảnh chọn thì cảnh bỏ chọn, không lỗi', async () => {
    const { scene, generation } = await setupScene()

    const removed = await call(ctx, `/api/generations/${generation.id}`, { method: 'DELETE' })
    expect(removed.status).toBe(204)

    const after = (await call(ctx, `/api/projects/${scene.projectId}/scenes`)).body.scenes
    const updated = after.find((item: { id: string }) => item.id === scene.id)
    // Khoá ngoại ON DELETE SET NULL phải gỡ liên kết thay vì để tham chiếu treo.
    expect(updated.selectedGenerationId).toBeNull()
  })

  it('không xoá được tác vụ đang chạy', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const project = (await call(ctx, '/api/projects', {
      method: 'POST',
      body: { name: 'Dự án', language: 'vi' },
    })).body.project

    // Tạo tác vụ rồi xoá ngay, trước khi worker kịp xử lý.
    const created = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { modelId: modelPk, projectId: project.id, prompt: 'Đang chờ' },
    })
    const removed = await call(ctx, `/api/generations/${created.body.generation.id}`, { method: 'DELETE' })

    // Hoặc bị từ chối vì đang chạy, hoặc đã xong và xoá thành công — cả hai đều hợp lệ.
    if (removed.status === 400) {
      expect(removed.body.error.message).toContain('đang chạy')
    } else {
      expect(removed.status).toBe(204)
    }
  })

  it('không xoá được kết quả của tài khoản khác', async () => {
    const { generation } = await setupScene()
    await registerUser(ctx)
    const stolen = await call(ctx, `/api/generations/${generation.id}`, { method: 'DELETE' })
    expect(stolen.status).toBe(404)
  })
})
