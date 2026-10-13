import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { postprocessGenerationLogos } from '../../server/entityLibrary/postprocess'
import type { ResolvedLogoOverlay } from '../../server/entityLibrary/overlay'
import type { GenerationRow } from '../../server/generations/types'
import { createWorker } from '../../server/generations/worker'
import * as logoOverlay from '../../server/entityLibrary/overlay'
import * as ffmpeg from '../../server/exports/ffmpeg'
import * as imageAdapter from '../../server/generations/adapters/image'
import * as videoAdapter from '../../server/generations/adapters/video'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'

let ctx: TestContext
let userId: string
let logo: ResolvedLogoOverlay
const nativeImage = (colour: string) => sharp({ create: { width: 12, height: 8, channels: 4, background: colour } }).png().toBuffer()

beforeEach(async () => {
  ctx = await startTestServer()
  userId = (await registerUser(ctx)).userId
  const bytes = await nativeImage('#ff0000')
  const saved = ctx.mediaStore.saveUpload({ userId, uploadId: randomUUID(), bytes, maxBytes: ctx.env.MAX_IMAGE_BYTES })
  logo = { entityId: 'snapshotted-logo', path: saved.relativePath, mime: saved.mimeType, x: 0, y: 0, width: 0.5, opacity: 1 }
})
afterEach(async () => {
  vi.restoreAllMocks()
  if (ctx) await ctx.close()
})

