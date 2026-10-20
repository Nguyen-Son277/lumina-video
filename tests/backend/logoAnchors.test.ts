import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { LOGO_ANCHORS, buildLogoVideoArgs, compositeLogoImage, validateLogoOverlays, type LogoAnchor, type ResolvedLogoOverlay } from '../../server/entityLibrary/overlay'
import { enqueueSchema, generationParamsSchema } from '../../server/generations/enqueue'
import { resolveFfmpeg } from '../../server/exports/ffmpeg'

const run = promisify(execFile)
const spec = (anchor?: LogoAnchor): ResolvedLogoOverlay => ({
  entityId: 'brand', x: 0.7, y: 0.8, width: 0.2, opacity: 1,
  path: 'logo.png', mime: 'image/png', ...(anchor ? { anchor } : {}),
})
const image = (width: number, height: number, background: string) =>
  sharp({ create: { width, height, channels: 4, background } }).png().toBuffer()

async function redBounds(bytes: Uint8Array): Promise<number[]> {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let left = info.width, top = info.height, right = -1, bottom = -1
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const offset = (y * info.width + x) * 4
    if (data[offset]! > 200 && data[offset + 1]! < 40 && data[offset + 2]! < 40) {
      left = Math.min(left, x); top = Math.min(top, y)
      right = Math.max(right, x); bottom = Math.max(bottom, y)
    }
  }
  return [left, top, right - left + 1, bottom - top + 1]
}

const positions: Array<[LogoAnchor, number, number]> = [
  ['top-left', 10, 5], ['top-center', 80, 5], ['top-right', 150, 5],
  ['middle-left', 10, 40], ['center', 80, 40], ['middle-right', 150, 40],
  ['bottom-left', 10, 75], ['bottom-center', 80, 75], ['bottom-right', 150, 75],
]

