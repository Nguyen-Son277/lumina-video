import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'
import {
  durationRange,
  normalizeIdeas,
  normalizePlan,
  MAX_PLAN_CHARACTERS,
  MAX_PLAN_SCENES,
  type LibraryCharacter,
  type VideoModel,
} from '../../server/planner/prompts'

let ctx: TestContext
beforeAll(async () => {
  ctx = await startTestServer()
})
afterAll(async () => {
  if (ctx) await ctx.close()
})

/** Tạo kết nối LLM để Trợ lý AI có credential dùng. */
async function seedLlm(target: TestContext) {
  const created = await call(target, '/api/llm', {
    method: 'POST',
    body: { baseUrl: 'https://llm.mock.test/v1', modelId: 'mock-chat-model', apiKey: 'sk-llm-planner1' },
  })
  expect(created.status).toBe(201)
  return created.body.connection.id as string
}

/** Phiên planner đã có sẵn kết nối LLM. */
async function seedSession(target: TestContext) {
  const connectionId = await seedLlm(target)
  const created = await call(target, '/api/plans', {
    method: 'POST',
    body: { kind: 'planner', connectionId },
  })
  expect(created.status).toBe(201)
  return { connectionId, sessionId: created.body.session.id as string }
}

describe('Khoảng thời lượng suy từ cấu hình model', () => {
  it('không có model nào thì dùng khoảng mặc định', () => {
    expect(durationRange([])).toEqual({ lower: 4, upper: 12, conflict: false })
  })

  it('lấy giao của mọi ràng buộc để hợp lệ với mọi model', () => {
    const models: VideoModel[] = [
      { id: 'a', name: 'A', minSeconds: 2, maxSeconds: 8 },
      { id: 'b', name: 'B', minSeconds: 6, maxSeconds: 15 },
    ]
    expect(durationRange(models)).toEqual({ lower: 6, upper: 8, conflict: false })
  })

  it('báo mâu thuẫn khi giao rỗng và quay về mặc định', () => {
    const models: VideoModel[] = [
      { id: 'a', name: 'A', minSeconds: 10, maxSeconds: 20 },
      { id: 'b', name: 'B', minSeconds: 2, maxSeconds: 5 },
    ]
    expect(durationRange(models)).toEqual({ lower: 4, upper: 12, conflict: true })
  })
})

describe('Chuẩn hoá đề xuất ý kiến', () => {
  it('cắt độ dài, bỏ mục rỗng và khử trùng', () => {
    const ideas = normalizeIdeas(
      {
        logline: 'x'.repeat(900),
        keyPoints: ['a', 'A', '  ', 'b'],
        characters: ['An', 'an', 'Bình'],
        risks: 'không phải mảng',
      },
      { language: 'vi', lower: 4, upper: 12 },
    )

    expect(ideas.logline).toHaveLength(500)
    expect(ideas.keyPoints).toEqual(['a', 'b'])
    expect(ideas.characters).toEqual(['An', 'Bình'])
    expect(ideas.risks).toEqual([])
    // Thiếu aspectRatio thì dùng mặc định.
    expect(ideas.aspectRatio).toBe('16:9')
  })

  it('chấp nhận số dạng chuỗi và chặn giá trị vô lý', () => {
    expect(
      normalizeIdeas({ durationSeconds: '75' }, { language: 'vi', lower: 4, upper: 12 }).durationSeconds,
    ).toBe(75)
    expect(
      normalizeIdeas({ durationSeconds: -5 }, { language: 'vi', lower: 6, upper: 10 }).durationSeconds,
    ).toBe(8)
  })
})

