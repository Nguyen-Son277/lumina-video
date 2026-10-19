import { describe, expect, it } from 'vitest'
import { sanitizeQuickSettings, emptyQuickPreferences, isQuickSettings } from '../../shared/quickGenerationPreferences'

describe('quick generation preference schema', () => {
  it('sanitizes image preferences without requiring prompt or media', () => {
    expect(sanitizeQuickSettings('image', { modelId: 'gpt-image-1', size: '2048x2048', quality: '', count: 2 })).toEqual({
      modelId: 'gpt-image-1', size: '2048x2048', quality: '', count: 2,
    })
    expect(sanitizeQuickSettings('image', { modelId: 'gpt-image-1' })).toEqual({
      modelId: 'gpt-image-1', size: '1024x1024', quality: '', count: 1,
    })
  })

  it('rejects non-preference top-level image fields and invalid values', () => {
    for (const key of ['prompt', 'url', 'uploadId', 'assetId', 'references', 'cast', 'logos', 'consent', 'purpose']) {
      expect(() => sanitizeQuickSettings('image', { modelId: 'm', [key]: 'not persisted' })).toThrow()
    }
    expect(() => sanitizeQuickSettings('image', { modelId: 'm', count: 5 })).toThrow()
    expect(() => sanitizeQuickSettings('image', { modelId: 'm', quality: 'ultra' })).toThrow()
  })

  it('retains only stable provider-specific video params', () => {
    expect(sanitizeQuickSettings('video', { modelId: 'agnes-video-2.5', params: { mode: 'text', seconds: '8', seed: 12 } })).toEqual({
      modelId: 'agnes-video-2.5', params: { mode: 'text', seconds: '8', seed: 12 },
    })
    expect(() => sanitizeQuickSettings('video', { modelId: 'agnes-video-2.5', params: { mode: 'text', referenceImages: ['https://example.com/a.png'] } })).toThrow()
    expect(() => sanitizeQuickSettings('video', { modelId: 'bytedance/seedance-2.5', params: { mode: 'image', imageUrl: 'https://example.com/a.png' } })).toThrow()
    expect(sanitizeQuickSettings('video', { modelId: 'bytedance/seedance-2.5', params: { mode: 'text', duration: 8 } })).toMatchObject({
      params: { mode: 'text', duration: 8, resolution: '720p', bitrateMode: 'high', generateAudio: true, aspectRatio: '16:9', outputFormat: 'mp4' },
    })
  })

  it('uses database model identity while inferring behavior from provider identity', () => {
    expect(sanitizeQuickSettings('video', { modelId: 'db-pk', params: {} }, { id: 'db-pk', modelId: 'agnes-video-2.5-flash' })).toEqual({
      modelId: 'db-pk', params: { mode: 'text', size: '720P', seconds: '5', n: 1 },
    })
    expect(() => sanitizeQuickSettings('video', { modelId: 'wrong-pk', params: {} }, { id: 'db-pk', modelId: 'agnes-video-2.5-flash' })).toThrow()
    expect(sanitizeQuickSettings('video', { modelId: 'provider-model', params: {} }, { modelId: 'agnes-video-2.5-flash' })).toMatchObject({
      params: { size: '720P', seconds: '5', n: 1 },
    })
    expect(() => sanitizeQuickSettings('video', { modelId: 'db-pk', params: { size: '1080P' } }, { id: 'db-pk', modelId: 'agnes-video-2.5-flash' })).toThrow()
  })

  it('omits unsupported Higgsfield image ratio and format and provides typed helpers', () => {
    const image = sanitizeQuickSettings('video', { modelId: 'bytedance/seedance-2.5', params: { mode: 'image', aspectRatio: '16:9', outputFormat: 'mp4' } })
    expect(image).toEqual({ modelId: 'bytedance/seedance-2.5', params: { mode: 'image', duration: 5, resolution: '720p', bitrateMode: 'high', generateAudio: true } })
    expect(() => sanitizeQuickSettings('video', { modelId: 'one', params: {} }, { id: 'two', modelId: 'agnes-video-2.5' })).toThrow()
    const settings = sanitizeQuickSettings('video', { modelId: 'some-video', params: {} })
    expect(isQuickSettings('video', settings)).toBe(true)
    expect(isQuickSettings('image', settings)).toBe(false)
    expect(emptyQuickPreferences()).toEqual({ image: null, video: null })
  })
})
