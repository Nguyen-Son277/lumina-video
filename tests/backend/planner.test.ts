import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  registerUser,
  seedProviderAndModel,
  startTestServer,
  waitForGeneration,
  type TestContext,
} from './helpers'
import {
  buildArtifactSystem,
  buildArtifactRequest,
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

/** Tạo provider + model LLM & Chat để tính năng văn bản có credential dùng. */
async function seedLlm(target: TestContext, baseUrl = 'https://llm.mock.test/v1') {
  const provider = await call(target, '/api/providers', {
    method: 'POST',
    body: { name: 'LLM provider', baseUrl, apiKey: 'sk-llm-abcd1234' },
  })
  expect(provider.status).toBe(201)
  const model = await call(target, '/api/models', {
    method: 'POST',
    body: { providerId: provider.body.provider.id, modelId: 'mock-chat-model', kind: 'llm' },
  })
  expect(model.status).toBe(201)
  return model.body.model.id as string
}

/** Phiên đã chọn đủ model chat/ảnh/video, sẵn sàng dùng các tab. */
async function setupSession(target: TestContext) {
  const chatModelId = await seedLlm(target)
  const { modelPk: imageModelId } = await seedProviderAndModel(target, 'image')
  const { modelPk: videoModelId } = await seedProviderAndModel(target, 'video')

  const created = await call(target, '/api/plans', { method: 'POST', body: { kind: 'planner' } })
  expect(created.status).toBe(201)
  const sessionId = created.body.session.id as string
  expect(created.body.session.status).toBe('setup')

  const setup = await call(target, `/api/plans/${sessionId}/setup`, {
    method: 'PATCH',
    body: { chatModelId, imageModelId, videoModelId },
  })
  expect(setup.status).toBe(200)
  expect(setup.body.session.status).toBe('scripting')

  return { sessionId, chatModelId, imageModelId, videoModelId }
}

/** Phiên đã có kịch bản nháp + nhân vật + timeline, sẵn sàng chốt vào Studio. */
async function timelineReadySession(target: TestContext) {
  const session = await setupSession(target)
  const { sessionId, videoModelId } = session

  await call(target, `/api/plans/${sessionId}/messages`, {
    method: 'POST',
    body: { content: 'Làm video ngắn về một chuyến đi của hai người bạn.', target: 'script' },
  })
  const script = await call(target, `/api/plans/${sessionId}/script`, { method: 'POST' })
  expect(script.status).toBe(200)
  expect(script.body.session.script.scenes.length).toBeGreaterThan(0)

  const cast = await call(target, `/api/plans/${sessionId}/cast`, { method: 'POST' })
  expect(cast.status).toBe(200)
  expect(cast.body.session.cast.length).toBeGreaterThan(0)

  const timeline = await call(target, `/api/plans/${sessionId}/timeline`, { method: 'POST' })
  expect(timeline.status).toBe(200)
  expect(timeline.body.session.timeline.frames.length).toBeGreaterThan(0)

  return { ...session, videoModelId }
}


describe('Hợp đồng prompt artifact', () => {
  it('kịch bản yêu cầu characters cấp gốc và gửi trạng thái đã sửa tay', () => {
    const state = { script: { text: 'Bản nháp đã sửa tay', scenes: [] }, cast: [], timeline: null }
    const prompt = buildArtifactSystem('script', {
      project: null, language: 'vi', libraryCharacters: [], videoModels: [], existingSceneTitles: [],
    }, state)
    expect(prompt).toContain('"characters":[{"name"')
    expect(prompt).toContain('"scenes[].characters"')
    expect(prompt).toContain('"dialogue" phải chứa câu nói thực tế')
    expect(prompt).toContain(JSON.stringify(state))
    expect(buildArtifactRequest('script').content).toContain('characters cấp gốc')
  })
})

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

  it('giữ cảnh không lời mà không tự bịa người nói', () => {
    const plan = normalizePlan({
      characters: [{ name: 'An' }],
      scenes: [{ title: 'Ngắm biển', action: 'An nhìn ra biển', characters: ['An'], dialogue: '', speaker: '' }],
    }, base)
    expect(plan.scenes[0]).toMatchObject({ characters: ['An'], dialogue: '', speaker: '' })
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


describe('Vòng đời Tạo kịch bản AI', () => {
  it('chat, viết kịch bản, ý tưởng nhân vật rồi lên timeline', async () => {
    await registerUser(ctx)
    const { sessionId } = await setupSession(ctx)

    // Chat trong tab kịch bản: AI trả lời và trả về artifact đã cập nhật.
    const sent = await call(ctx, `/api/plans/${sessionId}/messages`, {
      method: 'POST',
      body: { content: 'Làm video ngắn về một chuyến đi của hai người bạn.', target: 'script' },
    })
    expect(sent.status).toBe(200)
    expect(sent.body.messages).toHaveLength(2)
    expect(sent.body.reply.role).toBe('assistant')

    // Nút "viết kịch bản" sinh bản nháp đầy đủ (text + cảnh có cấu trúc).
    const script = await call(ctx, `/api/plans/${sessionId}/script`, { method: 'POST' })
    expect(script.status).toBe(200)
    expect(script.body.session.status).toBe('script_ready')
    expect(script.body.session.script.text.length).toBeGreaterThan(0)
    expect(script.body.session.script.scenes[0].context).toBeTruthy()
    expect(script.body.session.script.scenes[0].durationSeconds).toBeGreaterThan(0)
    expect(script.body.session.script.scenes[0]).toMatchObject({
      characters: ['An'], speaker: 'An', dialogue: 'Đi thôi, sắp muộn rồi!',
    })
    expect(script.body.session.script.scenes[1]).toMatchObject({
      characters: ['An', 'Bình'], speaker: 'Bình', dialogue: 'Cậu nhớ mang theo bản đồ chứ?',
    })
    const reloaded = await call(ctx, `/api/plans/${sessionId}`)
    expect(reloaded.body.session.script).toEqual(script.body.session.script)

    const cast = await call(ctx, `/api/plans/${sessionId}/cast`, { method: 'POST' })
    expect(cast.status).toBe(200)
    expect(cast.body.session.status).toBe('cast_ready')
    expect(cast.body.session.cast.map((member: { name: string }) => member.name)).toEqual(['An', 'Bình', 'Chi'])
    // Mặc định lưu vào thư viện dùng chung.
    expect(cast.body.session.cast[0].storage).toBe('library')

    const timeline = await call(ctx, `/api/plans/${sessionId}/timeline`, { method: 'POST' })
    expect(timeline.status).toBe(200)
    expect(timeline.body.session.status).toBe('timeline_ready')
    const frames = timeline.body.session.timeline.frames as Array<{
      title: string
      context: string
      backgroundPrompt: string
      durationSeconds: number
      characters: string[]
    }>
    expect(frames).toHaveLength(2)
    expect(frames[0]!.context).toBeTruthy()
    expect(frames[0]!.backgroundPrompt).toBeTruthy()
    expect(frames[0]!.characters.length).toBeGreaterThan(0)
    expect(frames[0]).toMatchObject({ speaker: 'An', dialogue: 'Đi thôi, sắp muộn rồi!' })
    expect(frames[1]).toMatchObject({ speaker: 'Bình', dialogue: 'Cậu nhớ mang theo bản đồ chứ?' })
  })

  it('lưu kịch bản / nhân vật / timeline do người dùng sửa tay', async () => {
    await registerUser(ctx)
    const { sessionId } = await setupSession(ctx)

    const savedScript = await call(ctx, `/api/plans/${sessionId}/script`, {
      method: 'PUT',
      body: {
        text: 'Kịch bản tôi tự viết',
        scenes: [
          {
            title: 'Cảnh biển',
            context: 'Bãi biển hoàng hôn',
            action: 'Sóng vỗ bờ',
            dialogue: '',
            speaker: '',
            characters: [],
            durationSeconds: 9,
            shotNotes: 'Toàn cảnh',
          },
        ],
      },
    })
    expect(savedScript.status).toBe(200)
    expect(savedScript.body.session.script.text).toBe('Kịch bản tôi tự viết')
    expect(savedScript.body.session.script.scenes).toHaveLength(1)
    // Tiêu đề phiên lấy từ dòng đầu của kịch bản khi chưa có tên.
    expect(savedScript.body.session.title).toBe('Kịch bản tôi tự viết')

    const cast = await call(ctx, `/api/plans/${sessionId}/cast`, { method: 'POST' })
    const members = cast.body.session.cast as Array<{ id: string; name: string; storage: string }>
    const savedCast = await call(ctx, `/api/plans/${sessionId}/cast`, {
      method: 'PUT',
      body: {
        cast: members.map((member, index) => ({
          ...member,
          storage: index === 0 ? 'project' : 'library',
        })),
      },
    })
    expect(savedCast.status).toBe(200)
    expect(savedCast.body.session.cast[0].storage).toBe('project')
    expect(savedCast.body.session.cast[1].storage).toBe('library')

    await call(ctx, `/api/plans/${sessionId}/timeline`, { method: 'POST' })
    const frames = (await call(ctx, `/api/plans/${sessionId}`)).body.session.timeline.frames as Array<{
      id: string
      title: string
      durationSeconds: number
      characters: string[]
      speaker: string
      context: string
    }>
    const savedTimeline = await call(ctx, `/api/plans/${sessionId}/timeline`, {
      method: 'PUT',
      body: {
        frames: frames.map((frame, index) =>
          index === 0 ? { ...frame, durationSeconds: 12, context: 'Bối cảnh đã sửa' } : frame,
        ),
      },
    })
    expect(savedTimeline.status).toBe(200)
    expect(savedTimeline.body.session.timeline.frames[0].durationSeconds).toBe(12)
    expect(savedTimeline.body.session.timeline.frames[0].context).toBe('Bối cảnh đã sửa')
  })

  it('agent tự chạy bước tiếp theo khi người dùng yêu cầu', async () => {
    await registerUser(ctx)
    const { sessionId } = await setupSession(ctx)

    // Viết kịch bản trước để có artifact thượng nguồn cho bước phụ.
    await call(ctx, `/api/plans/${sessionId}/script`, { method: 'POST' })

    const sent = await call(ctx, `/api/plans/${sessionId}/messages`, {
      method: 'POST',
      body: { content: 'Lên timeline cho tôi', target: 'script' },
    })
    expect(sent.status).toBe(200)
    expect(sent.body.ran).toBe('timeline')
    expect(sent.body.reply.content).toContain('Đã tự chạy bước')

    // Phiên đã có timeline do agent tự chạy.
    const fetched = await call(ctx, `/api/plans/${sessionId}`)
    expect(fetched.body.session.timeline.frames.length).toBeGreaterThan(0)
  })

  it('không tự chạy bước khi thiếu artifact thượng nguồn', async () => {
    await registerUser(ctx)
    const { sessionId } = await setupSession(ctx)
    // Chưa có kịch bản nháp (đang ở tab Nhân vật): chỉ trả lời, không tự chạy timeline.
    const sent = await call(ctx, `/api/plans/${sessionId}/messages`, {
      method: 'POST',
      body: { content: 'Lên timeline cho tôi', target: 'cast' },
    })
    expect(sent.status).toBe(200)
    expect(sent.body.ran ?? null).toBeNull()
  })

  it('bắt buộc chọn đúng model chat trước khi dùng tab', async () => {
    await registerUser(ctx)
    const { modelPk: imageModelId } = await seedProviderAndModel(ctx, 'image')
    const created = await call(ctx, '/api/plans', { method: 'POST', body: { kind: 'planner' } })
    const sessionId = created.body.session.id as string

    // Model ảnh không được dùng làm model chat.
    const wrongKind = await call(ctx, `/api/plans/${sessionId}/setup`, {
      method: 'PATCH',
      body: { chatModelId: imageModelId },
    })
    expect(wrongKind.status).toBe(404)

    // Chưa có model chat thì chưa viết được kịch bản.
    const blocked = await call(ctx, `/api/plans/${sessionId}/script`, { method: 'POST' })
    expect(blocked.status).toBe(400)
    expect(blocked.body.error.message).toContain('Chưa có model LLM & Chat')
  })

  it('kiểm tra dữ liệu vào, xác thực và quyền sở hữu', async () => {
    await registerUser(ctx)
    const { sessionId, chatModelId } = await setupSession(ctx)

    // Thiếu nội dung.
    expect(
      (
        await call(ctx, `/api/plans/${sessionId}/messages`, {
          method: 'POST',
          body: { content: '', target: 'script' },
        })
      ).status,
    ).toBe(400)
    // Nội dung quá dài.
    expect(
      (
        await call(ctx, `/api/plans/${sessionId}/messages`, {
          method: 'POST',
          body: { content: 'x'.repeat(8001), target: 'script' },
        })
      ).status,
    ).toBe(400)
    // Tab không hợp lệ.
    expect(
      (
        await call(ctx, `/api/plans/${sessionId}/messages`, {
          method: 'POST',
          body: { content: 'x', target: 'unknown' },
        })
      ).status,
    ).toBe(400)

    // Chưa đăng nhập.
    expect((await fetch(`${ctx.baseUrl}/api/plans`)).status).toBe(401)

    // Phiên của tài khoản khác.
    await registerUser(ctx)
    expect((await call(ctx, `/api/plans/${sessionId}`)).status).toBe(404)
    expect((await call(ctx, `/api/plans/${sessionId}/script`, { method: 'POST' })).status).toBe(404)
    // Model chat của tài khoản khác không gắn được vào phiên.
    expect(
      (
        await call(ctx, '/api/plans', {
          method: 'POST',
          body: { kind: 'planner', chatModelId },
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
  })

  it('sinh ảnh chân dung nhân vật và ảnh nền frame rồi gắn vào phiên', async () => {
    await registerUser(ctx)
    const { sessionId } = await timelineReadySession(ctx)

    const session = (await call(ctx, `/api/plans/${sessionId}`)).body.session
    const castId = session.cast[0].id as string
    const frameId = session.timeline.frames[0].id as string

    const portrait = await call(ctx, `/api/plans/${sessionId}/cast/${castId}/portrait`, {
      method: 'POST',
    })
    expect(portrait.status).toBe(202)
    const portraitDone = await waitForGeneration(ctx, portrait.body.generation.id)
    expect(portraitDone.status).toBe('succeeded')

    const attached = await call(ctx, `/api/plans/${sessionId}/cast/${castId}/portrait/attach`, {
      method: 'POST',
      body: { generationId: portrait.body.generation.id },
    })
    expect(attached.status).toBe(201)
    const portraitUploadId = attached.body.session.cast[0].portrait.uploadId as string
    expect(portraitUploadId).toBeTruthy()
    // Ảnh phục vụ qua endpoint có xác thực.
    expect((await call(ctx, `/api/uploads/${portraitUploadId}`)).status).toBe(200)

    const background = await call(ctx, `/api/plans/${sessionId}/timeline/${frameId}/background`, {
      method: 'POST',
    })
    expect(background.status).toBe(202)
    const backgroundDone = await waitForGeneration(ctx, background.body.generation.id)
    expect(backgroundDone.status).toBe('succeeded')

    const withBackground = await call(
      ctx,
      `/api/plans/${sessionId}/timeline/${frameId}/background/attach`,
      { method: 'POST', body: { generationId: background.body.generation.id } },
    )
    expect(withBackground.status).toBe(201)
    expect(withBackground.body.session.timeline.frames[0].background.uploadId).toBeTruthy()
  })

  it('từ chối sinh ảnh khi phiên chưa chọn model ảnh', async () => {
    await registerUser(ctx)
    const chatModelId = await seedLlm(ctx)
    const created = await call(ctx, '/api/plans', {
      method: 'POST',
      body: { kind: 'planner', chatModelId },
    })
    const sessionId = created.body.session.id as string

    const script = await call(ctx, `/api/plans/${sessionId}/script`, { method: 'POST' })
    const castId = script.body.session.cast?.length
      ? script.body.session.cast[0].id
      : (await call(ctx, `/api/plans/${sessionId}/cast`, { method: 'POST' })).body.session.cast[0].id

    const blocked = await call(ctx, `/api/plans/${sessionId}/cast/${castId}/portrait`, {
      method: 'POST',
    })
    expect(blocked.status).toBe(400)
    expect(blocked.body.error.message).toContain('model ảnh')
  })
})

describe('Chốt timeline thành dự án', () => {
  it('tạo dự án mới với nhân vật, cảnh, ảnh nền và thời lượng; cảnh CHƯA duyệt', async () => {
    await registerUser(ctx)
    const { sessionId, videoModelId } = await timelineReadySession(ctx)

    // Gắn ảnh nền cho frame đầu để kiểm tra ảnh đi theo cảnh.
    const frameId = (await call(ctx, `/api/plans/${sessionId}`)).body.session.timeline.frames[0].id as string
    const generated = await call(ctx, `/api/plans/${sessionId}/timeline/${frameId}/background`, {
      method: 'POST',
    })
    await waitForGeneration(ctx, generated.body.generation.id)
    await call(ctx, `/api/plans/${sessionId}/timeline/${frameId}/background/attach`, {
      method: 'POST',
      body: { generationId: generated.body.generation.id },
    })

    const applied = await call(ctx, `/api/plans/${sessionId}/apply`, {
      method: 'POST',
      body: { modelId: videoModelId, autoGenerate: true },
    })
    expect(applied.status).toBe(201)
    expect(applied.body.scenes).toHaveLength(2)
    expect(applied.body.pending).toBe(2)

    let withBackground = 0
    for (const scene of applied.body.scenes as Array<{ id: string }>) {
      const row = ctx.db
        .prepare('SELECT * FROM scenes WHERE id = ?')
        .get(scene.id) as Record<string, unknown>

      expect(row.approved).toBe(0)
      expect(row.auto_generate).toBe(1)
      expect(row.model_id).toBe(videoModelId)
      expect(String(row.background ?? '')).not.toBe('')
      // Ảnh nền của frame được sao chép thành ảnh nguồn của cảnh.
      if (row.background_upload_id) withBackground += 1

      const params = JSON.parse(String(row.params_json)) as Record<string, unknown>
      expect(Number(params.seconds)).toBeGreaterThan(0)

      const cast = ctx.db
        .prepare('SELECT character_id FROM scene_characters WHERE scene_id = ? ORDER BY position')
        .all(scene.id) as Array<{ character_id: string }>
      expect(cast.length).toBeGreaterThan(0)
      expect(cast[0]!.character_id).toBe(row.character_id)
    }
    expect(withBackground).toBe(1)

    const session = await call(ctx, `/api/plans/${sessionId}`)
    expect(session.body.session.status).toBe('applied')
    expect(session.body.session.projectId).toBe(applied.body.project.id)
  })

  it('chặn áp dụng khi chưa có timeline', async () => {
    await registerUser(ctx)
    const { sessionId } = await setupSession(ctx)

    const blocked = await call(ctx, `/api/plans/${sessionId}/apply`, { method: 'POST', body: {} })
    expect(blocked.status).toBe(400)
    expect(blocked.body.error.message).toContain('Timeline')
  })

  it('chốt hai lần không tạo dự án trùng', async () => {
    await registerUser(ctx)
    const { sessionId, videoModelId } = await timelineReadySession(ctx)

    const first = await call(ctx, `/api/plans/${sessionId}/apply`, {
      method: 'POST',
      body: { modelId: videoModelId },
    })
    const second = await call(ctx, `/api/plans/${sessionId}/apply`, {
      method: 'POST',
      body: { modelId: videoModelId },
    })

    expect(second.status).toBe(200)
    expect(second.body.alreadyApplied).toBe(true)
    expect(second.body.project.id).toBe(first.body.project.id)
  })

  it('viết lại timeline sau khi đã chốt thì lần chốt sau tạo DỰ ÁN MỚI', async () => {
    await registerUser(ctx)
    const { sessionId, videoModelId } = await timelineReadySession(ctx)

    const first = await call(ctx, `/api/plans/${sessionId}/apply`, {
      method: 'POST',
      body: { modelId: videoModelId },
    })
    expect(first.status).toBe(201)

    const regenerated = await call(ctx, `/api/plans/${sessionId}/timeline`, { method: 'POST' })
    expect(regenerated.status).toBe(200)
    expect(regenerated.body.session.projectId).toBeNull()

    const second = await call(ctx, `/api/plans/${sessionId}/apply`, {
      method: 'POST',
      body: { modelId: videoModelId, newProjectName: 'Kịch bản lần hai' },
    })
    expect(second.status).toBe(201)
    expect(second.body.alreadyApplied).toBeUndefined()
    expect(second.body.project.id).not.toBe(first.body.project.id)
    expect(second.body.project.name).toBe('Kịch bản lần hai')
  })

  it('nhân vật chọn "chỉ dự án" thuộc dự án mới, không vào thư viện', async () => {
    await registerUser(ctx)
    const { sessionId, videoModelId } = await timelineReadySession(ctx)

    const session = (await call(ctx, `/api/plans/${sessionId}`)).body.session
    await call(ctx, `/api/plans/${sessionId}/cast`, {
      method: 'PUT',
      body: { cast: session.cast.map((member: { id: string }) => ({ ...member, storage: 'project' })) },
    })

    const applied = await call(ctx, `/api/plans/${sessionId}/apply`, {
      method: 'POST',
      body: { modelId: videoModelId },
    })
    expect(applied.status).toBe(201)

    const rows = ctx.db
      .prepare('SELECT name, project_id FROM characters WHERE user_id = (SELECT user_id FROM projects WHERE id = ?)')
      .all(applied.body.project.id) as Array<{ name: string; project_id: string | null }>
    expect(rows.length).toBe(3)
    expect(rows.every((row) => row.project_id === applied.body.project.id)).toBe(true)
  })

  it('không tái dùng nhân vật của dự án khác khi lên kịch bản mới', async () => {
    await registerUser(ctx)
    const { sessionId, videoModelId } = await timelineReadySession(ctx)
    await call(ctx, `/api/plans/${sessionId}/apply`, { method: 'POST', body: { modelId: videoModelId } })

    // Nhân vật "An" được tạo trực tiếp trong một dự án khác (project_id = dự án đó).
    const projectA = await call(ctx, '/api/projects', { method: 'POST', body: { name: 'Dự án A' } })
    const projectAId = projectA.body.project.id as string
    const characterA = await call(ctx, `/api/projects/${projectAId}/characters`, {
      method: 'POST',
      body: { name: 'An', appearance: 'Nhân vật của dự án A' },
    })
    expect(characterA.status).toBe(201)

    const second = await timelineReadySession(ctx)
    const applied = await call(ctx, `/api/plans/${second.sessionId}/apply`, {
      method: 'POST',
      body: { modelId: second.videoModelId },
    })
    expect(applied.status).toBe(201)

    const used = (applied.body.characters as Array<{ id: string; name: string }>).filter(
      (character) => character.name === 'An',
    )
    expect(used).toHaveLength(1)
    expect(used[0]!.id).not.toBe(characterA.body.character.id)

    for (const scene of applied.body.scenes as Array<{ id: string }>) {
      const cast = ctx.db
        .prepare('SELECT character_id FROM scene_characters WHERE scene_id = ?')
        .all(scene.id) as Array<{ character_id: string }>
      for (const row of cast) expect(row.character_id).not.toBe(characterA.body.character.id)
    }
  })

  it('từ chối model không phải model video', async () => {
    await registerUser(ctx)
    const { modelPk: imageModel } = await seedProviderAndModel(ctx, 'image')
    const { sessionId } = await timelineReadySession(ctx)

    const bad = await call(ctx, `/api/plans/${sessionId}/apply`, {
      method: 'POST',
      body: { modelId: imageModel },
    })
    expect(bad.status).toBe(400)
    expect(bad.body.error.message).toContain('model video')
  })

  it('không tạo trùng nhân vật đã có cùng tên trong thư viện', async () => {
    await registerUser(ctx)
    const existing = await call(ctx, '/api/shared-characters', {
      method: 'POST',
      body: { name: 'An', appearance: 'Đã có sẵn', voice: { language: 'vi' } },
    })
    expect(existing.status).toBe(201)

    const { sessionId, videoModelId } = await timelineReadySession(ctx)
    const applied = await call(ctx, `/api/plans/${sessionId}/apply`, {
      method: 'POST',
      body: { modelId: videoModelId },
    })
    expect(applied.status).toBe(201)
    expect(
      (applied.body.characters as Array<{ name: string }>).filter((item) => item.name === 'An'),
    ).toHaveLength(1)
  })

  it('phiên copilot vá vào dự án đang mở, không tạo dự án mới', async () => {
    await registerUser(ctx)
    const { modelPk: videoModelId } = await seedProviderAndModel(ctx, 'video')
    const chatModelId = await seedLlm(ctx)

    const project = await call(ctx, '/api/projects', {
      method: 'POST',
      body: { name: 'Dự án đang mở' },
    })
    const projectId = project.body.project.id as string
    const created = await call(ctx, '/api/plans', {
      method: 'POST',
      body: { kind: 'copilot', projectId, chatModelId },
    })
    const sessionId = created.body.session.id as string

    await call(ctx, `/api/plans/${sessionId}/messages`, {
      method: 'POST',
      body: { content: 'Thêm cảnh mới', target: 'script' },
    })
    await call(ctx, `/api/plans/${sessionId}/script`, { method: 'POST' })
    await call(ctx, `/api/plans/${sessionId}/cast`, { method: 'POST' })
    await call(ctx, `/api/plans/${sessionId}/timeline`, { method: 'POST' })

    const applied = await call(ctx, `/api/plans/${sessionId}/apply`, {
      method: 'POST',
      body: { modelId: videoModelId },
    })
    expect(applied.status).toBe(201)
    expect(applied.body.project.id).toBe(projectId)
  })
})
