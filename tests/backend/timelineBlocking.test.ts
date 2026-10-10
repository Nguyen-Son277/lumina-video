import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  keepExpressions,
  normalizeBlocking,
  suggestPosition,
  type CastMember,
  type FrameBlocking,
} from '../../server/planner/artifacts'
import {
  call,
  registerUser,
  seedProviderAndModel,
  startTestServer,
  waitForGeneration,
  type TestContext,
} from './helpers'

let ctx: TestContext
beforeAll(async () => {
  ctx = await startTestServer()
})
afterAll(async () => {
  if (ctx) await ctx.close()
})

function member(id: string, name: string, appearance = 'áo xanh'): CastMember {
  return {
    id,
    name,
    appearance,
    role: '',
    voice: {} as CastMember['voice'],
    reuseCharacterId: null,
    storage: 'library',
    portrait: null,
  }
}

const CAST = [member('cast-an', 'An'), member('cast-binh', 'Bình'), member('cast-chi', 'Chi')]

describe('Nhân vật trong frame (blocking)', () => {
  it('gợi ý vị trí theo số người: giữa, trái/phải, trái/giữa/phải, rồi tới nền', () => {
    expect(suggestPosition(0, 1)).toBe('center')
    expect(suggestPosition(0, 2)).toBe('left')
    expect(suggestPosition(1, 2)).toBe('right')
    expect([suggestPosition(0, 3), suggestPosition(1, 3), suggestPosition(2, 3)]).toEqual([
      'left',
      'center',
      'right',
    ])
    expect(suggestPosition(3, 5)).toBe('background')
    expect(suggestPosition(4, 5)).toBe('background')
  })

  it('phân giải cả castId lẫn tên, bỏ nhân vật lạ và không trùng người', () => {
    const result = normalizeBlocking(
      {
        blocking: [
          { castId: 'cast-an', action: 'mở cửa', expression: 'mắt mở to, nhìn thẳng', position: 'left' },
          { name: 'Bình', action: 'chỉ tay', position: 'right' },
          { name: 'Bình', action: 'trùng', position: 'center' },
          { name: 'Người lạ', action: 'không thuộc cast', position: 'left' },
          { name: 'Chi', action: 'đứng sau', position: 'không hợp lệ' },
        ],
      },
      CAST,
    )

    expect(result.blocking.map((entry) => entry.castId)).toEqual(['cast-an', 'cast-binh', 'cast-chi'])
    expect(result.blocking[0]).toEqual({ castId: 'cast-an', action: 'mở cửa', expression: 'mắt mở to, nhìn thẳng', position: 'left' })
    expect(result.blocking[1]).toEqual({ castId: 'cast-binh', action: 'chỉ tay', expression: '', position: 'right' })
    // Vị trí không hợp lệ được thay bằng gợi ý theo thứ tự.
    expect(result.blocking[2]!.position).toBe('right')
    // `characters` đồng bộ từ blocking để số người luôn khớp.
    expect(result.characters).toEqual(['An', 'Bình', 'Chi'])
  })

  it('người nói phải nằm trong frame, nếu không thì lấy người đầu tiên', () => {
    expect(normalizeBlocking({ blocking: [], characters: ['An', 'Bình'], speaker: 'Bình' }, CAST).speaker).toBe('Bình')
    expect(normalizeBlocking({ blocking: [], characters: ['An', 'Bình'], speaker: 'Chi' }, CAST).speaker).toBe('An')
    expect(normalizeBlocking({ blocking: [], characters: [], speaker: 'An' }, CAST).speaker).toBe('')
  })

  it('frame cũ không có blocking thì suy từ tên, hành động riêng để trống', () => {
    const result = normalizeBlocking({ characters: ['An', 'Bình'] }, CAST)
    expect(result.blocking).toEqual([
      { castId: 'cast-an', action: '', expression: '', position: 'left' },
      { castId: 'cast-binh', action: '', expression: '', position: 'right' },
    ])
    expect(result.characters).toEqual(['An', 'Bình'])
  })

  it('phiên chưa có cast vẫn giữ tên người dùng đã nhập', () => {
    const result = normalizeBlocking({ characters: ['An', 'Bình'] }, [])
    expect(result.blocking.map((entry) => entry.castId)).toEqual(['An', 'Bình'])
    expect(result.characters).toEqual(['An', 'Bình'])
  })
})