describe('Chuẩn hoá kế hoạch', () => {
  const library: LibraryCharacter[] = [
    { id: 'char-an', name: 'An', appearance: 'Nam, tóc ngắn' },
  ]
  const base = { language: 'vi', lower: 6, upper: 8, libraryCharacters: library }

  it('kẹp thời lượng mỗi cảnh vào khoảng hợp lệ', () => {
    const plan = normalizePlan(
      {
        title: 'Test',
        characters: [{ name: 'An', appearance: 'x' }],
        scenes: [
          { title: 'S1', action: 'a', speaker: 'An', characters: ['An'], durationSeconds: 999 },
          { title: 'S2', action: 'b', speaker: 'An', characters: ['An'], durationSeconds: 1 },
        ],
      },
      base,
    )
    expect(plan.scenes[0]!.durationSeconds).toBe(8)
    expect(plan.scenes[1]!.durationSeconds).toBe(6)
    expect(plan.totalSeconds).toBe(14)
  })

  it('dùng lại nhân vật thư viện và giữ nguyên tên đã lưu', () => {
    const plan = normalizePlan(
      {
        characters: [{ name: 'Tên khác', appearance: '', reuseCharacterId: 'char-an' }],
        scenes: [{ title: 'S', action: 'a', speaker: 'An', characters: ['An'] }],
      },
      base,
    )
    expect(plan.characters[0]!.reuseCharacterId).toBe('char-an')
    expect(plan.characters[0]!.name).toBe('An')
    expect(plan.characters[0]!.appearance).toBe('Nam, tóc ngắn')
  })

  it('bỏ reuseCharacterId không tồn tại và cảnh báo', () => {
    const plan = normalizePlan(
      {
        characters: [{ name: 'An', reuseCharacterId: 'khong-ton-tai' }],
        scenes: [{ title: 'S', action: 'a', speaker: 'An', characters: ['An'] }],
      },
      base,
    )
    expect(plan.characters[0]!.reuseCharacterId).toBeNull()
    expect(plan.warnings.join(' ')).toContain('khong-ton-tai')
  })

  it('loại nhân vật lạ khỏi cảnh và bỏ lời thoại thiếu người nói', () => {
    const plan = normalizePlan(
      {
        characters: [{ name: 'An' }],
        scenes: [
          {
            title: 'S',
            action: 'a',
            speaker: 'Người lạ',
            characters: ['An', 'Người lạ'],
            dialogue: 'Xin chào',
          },
        ],
      },
      base,
    )
    expect(plan.scenes[0]!.characters).toEqual(['An'])
    expect(plan.scenes[0]!.speaker).toBe('')
    // Có thoại mà không có người nói hợp lệ thì bỏ thoại để không sinh sai.
    expect(plan.scenes[0]!.dialogue).toBe('')
    expect(plan.warnings.join(' ')).toContain('Người lạ')
  })

  it('tự thêm người nói vào danh sách nhân vật của cảnh', () => {
    const plan = normalizePlan(
      {
        characters: [{ name: 'An' }, { name: 'Bình' }],
        scenes: [{ title: 'S', action: 'a', speaker: 'Bình', characters: ['An'], dialogue: 'Chào' }],
      },
      base,
    )
    expect(plan.scenes[0]!.characters).toEqual(['Bình', 'An'])
    expect(plan.scenes[0]!.dialogue).toBe('Chào')
  })

  it('khử trùng tên nhân vật và giới hạn số lượng', () => {
    const plan = normalizePlan(
      {
        characters: [
          { name: 'An' },
          { name: 'an' },
          ...Array.from({ length: 20 }, (_, i) => ({ name: `N${i}` })),
        ],
        scenes: [],
      },
      base,
    )
    expect(plan.characters).toHaveLength(MAX_PLAN_CHARACTERS)
    expect(plan.characters.filter((c) => c.name.toLowerCase() === 'an')).toHaveLength(1)
  })

  it('giới hạn số cảnh và bỏ cảnh rỗng', () => {
    const plan = normalizePlan(
      {
        characters: [{ name: 'An' }],
        scenes: [
          { title: '', action: '' },
          ...Array.from({ length: 40 }, (_, i) => ({ title: `S${i}`, action: 'a' })),
        ],
      },
      base,
    )
    expect(plan.scenes).toHaveLength(MAX_PLAN_SCENES)
    expect(plan.scenes[0]!.title).toBe('S0')
  })

  it('điền đủ 7 trường giọng và mặc định ngôn ngữ', () => {
    const plan = normalizePlan(
      { characters: [{ name: 'An', voice: { accent: 'Miền Nam' } }], scenes: [] },
      base,
    )
    expect(plan.characters[0]!.voice.accent).toBe('Miền Nam')
    expect(plan.characters[0]!.voice.language).toBe('vi')
  })
})

