import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  call,
  registerUser,
  seedProviderAndModel,
  startTestServer,
  waitForGeneration,
  type TestContext,
} from './helpers'
import {
  parseLocations,
  type CastMember,
  type LocationReference,
  type Timeline,
  type TimelineFrame,
} from '../../server/planner/artifacts'
import { storyboardInputs } from '../../server/planner/storyboard'
import { createImageBatch, advanceImageBatch } from '../../server/planner/imageBatch'
import { applyPlan } from '../../server/planner/apply'
import type { PlanSessionRow } from '../../server/planner/service'

let ctx: TestContext
beforeAll(async () => {
  ctx = await startTestServer()
})
afterAll(async () => {
  if (ctx) await ctx.close()
})

const LOCATION_UPLOAD = 'loc-upload-1'
const PORTRAIT_UPLOAD = 'portrait-upload-1'

function location(overrides: Partial<LocationReference> = {}): LocationReference {
  return {
    id: 'loc-1',
    name: 'Sân ga',
    stage: 'Sáng sớm',
    description: 'Sân ga cũ, mái sắt, ghế gỗ dài',
    continuityNotes: 'Giữ nguyên bố cục và ánh nắng nhạt',
    imagePrompt: 'empty train station platform, no people',
    reference: { uploadId: LOCATION_UPLOAD },
    revision: 1,
    ...overrides,
  }
}

function member(id: string, name: string, portraitUploadId = PORTRAIT_UPLOAD): CastMember {
  return {
    id,
    name,
    appearance: 'áo xanh',
    role: '',
    voice: {} as CastMember['voice'],
    reuseCharacterId: null,
    storage: 'library',
    portrait: { uploadId: portraitUploadId },
  }
}

/** Cast gắn đúng ảnh chân dung đã đăng ký cho phiên test. */
function seededCast(seed: { portraitUploadId: string }): CastMember[] {
  return [member('cast-an', 'An', seed.portraitUploadId)]
}

function frame(overrides: Partial<TimelineFrame> = {}): TimelineFrame {
  return {
    id: 'frame-1',
    title: 'Mở đầu ở sân ga',
    context: 'Sân ga buổi sớm',
    backgroundPrompt: 'Sân ga buổi sớm',
    durationSeconds: 8,
    action: 'An kéo vali',
    dialogue: '',
    speaker: 'An',
    characters: ['An'],
    shotNotes: '',
    blocking: [{ castId: 'cast-an', action: 'kéo vali', position: 'center' }],
    background: null,
    locationId: null,
    backgroundLocationRevision: null,
    backgroundStale: false,
    ...overrides,
  } as TimelineFrame
}

describe('storyboardInputs — ảnh bối cảnh là nguồn bắt buộc, đứng trước chân dung', () => {
  const cast = [member('cast-an', 'An')]

  it('đặt ảnh bối cảnh ở vị trí đầu và nêu thứ tự vai trò', () => {
    const inputs = storyboardInputs(frame({ locationId: 'loc-1' }), cast, [location()], 16)
    expect(inputs.sourceUploadIds).toEqual([LOCATION_UPLOAD, PORTRAIT_UPLOAD])
    expect(inputs.sourceRoles).toEqual([
      { uploadId: LOCATION_UPLOAD, role: 'location', id: 'loc-1' },
      { uploadId: PORTRAIT_UPLOAD, role: 'character', id: 'cast-an' },
    ])
    expect(inputs.locationId).toBe('loc-1')
    expect(inputs.locationRevision).toBe(1)
    expect(inputs.prompt).toContain('Canonical location: Sân ga')
    expect(inputs.prompt).toContain('EMPTY location reference')
    expect(inputs.prompt).toContain('continuity')
  })

  it('cùng một ảnh bối cảnh cho mọi frame trong một batch', () => {
    const locations = [location()]
    const first = storyboardInputs(frame({ id: 'f1', locationId: 'loc-1' }), cast, locations, 16)
    const second = storyboardInputs(frame({ id: 'f2', locationId: 'loc-1' }), cast, locations, 16)
    expect(second.sourceUploadIds[0]).toBe(first.sourceUploadIds[0])
    expect(second.sourceRoles[0]).toEqual(first.sourceRoles[0])
  })

  it('không dùng ảnh bối cảnh khi frame không gắn bối cảnh', () => {
    const inputs = storyboardInputs(frame(), cast, [location()], 16)
    expect(inputs.sourceUploadIds).toEqual([PORTRAIT_UPLOAD])
    expect(inputs.sourceRoles).toEqual([{ uploadId: PORTRAIT_UPLOAD, role: 'character', id: 'cast-an' }])
    expect(inputs.locationId).toBeNull()
  })

  it('báo lỗi rõ ràng khi bối cảnh không tồn tại', () => {
    expect(() => storyboardInputs(frame({ locationId: 'missing' }), cast, [location()], 16))
      .toThrowError(/không tồn tại/i)
  })

  it('báo lỗi khi bối cảnh chưa có ảnh tham chiếu', () => {
    expect(() => storyboardInputs(frame({ locationId: 'loc-1' }), cast, [location({ reference: null })], 16))
      .toThrowError(/chưa có ảnh tham chiếu/i)
  })

  it('từ chối thay vì cắt bớt khi vượt giới hạn ảnh', () => {
    expect(() => storyboardInputs(frame({ locationId: 'loc-1' }), cast, [location()], 1))
      .toThrowError(/tối đa 1/i)
  })
})