/** Phiên đã có kịch bản, nhân vật và timeline từ model mock. */
async function sessionWithTimeline(target: TestContext) {
  await registerUser(target)
  const provider = await call(target, '/api/providers', {
    method: 'POST',
    body: { name: 'LLM', baseUrl: 'https://llm.mock.test/v1', apiKey: 'sk-llm-abcd1234' },
  })
  const chat = await call(target, '/api/models', {
    method: 'POST',
    body: { providerId: provider.body.provider.id, modelId: 'mock-chat-model', kind: 'llm' },
  })
  const { modelPk: imageModelId } = await seedProviderAndModel(target, 'image')
  const { modelPk: videoModelId } = await seedProviderAndModel(target, 'video')

  const created = await call(target, '/api/plans', { method: 'POST', body: { kind: 'planner' } })
  const sessionId = created.body.session.id as string
  await call(target, `/api/plans/${sessionId}/setup`, {
    method: 'PATCH',
    body: { chatModelId: chat.body.model.id, imageModelId, videoModelId },
  })
  await call(target, `/api/plans/${sessionId}/script`, { method: 'POST' })
  await call(target, `/api/plans/${sessionId}/cast`, { method: 'POST' })
  const timeline = await call(target, `/api/plans/${sessionId}/timeline`, { method: 'POST' })
  expect(timeline.status).toBe(200)
  return { sessionId, session: timeline.body.session, imageModelId }
}

