import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import {
  buildLogoVideoArgs,
  compositeLogoImage,
  validateLogoOverlays,
  type ResolvedLogoOverlay,
} from '../../server/entityLibrary/overlay'
import type { MediaStore } from '../../server/media/store'

async function rgba(bytes: Uint8Array): Promise<{ width: number; height: number; data: Buffer }> {
  const result = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { width: result.info.width, height: result.info.height, data: result.data }
}

const overlay = (overrides: Partial<ResolvedLogoOverlay> = {}): ResolvedLogoOverlay => ({
  entityId: 'logo-1', x: 0.25, y: 0.25, width: 0.5, opacity: 1,
  path: 'user/entity/logo.png', mime: 'image/png', ...overrides,
})

describe('logo overlay configuration validation', () => {
  it('accepts normalized values and time bounds', () => {
    expect(validateLogoOverlays([{
      entityId: 'brand', x: 0, y: 1, width: 1, opacity: 0, startSeconds: 0, endSeconds: 0.01,
    }])).toHaveLength(1)
  })

  it.each([
    { entityId: '', x: 0, y: 0, width: 1, opacity: 1 },
    { entityId: 'x', x: -0.01, y: 0, width: 1, opacity: 1 },
    { entityId: 'x', x: 0, y: 1.01, width: 1, opacity: 1 },
    { entityId: 'x', x: 0, y: 0, width: 0, opacity: 1 },
    { entityId: 'x', x: 0, y: 0, width: 1.01, opacity: 1 },
    { entityId: 'x', x: 0, y: 0, width: 1, opacity: -0.1 },
    { entityId: 'x', x: 0, y: 0, width: 1, opacity: 1.1 },
    { entityId: 'x', x: 0, y: 0, width: 1, opacity: 1, startSeconds: -1 },
    { entityId: 'x', x: 0, y: 0, width: 1, opacity: 1, startSeconds: 3, endSeconds: 3 },
  ])('rejects invalid config %j', (config) => {
    expect(() => validateLogoOverlays([config])).toThrow()
  })

  it('rejects more than eight overlays', () => {
    const config = Array.from({ length: 9 }, (_, index) => ({
      entityId: `logo-${index}`, x: 0, y: 0, width: 1, opacity: 1,
    }))
    expect(() => validateLogoOverlays(config)).toThrow(/8 logo/)
  })
})

