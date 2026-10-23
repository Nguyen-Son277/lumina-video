import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { probeVideo, resolveFfmpeg, stitchVideos } from '../../server/exports/ffmpeg'
import { logger } from '../../server/lib/logger'
import type { CanvasGraph } from '../../shared/canvas'
import { call, registerUser, seedProviderAndModel, startTestServer, waitForGeneration, type TestContext } from './helpers'

const run = promisify(execFile)
const tooling = await resolveFfmpeg(existsSync('/usr/local/bin/ffmpeg') ? '/usr/local/bin/ffmpeg' : undefined, 2_000)

type Media = {
  streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number; pix_fmt?: string; r_frame_rate?: string; sample_rate?: string; channels?: number }>
  format: { duration: string }
}

describe.skipIf(!tooling?.ffprobe)('Studio exports with real ffmpeg and ffprobe', () => {
  let directory: string
  let server: TestContext | undefined
  const clips: Record<string, string> = {}

  async function makeClip(name: string, options: {
    color: string; size?: string; fps?: number; frequency?: number; duration?: number; audioDuration?: number; codec?: string
    sampleRate?: number; channels?: number; offset?: number; odd?: boolean
  }): Promise<void> {
    const path = join(directory, `${name}.mp4`)
    const args = ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
      `color=c=${options.color}:s=${options.size ?? '64x48'}:r=${options.fps ?? 24}:d=${options.duration ?? 1}${options.odd ? ',format=yuv444p' : ''}`]
    if (options.frequency) {
      args.push('-f', 'lavfi', '-i', `sine=frequency=${options.frequency}:sample_rate=${options.sampleRate ?? 44100}:duration=${options.audioDuration ?? options.duration ?? 1}`)
    }
    args.push('-map', '0:v:0', '-c:v', options.codec ?? 'libx264', '-threads', '1', '-pix_fmt', options.odd ? 'yuv444p' : 'yuv420p')
    if (options.frequency) args.push('-map', '1:a:0', '-c:a', 'aac', '-ac', String(options.channels ?? 1))
    if (options.offset) args.push('-output_ts_offset', String(options.offset))
    args.push('-movflags', '+faststart', path)
    await run(tooling!.ffmpeg, args, { timeout: 5_000, maxBuffer: 1024 * 1024 })
    clips[name] = path
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'lumina-native-export-'))
    await Promise.all([
      makeClip('red', { color: 'red', frequency: 440, fps: 24, sampleRate: 44100 }),
      makeClip('blue', { color: 'blue', size: '48x64', frequency: 880, fps: 15, sampleRate: 48000, channels: 2, codec: 'mpeg4' }),
      makeClip('fractional', { color: 'red', frequency: 440, duration: 0.7 }),
      makeClip('silent', { color: 'lime', fps: 25 }),
      makeClip('silent-blue', { color: 'blue', fps: 12 }),
      makeClip('short-audio', { color: 'red', frequency: 440, audioDuration: 0.4 }),
      makeClip('long-audio', { color: 'blue', frequency: 880, audioDuration: 1.5 }),
      makeClip('odd-offset', { color: 'red', size: '65x49', frequency: 440, odd: true, offset: 3 }),
    ])
  })

  afterEach(() => vi.restoreAllMocks())
  afterAll(async () => {
    if (server) await server.close()
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  async function inspect(path: string): Promise<Media> {
    const { stdout } = await run(tooling!.ffprobe!, [
      '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,sample_rate,channels:format=duration',
      '-of', 'json', path,
    ], { timeout: 5_000 })
    return JSON.parse(stdout) as Media
  }

  async function expectPlayable(path: string, seconds: number, audio: boolean, width = 64, height = 48): Promise<void> {
    const media = await inspect(path)
    expect(Math.abs(Number(media.format.duration) - seconds)).toBeLessThan(0.07)
    expect(media.streams.find(stream => stream.codec_type === 'video')).toMatchObject({ codec_name: 'h264', width, height, r_frame_rate: '30/1', pix_fmt: 'yuv420p' })
    if (audio) {
      expect(media.streams.find(stream => stream.codec_type === 'audio')).toMatchObject({ codec_name: 'aac', sample_rate: '48000', channels: 2 })
    } else {
      expect(media.streams.some(stream => stream.codec_type === 'audio')).toBe(false)
    }
    // Probe metadata alone cannot prove the encoded file is decodable.
    await run(tooling!.ffmpeg, ['-nostdin', '-v', 'error', '-xerror', '-i', path, '-f', 'null', '-'], { timeout: 5_000 })
  }

  async function expectColor(path: string, at: number, color: 'red' | 'blue' | 'lime' | 'black', leftEdge = false): Promise<void> {
    const { stdout } = await run(tooling!.ffmpeg, [
      '-nostdin', '-v', 'error', '-ss', String(at), '-i', path,
      '-vf', `crop=2:2:${leftEdge ? '0' : 'iw/2'}:ih/2`,
      '-frames:v', '1', '-threads', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1',
    ], { encoding: 'buffer', timeout: 5_000, maxBuffer: 1024 * 1024 })
    expect(stdout.length).toBe(12)
    const channels = Array.from(stdout.subarray(0, 3))
    const dominant = { red: 0, lime: 1, blue: 2, black: -1 }[color]
    for (const [index, value] of channels.entries()) {
      if (index === dominant) expect(value).toBeGreaterThan(180)
      else expect(value).toBeLessThan(30)
    }
  }

  async function decodeAudio(path: string): Promise<Buffer> {
    const { stdout } = await run(tooling!.ffmpeg, [
      '-nostdin', '-v', 'error', '-i', path, '-map', '0:a:0', '-ar', '48000', '-ac', '1',
      '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1',
    ], { encoding: 'buffer', timeout: 5_000, maxBuffer: 8 * 1024 * 1024 })
    return stdout
  }

  function expectSound(samples: Buffer, start: number, end: number, frequency: number | null): void {
    const first = Math.round(start * 48000)
    const last = Math.round(end * 48000)
    expect(samples.length / 4).toBeGreaterThanOrEqual(last)
    let squareSum = 0, crossings = 0, previous = 0
    for (let index = first; index < last; index += 1) {
      const sample = samples.readFloatLE(index * 4)
      squareSum += sample * sample
      if (index > first && previous <= 0 && sample > 0) crossings += 1
      previous = sample
    }
    const rms = Math.sqrt(squareSum / (last - first))
    if (frequency === null) expect(rms).toBeLessThan(0.002)
    else {
      expect(rms).toBeGreaterThan(0.03)
      expect(Math.abs(crossings / (end - start) - frequency)).toBeLessThan(12)
    }
  }

  async function stitch(name: string, sources: string[]): Promise<string> {
    const output = join(directory, `${name}-output.mp4`)
    await stitchVideos({ tooling: tooling!, inputs: sources.map(source => clips[source]!), output, timeoutMs: 10_000 })
    return output
  }

  it('joins audible scenes in decoded picture and sound order across sizes, codecs, fps and sample rates', async () => {
    const output = await stitch('two-audio', ['red', 'blue'])
    await expectPlayable(output, 2, true)
    await expectColor(output, 0.25, 'red')
    await expectColor(output, 1.25, 'blue')
    await expectColor(output, 1.25, 'black', true)
    const samples = await decodeAudio(output)
    expectSound(samples, 0.2, 0.7, 440)
    expectSound(samples, 1.2, 1.7, 880)
  })

  it('retains sound on both sides of a silent scene without shifting later audio', async () => {
    const output = await stitch('mixed', ['red', 'silent', 'blue'])
    await expectPlayable(output, 3, true)
    await expectColor(output, 1.25, 'lime')
    await expectColor(output, 2.25, 'blue')
    const samples = await decodeAudio(output)
    expectSound(samples, 0.2, 0.7, 440)
    expectSound(samples, 1.2, 1.7, null)
    expectSound(samples, 2.2, 2.7, 880)
  })

  it('keeps fractional-duration scene boundaries aligned to the 30fps output', async () => {
    const output = await stitch('fractional', ['fractional', 'blue'])
    await expectPlayable(output, 1.7, true)
    await expectColor(output, 0.4, 'red')
    await expectColor(output, 0.9, 'blue')
    const samples = await decodeAudio(output)
    expectSound(samples, 0.2, 0.5, 440)
    expectSound(samples, 0.9, 1.4, 880)
  })

  it('pads short audio and trims long audio to each scene’s video duration', async () => {
    const output = await stitch('audio-lengths', ['short-audio', 'long-audio', 'silent'])
    await expectPlayable(output, 3, true)
    await expectColor(output, 1.25, 'blue')
    await expectColor(output, 2.25, 'lime')
    const samples = await decodeAudio(output)
    expectSound(samples, 0.1, 0.3, 440)
    expectSound(samples, 0.6, 0.8, null)
    expectSound(samples, 1.2, 1.7, 880)
    expectSound(samples, 2.2, 2.7, null)
  })

  it('joins silent scenes without creating an audio track', async () => {
    const output = await stitch('silent', ['silent', 'silent-blue'])
    await expectPlayable(output, 2, false)
    await expectColor(output, 0.25, 'lime')
    await expectColor(output, 1.25, 'blue')
  })

  it('exports a single silent scene', async () => {
    await expectPlayable(await stitch('single-silent', ['silent']), 1, false)
  })

  it('resets nonzero timestamps and rounds an odd-sized first scene up to even dimensions', async () => {
    expect(await probeVideo(tooling!, clips['odd-offset']!, 5_000)).toEqual({ width: 65, height: 49, hasAudio: true })
    const output = await stitch('odd-offset', ['odd-offset'])
    await expectPlayable(output, 1, true, 66, 50)
    await expectColor(output, 0.25, 'red')
    expectSound(await decodeAudio(output), 0.2, 0.7, 440)
  })

  it('reports unreadable input by scene index and keeps local paths out of the error', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const corrupt = join(directory, 'private-corrupt-video.mp4')
    await writeFile(corrupt, 'not an MP4')
    const rejected = stitchVideos({ tooling: tooling!, inputs: [clips.red!, corrupt], output: join(directory, 'bad-output.mp4'), timeoutMs: 5_000 })
    await expect(rejected).rejects.toMatchObject({ messageKey: 'exports.video_unreadable', messageParams: { index: 2 } })
    await expect(rejected).rejects.not.toHaveProperty('message', expect.stringContaining(directory))
  })

  it('reports missing ffprobe instead of assuming that the videos are silent', async () => {
    await expect(stitchVideos({ tooling: { ...tooling!, ffprobe: null }, inputs: [clips.red!], output: join(directory, 'no-probe.mp4'), timeoutMs: 5_000 }))
      .rejects.toMatchObject({ messageKey: 'exports.ffmpeg_missing' })
  })

  it('keeps encoder command details and local paths in server logs only', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const rejected = stitchVideos({ tooling: { ...tooling!, ffmpeg: join(directory, 'private-missing-encoder') }, inputs: [clips.red!], output: join(directory, 'no-encoder.mp4'), timeoutMs: 5_000 })
    await expect(rejected).rejects.toMatchObject({ messageKey: 'exports.stitch_failed', messageParams: {} })
    await expect(rejected).rejects.not.toHaveProperty('message', expect.stringContaining(directory))
  })

  it('exports through the real API and worker, downloads playable media and rejects missing sources and another owner', async () => {
    server = await startTestServer({ ffmpegPath: tooling!.ffmpeg === 'ffmpeg' ? '' : tooling!.ffmpeg })
    await registerUser(server)
    const ownerCookie = server.cookie
    const { modelPk } = await seedProviderAndModel(server, 'video')
    const project = await call(server, '/api/projects', { method: 'POST', body: { name: 'Native export project' } })
    expect(project.status).toBe(201)
    const projectId = project.body.project.id as string
    const paths: string[] = []
    const generationIds: string[] = []
    for (const source of ['red', 'blue']) {
      const scene = await call(server, `/api/projects/${projectId}/scenes`, { method: 'POST', body: { title: source, prompt: source, modelId: modelPk } })
      expect(scene.status).toBe(201)
      const generation = await call(server, `/api/scenes/${scene.body.scene.id}/generate`, { method: 'POST', body: { idempotencyKey: `native-export-${source}` } })
      expect(generation.status).toBe(202)
      const generationId = generation.body.generation.id as string
      expect((await waitForGeneration(server, generationId)).status).toBe('succeeded')
      generationIds.push(generationId)
      const asset = server.db.prepare('SELECT id, relative_path FROM assets WHERE generation_id = ?').get(generationId) as { id: string; relative_path: string }
      const path = server.mediaStore.absolutePath(asset.relative_path)
      // Replace only this isolated server’s minimal mock result with a real, generated fixture.
      await copyFile(clips[source]!, path)
      server.db.prepare('UPDATE assets SET byte_size = ? WHERE id = ?').run((await readFile(path)).length, asset.id)
      paths.push(path)
    }

    async function createAndWait() {
      const created = await call(server!, `/api/projects/${projectId}/exports`, { method: 'POST', body: {} })
      expect(created.status).toBe(202)
      const id = created.body.export.id as string
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        await server!.worker.tick()
        const { body } = await call(server!, `/api/exports/${id}`)
        if (body.export.status === 'succeeded' || body.export.status === 'failed') return body.export
        await new Promise(resolve => setTimeout(resolve, 30))
      }
      throw new Error('Native export did not finish')
    }

    const finished = await createAndWait()
    expect(finished.status, JSON.stringify(finished)).toBe('succeeded')
    expect(finished.itemCount).toBe(2)
    expect(finished.progress).toBe(100)
    const download = await fetch(`${server.baseUrl}${finished.downloadUrl}`, { headers: { Cookie: ownerCookie } })
    expect(download.status).toBe(200)
    expect(download.headers.get('content-type')).toContain('video/mp4')
    expect(download.headers.get('content-disposition')).toContain('attachment')
    const downloaded = join(directory, 'downloaded.mp4')
    const bytes = Buffer.from(await download.arrayBuffer())
    expect(bytes.length).toBe(finished.byteSize)
    await writeFile(downloaded, bytes)
    await expectPlayable(downloaded, 2, true)
    await expectColor(downloaded, 0.25, 'red')
    await expectColor(downloaded, 1.25, 'blue')
    const samples = await decodeAudio(downloaded)
    expectSound(samples, 0.2, 0.7, 440)
    expectSound(samples, 1.2, 1.7, 880)
    const spec = server.db.prepare('SELECT spec_json FROM exports WHERE id = ?').get(finished.id) as { spec_json: string }
    expect(JSON.parse(spec.spec_json).items.map((item: { generationId: string }) => item.generationId)).toEqual(generationIds)
    expect((server.db.prepare('SELECT COUNT(*) AS count FROM generations').get() as { count: number }).count).toBe(2)
    expect(await readFile(paths[0]!)).toEqual(await readFile(clips.red!))

    await registerUser(server)
    expect((await call(server, `/api/exports/${finished.id}`)).status).toBe(404)
    expect((await fetch(`${server.baseUrl}${finished.downloadUrl}`, { headers: { Cookie: server.cookie } })).status).toBe(404)

    server.cookie = ownerCookie
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    await writeFile(paths[1]!, 'corrupt video')
    const invalid = await createAndWait()
    expect(invalid.status).toBe('failed')
    expect(invalid.errorCode).toBe('EXPORT_FAILED')
    expect(invalid.errorMessageKey).toBe('exports.video_unreadable')
    expect(invalid.errorMessageParams).toEqual({ index: 2 })
    expect(JSON.stringify(invalid)).not.toContain(server.dir)
    expect(invalid.downloadUrl).toBeNull()
    await rm(paths[1]!)
    const missing = await createAndWait()
    expect(missing.status).toBe('failed')
    expect(missing.errorCode).toBe('MEDIA_MISSING')
    expect(missing.downloadUrl).toBeNull()
    // A failed new export must not invalidate the previously completed video.
    expect((await fetch(`${server.baseUrl}${finished.downloadUrl}`, { headers: { Cookie: ownerCookie } })).status).toBe(200)
  })

  it.each(['projects', 'quick-sessions'] as const)('exports a frozen %s Canvas chain through the API and worker with decoded picture and sound order', async scope => {
    const ctx = await startTestServer({ ffmpegPath: tooling!.ffmpeg === 'ffmpeg' ? '' : tooling!.ffmpeg })
    try {
      await registerUser(ctx)
      // Keep queue timing deterministic: only explicit ticks process these isolated jobs.
      vi.spyOn(ctx.worker, 'wake').mockImplementation(() => {})
      const { modelPk } = await seedProviderAndModel(ctx, 'video')
      const quick = scope === 'quick-sessions'
      const createdScope = await call(ctx, `/api/${scope}`, { method: 'POST', body: quick ? { title: 'Native Canvas' } : { name: 'Native Canvas' } })
      const scopeId = createdScope.body[quick ? 'session' : 'project'].id as string
      const root = `/api/${scope}/${scopeId}/canvas`
      const sceneIds: Record<string, string> = {}
      if (!quick) {
        // Studio scene order deliberately differs from sequence order.
        for (const id of ['c', 'a', 'b']) {
          const scene = await call(ctx, `/api/projects/${scopeId}/scenes`, { method: 'POST', body: { title: id, prompt: id, modelId: modelPk } })
          sceneIds[id] = scene.body.scene.id
        }
      }
      const graph: CanvasGraph = { schemaVersion: 1, nodes: ['c', 'a', 'b', 'single'].flatMap((id, index) => [
        { id: `p-${id}`, kind: 'prompt', x: index * 300, y: 0, data: { text: id } },
        { id, kind: 'video', x: index * 300, y: 350, data: { modelId: modelPk, ...(quick ? {} : { sceneId: sceneIds[id] }) } },
      ]), edges: [
        ...['c', 'a', 'b', 'single'].map(id => ({ id: `prompt-${id}`, source: `p-${id}`, sourcePort: 'prompt', target: id, targetPort: 'prompt' })),
        { id: 'a-b', source: 'a', sourcePort: 'video', target: 'b', targetPort: 'sequence' },
        { id: 'b-c', source: 'b', sourcePort: 'video', target: 'c', targetPort: 'sequence' },
      ] }
      expect((await call(ctx, root, { method: 'PUT', body: { baseRevision: 0, graph } })).status).toBe(200)
      const sources = ['red', 'silent', 'blue']
      const generationIds: string[] = [], sourcePaths: string[] = []
      for (const [index, id] of ['a', 'b', 'c'].entries()) {
        const preview = await call(ctx, `${root}/nodes/${id}/preview`, { method: 'POST', body: { kind: 'video' } })
        expect(preview.status).toBe(200)
        const queued = await call(ctx, `${root}/nodes/${id}/run`, { method: 'POST', body: { kind: 'video', stamp: preview.body.preview.stamp } })
        expect(queued.status).toBe(202)
        const generationId = queued.body.generation.id as string
        expect((await waitForGeneration(ctx, generationId)).status).toBe('succeeded')
        generationIds.push(generationId)
        const asset = ctx.db.prepare('SELECT id,relative_path FROM assets WHERE generation_id=?').get(generationId) as { id: string; relative_path: string }
        const path = ctx.mediaStore.absolutePath(asset.relative_path)
        await copyFile(clips[sources[index]!]!, path)
        ctx.db.prepare('UPDATE assets SET byte_size=? WHERE id=?').run((await readFile(path)).length, asset.id)
        sourcePaths.push(path)
      }
      const preview = await call(ctx, `${root}/exports/preview`, { method: 'POST', body: { nodeId: 'b', baseRevision: 1 } })
      expect(preview.status).toBe(200)
      expect(preview.body.preview.ready).toBe(true)
      expect(preview.body.preview.items.map((item: { nodeId: string }) => item.nodeId)).toEqual(['a', 'b', 'c'])
      const request = { nodeId: 'b', baseRevision: 1, stamp: preview.body.preview.stamp }
      const queued = await call(ctx, `${root}/exports`, { method: 'POST', body: request })
      expect(queued.status).toBe(202)
      expect((await call(ctx, `${root}/exports`, { method: 'POST', body: request })).status).toBe(400)
      if (quick) expect((await call(ctx, `/api/quick-sessions/${scopeId}`, { method: 'DELETE' })).status).toBe(400)
      // The worker must use frozen media and sequence after the user disconnects the canvas.
      const disconnected = { ...graph, edges: graph.edges.filter(edge => edge.targetPort !== 'sequence') }
      expect((await call(ctx, root, { method: 'PUT', body: { baseRevision: 1, graph: disconnected } })).status).toBe(200)
      await ctx.worker.tick()
      const finished = (await call(ctx, `/api/exports/${queued.body.export.id}`)).body.export
      expect(finished.status, JSON.stringify(finished)).toBe('succeeded')
      expect(finished.projectId).toBe(quick ? null : scopeId)
      expect(finished.quickSessionId).toBe(quick ? scopeId : null)
      expect(finished.source).toBe('canvas-chain')
      const download = await fetch(`${ctx.baseUrl}${finished.downloadUrl}`, { headers: { Cookie: ctx.cookie } })
      expect(download.status).toBe(200)
      const output = join(directory, `canvas-${scope}.mp4`)
      await writeFile(output, Buffer.from(await download.arrayBuffer()))
      await expectPlayable(output, 3, true)
      await expectColor(output, 0.25, 'red')
      await expectColor(output, 1.25, 'lime')
      await expectColor(output, 2.25, 'blue')
      const sound = await decodeAudio(output)
      expectSound(sound, 0.2, 0.7, 440)
      expectSound(sound, 1.2, 1.7, null)
      expectSound(sound, 2.2, 2.7, 880)
      const spec = JSON.parse((ctx.db.prepare('SELECT spec_json FROM exports WHERE id=?').get(finished.id) as { spec_json: string }).spec_json)
      expect(spec.items.map((item: { generationId: string }) => item.generationId)).toEqual(generationIds)
      expect((ctx.db.prepare('SELECT COUNT(*) AS count FROM generations').get() as { count: number }).count).toBe(3)
      expect((await call(ctx, `${root}/exports`)).body.exports.map((item: { id: string }) => item.id)).toEqual([finished.id])
      if (quick) {
        const savedPath = (ctx.db.prepare('SELECT relative_path FROM exports WHERE id=?').get(finished.id) as { relative_path: string }).relative_path
        expect((await call(ctx, `/api/quick-sessions/${scopeId}`, { method: 'DELETE' })).status).toBe(204)
        expect((await call(ctx, `/api/exports/${finished.id}`)).status).toBe(404)
        expect(ctx.db.prepare('SELECT path FROM media_cleanup_jobs WHERE path=?').get(savedPath)).toBeTruthy()
        await ctx.worker.tick()
        expect(ctx.mediaStore.exists(savedPath)).toBe(false)
        for (const path of sourcePaths) expect(existsSync(path)).toBe(true)
        for (const id of generationIds) expect(ctx.db.prepare('SELECT quick_session_id FROM generations WHERE id=?').get(id)!.quick_session_id).toBeNull()
      }
    } finally { await ctx.close() }
  })
})