function generation(kind: 'image' | 'video' = 'image', snapshot: unknown = [logo]): GenerationRow {
  const id = randomUUID()
  ctx.db.prepare(`INSERT INTO generations (id, user_id, kind, prompt, params_json, snap_provider, snap_base_url, snap_model_id,
    status, logo_overlays_json, created_at, updated_at) VALUES (?, ?, ?, 'local test', '{}', 'deleted provider', '', 'test', 'succeeded', ?, ?, ?)`)
    .run(id, userId, kind, snapshot === null ? null : JSON.stringify(snapshot), Date.now(), Date.now())
  return row(id)
}
function row(id: string): GenerationRow {
  return ctx.db.prepare('SELECT * FROM generations WHERE id = ?').get(id) as GenerationRow
}
function assets(id: string): Array<{ id: string; relative_path: string; variant: string; source_asset_id: string | null }> {
  return ctx.db.prepare('SELECT * FROM assets WHERE generation_id = ? ORDER BY created_at, id').all(id) as ReturnType<typeof assets>
}
function original(g: GenerationRow, bytes: Uint8Array, index = 0): string {
  const saved = ctx.mediaStore.save({ userId, generationId: g.id, bytes, index })
  const id = randomUUID()
  ctx.db.prepare('INSERT INTO assets (id, generation_id, user_id, relative_path, mime_type, byte_size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, g.id, userId, saved.relativePath, saved.mimeType, saved.byteSize, Date.now())
  return id
}
const run = (g: GenerationRow) => postprocessGenerationLogos({ db: ctx.db, mediaStore: ctx.mediaStore, env: ctx.env, generation: g })

 describe('Local exact-logo derived outputs', () => {
  it('composites every native image without overwriting originals or orphan numbered files', async () => {
    const g = generation()
    const blue = await nativeImage('#0000ff')
    const ids = [original(g, blue, 0), original(g, blue, 1), original(g, blue, 2)]
    const orphan = ctx.mediaStore.save({ userId, generationId: g.id, bytes: blue, index: 3 })
    expect((await run(g)).status).toBe('succeeded')
    const saved = assets(g.id)
    expect(saved).toHaveLength(6)
    const derived = saved.filter(asset => asset.variant === 'logo_overlay')
    expect(new Set(derived.map(asset => asset.source_asset_id))).toEqual(new Set(ids))
    expect(derived.map(asset => asset.relative_path).sort()).toEqual([4, 5, 6].map(index => `${userId}/${g.id}/output-${index}.png`))
    for (const asset of saved.filter(asset => asset.variant === 'original')) {
      expect(Buffer.from(ctx.mediaStore.readFile(asset.relative_path))).toEqual(blue)
    }
    expect(Buffer.from(ctx.mediaStore.readFile(orphan.relativePath))).toEqual(blue)
    const { data } = await sharp(ctx.mediaStore.readFile(derived[0]!.relative_path)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    expect(Array.from(data.slice(0, 4))).toEqual([255, 0, 0, 255])
    expect(Array.from(data.slice(11 * 4, 12 * 4))).toEqual([0, 0, 255, 255])
    expect(row(g.id)).toMatchObject({ status: 'succeeded', postprocess_status: 'succeeded', postprocess_error: null })
  })

  it('is idempotent, uses persisted snapshots, and claims concurrent invocations once', async () => {
    const g = generation()
    original(g, await nativeImage('#0000ff'))
    const stale = { ...g, logo_overlays_json: '[{"path":"invalid-client-value"}]' }
    const results = await Promise.all([run(stale), run(stale)])
    expect(results.map(result => result.status)).toContain('succeeded')
    const first = assets(g.id)
    expect(first).toHaveLength(2)
    // A completed derivative does not depend on a current entity/logo file.
    ctx.mediaStore.remove(logo.path)
    expect((await run(g)).status).toBe('succeeded')
    ctx.db.prepare("UPDATE generations SET postprocess_status = 'queued' WHERE id = ?").run(g.id)
    // Existing derivatives should be checked before loading snapshot logo files.
    const saveSpy = vi.spyOn(ctx.mediaStore, 'save')
    const result = await run(g)
    expect(result.derivedAssetIds).toHaveLength(1)
    expect(saveSpy).not.toHaveBeenCalled()
    expect(assets(g.id)).toEqual(first)
  })

  it('records a local failure but retains usable immutable provider originals', async () => {
    const g = generation('image', [{ ...logo, path: `${userId}/uploads/missing/source.png` }])
    const blue = await nativeImage('#0000ff')
    original(g, blue)
    expect((await run(g)).status).toBe('failed')
    expect(row(g.id)).toMatchObject({ status: 'succeeded', postprocess_status: 'failed' })
    expect((row(g.id) as GenerationRow & { postprocess_error: string }).postprocess_error).not.toContain(ctx.dir)
    expect(assets(g.id)).toHaveLength(1)
    expect(Buffer.from(ctx.mediaStore.readFile(assets(g.id)[0]!.relative_path))).toEqual(blue)
  })

  it('checks quota per derivative and retries partial output without duplicate composites', async () => {
    const g = generation()
    const blue = await nativeImage('#0000ff')
    original(g, blue, 0)
    original(g, blue, 1)
    const composite = await sharp(blue).composite([{ input: await nativeImage('#ff0000'), left: 0, top: 0 }]).png().toBuffer()
    ctx.env.MAX_USER_MEDIA_BYTES = ctx.mediaStore.userUsageBytes(ctx.db, userId) + composite.byteLength + 15
    const first = await run(g)
    expect(first.status).toBe('failed')
    expect(first.derivedAssetIds).toHaveLength(1)
    ctx.env.MAX_USER_MEDIA_BYTES = 1024 * 1024
    const second = await run(g)
    expect(second.status).toBe('succeeded')
    expect(second.derivedAssetIds).toHaveLength(2)
    expect(second.derivedAssetIds).toEqual(expect.arrayContaining(first.derivedAssetIds))
    expect(assets(g.id)).toHaveLength(4)
  })

  it('skips generations without overlays and rejects foreign snapshot files', async () => {
    const skipped = generation('image', null)
    expect((await run(skipped)).status).toBe('skipped')
    expect(row(skipped.id)).toMatchObject({ postprocess_status: null })
    const foreign = generation('image', [{ ...logo, path: 'other-account/logo.png' }])
    original(foreign, await nativeImage('#0000ff'))
    expect((await run(foreign)).status).toBe('failed')
    expect(assets(foreign.id)).toHaveLength(1)
  })

  it('retains video originals on unavailable ffmpeg without loading/overwriting outputs', async () => {
    const g = generation('video')
    const bytes = Buffer.alloc(32)
    bytes.writeUInt32BE(32, 0)
    bytes.write('ftypisom', 4)
    original(g, bytes)
    ctx.env.FFMPEG_PATH = `${ctx.dir}/missing-ffmpeg`
    expect((await run(g)).status).toBe('failed')
    expect(assets(g.id)).toHaveLength(1)
    expect(Buffer.from(ctx.mediaStore.readFile(assets(g.id)[0]!.relative_path))).toEqual(bytes)
    expect(row(g.id).status).toBe('succeeded')
  })

  it('bounds video output before save and cleans temporary output on success and failure', async () => {
    const g = generation('video')
    const bytes = Buffer.alloc(32)
    bytes.writeUInt32BE(32, 0)
    bytes.write('ftypisom', 4)
    original(g, bytes)
    vi.spyOn(ffmpeg, 'resolveFfmpeg').mockResolvedValue({ ffmpeg: 'test', ffprobe: 'test' })
    let temporaryOutput = ''
    const overlay = vi.spyOn(logoOverlay, 'overlayLogoVideo').mockImplementation(async options => {
      temporaryOutput = options.output
      expect(options.input).not.toBe(options.output)
      expect(options.timeoutMs).toBeLessThanOrEqual(3_600_000)
      await writeFile(options.output, Buffer.concat([bytes, Buffer.alloc(32)]))
      return { width: 12, height: 8, hasAudio: false }
    })
    ctx.env.MAX_VIDEO_BYTES = 40
    const save = vi.spyOn(ctx.mediaStore, 'save')
    expect((await run(g)).status).toBe('failed')
    expect(save).not.toHaveBeenCalled()
    expect(existsSync(temporaryOutput)).toBe(false)
    expect(assets(g.id)).toHaveLength(1)
    ctx.env.MAX_VIDEO_BYTES = 1000
    overlay.mockImplementation(async options => {
      temporaryOutput = options.output
      await writeFile(options.output, bytes)
      return { width: 12, height: 8, hasAudio: false }
    })
    expect((await run(g)).status).toBe('succeeded')
    expect(assets(g.id)).toHaveLength(2)
    expect(existsSync(temporaryOutput)).toBe(false)
  })

  it('worker saves provider image then applies native overlay; local failure never becomes provider failure', async () => {
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    vi.spyOn(ctx.worker, 'wake').mockImplementation(() => {})
    const adapter = vi.spyOn(imageAdapter, 'runImageGeneration').mockImplementation(async context => {
      original(context.generation, await nativeImage('#0000ff'))
      return undefined
    })
    const created = await call(ctx, '/api/generations', { method: 'POST', body: { modelId: modelPk, prompt: 'Native image test' } })
    const id = created.body.generation.id
    ctx.db.prepare('UPDATE generations SET logo_overlays_json = ? WHERE id = ?').run(JSON.stringify([logo]), id)
    await ctx.worker.tick()
    expect(adapter).toHaveBeenCalledTimes(1)
    expect(row(id)).toMatchObject({ status: 'succeeded', postprocess_status: 'succeeded' })
    expect(assets(id)).toHaveLength(2)
    const failed = await call(ctx, '/api/generations', { method: 'POST', body: { modelId: modelPk, prompt: 'Missing logo' } })
    ctx.db.prepare('UPDATE generations SET logo_overlays_json = ? WHERE id = ?')
      .run(JSON.stringify([{ ...logo, path: `${userId}/missing.png` }]), failed.body.generation.id)
    await ctx.worker.tick()
    expect(row(failed.body.generation.id)).toMatchObject({ status: 'succeeded', error_code: null, postprocess_status: 'failed' })
    expect(assets(failed.body.generation.id)).toHaveLength(1)
  })

  it('worker retries queued local work even after provider removal without adapter or network calls', async () => {
    const g = generation()
    original(g, await nativeImage('#0000ff'))
    ctx.db.prepare("UPDATE generations SET postprocess_status = 'queued' WHERE id = ?").run(g.id)
    const image = vi.spyOn(imageAdapter, 'runImageGeneration')
    const video = vi.spyOn(videoAdapter, 'startVideoGeneration')
    const download = vi.spyOn(videoAdapter, 'downloadVideoContent')
    const network = vi.spyOn(globalThis, 'fetch')
    await ctx.worker.tick()
    expect(row(g.id)).toMatchObject({ status: 'succeeded', postprocess_status: 'succeeded' })
    expect(assets(g.id)).toHaveLength(2)
    expect(image).not.toHaveBeenCalled()
    expect(video).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
    expect(network).not.toHaveBeenCalled()
  })

  it('restart recovers persisted originals without re-submitting provider work', async () => {
    const g = generation()
    original(g, await nativeImage('#0000ff'))
    ctx.db.prepare("UPDATE generations SET status = 'running', postprocess_status = 'running' WHERE id = ?").run(g.id)
    const image = vi.spyOn(imageAdapter, 'runImageGeneration')
    const download = vi.spyOn(videoAdapter, 'downloadVideoContent')
    ctx.worker.start()
    await ctx.worker.stop()
    const retry = createWorker({ db: ctx.db, mediaStore: ctx.mediaStore, env: ctx.env })
    await retry.tick()
    await retry.stop()
    expect(row(g.id)).toMatchObject({ status: 'succeeded', postprocess_status: 'succeeded' })
    expect(image).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
    expect(assets(g.id)).toHaveLength(2)
    expect(assets(g.id).filter(asset => asset.variant === 'original')).toHaveLength(1)
  })
})
