import { describe, expect, it } from 'vitest'
import { IMAGE_RATIOS, IMAGE_RESOLUTIONS, imageSizeFor, imageSizeSelection } from '../../shared/imageControls'

describe('image resolution controls', () => {
  it('maps long-edge resolutions independently from quality', () => {
    expect(imageSizeFor('1:1', '1K')).toBe('1024x1024')
    expect(imageSizeFor('1:1', '4K')).toBe('4096x4096')
    expect(imageSizeFor('16:9', '2K')).toBe('2048x1152')
    expect(imageSizeFor('9:16', '4K')).toBe('2304x4096')
    expect(imageSizeFor('3:2', '1K')).toBe('1024x682')
    expect(imageSizeFor('2:3', '2K')).toBe('1366x2048')
  })
  it('round trips every option with even dimensions', () => {
    for (const ratio of IMAGE_RATIOS) for (const resolution of IMAGE_RESOLUTIONS) {
      const size = imageSizeFor(ratio, resolution)
      expect(imageSizeSelection(size)).toEqual({ ratio, resolution, legacy: false })
      for (const dimension of size.split('x').map(Number)) expect(dimension % 2).toBe(0)
    }
  })
  it('keeps historical sizes distinct instead of silently rewriting them', () => {
    expect(imageSizeSelection('1536x1024')).toEqual({ ratio: '3:2', resolution: '1K', legacy: true })
    expect(imageSizeSelection('1024x1536')).toEqual({ ratio: '2:3', resolution: '1K', legacy: true })
    expect(imageSizeSelection('1920x1200').legacy).toBe(true)
  })
})
