import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { call, registerUser, startTestServer, type TestContext } from './helpers'
import { recoverSpeechJobs } from '../../server/speech/worker'
import { createSpeechJob } from '../../server/speech/service'
import { isCredentialPinned } from '../../server/providers/credentials'
import type { SpeechJob } from '../../shared/speech'
import { cleanMediaJobs, purgeProject } from '../../server/projectsTrash/service'

const run = promisify(execFile)
let ctx: TestContext
let provider: Server
let directory: string
let mp3: Buffer
let providerId: string
let modelId: string
let userId: string
let baseUrl: string
let behavior = 'ok'
let submissions: Array<{ model: string; input: string; auth: string }> = []
const secret = 'sk-speech-test-do-not-expose-837263'

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'lumina-speech-tests-'))
  const path = join(directory, 'voice.mp3')
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=0.5', '-c:a', 'libmp3lame', path])
  mp3 = await readFile(path)
  provider = createServer(async (req, res) => {
    if (req.url === '/v1/audio/voices?provider=edge-tts') {
      if (behavior === 'catalog401') {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `Unauthorized ${secret}` } }))
      } else {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ data: [
          { id: 'vi-VN-NamMinhNeural', model: 'edge-tts/vi-VN-NamMinhNeural', name: 'Nam Minh' },
          { id: 'vi-VN-HoaiMyNeural', model: 'edge-tts/vi-VN-HoaiMyNeural', name: 'Hoài My' },
        ] }))
      }
      return
    }
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'edge-tts/vi-VN-NamMinhNeural' }, { id: 'unrelated-chat' }] }))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString())
    submissions.push({ ...body, auth: req.headers.authorization ?? '' })
    if (behavior === 'timeout') {
      setTimeout(() => res.end(mp3), 150).unref()
      return
    }
    if (behavior === 'slow') await new Promise(resolve => setTimeout(resolve, 150))
    if (behavior === 'error-stream-timeout') {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.write('{"error":')
      setTimeout(() => res.end('{"message":"Interrupted error body"}}'), 150).unref()
      return
    }
    if (behavior === '401' || behavior === '500') {
      res.writeHead(Number(behavior), { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `Provider rejected ${secret}` } }))
      return
    }
    if (behavior === 'invalid') {
      res.writeHead(200, { 'Content-Type': 'audio/mp3' })
      res.end('<html>This is not audio</html>')
      return
    }
    res.writeHead(200, { 'Content-Type': 'audio/mp3' })
    if (behavior === 'stream-timeout') {
      res.write(mp3.subarray(0, 20))
      setTimeout(() => res.end(mp3.subarray(20)), 150).unref()
      return
    }
    res.end(mp3)
  })
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  const address = provider.address() as { port: number }
  baseUrl = `http://127.0.0.1:${address.port}/v1`
  ctx = await startTestServer({ allowPrivate: true, providerMode: 'live' })
})

afterAll(async () => {
  await ctx?.close()
  if (provider) await new Promise<void>(resolve => provider.close(() => resolve()))
  if (directory) await rm(directory, { recursive: true, force: true })
})

beforeEach(async () => {
  behavior = 'ok'
  submissions = []
  ctx.env.TTS_REQUEST_TIMEOUT_MS = 180_000
  ctx.env.MAX_AUDIO_BYTES = 25 * 1024 * 1024
  ctx.env.MAX_USER_MEDIA_BYTES = 1024 * 1024 * 1024
  userId = (await registerUser(ctx)).userId
  const created = await call(ctx, '/api/providers', { method: 'POST', body: { name: 'Speech provider', baseUrl, apiKey: secret } })
  expect(created.status).toBe(201)
  providerId = created.body.provider.id
  const model = await call(ctx, '/api/models', { method: 'POST', body: { providerId, modelId: 'edge-tts/vi-VN-NamMinhNeural', kind: 'tts' } })
  expect(model.status).toBe(201)
  modelId = model.body.model.id
})

async function wait(id: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await ctx.worker.speech!.tick()
    const job = (await call(ctx, `/api/speech-jobs/${id}`)).body.job
    if (job.status !== 'queued' && job.status !== 'running') return job
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Speech job did not finish')
}

