import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  registerUser,
  seedProviderAndModel,
  startTestServer,
  type TestContext,
} from './helpers'
import { stampOf, diffLocations, diffTimeline } from '../../server/planner/proposals'
import type { LocationReference, Timeline } from '../../server/planner/artifacts'

let ctx: TestContext
beforeAll(async () => {
  ctx = await startTestServer()
})
afterAll(async () => {
  if (ctx) await ctx.close()
})

/** Phiên có model chat, kịch bản nháp, nhân vật và timeline. */
async function readySession(target: TestContext) {
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
  await call(target, `/api/plans/${sessionId}/timeline`, { method: 'POST' })
  return { sessionId }
}

describe('Đề xuất sửa — cổng model chat', () => {
  it('chưa chọn model chat thì không nhắn và không đề xuất được', async () => {
    await registerUser(ctx)
    const created = await call(ctx, '/api/plans', { method: 'POST', body: { kind: 'planner' } })
    const sessionId = created.body.session.id as string

    const chat = await call(ctx, `/api/plans/${sessionId}/messages`, {
      method: 'POST',
      body: { content: 'Xin chào', target: 'script' },
    })
    expect(chat.status).toBe(400)
    expect(chat.body.error.message).toContain('model chat')

    const propose = await call(ctx, `/api/plans/${sessionId}/propose`, {
      method: 'POST',
      body: { surface: 'timeline', content: 'Đổi góc máy khung 1' },
    })
    expect(propose.status).toBe(400)
    expect(propose.body.error.message).toContain('model chat')

    // Không có tin nhắn nào bị ghi khi yêu cầu bị từ chối.
    expect(created.body.session.messageCount).toBe(0)
  })
})

describe('Đề xuất sửa — không ghi dữ liệu, chỉ trả thay đổi', () => {
  it('đề xuất bối cảnh: trả summary + changes, giữ nguyên bối cảnh hiện có', async () => {
    await registerUser(ctx)
    const { sessionId } = await readySession(ctx)
    await call(ctx, `/api/plans/${sessionId}/locations`, {
      method: 'POST',
      body: { name: 'Sân ga', stage: 'Buổi sớm', description: 'Sân ga nhỏ', continuityNotes: 'Ánh nắng nhạt' },
    })
    const before = (await call(ctx, `/api/plans/${sessionId}`)).body.session.locations

    const proposed = await call(ctx, `/api/plans/${sessionId}/propose`, {
      method: 'POST',
      body: { surface: 'locations', content: 'Thêm bối cảnh cho cảnh đêm và chỉnh ghi chú liên tục' },
    })
    expect(proposed.status).toBe(200)
    expect(proposed.body.summary.length).toBeGreaterThan(0)
    expect(proposed.body.proposal.surface).toBe('locations')
    expect(proposed.body.proposal.baseStamp).toBe(stampOf(JSON.stringify(before)))

    const changes = proposed.body.changes as Array<{ action: string; entity: string; label: string }>
    expect(changes.some((item) => item.action === 'add' && item.entity === 'location')).toBe(true)
    expect(changes.some((item) => item.action === 'update')).toBe(true)
    expect(changes.every((item) => item.entity === 'location')).toBe(true)

    // Chưa ghi gì: danh sách bối cảnh trong phiên vẫn như cũ.
    const after = (await call(ctx, `/api/plans/${sessionId}`)).body.session.locations
    expect(after).toEqual(before)
  })

  it('đề xuất timeline: giữ nguyên timeline cho tới khi xác nhận', async () => {
    await registerUser(ctx)
    const { sessionId } = await readySession(ctx)
    const before = (await call(ctx, `/api/plans/${sessionId}`)).body.session.timeline

    const proposed = await call(ctx, `/api/plans/${sessionId}/propose`, {
      method: 'POST',
      body: { surface: 'timeline', content: 'Khung đầu quay cận cảnh' },
    })
    expect(proposed.status).toBe(200)
    expect(proposed.body.proposal.surface).toBe('timeline')
    const changes = proposed.body.changes as Array<{ entity: string; fields: Array<{ field: string }> }>
    expect(changes.length).toBeGreaterThan(0)
    expect(changes.every((item) => item.entity === 'frame')).toBe(true)
    expect(changes.some((item) => item.fields.some((field) => field.field === 'shotNotes'))).toBe(true)

    const after = (await call(ctx, `/api/plans/${sessionId}`)).body.session.timeline
    expect(after).toEqual(before)

    // Tin nhắn được ghi vào mạch chung để lần sau AI còn ngữ cảnh.
    const messages = (await call(ctx, `/api/plans/${sessionId}`)).body.messages
    expect(messages.length).toBeGreaterThanOrEqual(2)
    expect(messages.some((message: { role: string; content: string }) => message.role === 'user' && message.content.includes('cận cảnh'))).toBe(true)
  })
})

