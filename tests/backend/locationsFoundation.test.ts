import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestContext } from './helpers'
import { parseLocations, type LocationReference } from '../../server/planner/artifacts'
import { listPlanLocations, savePlanLocations, updatePlanLocation, removePlanLocation, assignPlanLocation, ownedPlanLocation, locationReferencePrompt } from '../../server/planner/locations'
import { listProjectLocations, saveProjectLocation, removeProjectLocation, assignProjectLocation, ownedProjectLocation } from '../../server/projects/locations'
import { planLocationRoutes } from '../../server/planner/locationRoutes'
import { projectLocationRoutes } from '../../server/projects/locationRoutes'

let ctx: TestContext

beforeAll(async () => {
  ctx = await startTestServer()
})
afterAll(async () => {
  if (ctx) await ctx.close()
})

/** Tài khoản + phiên + dự án trống cho các bài kiểm tra tầng service. */
function seedUser(): { userId: string; sessionId: string; projectId: string } {
  const now = Date.now()
  const userId = `user-${now}-${Math.random().toString(16).slice(2)}`
  ctx.db.prepare('INSERT INTO users (id, email, password_hash, password_salt, created_at) VALUES (?,?,?,?,?)').run(userId, `${userId}@gigone.com`, 'x', 'x', now)
  const sessionId = `session-${userId}`
  ctx.db.prepare(`INSERT INTO plan_sessions (id, user_id, kind, title, status, locations_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`).run(sessionId, userId, 'planner', 'Phiên test', 'scripting', '[]', now, now)
  const projectId = `project-${userId}`
  ctx.db.prepare(`INSERT INTO projects (id, user_id, name, description, style, language, archived, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(projectId, userId, 'Dự án test', '', '', 'vi', 0, now, now)
  return { userId, sessionId, projectId }
}

const input = (name: string) => ({
  name,
  stage: 'sân ga buổi sớm',
  description: 'Sân ga cũ, mái sắt, nắng nhạt',
  continuityNotes: 'Giữ nguyên ghế và biển ga',
  imagePrompt: 'sân ga, mái sắt, nắng sớm',
})

describe('Bối cảnh tham chiếu — kiểu dữ liệu', () => {
  it('parseLocations chịu được JSON rỗng, hỏng, thiếu id và id trùng', () => {
    expect(parseLocations(null)).toEqual([])
    expect(parseLocations('không phải json')).toEqual([])
    expect(parseLocations('{}')).toEqual([])
    const parsed = parseLocations(JSON.stringify([
      { id: 'a', name: 'Ga', revision: 2 },
      { id: 'a', name: 'trùng id' },
      { name: 'thiếu id' },
      { id: 'b', name: 'Bến', reference: { uploadId: 'u1' } },
    ]))
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toMatchObject<Partial<LocationReference>>({ id: 'a', name: 'Ga', revision: 2, reference: null })
    expect(parsed[1]!.reference).toEqual({ uploadId: 'u1' })
  })

  it('prompt ảnh bối cảnh yêu cầu khung cảnh trống, không có người và chữ', () => {
    const prompt = locationReferencePrompt({ id: 'a', ...input('Sân ga'), reference: null, revision: 1 })
    expect(prompt).toContain('no people')
    expect(prompt.toLowerCase()).toContain('no text')
    expect(prompt).toContain('Sân ga')
  })
})

describe('CRUD bối cảnh của phiên — service', () => {
  it('tạo, sửa tăng revision, giữ id khi sửa, xoá và kiểm tra quyền sở hữu', () => {
    const { userId, sessionId } = seedUser()
    const first = savePlanLocations(ctx.db, userId, sessionId, [input('Sân ga')])[0]!
    expect(first.revision).toBe(1)
    expect(first.reference).toBeNull()

    const second = savePlanLocations(ctx.db, userId, sessionId, [first, input('Khoang tàu')])
    expect(second).toHaveLength(2)
    expect(second.map((item) => item.id)).toContain(first.id)

    const updated = updatePlanLocation(ctx.db, userId, sessionId, first.id, { description: 'Mô tả mới' })
    expect(updated.id).toBe(first.id)
    expect(updated.description).toBe('Mô tả mới')
    expect(updated.revision).toBe(2)

    // Không tăng revision khi không có thay đổi thật.
    const same = updatePlanLocation(ctx.db, userId, sessionId, first.id, { description: 'Mô tả mới' })
    expect(same.revision).toBe(2)

    removePlanLocation(ctx.db, userId, sessionId, first.id)
    expect(listPlanLocations(ctx.db, userId, sessionId)).toHaveLength(1)

    const stranger = seedUser()
    expect(() => listPlanLocations(ctx.db, stranger.userId, sessionId)).toThrow(/không tìm thấy/i)
    expect(() => ownedPlanLocation(ctx.db, stranger.userId, sessionId, second[1]!.id)).toThrow(/không tìm thấy/i)
  })

  it('giới hạn 20 bối cảnh', () => {
    const { userId, sessionId } = seedUser()
    const many = Array.from({ length: 20 }, (_, index) => input(`Bối cảnh ${index}`))
    expect(savePlanLocations(ctx.db, userId, sessionId, many)).toHaveLength(20)
    expect(() => savePlanLocations(ctx.db, userId, sessionId, [...many, input('Thứ 21')])).toThrow(/20/)
  })

  it('gán bối cảnh cho frame, đánh dấu ảnh nền cũ mà không xoá ảnh', () => {
    const { userId, sessionId } = seedUser()
    const [location] = savePlanLocations(ctx.db, userId, sessionId, [input('Bến tàu')])
    const frame = { id: 'frame-1', title: 'Mở đầu', context: 'x', action: 'y', dialogue: '', speaker: '', characters: [], durationSeconds: 8, shotNotes: '', backgroundPrompt: 'x', background: { uploadId: 'cu' }, blocking: [] }
    ctx.db.prepare('UPDATE plan_sessions SET timeline_json = ? WHERE id = ?').run(JSON.stringify({ frames: [frame] }), sessionId)

    assignPlanLocation(ctx.db, userId, sessionId, location!.id, ['frame-1'])
    const timeline = JSON.parse(ctx.db.prepare('SELECT timeline_json AS json FROM plan_sessions WHERE id = ?').get(sessionId)!.json as string)
    expect(timeline.frames[0].locationId).toBe(location!.id)
    expect(timeline.frames[0].backgroundStale).toBe(true)
    expect(timeline.frames[0].background).toEqual({ uploadId: 'cu' })

    // Gỡ gán: ảnh cũ vẫn còn, chỉ bỏ liên kết.
    assignPlanLocation(ctx.db, userId, sessionId, null, ['frame-1'])
    const cleared = JSON.parse(ctx.db.prepare('SELECT timeline_json AS json FROM plan_sessions WHERE id = ?').get(sessionId)!.json as string)
    expect(cleared.frames[0].locationId).toBeNull()
    expect(cleared.frames[0].background).toEqual({ uploadId: 'cu' })

    expect(() => assignPlanLocation(ctx.db, userId, sessionId, location!.id, ['khong-ton-tai'])).toThrow(/không hợp lệ/i)
  })
})

describe('CRUD bối cảnh của dự án — service', () => {
  it('tạo, sửa, xoá và gỡ location_id khỏi cảnh', () => {
    const { userId, projectId } = seedUser()
    const created = saveProjectLocation(ctx.db, userId, projectId, input('Sân ga'))
    expect(created.revision).toBe(1)

    const updated = saveProjectLocation(ctx.db, userId, projectId, { ...input('Sân ga'), description: 'Mới' }, created.id)
    expect(updated.id).toBe(created.id)
    expect(updated.revision).toBe(2)

    ctx.db.prepare('INSERT INTO scenes (id, project_id, title, prompt, dialogue, params_json, position, background, approved, auto_generate, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('scene-1', projectId, 'Cảnh', 'p', '', '{}', 0, '', 0, 0, Date.now(), Date.now())
    assignProjectLocation(ctx.db, userId, projectId, created.id, ['scene-1'])
    expect(ctx.db.prepare('SELECT location_id AS id FROM scenes WHERE id = ?').get('scene-1')!.id).toBe(created.id)

    removeProjectLocation(ctx.db, userId, projectId, created.id)
    expect(listProjectLocations(ctx.db, userId, projectId)).toHaveLength(0)
    expect(ctx.db.prepare('SELECT location_id AS id FROM scenes WHERE id = ?').get('scene-1')!.id).toBeNull()

    const stranger = seedUser()
    expect(() => listProjectLocations(ctx.db, stranger.userId, projectId)).toThrow(/không tìm thấy/i)
    expect(() => ownedProjectLocation(ctx.db, stranger.userId, projectId, created.id)).toThrow(/không tìm thấy/i)
  })
})

describe('Router bối cảnh — hợp đồng đường dẫn', () => {
  it('đăng ký đủ endpoint cho phiên và dự án', () => {
    const plan = planLocationRoutes(ctx.db, ctx.env, ctx.mediaStore, ctx.worker)
    const project = projectLocationRoutes(ctx.db, ctx.env, ctx.mediaStore, ctx.worker)
    const paths = (router: typeof plan) => (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> })
      .stack.flatMap((layer) => (layer.route ? [`${Object.keys(layer.route.methods)[0]!.toUpperCase()} ${layer.route.path}`] : []))
    expect(paths(plan)).toEqual(expect.arrayContaining([
      'GET /:id/locations',
      'PUT /:id/locations',
      'POST /:id/locations',
      'POST /:id/locations/propose',
      'POST /:id/locations/assign',
      'PATCH /:id/locations/:locationId',
      'DELETE /:id/locations/:locationId',
      'POST /:id/locations/:locationId/reference',
      'POST /:id/locations/:locationId/reference/upload',
      'POST /:id/locations/:locationId/reference/attach',
      'DELETE /:id/locations/:locationId/reference',
    ]))
    expect(paths(project)).toEqual(expect.arrayContaining([
      'GET /:id/locations',
      'POST /:id/locations',
      'PATCH /:id/locations/:locationId',
      'DELETE /:id/locations/:locationId',
      'POST /:id/locations/assign',
      'POST /:id/locations/:locationId/reference/upload',
    ]))
  })
})