type Seed = {
  userId: string
  sessionId: string
  imageModelId: string
  locationUploadId: string
  portraitUploadId: string
}

/** Tạo user + provider/model ảnh + phiên planner với locations_json và timeline. */
async function seedSession(options: {
  locations: LocationReference[]
  frames: TimelineFrame[]
  cast: CastMember[]
}): Promise<Seed> {
  const registered = await registerUser(ctx)
  const userId = registered.userId
  const { modelPk: imageModelId } = await seedProviderAndModel(ctx, 'image')

  const locationUploadId = `loc-upload-${randomUUID()}`
  const portraitUploadId = `portrait-upload-${randomUUID()}`
  const resolveLocations = options.locations.map((item) =>
    item.reference?.uploadId === LOCATION_UPLOAD
      ? { ...item, reference: { uploadId: locationUploadId } }
      : item,
  )
  const sessionId = randomUUID()
  const now = Date.now()
  ctx.db
    .prepare(
      `INSERT INTO plan_sessions (id, user_id, kind, chat_model_id, image_model_id, video_model_id, project_id,
        title, status, script_json, cast_json, locations_json, timeline_json, created_at, updated_at)
       VALUES (?, ?, 'planner', NULL, ?, NULL, NULL, 'Phiên test', 'scripting', NULL, ?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      userId,
      imageModelId,
      JSON.stringify(options.cast),
      JSON.stringify(resolveLocations),
      JSON.stringify({ frames: options.frames }),
      now,
      now,
    )

  const insertUpload = ctx.db.prepare(
    'INSERT INTO uploads (id, user_id, relative_path, mime_type, byte_size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  // Ảnh phải tồn tại thật trên media store: adapter mock đọc bytes ảnh nguồn.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  for (const uploadId of [locationUploadId, portraitUploadId]) {
    const saved = ctx.mediaStore.saveUpload({ userId, uploadId, bytes: png, maxBytes: ctx.env.MAX_REFERENCE_BYTES })
    insertUpload.run(uploadId, userId, saved.relativePath, saved.mimeType, saved.byteSize, now)
  }

  return { userId: userId, sessionId, imageModelId, locationUploadId, portraitUploadId }
}

function readSnapshot(batchId: string): {
  prompt: string
  sourceUploadIds: string[]
  sourceRoles: Array<{ uploadId: string; role: string; id: string }>
  locationId: string | null
  locationRevision: number | null
  title: string
} {
  const row = ctx.db
    .prepare('SELECT snapshot_json AS json FROM plan_image_batch_items WHERE batch_id = ? ORDER BY position LIMIT 1')
    .get(batchId) as { json: string }
  return JSON.parse(row.json)
}

describe('Batch storyboard — snapshot bối cảnh không đổi khi người dùng sửa sau đó', () => {
  it('chốt ảnh bối cảnh + revision vào item và giữ nguyên dù bối cảnh bị sửa', async () => {
    const seed = await seedSession({
      locations: [location()],
      frames: [frame({ id: 'frame-1', locationId: 'loc-1' }), frame({ id: 'frame-2', title: 'Frame 2', locationId: 'loc-1' })],
      cast: [member('cast-an', 'An')],
    })

    const created = createImageBatch(
      { db: ctx.db, env: ctx.env, mediaStore: ctx.mediaStore, worker: ctx.worker },
      { userId: seed.userId, sessionId: seed.sessionId, imageModelId: seed.imageModelId, frames: (JSON.parse((ctx.db.prepare('SELECT timeline_json AS j FROM plan_sessions WHERE id = ?').get(seed.sessionId) as { j: string }).j) as Timeline).frames, cast: seededCast(seed), regenerateAll: true },
    )

    const snapshot = readSnapshot(created.id)
    expect(snapshot.sourceUploadIds[0]).toBe(seed.locationUploadId)
    expect(snapshot.sourceRoles[0]).toEqual({ uploadId: seed.locationUploadId, role: 'location', id: 'loc-1' })
    expect(snapshot.locationRevision).toBe(1)

    // Người dùng sửa bối cảnh sau khi batch đã chốt snapshot.
    ctx.db
      .prepare('UPDATE plan_sessions SET locations_json = ? WHERE id = ?')
      .run(JSON.stringify([location({ revision: 7, description: 'Đổi mô tả' })]), seed.sessionId)

    const afterEdit = readSnapshot(created.id)
    expect(afterEdit.locationRevision).toBe(1)
    expect(afterEdit.prompt).not.toContain('Đổi mô tả')
    expect(afterEdit.sourceUploadIds[0]).toBe(seed.locationUploadId)
  })

  it('không xếp hàng khi bối cảnh thiếu ảnh tham chiếu: lỗi trước khi tạo batch', async () => {
    const seed = await seedSession({
      locations: [location({ reference: null })],
      frames: [frame({ id: 'frame-1', locationId: 'loc-1' })],
      cast: [member('cast-an', 'An')],
    })
    const timeline = JSON.parse((ctx.db.prepare('SELECT timeline_json AS j FROM plan_sessions WHERE id = ?').get(seed.sessionId) as { j: string }).j) as Timeline

    expect(() =>
      createImageBatch(
        { db: ctx.db, env: ctx.env, mediaStore: ctx.mediaStore, worker: ctx.worker },
        { userId: seed.userId, sessionId: seed.sessionId, imageModelId: seed.imageModelId, frames: timeline.frames, cast: [member('cast-an', 'An')], regenerateAll: true },
      ),
    ).toThrowError(/chưa có ảnh tham chiếu/i)

    expect(
      ctx.db.prepare('SELECT COUNT(*) AS total FROM plan_image_batches WHERE session_id = ?').get(seed.sessionId),
    ).toEqual({ total: 0 })
  })

  it('gắn ảnh xong ghi revision đã dùng và đánh dấu stale khi bối cảnh đổi revision', async () => {
    const seed = await seedSession({
      locations: [location()],
      frames: [frame({ id: 'frame-1', locationId: 'loc-1' })],
      cast: [member('cast-an', 'An')],
    })
    const timeline = JSON.parse((ctx.db.prepare('SELECT timeline_json AS j FROM plan_sessions WHERE id = ?').get(seed.sessionId) as { j: string }).j) as Timeline

    const batch = createImageBatch(
      { db: ctx.db, env: ctx.env, mediaStore: ctx.mediaStore, worker: ctx.worker },
      { userId: seed.userId, sessionId: seed.sessionId, imageModelId: seed.imageModelId, frames: timeline.frames, cast: seededCast(seed), regenerateAll: true },
    )

    // Bối cảnh tăng revision trong lúc batch đang chạy.
    ctx.db
      .prepare('UPDATE plan_sessions SET locations_json = ? WHERE id = ?')
      .run(JSON.stringify([location({ revision: 3 })]), seed.sessionId)

    for (let step = 0; step < 40; step += 1) {
      const running = ctx.db
        .prepare("SELECT generation_id FROM plan_image_batch_items WHERE batch_id = ? AND status = 'running'")
        .all(batch.id) as Array<{ generation_id: string | null }>
      for (const row of running) if (row.generation_id) await waitForGeneration(ctx, row.generation_id)
      const next = advanceImageBatch({ db: ctx.db, env: ctx.env, mediaStore: ctx.mediaStore, worker: ctx.worker }, seed.userId, seed.sessionId, batch.id)
      if (next.status !== 'running') break
    }

    const stored = JSON.parse(
      (ctx.db.prepare('SELECT timeline_json AS j FROM plan_sessions WHERE id = ?').get(seed.sessionId) as { j: string }).j,
    ) as Timeline
    const saved = stored.frames[0]!
    expect(saved.background?.uploadId).toBeTruthy()
    expect(saved.backgroundLocationRevision).toBe(1)
    expect(saved.backgroundStale).toBe(true)
  })
})

describe('Chốt kế hoạch — sao chép bối cảnh và giữ ảnh storyboard riêng', () => {
  it('tạo project_locations, gắn scenes.location_id và không ghi đè ảnh nền của frame', async () => {
    const seed = await seedSession({
      locations: [location()],
      frames: [frame({ id: 'frame-1', locationId: 'loc-1', background: { uploadId: 'frame-bg-1' } })],
      cast: [member('cast-an', 'An')],
    })
    // Ảnh storyboard của frame là upload riêng, không phải ảnh bối cảnh.
    const frameBg = ctx.mediaStore.saveUpload({
      userId: seed.userId,
      uploadId: 'frame-bg-1',
      bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
      maxBytes: ctx.env.MAX_REFERENCE_BYTES,
    })
    ctx.db
      .prepare('INSERT INTO uploads (id, user_id, relative_path, mime_type, byte_size, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('frame-bg-1', seed.userId, frameBg.relativePath, frameBg.mimeType, frameBg.byteSize, Date.now())
    ctx.db
      .prepare('INSERT INTO characters (id, user_id, project_id, name, appearance, voice_json, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)')
      .run('char-an', seed.userId, 'An', 'áo xanh', '{}', Date.now(), Date.now())

    const session = ctx.db.prepare('SELECT * FROM plan_sessions WHERE id = ?').get(seed.sessionId) as unknown as PlanSessionRow
    const timeline = parseTimelineJson(session.timeline_json)
    const cast = seededCast(seed)

    const result = applyPlan({
      db: ctx.db,
      env: ctx.env,
      userId: seed.userId,
      session,
      timeline,
      cast,
      apply: {},
      mediaStore: ctx.mediaStore,
    })

    const locations = ctx.db
      .prepare('SELECT * FROM project_locations WHERE project_id = ?')
      .all(result.project.id) as Array<{ id: string; name: string; revision: number; reference_upload_id: string | null }>
    expect(locations).toHaveLength(1)
    expect(locations[0]!.name).toBe('Sân ga')
    expect(locations[0]!.revision).toBe(1)
    expect(locations[0]!.reference_upload_id).toBeTruthy()
    // Ảnh bối cảnh được sao chép thành upload riêng, không trỏ thẳng vào upload của phiên.
    expect(locations[0]!.reference_upload_id).not.toBe(seed.locationUploadId)

    const scenes = ctx.db
      .prepare('SELECT id, location_id, background_upload_id FROM scenes WHERE project_id = ?')
      .all(result.project.id) as Array<{ id: string; location_id: string | null; background_upload_id: string | null }>
    expect(scenes).toHaveLength(1)
    expect(scenes[0]!.location_id).toBe(locations[0]!.id)
    // Ảnh storyboard của frame vẫn nằm ở cột riêng, không bị ảnh bối cảnh thay thế.
    expect(scenes[0]!.background_upload_id).toBeTruthy()
    expect(scenes[0]!.background_upload_id).not.toBe(locations[0]!.reference_upload_id)

    expect(result.scenes[0]!.locationId).toBe(locations[0]!.id)
  })
})

describe('Tạo ảnh trong Studio với bối cảnh chỉ định', () => {
  it('gửi ảnh bối cảnh trước ảnh nguồn và ghi bối cảnh vào prompt snapshot', async () => {
    const seed = await seedSession({
      locations: [location()],
      frames: [frame({ id: 'frame-1', locationId: null })],
      cast: seededCast({ portraitUploadId: 'unused' }),
    })
    const modelPk = seed.imageModelId
    const projectId = randomUUID()
    const locationId = randomUUID()
    const now = Date.now()
    ctx.db
      .prepare('INSERT INTO projects (id, user_id, name, description, style, language, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)')
      .run(projectId, seed.userId, 'Dự án bối cảnh', '', '', 'vi', now, now)
    // Ảnh bối cảnh được sao chép như dữ liệu dự án thật.
    const reference = ctx.mediaStore.saveUpload({
      userId: seed.userId,
      uploadId: randomUUID(),
      bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
      maxBytes: ctx.env.MAX_REFERENCE_BYTES,
    })
    const referenceUploadId = randomUUID()
    ctx.db
      .prepare('INSERT INTO uploads (id, user_id, relative_path, mime_type, byte_size, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(referenceUploadId, seed.userId, reference.relativePath, reference.mimeType, reference.byteSize, now)
    ctx.db
      .prepare(`INSERT INTO project_locations (id, project_id, name, stage, description, continuity_notes, image_prompt, reference_upload_id, revision, created_at, updated_at)
        VALUES (?, ?, 'Sân ga', 'Sáng', 'Mái sắt', 'Giữ bố cục', 'empty platform', ?, 4, ?, ?)`)
      .run(locationId, projectId, referenceUploadId, now, now)

    // Ảnh nguồn do người dùng chọn, phải đứng SAU ảnh bối cảnh.
    const sourceSaved = ctx.mediaStore.saveUpload({
      userId: seed.userId,
      uploadId: randomUUID(),
      bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
      maxBytes: ctx.env.MAX_REFERENCE_BYTES,
    })
    const sourceUploadId = randomUUID()
    ctx.db
      .prepare('INSERT INTO uploads (id, user_id, relative_path, mime_type, byte_size, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sourceUploadId, seed.userId, sourceSaved.relativePath, sourceSaved.mimeType, sourceSaved.byteSize, now)

    const created = await call(ctx, '/api/generations', {
      method: 'POST',
      body: {
        projectId,
        locationId,
        modelId: modelPk,
        prompt: 'An bước vào sân ga',
        sourceUploadIds: [sourceUploadId],
      },
    })
    expect(created.status).toBe(202)
    const generation = created.body.generation as { id: string; sourceImageCount: number; effectivePrompt: string; promptSnapshot: { location?: { id: string; revision: number } } }
    expect(generation.sourceImageCount).toBe(2)
    expect(generation.effectivePrompt).toContain('Canonical location: Sân ga')
    expect(generation.effectivePrompt).toContain('revision 4')
    expect(generation.promptSnapshot.location?.id).toBe(locationId)
    expect(generation.promptSnapshot.location?.revision).toBe(4)

    // Ảnh bối cảnh đứng đầu danh sách ảnh nguồn đã lưu.
    const stored = JSON.parse(
      (ctx.db.prepare('SELECT source_images_json AS j FROM generations WHERE id = ?').get(generation.id) as { j: string }).j,
    ) as Array<{ path: string }>
    expect(stored).toHaveLength(2)
    expect(stored[0]!.path).toBe(reference.relativePath)
    expect(stored[1]!.path).toBe(sourceSaved.relativePath)
  })

  it('từ chối bối cảnh của dự án khác hoặc bối cảnh thiếu ảnh', async () => {
    const seed = await seedSession({ locations: [], frames: [frame()], cast: [member('cast-an', 'An')] })
    const now = Date.now()
    const projectId = randomUUID()
    ctx.db
      .prepare('INSERT INTO projects (id, user_id, name, description, style, language, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)')
      .run(projectId, seed.userId, 'Dự án khác', '', '', 'vi', now, now)
    const foreignLocationId = randomUUID()
    const otherProject = randomUUID()
    ctx.db
      .prepare('INSERT INTO projects (id, user_id, name, description, style, language, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)')
      .run(otherProject, seed.userId, 'Dự án bối cảnh', '', '', 'vi', now, now)
    ctx.db
      .prepare(`INSERT INTO project_locations (id, project_id, name, stage, description, continuity_notes, image_prompt, reference_upload_id, revision, created_at, updated_at)
        VALUES (?, ?, 'Sân ga', '', '', '', 'empty', NULL, 1, ?, ?)`)
      .run(foreignLocationId, otherProject, now, now)

    const wrongProject = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { projectId, locationId: foreignLocationId, modelId: seed.imageModelId, prompt: 'x' },
    })
    expect(wrongProject.status).toBe(400)

    const missingReference = await call(ctx, '/api/generations', {
      method: 'POST',
      body: { projectId: otherProject, locationId: foreignLocationId, modelId: seed.imageModelId, prompt: 'x' },
    })
    expect(missingReference.status).toBe(400)
    expect(missingReference.body.error.messageKey).toBe('locations.reference_missing')
  })
})

function parseTimelineJson(json: string | null): Timeline {
  const parsed = JSON.parse(json ?? '{"frames":[]}') as Timeline
  return parsed
}

describe('parseLocations', () => {
  it('đọc đúng dữ liệu và bỏ mục hỏng', () => {
    const parsed = parseLocations(JSON.stringify([location(), { id: '' }, null, { id: 'x' }]))
    expect(parsed.map((item) => item.id)).toEqual(['loc-1', 'x'])
    expect(parsed[0]!.reference).toEqual({ uploadId: LOCATION_UPLOAD })
  })
})