describe('Vòng đời Trợ lý AI', () => {
  it('chat, tổng hợp ý kiến, duyệt, rồi sinh kế hoạch', async () => {
    await registerUser(ctx)
    const { sessionId } = await seedSession(ctx)

    const sent = await call(ctx, `/api/plans/${sessionId}/messages`, {
      method: 'POST',
      body: { content: 'Làm video ngắn về một chuyến đi của hai người bạn.' },
    })
    expect(sent.status).toBe(200)
    expect(sent.body.reply.role).toBe('assistant')
    expect(sent.body.reply.content.length).toBeGreaterThan(0)
    expect(sent.body.messages).toHaveLength(2)

    const ideas = await call(ctx, `/api/plans/${sessionId}/ideas`, { method: 'POST' })
    expect(ideas.status).toBe(200)
    expect(ideas.body.session.status).toBe('ideas_ready')
    expect(ideas.body.ideas.logline).toBeTruthy()
    expect(ideas.body.ideas.characters.length).toBeGreaterThan(0)

    const approved = await call(ctx, `/api/plans/${sessionId}/ideas/approve`, { method: 'POST' })
    expect(approved.status).toBe(200)
    expect(approved.body.session.status).toBe('ideas_approved')

    const plan = await call(ctx, `/api/plans/${sessionId}/plan`, { method: 'POST' })
    expect(plan.status).toBe(200)
    expect(plan.body.session.status).toBe('plan_ready')
    expect(plan.body.plan.scenes).toHaveLength(2)
    expect(plan.body.plan.characters).toHaveLength(2)
    expect(plan.body.plan.totalSeconds).toBeGreaterThan(0)
    // Mỗi cảnh chỉ một người nói chính.
    for (const scene of plan.body.plan.scenes) {
      expect(scene.characters.length).toBeGreaterThan(0)
    }
  })

  it('ép cổng duyệt ở server', async () => {
    await registerUser(ctx)
    const { sessionId } = await seedSession(ctx)

    // Chưa có ý kiến thì không duyệt được.
    expect(
      (await call(ctx, `/api/plans/${sessionId}/ideas/approve`, { method: 'POST' })).status,
    ).toBe(400)

    // Chưa trao đổi thì không tổng hợp được.
    expect((await call(ctx, `/api/plans/${sessionId}/ideas`, { method: 'POST' })).status).toBe(400)

    await call(ctx, `/api/plans/${sessionId}/messages`, {
      method: 'POST',
      body: { content: 'Một video về biển.' },
    })

    // Có ý kiến nhưng CHƯA duyệt thì không sinh kế hoạch.
    await call(ctx, `/api/plans/${sessionId}/ideas`, { method: 'POST' })
    const blocked = await call(ctx, `/api/plans/${sessionId}/plan`, { method: 'POST' })
    expect(blocked.status).toBe(400)
    expect(blocked.body.error.message).toContain('duyệt')
  })

  it('sinh lại ý kiến thì xoá kế hoạch cũ', async () => {
    await registerUser(ctx)
    const { sessionId } = await seedSession(ctx)
    await call(ctx, `/api/plans/${sessionId}/messages`, {
      method: 'POST',
      body: { content: 'Video về núi.' },
    })
    await call(ctx, `/api/plans/${sessionId}/ideas`, { method: 'POST' })
    await call(ctx, `/api/plans/${sessionId}/ideas/approve`, { method: 'POST' })
    await call(ctx, `/api/plans/${sessionId}/plan`, { method: 'POST' })

    const again = await call(ctx, `/api/plans/${sessionId}/ideas`, { method: 'POST' })
    expect(again.status).toBe(200)
    expect(again.body.session.status).toBe('ideas_ready')
    expect(again.body.session.plan).toBeNull()
  })

  it('lưu và đọc lại hội thoại', async () => {
    await registerUser(ctx)
    const { sessionId } = await seedSession(ctx)
    await call(ctx, `/api/plans/${sessionId}/messages`, {
      method: 'POST',
      body: { content: 'Nội dung thứ nhất' },
    })

    const loaded = await call(ctx, `/api/plans/${sessionId}`)
    expect(loaded.status).toBe(200)
    expect(loaded.body.messages).toHaveLength(2)
    expect(loaded.body.messages[0].content).toBe('Nội dung thứ nhất')

    const listed = await call(ctx, '/api/plans')
    expect(listed.status).toBe(200)
    expect(listed.body.sessions.some((s: { id: string }) => s.id === sessionId)).toBe(true)
  })

  it('kiểm tra dữ liệu vào, xác thực và quyền sở hữu', async () => {
    await registerUser(ctx)
    const { sessionId, connectionId } = await seedSession(ctx)

    // Thiếu nội dung.
    expect(
      (await call(ctx, `/api/plans/${sessionId}/messages`, { method: 'POST', body: {} })).status,
    ).toBe(400)
    // Nội dung quá dài.
    expect(
      (
        await call(ctx, `/api/plans/${sessionId}/messages`, {
          method: 'POST',
          body: { content: 'x'.repeat(8001) },
        })
      ).status,
    ).toBe(400)

    // Chưa đăng nhập.
    expect((await fetch(`${ctx.baseUrl}/api/plans`)).status).toBe(401)

    // Phiên của tài khoản khác.
    await registerUser(ctx)
    expect((await call(ctx, `/api/plans/${sessionId}`)).status).toBe(404)
    expect(
      (
        await call(ctx, `/api/plans/${sessionId}/messages`, {
          method: 'POST',
          body: { content: 'x' },
        })
      ).status,
    ).toBe(404)

    // Kết nối LLM của tài khoản khác không gắn được vào phiên.
    expect(
      (
        await call(ctx, '/api/plans', {
          method: 'POST',
          body: { kind: 'planner', connectionId },
        })
      ).status,
    ).toBe(404)
  })

  it('phiên copilot bắt buộc gắn dự án thuộc sở hữu', async () => {
    await registerUser(ctx)
    await seedLlm(ctx)

    expect(
      (await call(ctx, '/api/plans', { method: 'POST', body: { kind: 'copilot' } })).status,
    ).toBe(400)

    const project = await call(ctx, '/api/projects', {
      method: 'POST',
      body: { name: 'Dự án copilot' },
    })
    const projectId = project.body.project.id as string

    const created = await call(ctx, '/api/plans', {
      method: 'POST',
      body: { kind: 'copilot', projectId },
    })
    expect(created.status).toBe(201)
    expect(created.body.session.kind).toBe('copilot')
    expect(created.body.session.projectId).toBe(projectId)

    // Tài khoản khác không tạo được phiên trên dự án này.
    await registerUser(ctx)
    await seedLlm(ctx)
    expect(
      (
        await call(ctx, '/api/plans', {
          method: 'POST',
          body: { kind: 'copilot', projectId },
        })
      ).status,
    ).toBe(404)
  })

  it('từ chối khi chưa có kết nối LLM', async () => {
    await registerUser(ctx)
    const created = await call(ctx, '/api/plans', { method: 'POST', body: { kind: 'planner' } })
    const sessionId = created.body.session.id as string

    const result = await call(ctx, `/api/plans/${sessionId}/messages`, {
      method: 'POST',
      body: { content: 'Xin chào' },
    })
    expect(result.status).toBe(400)
    expect(result.body.error.message).toContain('kết nối LLM')
  })
})

