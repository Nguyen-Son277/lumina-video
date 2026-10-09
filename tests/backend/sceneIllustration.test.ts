import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'
import { applyPlan } from '../../server/planner/apply'
import { sweepAutoGenerate } from '../../server/generations/sweeper'
import type { PlanSessionRow } from '../../server/planner/service'
import { parseTimeline, type CastMember, type TimelineFrame } from '../../server/planner/artifacts'

/**
 * Ảnh minh hoạ storyboard của cảnh (`scenes.background_upload_id`).
 *
 * Ảnh này được `applyPlan` sao chép từ ảnh khung timeline sang, phải hiển thị được
 * qua `scenePublic` (id + URL), và tách biệt hoàn toàn với text `background` của
 * cảnh. Endpoint `bulk` chỉ ghi cờ duyệt/model — không bao giờ tự xếp hàng tạo
 * nội dung; việc tạo thật do `sweepAutoGenerate` làm ở vòng worker sau đó.
 */

const PASSWORD = 'matkhau-rat-dai-123'
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let ctx: TestContext
beforeAll(async () => {
  ctx = await startTestServer()
})
afterAll(async () => {
  if (ctx) await ctx.close()
})

/** Tạo một upload thật (có tệp trong kho media) và trả id. */
function insertUpload(userId: string, uploadId = randomUUID()): string {
  const saved = ctx.mediaStore.saveUpload({
    userId,
    uploadId,
    bytes: Buffer.from(PNG_BASE64, 'base64'),
    maxBytes: ctx.env.MAX_REFERENCE_BYTES,
  })
  ctx.db
    .prepare('INSERT INTO uploads (id, user_id, relative_path, mime_type, byte_size, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uploadId, userId, saved.relativePath, saved.mimeType, saved.byteSize, Date.now())
  return uploadId
}

async function createProject(name = 'Dự án minh hoạ'): Promise<string> {
  const created = await call(ctx, '/api/projects', { method: 'POST', body: { name } })
  expect(created.status).toBe(201)
  return created.body.project.id as string
}

async function createScene(projectId: string, body: Record<string, unknown>) {
  return call(ctx, `/api/projects/${projectId}/scenes`, { method: 'POST', body })
}

function generationCount(userId: string): number {
  return Number(
    (ctx.db.prepare('SELECT COUNT(*) AS total FROM generations WHERE user_id = ?').get(userId) as { total: number }).total,
  )
}

describe('applyPlan — ảnh storyboard của khung đi sang cảnh Studio', () => {
  it('sao chép upload thành scenes.background_upload_id và scenePublic trả id + URL', async () => {
    const owner = await registerUser(ctx)
    const uploadId = insertUpload(owner.userId)

    const frame: TimelineFrame = {
      id: 'frame-1',
      title: 'Mở đầu',
      context: 'Sân ga buổi sớm',
      action: 'An kéo vali',
      dialogue: '',
      speaker: '',
      characters: [],
      durationSeconds: 8,
      shotNotes: '',
      backgroundPrompt: 'Sân ga buổi sớm',
      background: { uploadId },
      locationId: null,
      backgroundLocationRevision: null,
      backgroundStale: false,
      blocking: [],
    }
    const cast: CastMember[] = []
    const sessionId = randomUUID()
    const now = Date.now()
    ctx.db
      .prepare(
        `INSERT INTO plan_sessions (id, user_id, kind, project_id, title, status, script_json, cast_json, timeline_json, locations_json, created_at, updated_at)
         VALUES (?, ?, 'planner', NULL, 'Phiên minh hoạ', 'timeline_ready', NULL, '[]', ?, '[]', ?, ?)`,
      )
      .run(sessionId, owner.userId, JSON.stringify({ frames: [frame] }), now, now)

    const session = ctx.db.prepare('SELECT * FROM plan_sessions WHERE id = ?').get(sessionId) as unknown as PlanSessionRow
    const timeline = parseTimeline(session.timeline_json)!

    const result = applyPlan({
      db: ctx.db,
      env: ctx.env,
      userId: owner.userId,
      session,
      timeline,
      cast,
      apply: {},
      mediaStore: ctx.mediaStore,
    })

    const stored = ctx.db
      .prepare('SELECT background_upload_id AS uploadId FROM scenes WHERE project_id = ?')
      .all(result.project.id) as Array<{ uploadId: string | null }>
    expect(stored).toHaveLength(1)
    // Upload được sao chép sang bản riêng của cảnh, không trỏ thẳng vào upload của phiên.
    expect(stored[0]!.uploadId).toBeTruthy()
    expect(stored[0]!.uploadId).not.toBe(uploadId)

    const scene = (await call(ctx, `/api/projects/${result.project.id}/scenes`)).body.scenes[0] as {
      backgroundUploadId: string | null
      backgroundUrl: string | null
      background: string
    }
    expect(scene.backgroundUploadId).toBe(stored[0]!.uploadId)
    expect(scene.backgroundUrl).toBe(`/api/uploads/${stored[0]!.uploadId}`)
    // Ảnh minh hoạ không thay thế text bối cảnh của cảnh.
    expect(scene.background).toBe('Sân ga buổi sớm')
  })
})

describe('PATCH cảnh — gắn, thay và bỏ ảnh minh hoạ', () => {
  it('gắn mới, thay ảnh, bỏ trống thì giữ nguyên và null thì xoá', async () => {
    const owner = await registerUser(ctx)
    const projectId = await createProject()
    const first = insertUpload(owner.userId)
    const second = insertUpload(owner.userId)

    const created = await createScene(projectId, {
      title: 'Cảnh 1',
      prompt: 'Khung cảnh',
      background: 'Bối cảnh bằng chữ',
      backgroundUploadId: first,
    })
    expect(created.status).toBe(201)
    expect(created.body.scene.backgroundUploadId).toBe(first)
    expect(created.body.scene.backgroundUrl).toBe(`/api/uploads/${first}`)
    // Text bối cảnh vẫn riêng.
    expect(created.body.scene.background).toBe('Bối cảnh bằng chữ')

    const sceneId = created.body.scene.id as string
    const patch = (body: Record<string, unknown>) =>
      call(ctx, `/api/projects/${projectId}/scenes/${sceneId}`, { method: 'PATCH', body })

    // Thay ảnh khác.
    const replaced = await patch({ backgroundUploadId: second })
    expect(replaced.status).toBe(200)
    expect(replaced.body.scene.backgroundUploadId).toBe(second)
    expect(replaced.body.scene.background).toBe('Bối cảnh bằng chữ')

    // Bỏ trống trường thì giữ nguyên ảnh đang có (giao diện lưu lại cảnh).
    const kept = await patch({ title: 'Cảnh 1 sửa' })
    expect(kept.status).toBe(200)
    expect(kept.body.scene.backgroundUploadId).toBe(second)
    expect(kept.body.scene.title).toBe('Cảnh 1 sửa')

    // null để bỏ ảnh minh hoạ.
    const cleared = await patch({ backgroundUploadId: null })
    expect(cleared.status).toBe(200)
    expect(cleared.body.scene.backgroundUploadId).toBeNull()
    expect(cleared.body.scene.backgroundUrl).toBeNull()
  })

  it('từ chối ảnh không tồn tại và ảnh của tài khoản khác', async () => {
    const owner = await registerUser(ctx, `owner-${Date.now()}@gigone.com`, PASSWORD)
    const projectId = await createProject()
    const sceneId = (
      await createScene(projectId, { title: 'Cảnh 1', prompt: 'x' })
    ).body.scene.id as string

    const unknown = await call(ctx, `/api/projects/${projectId}/scenes/${sceneId}`, {
      method: 'PATCH',
      body: { backgroundUploadId: 'khong-ton-tai' },
    })
    expect(unknown.status).toBe(400)
    expect(unknown.body.error.messageKey).toBe('scenes.illustration_not_found')

    // Upload của người khác phải bị từ chối; sau đó đăng nhập lại chủ dự án.
    const other = await registerUser(ctx, `other-${Date.now()}@gigone.com`, PASSWORD)
    const foreignUpload = insertUpload(other.userId)
    await call(ctx, '/api/auth/login', { method: 'POST', body: { email: owner.email, password: PASSWORD } })
    const foreign = await call(ctx, `/api/projects/${projectId}/scenes/${sceneId}`, {
      method: 'PATCH',
      body: { backgroundUploadId: foreignUpload },
    })
    expect(foreign.status).toBe(400)
    expect(foreign.body.error.messageKey).toBe('scenes.illustration_not_found')

    // Không thay đổi gì sau các request bị từ chối.
    const current = await call(ctx, `/api/projects/${projectId}/scenes/${sceneId}`)
    expect(current.body.scene.backgroundUploadId).toBeNull()
  })
})

describe('POST cảnh hàng loạt — duyệt và gán model, không tự tạo nội dung', () => {
  it('duyệt/bỏ duyệt theo danh sách, chỉ lấp model còn thiếu và không xếp hàng tạo', async () => {
    const user = await registerUser(ctx)
    const { modelPk: videoModel } = await seedProviderAndModel(ctx, 'video')
    const projectId = await createProject()

    const first = (await createScene(projectId, { title: 'Cảnh 1', prompt: 'Một' })).body.scene
    const second = (await createScene(projectId, { title: 'Cảnh 2', prompt: 'Hai' })).body.scene
    // Cảnh thứ hai đã có model khác: bulk không được ghi đè.
    const { modelPk: otherVideoModel } = await seedProviderAndModel(ctx, 'video')
    await call(ctx, `/api/projects/${projectId}/scenes/${second.id}`, {
      method: 'PATCH',
      body: { modelId: otherVideoModel },
    })

    const bulk = (body: Record<string, unknown>) =>
      call(ctx, `/api/projects/${projectId}/scenes/bulk`, { method: 'POST', body })

    const approved = await bulk({ ids: [first.id], approved: true, autoGenerate: true, modelId: videoModel })
    expect(approved.status).toBe(200)
    expect(approved.body.scenes).toHaveLength(1)
    expect(approved.body.scenes[0].approved).toBe(true)
    expect(approved.body.scenes[0].autoGenerate).toBe(true)
    expect(approved.body.scenes[0].modelId).toBe(videoModel)
    // Không hiển thị cảnh ngoài danh sách.
    expect(approved.body.scenes[0].id).toBe(first.id)
    // Chỉ trả id nhân vật theo thứ tự; cảnh này chưa có nhân vật.
    expect(approved.body.scenes[0].characterIds).toEqual([])

    // Không cảnh nào được xếp hàng tạo nội dung bởi chính endpoint bulk.
    expect(generationCount(user.userId)).toBe(0)

    // Cảnh thứ hai không có trong danh sách nên không bị đổi.
    const untouched = (await call(ctx, `/api/projects/${projectId}/scenes`)).body.scenes as Array<{
      id: string
      approved: boolean
      autoGenerate: boolean
      modelId: string | null
    }>
    expect(untouched.find((scene) => scene.id === second.id)!.approved).toBe(false)

    // Bỏ duyệt và gán model cho cả hai (chỉ cảnh thiếu model nhận model mới).
    const all = await bulk({ approved: false, modelId: videoModel })
    expect(all.body.scenes).toHaveLength(2)
    const byId = new Map((all.body.scenes as Array<{ id: string; approved: boolean; modelId: string | null }>).map((scene) => [scene.id, scene]))
    expect(byId.get(first.id)!.approved).toBe(false)
    expect(byId.get(first.id)!.modelId).toBe(videoModel)
    // Cảnh đã có model riêng thì giữ nguyên.
    expect(byId.get(second.id)!.modelId).toBe(otherVideoModel)

    // modelId: null xoá model; bỏ trống thì giữ nguyên.
    const cleared = await bulk({ ids: [first.id], modelId: null })
    expect(cleared.body.scenes[0].modelId).toBeNull()
    const kept = await bulk({ ids: [first.id] })
    expect(kept.body.scenes[0].modelId).toBeNull()
  })

  it('từ chối cảnh lạ, id trùng và model không phải video', async () => {
    const owner = await registerUser(ctx, `owner-${Date.now()}@gigone.com`, PASSWORD)
    const { modelPk: videoModel } = await seedProviderAndModel(ctx, 'video')
    const { modelPk: imageModel } = await seedProviderAndModel(ctx, 'image')
    const projectId = await createProject()
    const otherProjectId = await createProject('Dự án khác')
    const scene = (await createScene(projectId, { title: 'Cảnh 1', prompt: 'Một' })).body.scene
    const otherScene = (await createScene(otherProjectId, { title: 'Cảnh dự án khác', prompt: 'Hai' })).body.scene

    const bulk = (body: Record<string, unknown>) =>
      call(ctx, `/api/projects/${projectId}/scenes/bulk`, { method: 'POST', body })

    // Cảnh của dự án khác không được phép.
    const foreignScene = await bulk({ ids: [otherScene.id], approved: true })
    expect(foreignScene.status).toBe(400)

    // Id không tồn tại cũng bị từ chối.
    const unknown = await bulk({ ids: ['khong-co-that'], approved: true })
    expect(unknown.status).toBe(400)

    const duplicated = await bulk({ ids: [scene.id, scene.id], approved: true })
    expect(duplicated.status).toBe(400)

    const wrongKind = await bulk({ ids: [scene.id], modelId: imageModel })
    expect(wrongKind.status).toBe(400)
    expect(wrongKind.body.error.messageKey).toBe('planner.video_model_required')

    // Model video của người khác cũng bị từ chối; sau đó đăng nhập lại chủ dự án.
    const stranger = await registerUser(ctx, `stranger-${Date.now()}@gigone.com`, PASSWORD)
    const { modelPk: strangerModel } = await seedProviderAndModel(ctx, 'video')
    expect(stranger.userId).toBeTruthy()
    await call(ctx, '/api/auth/login', { method: 'POST', body: { email: owner.email, password: PASSWORD } })
    const foreign = await bulk({ ids: [scene.id], modelId: strangerModel })
    expect(foreign.status).toBe(400)
    expect(foreign.body.error.messageKey).toBe('planner.video_model_required')

    // Không thay đổi nào được ghi sau các request lỗi.
    const after = (await call(ctx, `/api/projects/${projectId}/scenes/${scene.id}`)).body.scene
    expect(after.approved).toBe(false)
    expect(after.modelId).toBeNull()
    expect(after.modelId).not.toBe(videoModel)
  })
})

describe('Duyệt + autoGenerate + model → worker xếp hàng tạo video', () => {
  it('bulk chỉ ghi cờ; sweepAutoGenerate mới tạo tác vụ', async () => {
    const user = await registerUser(ctx)
    const { modelPk: videoModel } = await seedProviderAndModel(ctx, 'video')
    const projectId = await createProject()
    const scene = (await createScene(projectId, { title: 'Cảnh quay', prompt: 'Một khung hình chuyển động' })).body.scene

    const bulk = await call(ctx, `/api/projects/${projectId}/scenes/bulk`, {
      method: 'POST',
      body: { ids: [scene.id], approved: true, autoGenerate: true, modelId: videoModel },
    })
    expect(bulk.status).toBe(200)
    expect(bulk.body.scenes[0].approved).toBe(true)
    expect(bulk.body.scenes[0].autoGenerate).toBe(true)
    // Endpoint duyệt không tự tạo tác vụ.
    expect(generationCount(user.userId)).toBe(0)

    const queued = sweepAutoGenerate({ db: ctx.db, env: ctx.env, worker: ctx.worker })
    expect(queued).toBe(1)

    const generation = ctx.db
      .prepare('SELECT scene_id AS sceneId, model_pk AS modelId, status FROM generations WHERE user_id = ?')
      .get(user.userId) as { sceneId: string | null; modelId: string | null; status: string } | undefined
    expect(generation?.sceneId).toBe(scene.id)
    expect(generation?.modelId).toBe(videoModel)
    // Worker nền có thể đã nhận tác vụ ngay, nên chỉ cần nó đã vào hệ thống.
    expect(['queued', 'running', 'downloading', 'succeeded']).toContain(generation?.status)

    // Đã vào hàng thì cờ auto_generate được hạ để vòng sau không xếp trùng.
    const after = ctx.db.prepare('SELECT auto_generate AS autoGenerate FROM scenes WHERE id = ?').get(scene.id) as {
      autoGenerate: number
    }
    expect(after.autoGenerate).toBe(0)
    expect(sweepAutoGenerate({ db: ctx.db, env: ctx.env, worker: ctx.worker })).toBe(0)
  })

  it('cảnh chưa duyệt không bao giờ được xếp hàng', async () => {
    const user = await registerUser(ctx)
    const { modelPk: videoModel } = await seedProviderAndModel(ctx, 'video')
    const projectId = await createProject()
    const scene = (await createScene(projectId, { title: 'Chưa duyệt', prompt: 'x' })).body.scene
    await call(ctx, `/api/projects/${projectId}/scenes/bulk`, {
      method: 'POST',
      body: { ids: [scene.id], autoGenerate: true, modelId: videoModel },
    })
    expect(sweepAutoGenerate({ db: ctx.db, env: ctx.env, worker: ctx.worker })).toBe(0)
    expect(generationCount(user.userId)).toBe(0)
  })
})
