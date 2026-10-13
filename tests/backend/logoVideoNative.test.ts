import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as overlays from '../../server/entityLibrary/overlay'
import { postprocessGenerationLogos } from '../../server/entityLibrary/postprocess'
import { probeVideo, resolveFfmpeg, type FfmpegTooling } from '../../server/exports/ffmpeg'
import type { GenerationRow } from '../../server/generations/types'
import { createMediaStore, type MediaStore } from '../../server/media/store'
import { startTestServer, type TestContext } from './helpers'

const run = promisify(execFile)
const nativePrefix = 'lumina-native-logo-test-'
const directories: string[] = []
const servers: TestContext[] = []

// Missing tooling skips only these native tests; no provider or fake MP4 fixture is used.
async function detectTooling(): Promise<FfmpegTooling | null> {
  const tools = await resolveFfmpeg(existsSync('/usr/local/bin/ffmpeg') ? '/usr/local/bin/ffmpeg' : undefined, 2_000)
  if (!tools?.ffprobe) return null
  try {
    await run(tools.ffmpeg, ['-version'], { timeout: 2_000 })
    await run(tools.ffprobe, ['-version'], { timeout: 2_000 })
    return tools
  } catch {
    return null
  }
}
const tooling = await detectTooling()

function verifiedTemporary(directory: string, prefix: string): string {
  const absolute = resolve(directory)
  if (!isAbsolute(directory) || absolute !== directory || dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith(prefix)) {
    throw new Error(`Refusing cleanup of unexpected native-test directory: ${directory}`)
  }
  return absolute
}

afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  // Validate the helper's absolute cleanup target before its close() deletes anything.
  for (const server of servers) {
    verifiedTemporary(server.dir, 'lumina-test-')
    await server.close()
  }
  for (const directory of directories) {
    await rm(verifiedTemporary(directory, nativePrefix), { recursive: true, force: true })
  }
})

