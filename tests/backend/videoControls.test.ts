import { describe, expect, it } from 'vitest'
import { VIDEO_RATIOS, VIDEO_RESOLUTIONS, videoSizeFor, videoSizeSelection, validVideoSeconds, videoResolutionLabel } from '../../shared/videoControls'
import { buildVideoRequestBody } from '../../server/generations/adapters/video'
import { normalizeAgnesParams } from '../../shared/videoApi'
describe('video control mappings and validation', () => {
  it('maps all ratios and resolutions to even dimensions and round trips', () => {
    for (const ratio of VIDEO_RATIOS) for (const resolution of VIDEO_RESOLUTIONS) {
      const size = videoSizeFor(ratio, resolution)
      const dimensions = size.split('x').map(Number)
      expect(dimensions.every(n => n % 2 === 0)).toBe(true)
      expect(Math.min(...dimensions)).toBe(Number(resolution))
      expect(videoSizeSelection(size)).toEqual({ ratio, resolution, legacy: false })
    }
    expect(videoSizeFor('16:9', '720')).toBe('1280x720')
    expect(videoSizeFor('9:16', '720')).toBe('720x1280')
    expect(videoSizeFor('21:9', '1080')).toBe('2520x1080')
    expect(videoSizeFor('16:9', '1440')).toBe('2560x1440')
    expect(videoSizeFor('16:9', '2160')).toBe('3840x2160')
    expect(videoSizeFor('9:16', '2160')).toBe('2160x3840')
    expect(VIDEO_RATIOS.length * VIDEO_RESOLUTIONS.length).toBe(30)
    expect(videoResolutionLabel('1080')).toBe('1K (1080p)')
    expect(videoResolutionLabel('1440P')).toBe('2K (1440p)')
    expect(videoResolutionLabel('2160P')).toBe('4K (2160p)')
  })
  it('recognizes legacy sizes without mutating them', () => {
    expect(videoSizeSelection('1920x1200').legacy).toBe(true)
    const body = buildVideoRequestBody('sora', 'prompt', { size: '1920x1200', seconds: '17' })
    expect(body.size).toBe('1920x1200')
    expect(body.seconds).toBe('17')
  })
  it('uses Nexus-compatible minimal video payload', () => {
    const body = buildVideoRequestBody('minimax-h3', 'prompt', { size: '3840x2160', seconds: '12' }, 'data:image/png;base64,AAAA', null, 'image_url_object', 'https://api.nexusmmo.store/v1')
    expect(body).toEqual({ model: 'minimax-h3', prompt: 'prompt', seconds: '12', input_reference: 'data:image/png;base64,AAAA' })
  })
  it('accepts only whole seconds in the selected model range', () => {
    for (const value of ['4', '12', '17', '30', 8]) expect(validVideoSeconds(value)).toBe(true)
    for (const value of ['', ' ', '3', '31', '4.5', '04', '4e0', NaN, undefined]) expect(validVideoSeconds(value)).toBe(false)
    expect(validVideoSeconds('12', 12)).toBe(true)
    expect(validVideoSeconds('13', 12)).toBe(false)
  })
  it('keeps Agnes legacy payload size and string seconds, retaining Flash restrictions', () => {
    expect(normalizeAgnesParams('agnes-video-2.5', { size: 'custom', seconds: '30' })).toMatchObject({ size: 'custom', seconds: '30' })
    expect(normalizeAgnesParams('agnes-video-2.5-flash', { size: '720P', seconds: '12' })).toMatchObject({ size: '720P', seconds: '12' })
    expect(() => normalizeAgnesParams('agnes-video-2.5-flash', { size: '1080P', seconds: '12' })).toThrow()
  })
})