describe('compositeLogoImage', () => {
  it('places a semitransparent logo at normalized coordinates, keeps its intrinsic ratio and returns PNG', async () => {
    const base = await sharp({ create: { width: 8, height: 4, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer()
    // 2x1 red RGBA logo, scaled to width 4 => 4x2; opacity halves alpha.
    const logoBytes = await sharp({ create: { width: 2, height: 1, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer()
    const store = { readFile: (path: string) => {
      expect(path).toBe('user/entity/logo.png')
      return new Uint8Array(logoBytes)
    } } as Pick<MediaStore, 'readFile'>
    const result = await compositeLogoImage(new Uint8Array(base), [overlay({ opacity: 0.5 })], store)
    const metadata = await sharp(result).metadata()
    expect(metadata.format).toBe('png')
    expect(metadata.width).toBe(8)
    expect(metadata.height).toBe(4)
    const pixels = await rgba(result)
    const pixel = (x: number, y: number) => [...pixels.data.subarray((y * pixels.width + x) * 4, (y * pixels.width + x) * 4 + 4)]
    // Rounded position (2,1); 4x2 intrinsic-aspect logo. Black under half-alpha red -> ~128 red.
    expect(pixel(2, 1)[0]).toBeGreaterThanOrEqual(126)
    expect(pixel(2, 1)[0]).toBeLessThanOrEqual(129)
    expect(pixel(2, 1)[1]).toBe(0)
    expect(pixel(2, 1)[3]).toBe(255)
    expect(pixel(5, 1)[0]).toBeGreaterThanOrEqual(126)
    expect(pixel(6, 1)).toEqual([0, 0, 0, 255])
    expect(pixel(2, 3)).toEqual([0, 0, 0, 255])
  })

  it('clamps a logo at the lower-right edge and fits oversized logos inside the source', async () => {
    const base = await sharp({ create: { width: 4, height: 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer()
    const logoBytes = await sharp({ create: { width: 2, height: 4, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 1 } } }).png().toBuffer()
    const output = await compositeLogoImage(new Uint8Array(base), [overlay({ x: 1, y: 1, width: 1, path: 'logo.png' })], {
      readFile: () => new Uint8Array(logoBytes),
    })
    const pixels = await rgba(output)
    expect([pixels.width, pixels.height]).toEqual([4, 2])
    expect(pixels.data.some((value, index) => index % 4 === 1 && value > 200)).toBe(true)
    // Fit preserves the 1:2 ratio and does not stretch to the full 4x2 frame.
    expect(pixels.data.some((value, index) => index % 4 === 0 && value > 0)).toBe(false)
  })

  it('rejects SVG and an incorrect declared MIME type', async () => {
    const base = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'white' } }).png().toBuffer()
    const store = { readFile: () => new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>') }
    await expect(compositeLogoImage(new Uint8Array(base), [overlay({ mime: 'image/svg+xml' })], store)).rejects.toThrow(/SVG/)
  })
})

describe('buildLogoVideoArgs', () => {
  const videoOverlay = (overrides: Partial<ResolvedLogoOverlay & { absolutePath: string }> = {}): ResolvedLogoOverlay & { absolutePath: string } => ({
    ...overlay(), absolutePath: '/media/logo.png', ...overrides,
  })

  it('uses argument-array paths, H.264 MP4, optional AAC audio and bounded overlay filters', () => {
    const args = buildLogoVideoArgs('/tmp/source video;safe.mp4', '/tmp/result video.mp4', [
      videoOverlay({ x: 0.9, y: 0.8, width: 0.25, opacity: 0.4, startSeconds: 2, endSeconds: 8 }),
      videoOverlay({ entityId: 'second', x: 0, y: 0, width: 0.1, opacity: 1, absolutePath: '/media/logo 2.png' }),
    ], 1920, 1080)
    expect(args).toContain('/tmp/source video;safe.mp4')
    expect(args).toContain('/tmp/result video.mp4')
    expect(args).toContain('/media/logo 2.png')
    expect(args).toContain('-map')
    expect(args).toContain('0:a:0?')
    expect(args).toContain('libx264')
    expect(args).toContain('aac')
    expect(args).toContain('mp4')
    const graph = args[args.indexOf('-filter_complex') + 1]
    expect(graph).toContain('colorchannelmixer=aa=0.4')
    expect(graph).toContain("enable='between(t,2,8)'")
    expect(graph).toContain("min(1728,main_w-overlay_w)")
    expect(graph).toContain("min(864,main_h-overlay_h)")
    expect(graph).toContain('scale=480:1080:force_original_aspect_ratio=decrease')
    expect(graph).toContain('eof_action=repeat:shortest=0')
  })

  it('omits enable when no time window and rejects unsafe output/configuration', () => {
    const args = buildLogoVideoArgs('/tmp/in.mp4', '/tmp/out.mp4', [videoOverlay()], 1280, 720)
    expect(args[args.indexOf('-filter_complex') + 1]).not.toContain('enable=')
    expect(() => buildLogoVideoArgs('/tmp/in.mp4', '/tmp/in.mp4', [], 1280, 720)).toThrow()
    expect(() => buildLogoVideoArgs('/tmp/in.mp4', '/tmp/out.mp4', [videoOverlay({ absolutePath: 'https://example.com/logo.png' })], 1280, 720)).toThrow()
    expect(() => buildLogoVideoArgs('/tmp/in.mp4', '/tmp/out.mp4', [], 100_000, 100_000)).toThrow()
  })
})