async function synthesize(path: string, audio: boolean): Promise<Buffer> {
  const args = ['-y', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x48:r=4:d=1']
  // Deliberately shorter audio: the overlay must not truncate a one-second video.
  if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.5')
  args.push('-map', '0:v:0')
  if (audio) args.push('-map', '1:a:0', '-c:a', 'aac')
  args.push('-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path)
  await run(tooling!.ffmpeg, args, { timeout: 5_000, maxBuffer: 1024 * 1024 })
  return readFile(path)
}

async function decodedFrame(path: string, frame: number | { atSeconds: number }): Promise<{ data: Buffer; channels: number }> {
  // Overlay image inputs can change output fps: time-window assertions must use
  // actual presentation time rather than assume that output frame 2 is t=0.5.
  const select = typeof frame === 'number' ? `select=eq(n\\,${frame})` : `select=gte(t\\,${frame.atSeconds})`
  const result = await run(tooling!.ffmpeg, [
    '-nostdin', '-v', 'error', '-i', path, '-vf', select,
    '-frames:v', '1', '-threads', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1',
  ], { encoding: 'buffer', timeout: 5_000, maxBuffer: 1024 * 1024 })
  expect(result.stdout.length, `ffmpeg must decode frame ${frame} from a playable MP4`).toBeGreaterThan(0)
  const { data, info } = await sharp(result.stdout).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  expect([info.width, info.height]).toEqual([64, 48])
  return { data, channels: info.channels }
}

function expectColour(frame: { data: Buffer; channels: number }, x: number, y: number, colour: 'red' | 'blue'): void {
  const offset = (y * 64 + x) * frame.channels
  const [red, green, blue] = Array.from(frame.data.subarray(offset, offset + 3))
  // MP4 is lossy YUV420, so test channel dominance away from overlay edges.
  expect(green).toBeLessThan(30)
  if (colour === 'red') {
    expect(red).toBeGreaterThan(220)
    expect(blue).toBeLessThan(30)
  } else {
    expect(blue).toBeGreaterThan(220)
    expect(red).toBeLessThan(30)
  }
}

async function expectPlayable(path: string, hasAudio: boolean): Promise<void> {
  expect(await probeVideo(tooling!, path, 5_000)).toEqual({ width: 64, height: 48, hasAudio })
  const { stdout } = await run(tooling!.ffprobe!, [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', path,
  ], { timeout: 5_000 })
  const result = JSON.parse(stdout) as { format: { duration: string }; streams: Array<{ codec_type: string }> }
  expect(Number(result.format.duration)).toBeGreaterThanOrEqual(0.9)
  expect(result.streams.some(stream => stream.codec_type === 'audio')).toBe(hasAudio)
}

function logoFor(store: MediaStore, userId: string, bytes: Buffer): overlays.ResolvedLogoOverlay {
  const saved = store.saveUpload({ userId, uploadId: randomUUID(), bytes, maxBytes: 1024 * 1024 })
  return { entityId: 'native-red-logo', path: saved.relativePath, mime: saved.mimeType, x: 0.25, y: 0.25, width: 0.5, opacity: 1 }
}

describe.skipIf(!tooling?.ffprobe)('Native local logo video processing (ffmpeg + ffprobe)', () => {
  let directory: string
  let redPng: Buffer

  beforeAll(async () => {
    directory = verifiedTemporary(await mkdtemp(join(tmpdir(), nativePrefix)), nativePrefix)
    directories.push(directory)
    redPng = await sharp({ create: { width: 16, height: 12, channels: 4, background: '#ff0000' } }).png().toBuffer()
  })

  it('preserves dimensions, shorter tone audio and original bytes, and honours the logo time window', async () => {
    const input = join(directory, 'blue-with-tone.mp4')
    const output = join(directory, 'windowed-logo.mp4')
    const originalBytes = await synthesize(input, true)
    const store = createMediaStore({ root: join(directory, 'media'), maxImageBytes: 1024 * 1024, maxVideoBytes: 1024 * 1024, maxUserBytes: 1024 * 1024 })
    const logo = { ...logoFor(store, 'native-user', redPng), startSeconds: 0, endSeconds: 0.25 }
    expect(await overlays.overlayLogoVideo({ input, output, overlays: [logo], mediaStore: store, tooling: tooling!, timeoutMs: 10_000 }))
      .toEqual({ width: 64, height: 48, hasAudio: true })
    await expectPlayable(output, true)
    const first = await decodedFrame(output, 0)
    expectColour(first, 32, 24, 'red')
    expectColour(first, 4, 4, 'blue')
    expectColour(await decodedFrame(output, { atSeconds: 0.5 }), 32, 24, 'blue') // Outside [0, 0.25].
    expectColour(await decodedFrame(input, 0), 32, 24, 'blue')
    expect(await readFile(input)).toEqual(originalBytes)
  }, 20_000)

  it('postprocesses a persisted valid video into one linked derivative, checks quota, and cleans native temporary files', async () => {
    const ctx = await startTestServer({ ffmpegPath: tooling!.ffmpeg })
    servers.push(ctx)
    await ctx.worker.stop()
    const userId = randomUUID()
    ctx.db.prepare("INSERT INTO users (id, email, password_hash, password_salt, created_at, status) VALUES (?, ?, 'unused-native-test-hash', 'unused-native-test-salt', ?, 'approved')")
      .run(userId, `${userId}@gigone.com`, Date.now())
    const logo = logoFor(ctx.mediaStore, userId, redPng)
    const logoInfo = ctx.mediaStore.stat(logo.path)
    ctx.db.prepare('INSERT INTO uploads (id, user_id, relative_path, mime_type, byte_size, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), userId, logo.path, logo.mime, logoInfo.size, Date.now())
    const generationId = randomUUID()
    const snapshot = JSON.stringify([logo])
    ctx.db.prepare(`INSERT INTO generations (id, user_id, kind, prompt, params_json, snap_provider, snap_base_url, snap_model_id,
      status, logo_overlays_json, created_at, updated_at) VALUES (?, ?, 'video', 'pure local native test', '{"n":1}', 'no provider', '', 'local', 'succeeded', ?, ?, ?)`)
      .run(generationId, userId, snapshot, Date.now(), Date.now())
    const originalBytes = await synthesize(join(directory, 'persisted-original.mp4'), false)
    const original = ctx.mediaStore.save({ userId, generationId, bytes: originalBytes })
    const originalId = randomUUID()
    ctx.db.prepare('INSERT INTO assets (id, generation_id, user_id, relative_path, mime_type, byte_size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(originalId, generationId, userId, original.relativePath, original.mimeType, original.byteSize, Date.now())
    const generation = () => ctx.db.prepare('SELECT * FROM generations WHERE id = ?').get(generationId) as GenerationRow
    const rows = () => ctx.db.prepare('SELECT * FROM assets WHERE generation_id = ? ORDER BY created_at, id').all(generationId) as Array<{
      id: string; relative_path: string; variant: string; source_asset_id: string | null; byte_size: number
    }>
    const temporaryOutputs: string[] = []
    const nativeOverlay = overlays.overlayLogoVideo
    vi.spyOn(overlays, 'overlayLogoVideo').mockImplementation(async options => {
      // Instrument the real native codec, not a fake media fixture.
      verifiedTemporary(dirname(options.output), 'lumina-logo-')
      temporaryOutputs.push(options.output)
      return nativeOverlay(options)
    })
    const network = vi.spyOn(globalThis, 'fetch')
    const usageBefore = ctx.mediaStore.userUsageBytes(ctx.db, userId)
    ctx.env.MAX_USER_MEDIA_BYTES = usageBefore // No room for any derivative.
    const process = () => postprocessGenerationLogos({ db: ctx.db, mediaStore: ctx.mediaStore, env: ctx.env, generation: generation() })
    expect((await process()).status).toBe('failed')
    expect(generation()).toMatchObject({ status: 'succeeded', postprocess_status: 'failed' })
    expect(rows()).toHaveLength(1)
    expect(ctx.mediaStore.userUsageBytes(ctx.db, userId)).toBe(usageBefore)
    expect(Buffer.from(ctx.mediaStore.readFile(original.relativePath))).toEqual(originalBytes)

    ctx.env.MAX_USER_MEDIA_BYTES = usageBefore + 1024 * 1024
    const result = await process()
    expect(result.status).toBe('succeeded')
    expect(result.derivedAssetIds).toHaveLength(1)
    const saved = rows()
    expect(saved).toHaveLength(2)
    const derived = saved.find(asset => asset.variant === 'logo_overlay')!
    expect(derived).toMatchObject({ id: result.derivedAssetIds[0], source_asset_id: originalId })
    expect(derived.relative_path).not.toBe(original.relativePath)
    expect(ctx.mediaStore.userUsageBytes(ctx.db, userId)).toBe(usageBefore + derived.byte_size)
    await expectPlayable(ctx.mediaStore.absolutePath(derived.relative_path), false)
    expectColour(await decodedFrame(ctx.mediaStore.absolutePath(derived.relative_path), 0), 32, 24, 'red')
    expectColour(await decodedFrame(ctx.mediaStore.absolutePath(original.relativePath), 0), 32, 24, 'blue')
    expect(Buffer.from(ctx.mediaStore.readFile(original.relativePath))).toEqual(originalBytes)
    expect(generation()).toMatchObject({ status: 'succeeded', postprocess_status: 'succeeded', logo_overlays_json: snapshot })
    expect(await process()).toEqual(result)
    expect(rows()).toEqual(saved)
    expect(temporaryOutputs).toHaveLength(2) // Failed quota attempt and successful retry.
    for (const output of temporaryOutputs) {
      expect(existsSync(output)).toBe(false)
      expect(existsSync(dirname(output))).toBe(false)
    }
    expect(network).not.toHaveBeenCalled()
  }, 20_000)
})