async function create(body: Record<string, unknown> = {}, key?: string) {
  const response = await fetch(`${ctx.baseUrl}/api/speech-jobs`, {
    method: 'POST',
    headers: { Cookie: ctx.cookie, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify({ modelId, input: 'Xin chào, đây là quảng cáo.', ...body }),
  })
  return { status: response.status, json: async () => await response.json() as { job: SpeechJob } }
}

describe('Speech API and durable worker', () => {
  it('creates real playable MP3, pins its model, and supports authenticated byte ranges', async () => {
    const response = await create()
    expect(response.status).toBe(202)
    const job = await wait((await response.json()).job.id)
    expect(job.status).toBe('succeeded')
    expect(job.mimeType).toBe('audio/mpeg')
    expect(job.durationSeconds).toBeGreaterThan(0.49)
    expect(submissions).toEqual([{ model: 'edge-tts/vi-VN-NamMinhNeural', input: 'Xin chào, đây là quảng cáo.', auth: `Bearer ${secret}` }])
    expect(JSON.stringify(job)).not.toContain(secret)
    const file = await fetch(`${ctx.baseUrl}${job.url}`, { headers: { Cookie: ctx.cookie, Range: 'bytes=0-99' } })
    expect(file.status).toBe(206)
    expect((await file.arrayBuffer()).byteLength).toBe(100)
    expect(file.headers.get('content-type')).toBe('audio/mpeg')
    const suffix = await fetch(`${ctx.baseUrl}${job.url}`, { headers: { Cookie: ctx.cookie, Range: 'bytes=-10' } })
    expect(suffix.status).toBe(206)
    expect((await suffix.arrayBuffer()).byteLength).toBe(10)
    expect((await fetch(`${ctx.baseUrl}${job.url}`, { headers: { Cookie: ctx.cookie, Range: 'bytes=9999999-' } })).status).toBe(416)
    expect((await fetch(`${ctx.baseUrl}${job.url}`)).status).toBe(401)
    expect(ctx.mediaStore.userUsageBytes(ctx.db, userId)).toBe(mp3.byteLength)
    expect((await call(ctx, '/api/models?kind=tts')).body.models).toHaveLength(1)
  })

  it('replays a request once and rejects changed payloads using the same key', async () => {
    const first = await (await create({}, 'same-key')).json()
    const replay = await (await create({}, 'same-key')).json()
    expect(replay.job.id).toBe(first.job.id)
    expect((await create({ input: 'Changed script' }, 'same-key')).status).toBe(409)
    await wait(first.job.id)
    expect(submissions).toHaveLength(1)
  })

  it('isolates history, files, preferences and models between accounts', async () => {
    const first = await (await create()).json()
    const job = await wait(first.job.id)
    await registerUser(ctx)
    expect((await call(ctx, `/api/speech-jobs/${job.id}`)).status).toBe(404)
    expect((await call(ctx, `/api/speech-jobs/${job.id}/file`)).status).toBe(404)
    expect((await create()).status).toBe(400)
    expect((await call(ctx, '/api/speech-jobs')).body.jobs).toHaveLength(0)
  })

  it('stores scope preferences and prevents using a voiceover in another scope', async () => {
    const project = (await call(ctx, '/api/projects', { method: 'POST', body: { name: 'Narrated ad' } })).body.project
    const settings = { enabled: true, modelId, input: 'Lời đọc đã lưu', mode: 'mix', originalVolume: 0.2 }
    expect((await call(ctx, '/api/speech-jobs/preferences', { method: 'PUT', body: { scope: { projectId: project.id }, preferences: settings } })).status).toBe(200)
    expect((await call(ctx, `/api/speech-jobs/preferences?projectId=${project.id}`)).body.preferences).toEqual(settings)
    expect((await call(ctx, '/api/speech-jobs/preferences')).body.preferences.enabled).toBe(false)
    expect((await create({ projectId: project.id, quickSessionId: 'not-a-session' })).status).toBe(400)
  })

  it('does not repeat invalid audio, server errors, or incomplete submissions', async () => {
    for (const variant of ['invalid', '500', 'timeout', 'stream-timeout', 'error-stream-timeout']) {
      behavior = variant
      ctx.env.TTS_REQUEST_TIMEOUT_MS = variant.includes('timeout') ? 40 : 180_000
      const first = await (await create()).json()
      const job = await wait(first.job.id)
      expect(job.status).toBe(variant === 'invalid' ? 'failed' : 'unknown')
      expect(JSON.stringify(job)).not.toContain(secret)
      const count = submissions.length
      await ctx.worker.speech!.tick()
      expect(submissions).toHaveLength(count)
      await call(ctx, `/api/speech-jobs/${job.id}`, { method: 'DELETE' })
    }
  })

  it('rejects audio limits and account quota without storing oversized data', async () => {
    ctx.env.MAX_AUDIO_BYTES = 100
    const first = await wait((await (await create()).json()).job.id)
    expect(first.status).toBe('failed')
    expect(first.errorCode).toBe('STORAGE_LIMIT')
    ctx.env.MAX_AUDIO_BYTES = 25 * 1024 * 1024
    ctx.env.MAX_USER_MEDIA_BYTES = 100
    const second = await wait((await (await create()).json()).job.id)
    expect(second.status).toBe('failed')
    expect(ctx.mediaStore.userUsageBytes(ctx.db, userId)).toBe(0)
  })

  it('protects active keys, providers, models and audio from removal', async () => {
    behavior = 'slow'
    const id = (await (await create()).json()).job.id
    const credential = (ctx.db.prepare('SELECT id FROM provider_credentials WHERE provider_id=?').get(providerId) as { id: string }).id
    for (let attempt = 0; attempt < 50 && !isCredentialPinned(ctx.db, credential); attempt += 1) await new Promise(resolve => setTimeout(resolve, 5))
    expect(isCredentialPinned(ctx.db, credential)).toBe(true)
    expect((await call(ctx, `/api/providers/${providerId}`, { method: 'DELETE' })).status).toBe(400)
    expect((await call(ctx, `/api/models/${modelId}`, { method: 'DELETE' })).status).toBe(400)
    expect((await call(ctx, `/api/providers/${providerId}/credentials/${credential}`, { method: 'PATCH', body: { apiKey: 'replacement-key' } })).status).toBe(409)
    expect((await call(ctx, `/api/speech-jobs/${id}`, { method: 'DELETE' })).status).toBe(409)
    expect((await wait(id)).status).toBe('succeeded')
  })

  it('marks interrupted submissions unknown and never submits them after restart', async () => {
    const job = createSpeechJob(ctx.db, ctx.env, ctx.mediaStore, userId, { modelId, input: 'Interrupted request' })
    ctx.db.prepare("UPDATE speech_jobs SET status='running' WHERE id=?").run(job.id)
    recoverSpeechJobs(ctx.db, ctx.mediaStore)
    expect((await call(ctx, `/api/speech-jobs/${job.id}`)).body.job.status).toBe('unknown')
    await ctx.worker.speech!.tick()
    expect(submissions).toHaveLength(0)
  })

  it('uses the speech model field from discovery and preserves explicit classifications', async () => {
    const sync = await call(ctx, `/api/providers/${providerId}/sync-speech-models`, { method: 'POST', body: { catalog: 'edge-tts' } })
    expect(sync.status).toBe(200)
    const models = (await call(ctx, '/api/models?kind=tts')).body.models
    expect(models.map((model: { modelId: string }) => model.modelId)).toContain('edge-tts/vi-VN-HoaiMyNeural')
    expect(models.map((model: { modelId: string }) => model.modelId)).not.toContain('vi-VN-HoaiMyNeural')
    const repeated = await call(ctx, `/api/providers/${providerId}/sync-speech-models`, { method: 'POST', body: { catalog: 'models' } })
    expect(repeated.body.total).toBe(1)
  })

  it('does not poison a working speech credential when the voice catalog returns 401', async () => {
    behavior = 'catalog401'
    const sync = await call(ctx, `/api/providers/${providerId}/sync-speech-models`, { method: 'POST', body: { catalog: 'edge-tts' } })
    expect(sync.status).toBe(502)
    expect(sync.body.error.details.status).toBe(401)
    expect(JSON.stringify(sync.body)).not.toContain(secret)
    expect((await wait((await (await create()).json()).job.id)).status).toBe('succeeded')
  })

  it('cleans speech files and saved preferences when their Quick session is removed', async () => {
    const sessionId = (await call(ctx, '/api/quick-sessions', { method: 'POST', body: { title: 'Speech cleanup' } })).body.session.id
    const queued = await (await create({ quickSessionId: sessionId })).json()
    const job = await wait(queued.job.id)
    const row = ctx.db.prepare('SELECT relative_path FROM speech_jobs WHERE id=?').get(job.id) as { relative_path: string }
    await call(ctx, '/api/speech-jobs/preferences', { method: 'PUT', body: { scope: { quickSessionId: sessionId }, preferences: { modelId, input: job.input, enabled: true } } })
    expect(ctx.mediaStore.exists(row.relative_path)).toBe(true)
    expect((await call(ctx, `/api/quick-sessions/${sessionId}`, { method: 'DELETE' })).status).toBe(204)
    cleanMediaJobs({ db: ctx.db, mediaStore: ctx.mediaStore })
    expect(ctx.mediaStore.exists(row.relative_path)).toBe(false)
    expect(ctx.db.prepare('SELECT 1 FROM narration_preferences WHERE scope=?').get(`quick:${sessionId}`)).toBeUndefined()
    expect(ctx.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('cleans project speech on purge and protects a project with unfinished TTS', async () => {
    const projectId = (await call(ctx, '/api/projects', { method: 'POST', body: { name: 'Project speech cleanup' } })).body.project.id
    const queued = await (await create({ projectId })).json()
    const job = await wait(queued.job.id)
    const row = ctx.db.prepare('SELECT relative_path FROM speech_jobs WHERE id=?').get(job.id) as { relative_path: string }
    purgeProject(ctx.db, { id: projectId, user_id: userId, delete_results: 0 }, Date.now())
    cleanMediaJobs({ db: ctx.db, mediaStore: ctx.mediaStore })
    expect(ctx.mediaStore.exists(row.relative_path)).toBe(false)
    expect(ctx.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    const other = (await call(ctx, '/api/projects', { method: 'POST', body: { name: 'Busy project' } })).body.project.id
    const pending = createSpeechJob(ctx.db, ctx.env, ctx.mediaStore, userId, { modelId, input: 'Not yet submitted', projectId: other })
    expect((await call(ctx, `/api/projects/${other}/trash`, { method: 'POST', body: {} })).status).toBe(400)
    expect((await call(ctx, `/api/speech-jobs/${pending.id}`, { method: 'DELETE' })).status).toBe(204)
  })
})