describe('exact logo anchors', () => {
  it.each(LOGO_ANCHORS)('preserves %s through validation and both enqueue schemas', anchor => {
    const overlay = spec(anchor)
    expect(validateLogoOverlays([overlay])[0]?.anchor).toBe(anchor)
    const { path: _path, mime: _mime, ...config } = overlay
    expect(generationParamsSchema.parse({ logoOverlays: [config] }).logoOverlays?.[0]?.anchor).toBe(anchor)
  })

  it.each(LOGO_ANCHORS)('accepts %s at the enqueue root and in params', anchor => {
    const { path: _path, mime: _mime, ...overlay } = spec(anchor)
    const parsed = enqueueSchema.parse({ modelId: 'model', logoOverlays: [overlay], params: { logoOverlays: [overlay] } })
    expect(parsed.logoOverlays?.[0]?.anchor).toBe(anchor)
    expect(parsed.params.logoOverlays?.[0]?.anchor).toBe(anchor)
  })

  it.each(['top', 'middle-center', '', null, 123, {}, 'top-right;movie=evil'])('rejects invalid anchor %j everywhere', anchor => {
    const { path: _path, mime: _mime, ...overlay } = spec()
    const invalid = { ...overlay, anchor }
    expect(() => validateLogoOverlays([invalid])).toThrow()
    expect(generationParamsSchema.safeParse({ logoOverlays: [invalid] }).success).toBe(false)
    expect(enqueueSchema.safeParse({ modelId: 'model', logoOverlays: [invalid] }).success).toBe(false)
  })

  it.each(positions)('places %s after resizing with 5%% source-axis margins', async (anchor, left, top) => {
    const logo = await image(20, 10, '#ff0000')
    const output = await compositeLogoImage(await image(200, 100, '#000000'), [spec(anchor)], { readFile: () => logo })
    expect(await redBounds(output)).toEqual([left, top, 40, 20])
  })

  it.each([[20, 200, 10, 100, 95, 0], [200, 20, 100, 10, 50, 45]])('centers actual fitted dimensions for a %sx%s logo', async (w, h, fittedW, fittedH, left, top) => {
    const logo = await image(w, h, '#ff0000')
    const output = await compositeLogoImage(await image(200, 100, '#000000'), [{ ...spec('center'), width: 0.5 }], { readFile: () => logo })
    expect(await redBounds(output)).toEqual([left, top, fittedW, fittedH])
  })

  it('keeps legacy normalized x/y placement unchanged when anchor is omitted', async () => {
    const overlay = spec()
    expect(validateLogoOverlays([overlay])[0]).not.toHaveProperty('anchor')
    const logo = await image(20, 10, '#ff0000')
    const output = await compositeLogoImage(await image(200, 100, '#000000'), [overlay], { readFile: () => logo })
    expect(await redBounds(output)).toEqual([140, 80, 40, 20])
    const args = buildLogoVideoArgs('/tmp/in.mp4', '/tmp/out.mp4', [{ ...overlay, absolutePath: '/tmp/logo.png' }], 200, 100)
    expect(args[args.indexOf('-filter_complex') + 1]).toContain("x='min(140,main_w-overlay_w)':y='min(80,main_h-overlay_h)'")
  })

  it.each(LOGO_ANCHORS)('uses actual overlay dimensions in ffmpeg for %s', anchor => {
    const args = buildLogoVideoArgs('/tmp/in.mp4', '/tmp/out.mp4', [{ ...spec(anchor), absolutePath: '/tmp/logo.png' }], 200, 100)
    const graph = args[args.indexOf('-filter_complex') + 1]!
    expect(graph).toContain('main_w-overlay_w')
    expect(graph).toContain('main_h-overlay_h')
    expect(graph).not.toContain('min(140,')
    expect(graph).not.toContain('min(80,')
    if (anchor.endsWith('-left')) expect(graph).toContain("x='min(10,main_w-overlay_w)'")
    if (anchor.startsWith('bottom-')) expect(graph).toContain("y='main_h-overlay_h-min(5,main_h-overlay_h)'")
    if (anchor === 'center') expect(graph).toContain("x='round((main_w-overlay_w)/2)':y='round((main_h-overlay_h)/2)'")
  })
})

const tooling = await resolveFfmpeg(undefined, 2_000)
describe.skipIf(!tooling)('native ffmpeg anchor placement', () => {
  it('centers fitted tall and wide logos and uses bottom-right margins', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lumina-logo-anchor-'))
    try {
      const input = join(directory, 'base.mp4')
      await run(tooling!.ffmpeg, ['-y', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=200x100:r=1:d=1', '-c:v', 'libx264', '-threads', '1', input])
      for (const [name, w, h, anchor, expected] of [
        ['tall', 20, 200, 'center', [95, 0, 10, 100]],
        ['wide', 200, 20, 'center', [50, 45, 100, 10]],
        ['corner', 20, 10, 'bottom-right', [90, 45, 100, 50]],
      ] as const) {
        const path = join(directory, `${name}.png`)
        const output = join(directory, `${name}.mp4`)
        await writeFile(path, await image(w, h, '#ff0000'))
        await run(tooling!.ffmpeg, buildLogoVideoArgs(input, output, [{ ...spec(anchor), width: 0.5, absolutePath: path }], 200, 100), { timeout: 10_000 })
        const { stdout } = await run(tooling!.ffmpeg, ['-v', 'error', '-i', output, '-frames:v', '1', '-threads', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], { encoding: 'buffer', timeout: 5_000 })
        const bounds = await redBounds(stdout)
        // YUV420 chroma subsampling can shift a saturated edge by one pixel.
        expected.forEach((value, index) => expect(Math.abs(bounds[index]! - value)).toBeLessThanOrEqual(1))
      }
    } finally {
      const target = resolve(directory)
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('lumina-logo-anchor-')) throw new Error('Unexpected cleanup path')
      await rm(target, { recursive: true, force: true })
    }
  }, 30_000)
})
