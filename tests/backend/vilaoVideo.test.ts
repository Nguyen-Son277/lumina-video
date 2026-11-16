import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenerationContext } from '../../server/generations/types'

const { callProvider } = vi.hoisted(() => ({ callProvider: vi.fn() }))
vi.mock('../../server/providers/client', async (original) => ({
  ...await original<typeof import('../../server/providers/client')>(),
  callProvider,
}))
vi.mock('../../server/providers/pool', async (original) => ({
  ...await original<typeof import('../../server/providers/pool')>(),
  recordPinnedCredentialResult: vi.fn(),
}))

import { downloadVideoContent, pollVideoGeneration } from '../../server/generations/adapters/video'

function context(baseUrl: string): GenerationContext {
  return {
    generation: { provider_job_id: 'job/id', snap_model_id: 'seller/sora 2?variant=high', snap_video_style: 'openai', user_id: 'user' },
    provider: { baseUrl, apiKey: 'test-only' },
    env: { PROVIDER_MODE: 'live', MAX_VIDEO_BYTES: 1024, MAX_USER_MEDIA_BYTES: 1024 },
    mediaStore: { userUsageBytes: () => 0 },
  } as unknown as GenerationContext
}

beforeEach(() => vi.clearAllMocks())

describe('Vilao video reads', () => {
  it('polls with the encoded submitted model and accepts the documented completed response', async () => {
    callProvider.mockResolvedValue(Response.json({ id: 'job/id', status: 'completed', progress: 100 }))
    const ctx = context('https://api.vilao.ai/v1')
    const result = await pollVideoGeneration(ctx)
    expect(callProvider).toHaveBeenCalledWith(ctx.provider,
      'videos/job%2Fid?model=seller%2Fsora%202%3Fvariant%3Dhigh', expect.any(Object))
    expect(result.state).toBe('completed')
  })

  it('downloads binary content with the same encoded model', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    callProvider.mockResolvedValue(new Response(bytes))
    const ctx = context('https://api.vilao.ai/v1')
    expect(await downloadVideoContent(ctx)).toEqual(bytes)
    expect(callProvider).toHaveBeenCalledWith(ctx.provider,
      'videos/job%2Fid/content?model=seller%2Fsora%202%3Fvariant%3Dhigh', expect.any(Object))
  })

  it.each(['https://api.openai.com/v1', 'https://api.vilao.ai.example.com/v1', 'https://vilao.ai/v1'])(
    'keeps the standard endpoints for %s', async (baseUrl) => {
      const ctx = context(baseUrl)
      callProvider.mockResolvedValueOnce(Response.json({ id: 'job/id', status: 'completed' }))
      await pollVideoGeneration(ctx)
      expect(callProvider.mock.calls[0]?.[1]).toBe('videos/job%2Fid')
      callProvider.mockResolvedValueOnce(new Response(new Uint8Array([1])))
      await downloadVideoContent(ctx)
      expect(callProvider.mock.calls[1]?.[1]).toBe('videos/job%2Fid/content')
    },
  )
})