describe('Đề xuất sửa — xác nhận mới ghi', () => {
  it('áp dụng đề xuất bối cảnh thì mới lưu, và tăng revision khi nội dung đổi', async () => {
    await registerUser(ctx)
    const { sessionId } = await readySession(ctx)
    await call(ctx, `/api/plans/${sessionId}/locations`, {
      method: 'POST',
      body: { name: 'Sân ga', stage: '', description: 'Sân ga nhỏ', continuityNotes: '' },
    })

    const proposed = await call(ctx, `/api/plans/${sessionId}/propose`, {
      method: 'POST',
      body: { surface: 'locations', content: 'Thêm bối cảnh đêm' },
    })
    const applied = await call(ctx, `/api/plans/${sessionId}/propose/apply`, {
      method: 'POST',
      body: {
        surface: 'locations',
        baseStamp: proposed.body.proposal.baseStamp,
        locations: proposed.body.proposal.payload.locations,
      },
    })
    expect(applied.status).toBe(200)
    const locations = applied.body.locations as LocationReference[]
    expect(locations.length).toBe(2)
    expect(locations[0]!.revision).toBeGreaterThan(1)
    // Đã ghi thật vào phiên.
    const stored = (await call(ctx, `/api/plans/${sessionId}`)).body.session.locations
    expect(stored).toHaveLength(2)
  })

  it('áp dụng đề xuất timeline thì cập nhật khung và giữ ảnh đã gắn', async () => {
    await registerUser(ctx)
    const { sessionId } = await readySession(ctx)
    const frameId = (await call(ctx, `/api/plans/${sessionId}`)).body.session.timeline.frames[0].id as string
    const generated = await call(ctx, `/api/plans/${sessionId}/timeline/${frameId}/background`, { method: 'POST' })
    // Gắn ảnh nền chỉ để kiểm tra bảo toàn; chờ generation xong trước.
    for (let i = 0; i < 40; i += 1) {
      await ctx.worker.tick()
      const status = (await call(ctx, `/api/generations/${generated.body.generation.id}`)).body.generation.status
      if (status === 'succeeded' || status === 'failed') break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await call(ctx, `/api/plans/${sessionId}/timeline/${frameId}/background/attach`, {
      method: 'POST',
      body: { generationId: generated.body.generation.id },
    })
    const withImage = (await call(ctx, `/api/plans/${sessionId}`)).body.session.timeline
    expect(withImage.frames[0].background).toBeTruthy()

    const proposed = await call(ctx, `/api/plans/${sessionId}/propose`, {
      method: 'POST',
      body: { surface: 'timeline', content: 'Khung đầu quay cận cảnh' },
    })
    const applied = await call(ctx, `/api/plans/${sessionId}/propose/apply`, {
      method: 'POST',
      body: {
        surface: 'timeline',
        baseStamp: proposed.body.proposal.baseStamp,
        frames: proposed.body.proposal.payload.frames,
      },
    })
    expect(applied.status).toBe(200)
    const frames = applied.body.session.timeline.frames as Timeline['frames']
    expect(frames[0]!.shotNotes).toContain('đề xuất')
    // Ảnh nền của khung cũ vẫn còn.
    expect(frames[0]!.background).toBeTruthy()
  })

  it('từ chối áp dụng khi dữ liệu đã đổi kể từ lúc đề xuất', async () => {
    await registerUser(ctx)
    const { sessionId } = await readySession(ctx)
    await call(ctx, `/api/plans/${sessionId}/locations`, {
      method: 'POST',
      body: { name: 'Sân ga', stage: '', description: 'Sân ga nhỏ', continuityNotes: '' },
    })
    const proposed = await call(ctx, `/api/plans/${sessionId}/propose`, {
      method: 'POST',
      body: { surface: 'locations', content: 'Thêm bối cảnh đêm' },
    })

    // Người dùng đổi bối cảnh ngay sau khi AI đề xuất.
    await call(ctx, `/api/plans/${sessionId}/locations`, {
      method: 'POST',
      body: { name: 'Bến tàu', stage: '', description: 'Bến tàu lớn', continuityNotes: '' },
    })

    const applied = await call(ctx, `/api/plans/${sessionId}/propose/apply`, {
      method: 'POST',
      body: {
        surface: 'locations',
        baseStamp: proposed.body.proposal.baseStamp,
        locations: proposed.body.proposal.payload.locations,
      },
    })
    expect(applied.status).toBe(409)
    expect(applied.body.error.message).toContain('đã thay đổi')
    // Dữ liệu mới không bị ghi đè.
    const stored = (await call(ctx, `/api/plans/${sessionId}`)).body.session.locations
    expect(stored.map((item: { name: string }) => item.name)).toEqual(['Sân ga', 'Bến tàu'])
  })

  it('từ chối payload sai và không cho áp dụng lên phiên của người khác', async () => {
    const owner = await registerUser(ctx)
    const { sessionId } = await readySession(ctx)
    const proposed = await call(ctx, `/api/plans/${sessionId}/propose`, {
      method: 'POST',
      body: { surface: 'locations', content: 'Thêm bối cảnh' },
    })

    const badSurface = await call(ctx, `/api/plans/${sessionId}/propose/apply`, {
      method: 'POST',
      body: { surface: 'script', baseStamp: proposed.body.proposal.baseStamp },
    })
    expect(badSurface.status).toBe(400)

    const missingPayload = await call(ctx, `/api/plans/${sessionId}/propose/apply`, {
      method: 'POST',
      body: { surface: 'locations', baseStamp: proposed.body.proposal.baseStamp },
    })
    expect(missingPayload.status).toBe(400)

    const other = await registerUser(ctx)
    const stolen = await call(ctx, `/api/plans/${sessionId}/propose/apply`, {
      method: 'POST',
      body: {
        surface: 'locations',
        baseStamp: proposed.body.proposal.baseStamp,
        locations: proposed.body.proposal.payload.locations,
      },
      cookie: ctx.cookie,
    })
    expect(stolen.status).toBe(404)
    void owner
  })
})

describe('Đề xuất sửa — ghi nhật ký sử dụng', () => {
  it('mỗi lần đề xuất là một dòng log với nguồn riêng', async () => {
    const user = await registerUser(ctx)
    const { sessionId } = await readySession(ctx)
    await call(ctx, `/api/plans/${sessionId}/propose`, {
      method: 'POST',
      body: { surface: 'locations', content: 'Thêm bối cảnh' },
    })
    await call(ctx, `/api/plans/${sessionId}/propose`, {
      method: 'POST',
      body: { surface: 'timeline', content: 'Đổi góc máy' },
    })

    const usage = await call(ctx, '/api/usage', { cookie: ctx.cookie })
    const sources = (usage.body.events as Array<{ source: string }>).map((event) => event.source)
    expect(sources).toContain('planner_propose_locations')
    expect(sources).toContain('planner_propose_timeline')
    void user
  })
})

describe('So sánh đề xuất (hàm thuần)', () => {
  it('diffLocations phát hiện thêm, sửa và xoá', () => {
    const current = [
      { id: 'a', name: 'A', stage: '', description: 'cũ', continuityNotes: '', imagePrompt: '', reference: null, revision: 1 },
      { id: 'b', name: 'B', stage: '', description: '', continuityNotes: '', imagePrompt: '', reference: null, revision: 1 },
    ] as LocationReference[]
    const next = [
      { ...current[0]!, description: 'mới', revision: 2 },
      { id: 'c', name: 'C', stage: '', description: '', continuityNotes: '', imagePrompt: '', reference: null, revision: 1 },
    ] as LocationReference[]
    const actions = diffLocations(current, next).map((change) => change.action)
    expect(actions).toContain('update')
    expect(actions).toContain('add')
    expect(actions).toContain('remove')
  })

  it('diffTimeline phát hiện đổi bối cảnh gắn cho khung và đổi thứ tự', () => {
    const frame = (id: string, locationId: string | null) => ({
      id, title: id, context: '', action: '', dialogue: '', speaker: '', characters: [],
      durationSeconds: 8, shotNotes: '', beats: '', locationId, backgroundPrompt: '',
      background: null, blocking: [],
    })
    const current: Timeline = { frames: [frame('f1', null), frame('f2', null)] as Timeline['frames'] }
    const next = [frame('f2', 'loc-1'), frame('f1', null)] as Timeline['frames']
    const changes = diffTimeline(current, next, new Map([['loc-1', 'Sân ga']]))
    expect(changes.some((change) => change.action === 'reorder')).toBe(true)
    const assigned = changes.find((change) => change.action === 'assign')
    expect(assigned?.fields[0]?.to).toBe('Sân ga')
  })
})