describe('Timeline lưu nhân vật trong frame', () => {
  it('lên timeline thì mỗi frame có blocking theo cast và characters đồng bộ', async () => {
    const { session } = await sessionWithTimeline(ctx)
    const frames = session.timeline.frames as Array<{
      characters: string[]
      speaker: string
      beats: string
      blocking: Array<{ castId: string; action: string; expression: string; position: string }>
    }>

    const castIds = new Set(session.cast.map((item: { id: string }) => item.id))
    expect(frames.length).toBeGreaterThan(1)

    for (const frame of frames) {
      expect(frame.blocking.length).toBe(frame.characters.length)
      for (const entry of frame.blocking) expect(castIds.has(entry.castId)).toBe(true)
    }

    // Frame đầu: một người, hành động riêng lấy từ AI (mock).
    expect(frames[0]!.characters).toEqual(['An'])
    expect(frames[0]!.blocking[0]!.action).toContain('vali')
    expect(frames[0]!.blocking[0]!.position).toBe('center')
    // Biểu cảm từng người và nhịp hành động của frame đi cùng dữ liệu blocking.
    expect(frames[0]!.blocking[0]!.expression).toContain('mắt')
    expect(frames[0]!.beats).toContain('0–2s')

    // Frame hai người: trái/phải và người nói hợp lệ.
    expect(frames[1]!.characters).toEqual(['An', 'Bình'])
    expect(frames[1]!.blocking.map((entry) => entry.position)).toEqual(['left', 'right'])
    expect(frames[1]!.speaker).toBe('Bình')
  })

  it('lưu tay sẽ bỏ nhân vật lạ và giữ hành động riêng của từng người', async () => {
    const { sessionId, session } = await sessionWithTimeline(ctx)
    const anId = session.cast.find((item: { name: string }) => item.name === 'An').id
    const first = session.timeline.frames[0]

    const saved = await call(ctx, `/api/plans/${sessionId}/timeline`, {
      method: 'PUT',
      body: {
        frames: [
          {
            id: first.id,
            title: first.title,
            characters: ['An', 'Người lạ'],
            speaker: 'Người lạ',
            beats: '0–3s đứng yên, 3–8s vẫy tay rồi hạ xuống',
            blocking: [
              { castId: anId, action: 'vẫy tay chào', expression: 'mắt nhắm hờ, miệng cười nhẹ', position: 'background' },
              { name: 'Người lạ', action: 'không thuộc cast', position: 'left' },
            ],
          },
        ],
      },
    })

    expect(saved.status).toBe(200)
    const frame = saved.body.session.timeline.frames[0]
    expect(frame.characters).toEqual(['An'])
    expect(frame.blocking).toEqual([
      { castId: anId, action: 'vẫy tay chào', expression: 'mắt nhắm hờ, miệng cười nhẹ', position: 'background' },
    ])
    expect(frame.beats).toBe('0–3s đứng yên, 3–8s vẫy tay rồi hạ xuống')
    expect(frame.speaker).toBe('An')
  })

  it('AI sắp xếp lại trả biểu cảm cho từng người trong frame', async () => {
    const { sessionId, session } = await sessionWithTimeline(ctx)
    const first = session.timeline.frames[0]

    const arranged = await call(ctx, `/api/plans/${sessionId}/timeline/${first.id}/arrange`, {
      method: 'POST',
      body: {},
    })
    expect(arranged.status).toBe(200)
    const updated = arranged.body.session.timeline.frames[0]
    expect(updated.blocking[0].action).toContain('hoạt động nhịp nhàng')
    expect(updated.blocking[0].expression).toContain('mắt')
  })

  it('keepExpressions giữ biểu cảm cũ khi AI không trả trường này', () => {
    const previous: FrameBlocking[] = [
      { castId: 'cast-an', action: 'ngồi', expression: 'mắt nhắm hờ', position: 'left' },
    ]
    const aligned: FrameBlocking[] = [
      { castId: 'cast-an', action: 'đứng dậy', expression: '', position: 'center' },
      { castId: 'cast-binh', action: 'bước vào', expression: 'mắt mở to', position: 'right' },
    ]
    expect(keepExpressions(previous, aligned)).toEqual([
      { castId: 'cast-an', action: 'đứng dậy', expression: 'mắt nhắm hờ', position: 'center' },
      { castId: 'cast-binh', action: 'bước vào', expression: 'mắt mở to', position: 'right' },
    ])
  })

  it('AI sắp xếp lại chỉ đổi frame được chọn', async () => {
    const { sessionId, session } = await sessionWithTimeline(ctx)
    const [first, second] = session.timeline.frames
    const secondBefore = JSON.stringify(second)
    const firstBackgroundBefore = first.background

    const arranged = await call(ctx, `/api/plans/${sessionId}/timeline/${first.id}/arrange`, {
      method: 'POST',
      body: {},
    })

    expect(arranged.status).toBe(200)
    const frames = arranged.body.session.timeline.frames
    const updatedFirst = frames.find((frame: { id: string }) => frame.id === first.id)
    expect(updatedFirst.blocking[0].action).toContain('hoạt động nhịp nhàng')
    expect(updatedFirst.blocking[0].castId).toBe(first.blocking[0].castId)
    // Frame khác và ảnh đã gắn của frame này không bị đụng tới.
    expect(JSON.stringify(frames.find((frame: { id: string }) => frame.id === second.id))).toBe(secondBefore)
    expect(updatedFirst.background).toEqual(firstBackgroundBefore)
  })

  it('ảnh storyboard dùng prompt có nhân vật và gửi kèm chân dung làm ảnh nguồn', async () => {
    const { sessionId, session } = await sessionWithTimeline(ctx)
    const frame = session.timeline.frames[0]
    const anId = session.cast.find((item: { name: string }) => item.name === 'An').id

    // Gắn ảnh chân dung cho An để có ảnh tham chiếu.
    const portrait = await call(ctx, `/api/plans/${sessionId}/cast/${anId}/portrait`, { method: 'POST' })
    expect(portrait.status).toBe(202)
    const portraitDone = await waitForGeneration(ctx, portrait.body.generation.id)
    expect(portraitDone.status).toBe('succeeded')
    const attached = await call(ctx, `/api/plans/${sessionId}/cast/${anId}/portrait/attach`, {
      method: 'POST',
      body: { generationId: portrait.body.generation.id },
    })
    expect(attached.status).toBe(201)
    const portraitUploadId = attached.body.session.cast.find(
      (item: { id: string }) => item.id === anId,
    ).portrait.uploadId as string

    const created = await call(ctx, `/api/plans/${sessionId}/timeline/${frame.id}/background`, {
      method: 'POST',
    })
    expect(created.status).toBe(202)

    const row = ctx.db
      .prepare('SELECT prompt, source_images_json AS sources FROM generations WHERE id = ?')
      .get(created.body.generation.id) as { prompt: string; sources: string | null }
    // Prompt mô tả cảnh có nhân vật, vị trí và hành động riêng.
    expect(row.prompt).toContain('storyboard')
    expect(row.prompt).toContain('An')
    expect(row.prompt).toContain('đứng chính giữa khung hình')
    expect(row.prompt).toContain('vali')
    expect(row.prompt).toContain('16:9')
    // Biểu cảm và nhịp hành động đi vào prompt ảnh storyboard.
    expect(row.prompt).toContain('biểu cảm')
    expect(row.prompt).toContain('Nhịp hành động')
    // Ảnh chân dung của An được gửi kèm làm ảnh nguồn.
    const upload = ctx.db
      .prepare('SELECT relative_path AS path FROM uploads WHERE id = ?')
      .get(portraitUploadId) as { path: string }
    expect(row.sources).toContain(upload.path)
  })
})
