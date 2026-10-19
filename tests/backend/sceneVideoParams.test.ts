import { describe, it, expect } from 'vitest'
import { completeSceneVideoParams, switchSceneVideoParams, sceneVideoDurationValid } from '../../shared/sceneVideoParams'
const openai = { modelId: 'sora' }
const hf = { modelId: 'bytedance/seedance-2.5' }
const agnes = { modelId: 'agnes-video-2.5' }
const flash = { modelId: 'agnes-video-2.5-flash' }
describe('scene protocol parameters', () => {
  it('fills missing fields exactly as shown in controls and retains legacy dimensions', () => {
    expect(completeSceneVideoParams(openai, {})).toEqual({ size: '1280x720', seconds: '4' })
    expect(completeSceneVideoParams(openai, { size: '1920x1200', seconds: '19' })).toEqual({ size: '1920x1200', seconds: '19' })
    expect(completeSceneVideoParams(hf, {})).toMatchObject({ mode: 'text', duration: 5, resolution: '720p' })
    expect(completeSceneVideoParams(hf, { mode: 'image' })).not.toHaveProperty('aspectRatio')
  })
  it('drops protocol fields while preserving application options across every transition', () => {
    for (const target of [openai, hf, agnes, flash]) {
      const next = switchSceneVideoParams(target, { duration: 20, mode: 'reference', referenceImages: ['https://example.com/x'], logoOverlays: [], allowTemporaryMedia: true, useCharacterReference: false })
      expect(next).toMatchObject({ logoOverlays: [], allowTemporaryMedia: true, useCharacterReference: false })
      expect(next).not.toHaveProperty('referenceImages')
      if (target === openai) expect(next).not.toHaveProperty('duration')
    }
  })
  it('validates numeric duration and Flash-specific caps', () => {
    expect(sceneVideoDurationValid(openai, { seconds: '30' })).toBe(true)
    expect(sceneVideoDurationValid(agnes, { seconds: '20' })).toBe(true)
    expect(sceneVideoDurationValid(flash, { seconds: '20' })).toBe(false)
    expect(sceneVideoDurationValid(hf, { duration: 4.5 })).toBe(false)
    expect(sceneVideoDurationValid(openai, { seconds: '' })).toBe(false)
  })
})
