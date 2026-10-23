import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'

const run = promisify(execFile)
let ctx: TestContext
let directory: string
let userId: string
let modelId: string
let red: Uint8Array
let blue: Uint8Array
let short: Uint8Array

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'lumina-narrated-export-'))
  async function clip(name: string, color: string, frequency: number, seconds: number) {
    const path = join(directory, name + '.mp4')
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=64x48:r=30:d=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000:duration=${seconds}`, '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path])
    return new Uint8Array(await readFile(path))
  }
  red = await clip('red', 'red', 440, 2)
  blue = await clip('blue', 'blue', 880, 1)
  short = await clip('short', 'red', 440, 0.2)
  ctx = await startTestServer()
})

afterAll(async () => {
  await ctx?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

beforeEach(async () => {
  userId = (await registerUser(ctx)).userId
  const { providerId } = await seedProviderAndModel(ctx, 'video')
  const model = await call(ctx, '/api/models', { method: 'POST', body: { providerId, modelId: 'edge-tts/vi-VN-NamMinhNeural', kind: 'tts' } })
  modelId = model.body.model.id
})

function video(bytes: Uint8Array, projectId?: string, sceneId?: string, quickSessionId?: string) {
  const id = randomUUID()
  ctx.db.prepare(`INSERT INTO generations(id,user_id,kind,prompt,snap_provider,snap_base_url,snap_model_id,status,created_at,updated_at,completed_at,project_id,scene_id,quick_session_id)
    VALUES(?,?,'video','Test video','Test','https://test.invalid/v1','test','succeeded',?,?,?,?,?,?)`)
    .run(id, userId, Date.now(), Date.now(), Date.now(), projectId ?? null, sceneId ?? null, quickSessionId ?? null)
  const saved = ctx.mediaStore.save({ userId, generationId: id, bytes })
  const assetId = randomUUID()
  ctx.db.prepare('INSERT INTO assets(id,generation_id,user_id,relative_path,mime_type,byte_size,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(assetId, id, userId, saved.relativePath, saved.mimeType, saved.byteSize, Date.now())
  return { generationId: id, assetId }
}

async function project(bytes: Uint8Array[] = [red, blue]) {
  const projectId = (await call(ctx, '/api/projects', { method: 'POST', body: { name: 'Narration ad' } })).body.project.id as string
  for (const [index, media] of bytes.entries()) {
    const sceneId = (await call(ctx, `/api/projects/${projectId}/scenes`, { method: 'POST', body: { title: `Scene ${index}` } })).body.scene.id as string
    video(media, projectId, sceneId)
  }
  return projectId
}

async function finish(id: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await ctx.worker.tick()
    const result = (await call(ctx, `/api/exports/${id}`)).body.export
    if (result.status === 'succeeded' || result.status === 'failed') return result
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Narrated export did not finish')
}

async function samples(id: string): Promise<Buffer> {
  const row = ctx.db.prepare('SELECT relative_path FROM exports WHERE id=?').get(id) as { relative_path: string }
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', ctx.mediaStore.absolutePath(row.relative_path), '-map', '0:a:0', '-ar', '48000', '-ac', '1', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 })
  return stdout
}

function amplitude(bytes: Buffer, frequency: number, start = 0.1, end = 0.4) {
  let real = 0
  let imaginary = 0
  const first = Math.round(start * 48000)
  const last = Math.round(end * 48000)
  for (let index = first; index < last; index += 1) {
    const sample = bytes.readFloatLE(index * 4)
    const angle = 2 * Math.PI * frequency * index / 48000
    real += sample * Math.cos(angle)
    imaginary += sample * Math.sin(angle)
  }
  return 2 * Math.hypot(real, imaginary) / (last - first)
}

describe('Narration exports with real FFmpeg', () => {
  it('replaces original speech, preserves video duration, and pads the rest with silence', async () => {
    const projectId = await project()
    const created = await call(ctx, `/api/projects/${projectId}/exports`, { method: 'POST', body: { narration: { modelId, input: 'Consistent advertisement narration' } } })
    expect(created.status).toBe(202)
    expect(created.body.export.speechJobId).toBeTruthy()
    const output = await finish(created.body.export.id)
    expect(output.status).toBe('succeeded')
    expect(output.stage).toBe('succeeded')
    const audio = await samples(output.id)
    expect(audio.length / 4 / 48000).toBeCloseTo(3, 1)
    expect(amplitude(audio, 660)).toBeGreaterThan(0.04)
    expect(amplitude(audio, 440)).toBeLessThan(0.003)
    expect(amplitude(audio, 660, 1.2, 1.5)).toBeLessThan(0.003)
    const file = await fetch(`${ctx.baseUrl}${output.downloadUrl}`, { headers: { Cookie: ctx.cookie } })
    expect(file.status).toBe(200)
    expect(file.headers.get('content-type')).toBe('video/mp4')
  })

  it('mixes original sound at the chosen gain while keeping narration at full gain', async () => {
    const projectId = await project()
    const created = await call(ctx, `/api/projects/${projectId}/exports`, { method: 'POST', body: { narration: { modelId, input: 'Mixed narration', mode: 'mix', originalVolume: 0.15 } } })
    const output = await finish(created.body.export.id)
    expect(output.status).toBe('succeeded')
    const audio = await samples(output.id)
    expect(amplitude(audio, 660)).toBeGreaterThan(0.04)
    expect(amplitude(audio, 440)).toBeGreaterThan(0.008)
    expect(amplitude(audio, 440)).toBeLessThan(0.04)
    expect(amplitude(audio, 880, 2.2, 2.5)).toBeGreaterThan(0.008)
  })

  it('rejects long narration with both durations and keeps the full downloadable speech', async () => {
    const projectId = await project([short])
    const created = await call(ctx, `/api/projects/${projectId}/exports`, { method: 'POST', body: { narration: { modelId, input: 'This speech is too long for a short clip' } } })
    const output = await finish(created.body.export.id)
    expect(output.status).toBe('failed')
    expect(output.errorCode).toBe('NARRATION_TOO_LONG')
    expect(output.errorMessageParams.audioSeconds).toBeGreaterThan(output.errorMessageParams.videoSeconds)
    const speech = (await call(ctx, `/api/speech-jobs/${output.speechJobId}`)).body.job
    expect(speech.status).toBe('succeeded')
    expect(speech.downloadUrl).toBeTruthy()
  })

  it('keeps pending dependencies protected, snapshots inputs and replays export requests', async () => {
    const projectId = await project()
    await ctx.worker.speech!.stop()
    const body = { narration: { modelId, input: 'Frozen script' } }
    async function request(data = body) {
      const response = await fetch(`${ctx.baseUrl}/api/projects/${projectId}/exports`, { method: 'POST', headers: { Cookie: ctx.cookie, 'Content-Type': 'application/json', 'Idempotency-Key': 'narrated-export' }, body: JSON.stringify(data) })
      return { status: response.status, body: await response.json() as { export: { id: string; speechJobId: string | null } } }
    }
    const first = await request()
    expect(first.status).toBe(202)
    const repeated = await request()
    expect(repeated.body.export.id).toBe(first.body.export.id)
    expect((await request({ narration: { modelId, input: 'Different script' } })).status).toBe(409)
    const id = first.body.export.speechJobId
    expect((await call(ctx, `/api/speech-jobs/${id}`, { method: 'DELETE' })).status).toBe(409)
    expect((await call(ctx, `/api/speech-jobs/${id}`)).body.job.input).toBe('Frozen script')
    ctx.worker.speech!.start()
    expect((await finish(first.body.export.id)).status).toBe('succeeded')
  })

  it('reuses a preview without a second speech job and rejects cross-project use', async () => {
    const projectId = await project()
    const other = await project()
    const speech = await call(ctx, '/api/speech-jobs', { method: 'POST', body: { modelId, input: 'Preview to reuse', projectId } })
    await ctx.worker.speech!.tick()
    const count = (await call(ctx, `/api/speech-jobs?projectId=${projectId}`)).body.jobs.length
    expect((await call(ctx, `/api/projects/${other}/exports`, { method: 'POST', body: { narration: { speechJobId: speech.body.job.id } } })).status).toBe(400)
    const created = await call(ctx, `/api/projects/${projectId}/exports`, { method: 'POST', body: { narration: { speechJobId: speech.body.job.id } } })
    expect((await finish(created.body.export.id)).status).toBe('succeeded')
    expect((await call(ctx, `/api/speech-jobs?projectId=${projectId}`)).body.jobs).toHaveLength(count)
  })

  it('exports a Quick Canvas chain with narration and isolates its owner', async () => {
    const sessionId = (await call(ctx, '/api/quick-sessions', { method: 'POST', body: { title: 'Quick narrated ad' } })).body.session.id
    const source = video(red, undefined, undefined, sessionId)
    const root = `/api/quick-sessions/${sessionId}/canvas`
    const graph = { schemaVersion: 1, nodes: [{ id: 'video', kind: 'video', x: 0, y: 0, data: {} }], edges: [] }
    expect((await call(ctx, root, { method: 'PUT', body: { baseRevision: 0, graph } })).status).toBe(200)
    ctx.db.prepare('INSERT INTO quick_canvas_runs(id,session_id,node_id,kind,generation_id,input_stamp,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(randomUUID(), sessionId, 'video', 'video', source.generationId, 'frozen', Date.now())
    const preview = (await call(ctx, `${root}/exports/preview`, { method: 'POST', body: { nodeId: 'video', baseRevision: 1 } })).body.preview
    expect(preview.ready).toBe(true)
    const created = await call(ctx, `${root}/exports`, { method: 'POST', body: { nodeId: 'video', baseRevision: 1, stamp: preview.stamp, narration: { modelId, input: 'Quick narration' } } })
    expect(created.status).toBe(202)
    const output = await finish(created.body.export.id)
    expect(output.status).toBe('succeeded')
    expect(output.quickSessionId).toBe(sessionId)
    expect(amplitude(await samples(output.id), 660)).toBeGreaterThan(0.04)
    await registerUser(ctx)
    expect((await call(ctx, `/api/exports/${output.id}`)).status).toBe(404)
    expect((await call(ctx, `/api/speech-jobs/${output.speechJobId}`)).status).toBe(404)
  })
})