/** Đưa một phiên planner tới trạng thái plan_ready. */
async function planReadySession(target: TestContext) {
  const { sessionId } = await seedSession(target)
  await call(target, `/api/plans/${sessionId}/messages`, {
    method: 'POST',
    body: { content: 'Làm video ngắn về một chuyến đi của hai người bạn.' },
  })
  await call(target, `/api/plans/${sessionId}/ideas`, { method: 'POST' })
  await call(target, `/api/plans/${sessionId}/ideas/approve`, { method: 'POST' })
  const result = await call(target, `/api/plans/${sessionId}/plan`, { method: 'POST' })
  expect(result.status).toBe(200)
  return { sessionId, plan: result.body.plan as { title: string; scenes: unknown[] } }
}

describe('Chốt kế hoạch thành dự án', () => {
  it('tạo dự án mới với nhân vật, cảnh và liên kết nhân vật; cảnh CHƯA duyệt', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'video')
    const { sessionId, plan } = await planReadySession(ctx)

    const applied = await call(ctx, `/api/plans/${sessionId}/apply`, {
      method: 'POST',
      body: { modelId: modelPk, autoGenerate: true },
    })

    expect(applied.status).toBe(201)
    expect(applied.body.project.name).toBe(plan.title)
    expect(applied.body.scenes).toHaveLength(2)
    expect(applied.body.pending).toBe(2)

    for (const scene of applied.body.scenes) {
      const row = ctx.db
        .prepare('SELECT * FROM scenes WHERE id = ?')
        .get(scene.id) as Record<string, unknown>

      // Chưa duyệt nên chưa tốn tiền; nhưng đã sẵn sàng tạo khi được duyệt.
      expect(row.approved).toBe(0)
      expect(row.auto_generate).toBe(1)
      expect(row.model_id).toBe(modelPk)
      expect(String(row.background ?? '')).not.toBe('')

      // Thời lượng timeline nằm trong params để tác vụ dùng đúng con số đã duyệt.
      const params = JSON.parse(String(row.params_json)) as Record<string, unknown>
      expect(Number(params.seconds)).toBeGreaterThan(0)

      const cast = ctx.db
        .prepare('SELECT character_id FROM scene_characters WHERE scene_id = ? ORDER BY position')
        .all(scene.id) as Array<{ character_id: string }>
      expect(cast.length).toBeGreaterThan(0)
      // Người nói chính luôn ở vị trí 0.
      expect(cast[0]!.character_id).toBe(row.character_id)
    }

    const session = await call(ctx, `/api/plans/${sessionId}`)
    expect(session.body.session.status).toBe('applied')
    expect(session.body.session.projectId).toBe(applied.body.project.id)
  })

  it('chặn áp dụng khi kế hoạch chưa sẵn sàng', async () => {
    await registerUser(ctx)
    const { sessionId } = await seedSession(ctx)

    const blocked = await call(ctx, `/api/plans/${sessionId}/apply`, { method: 'POST', body: {} })
    expect(blocked.status).toBe(400)
  })

  it('chốt hai lần không tạo dự án trùng', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'video')
    const { sessionId } = await planReadySession(ctx)

    const first = await call(ctx, `/api/plans/${sessionId}/apply`, {
      method: 'POST',
      body: { modelId: modelPk },
    })
    const second = await call(ctx, `/api/plans/${sessionId}/apply`, {
      method: 'POST',
      body: { modelId: modelPk },
    })

    expect(second.status).toBe(200)
    expect(second.body.alreadyApplied).toBe(true)
    expect(second.body.project.id).toBe(first.body.project.id)

    const projects = await call(ctx, '/api/projects')
    const sameName = (projects.body.projects as Array<{ name: string }>).filter(
      (project) => project.name === first.body.project.name,
    )
    expect(sameName).toHaveLength(1)
  })

  it('từ chối model không phải model video', async () => {
    await registerUser(ctx)
    const { modelPk: imageModel } = await seedProviderAndModel(ctx, 'image')
    const { sessionId } = await planReadySession(ctx)

    const bad = await call(ctx, `/api/plans/${sessionId}/apply`, {
      method: 'POST',
      body: { modelId: imageModel },
    })
    expect(bad.status).toBe(400)
    expect(bad.body.error.message).toContain('model video')
  })

  it('không tạo trùng nhân vật đã có cùng tên trong thư viện', async () => {
    const { userId } = await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'video')

    // "An" đã có trong thư viện trước khi áp dụng kế hoạch.
    const existing = await call(ctx, '/api/shared-characters', {
      method: 'POST',
      body: { name: 'An', appearance: 'Đã có sẵn', voice: { language: 'vi' } },
    })
    expect(existing.status).toBe(201)

    const { sessionId } = await planReadySession(ctx)
    const applied = await call(ctx, `/api/plans/${sessionId}/apply`, {
      method: 'POST',
      body: { modelId: modelPk },
    })
    expect(applied.status).toBe(201)

    const counted = ctx.db
      .prepare('SELECT COUNT(*) AS total FROM characters WHERE user_id = ? AND LOWER(name) = ?')
      .get(userId, 'an') as { total: number }
    expect(Number(counted.total)).toBe(1)

    const linked = (applied.body.characters as Array<{ id: string; name: string }>).find(
      (character) => character.name === 'An',
    )
    expect(linked?.id).toBe(existing.body.character.id)
  })

  it('phiên copilot vá vào dự án đang mở, không tạo dự án mới', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedProviderAndModel(ctx, 'video')
    await seedLlm(ctx)

    const project = await call(ctx, '/api/projects', {
      method: 'POST',
      body: { name: 'Dự án copilot' },
    })
    const projectId = project.body.project.id as string

    const created = await call(ctx, '/api/plans', {
      method: 'POST',
      body: { kind: 'copilot', projectId },
    })
    const sessionId = created.body.session.id as string

    await call(ctx, `/api/plans/${sessionId}/messages`, {
      method: 'POST',
      body: { content: 'Thêm cảnh cho dự án này.' },
    })
    await call(ctx, `/api/plans/${sessionId}/ideas`, { method: 'POST' })
    await call(ctx, `/api/plans/${sessionId}/ideas/approve`, { method: 'POST' })
    const planned = await call(ctx, `/api/plans/${sessionId}/plan`, { method: 'POST' })
    expect(planned.status).toBe(200)

    const before = await call(ctx, '/api/projects')
    const applied = await call(ctx, `/api/plans/${sessionId}/apply`, {
      method: 'POST',
      body: { modelId: modelPk },
    })

    expect(applied.status).toBe(201)
    // Vá vào đúng dự án cũ, không sinh dự án mới.
    expect(applied.body.project.id).toBe(projectId)
    expect(applied.body.scenes).toHaveLength(2)

    const after = await call(ctx, '/api/projects')
    expect((after.body.projects as unknown[]).length).toBe(
      (before.body.projects as unknown[]).length,
    )
  })
})
