import { describe, expect, it } from 'vitest'
import { latestSceneVideo, sceneVideoCoverUrl, type SceneVideo } from '../../shared/sceneCover'

type TestGeneration = SceneVideo & {
  prompt: string
  progress: number | null
  provider: string
  model: string
  params: Record<string, unknown>
  errorCode: string | null
  errorMessage: string | null
  providerJobId: string | null
  updatedAt: number
  completedAt: number | null
  assets: Array<{ id: string; mimeType: string; byteSize: number; url: string }>
}

function generation(overrides: Partial<TestGeneration> = {}): TestGeneration {
  return {
    id: 'generation',
    kind: 'video',
    prompt: '',
    status: 'succeeded',
    progress: null,
    provider: '',
    model: '',
    params: {},
    errorCode: null,
    errorMessage: null,
    providerJobId: null,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    assets: [],
    ...overrides,
  }
}

function asset(mimeType: string, url: string) {
  return { id: `${mimeType}-${url}`, mimeType, byteSize: 1, url }
}

describe('latestSceneVideo', () => {
  it('chooses greatest createdAt, then greatest id, regardless of input order and without mutation', () => {
    const entries = [
      generation({ id: 'b', sceneId: 'scene-a', createdAt: 4 }),
      generation({ id: 'newer', sceneId: 'scene-a', createdAt: 5 }),
      generation({ id: 'a', sceneId: 'scene-a', createdAt: 4 }),
    ]
    const originalOrder = [...entries]

    expect(latestSceneVideo(entries, 'scene-a')?.id).toBe('newer')
    expect(latestSceneVideo([entries[0]!, entries[2]!], 'scene-a')?.id).toBe('b')
    expect(entries).toEqual(originalOrder)
  })

  it('ignores images and generations belonging to another scene', () => {
    const entries = [
      generation({ id: 'image', kind: 'image', sceneId: 'scene-a', createdAt: 99 }),
      generation({ id: 'foreign', sceneId: 'scene-b', createdAt: 100 }),
      generation({ id: 'match', sceneId: 'scene-a', createdAt: 1 }),
    ]
    expect(latestSceneVideo(entries, 'scene-a')?.id).toBe('match')
    expect(latestSceneVideo(entries, 'absent')).toBeNull()
  })
})

describe('sceneVideoCoverUrl', () => {
  it('returns the first matching video asset with a nonempty URL', () => {
    const value = generation({ assets: [
      asset('image/png', '/image.png'),
      asset('video/mp4', '/first.mp4'),
      asset('video/webm', '/second.webm'),
    ] })
    expect(sceneVideoCoverUrl(value)).toBe('/first.mp4')
  })

  it.each(['queued', 'running', 'downloading', 'unknown', 'failed'] as const)(
    'does not show a cover for %s (or fall back to a previous success)', status => {
      const pending = generation({ status, assets: [asset('video/mp4', '/current.mp4')] })
      expect(sceneVideoCoverUrl(pending)).toBeNull()
    },
  )

  it('returns null for missing generation, missing assets, image-only assets, and empty video URLs', () => {
    expect(sceneVideoCoverUrl(null)).toBeNull()
    expect(sceneVideoCoverUrl(generation())).toBeNull()
    expect(sceneVideoCoverUrl(generation({ assets: [asset('image/png', '/image.png')] }))).toBeNull()
    expect(sceneVideoCoverUrl(generation({ assets: [asset('video/mp4', '  ')] }))).toBeNull()
  })
})
