/**
 * Chẩn đoán provider: trạng thái tổng hợp của pool API key và rò rỉ bí mật từ
 * payload job video.
 *
 * Ba nhóm:
 *   A. Trạng thái `provider.status` suy ra từ CẢ pool (mock, không gọi mạng):
 *      pool rỗng ⇒ `untested`; mọi key bị tắt/auth_failed/cooldown ⇒ `error`;
 *      có key `ok` ⇒ `connected`; đổi Base URL ⇒ `untested` dù key cũ từng `ok`.
 *   B. `readVideoJob` (unit): mọi chuỗi chẩn đoán của provider được rửa key thô
 *      và cắt còn 500 ký tự TRƯỚC khi trả về hoặc ném lỗi.
 *   C. Provider giả HTTP thật (live): payload video dội lại chính API key trong
 *      `error`/`status` không bao giờ lọt vào API, metadata lỗi hay database;
 *      một lần poll thành công trên key đã ghim KHÔNG xoá `auth_failed`/cooldown
 *      do tác vụ khác gây ra.
 */
import { randomUUID } from 'node:crypto'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, startTestServer, waitForGeneration, type TestContext } from './helpers'
import { pollVideoGeneration, readVideoJob } from '../../server/generations/adapters/video'
import type { GenerationRow } from '../../server/generations/types'
import {
  listCredentials,
  recordCredentialResult,
  removeCredential,
  updateCredential,
} from '../../server/providers/credentials'
import { pinnedTargetForRow } from '../../server/providers/pool'

let ctx: TestContext

beforeAll(async () => {
  ctx = await startTestServer()
})

afterAll(async () => {
  if (ctx) await ctx.close()
})

async function newUser(): Promise<string> {
  const { userId } = await registerUser(ctx)
  return userId
}

async function createProvider(apiKey = 'sk-diag-1111'): Promise<{
  userId: string
  providerId: string
  credentialId: string
}> {
  const userId = await newUser()
  const created = await call(ctx, '/api/providers', {
    method: 'POST',
    body: { name: 'Chẩn đoán', baseUrl: 'https://diag.mock.test/v1', apiKey },
  })
  if (created.status !== 201) throw new Error(`Tạo provider thất bại: ${JSON.stringify(created.body)}`)
  return {
    userId,
    providerId: created.body.provider.id,
    credentialId: created.body.provider.credentials[0].id,
  }
}

function providerStatus(body: any, providerId: string): string {
  const found = (body?.providers ?? []).find((item: any) => item.id === providerId)
  if (!found) throw new Error(`Không thấy provider ${providerId} trong danh sách`)
  return found.status
}

// ── A. Trạng thái tổng hợp của provider ─────────────────────────────────────

describe('Trạng thái provider suy ra từ pool', () => {
  it('provider mới (một key chưa kiểm tra) là untested', async () => {
    const { providerId } = await createProvider()
    const list = await call(ctx, '/api/providers')
    expect(providerStatus(list.body, providerId)).toBe('untested')
  })

  it('pool rỗng ⇒ untested, không giữ connected cũ', async () => {
    const { userId, providerId, credentialId } = await createProvider()

    const tested = await call(ctx, `/api/providers/${providerId}/test`, { method: 'POST' })
    expect(tested.status).toBe(200)
    expect(providerStatus((await call(ctx, '/api/providers')).body, providerId)).toBe('connected')

    // Xoá key cuối cùng: không còn gì để kiểm tra ⇒ untested dù cột status cũ
    // vẫn là 'connected'.
    removeCredential(ctx.db, userId, providerId, credentialId)
    const after = await call(ctx, '/api/providers')
    expect(providerStatus(after.body, providerId)).toBe('untested')
    expect(after.body.providers.find((item: any) => item.id === providerId).credentials).toHaveLength(0)
  })

  it('mọi key đều không dùng được (tắt / auth_failed / cooldown) ⇒ error', async () => {
    const { userId, providerId, credentialId } = await createProvider()

    // Key bị tắt.
    updateCredential(ctx.db, ctx.env, userId, providerId, credentialId, { enabled: false })
    expect(providerStatus((await call(ctx, '/api/providers')).body, providerId)).toBe('error')

    // Bật lại nhưng sai quyền.
    updateCredential(ctx.db, ctx.env, userId, providerId, credentialId, { enabled: true })
    recordCredentialResult(ctx.db, credentialId, { status: 401, message: 'invalid key' })
    expect(providerStatus((await call(ctx, '/api/providers')).body, providerId)).toBe('error')

    // Cooldown cũng là "không dùng được".
    recordCredentialResult(ctx.db, credentialId, { status: 429, retryAfterSeconds: 600 })
    expect(providerStatus((await call(ctx, '/api/providers')).body, providerId)).toBe('error')
  })

  it('key dùng được nhưng chưa ok ⇒ untested, không kế thừa connected cũ', async () => {
    const { providerId } = await createProvider('sk-diag-unknown-2222')

    // Mô phỏng dữ liệu cũ: cột status nói 'connected' nhưng pool chưa có bằng
    // chứng 'ok' nào. Không được báo connected chỉ vì cột cũ.
    ctx.db
      .prepare("UPDATE provider_connections SET status = 'connected' WHERE id = ?")
      .run(providerId)
    expect(providerStatus((await call(ctx, '/api/providers')).body, providerId)).toBe('untested')

    // Có bằng chứng ok từ pool ⇒ connected.
    await call(ctx, `/api/providers/${providerId}/test`, { method: 'POST' })
    expect(providerStatus((await call(ctx, '/api/providers')).body, providerId)).toBe('connected')
  })

  it('đổi Base URL buộc untested dù key cũ từng ok, rồi kiểm tra lại mới connected', async () => {
    const { providerId } = await createProvider()

    const tested = await call(ctx, `/api/providers/${providerId}/test`, { method: 'POST' })
    expect(tested.status).toBe(200)
    expect(providerStatus((await call(ctx, '/api/providers')).body, providerId)).toBe('connected')

    const moved = await call(ctx, `/api/providers/${providerId}`, {
      method: 'PATCH',
      body: { baseUrl: 'https://diag-moved.mock.test/v1' },
    })
    expect(moved.status).toBe(200)
    expect(moved.body.provider.status).toBe('untested')
    expect(
      moved.body.provider.credentials.every((item: any) => item.healthStatus === 'unknown'),
    ).toBe(true)

    // Không còn giữ 'connected' nhờ health đo ở URL cũ.
    expect(providerStatus((await call(ctx, '/api/providers')).body, providerId)).toBe('untested')

    await call(ctx, `/api/providers/${providerId}/test`, { method: 'POST' })
    expect(providerStatus((await call(ctx, '/api/providers')).body, providerId)).toBe('connected')
  })
})

// ── B. readVideoJob: rửa key + cắt 500 ký tự ────────────────────────────────

function capturedError(fn: () => unknown): {
  message: string
  messageParams?: Record<string, unknown>
  details?: unknown
} {
  try {
    fn()
  } catch (error) {
    const err = error as {
      message: string
      messageParams?: Record<string, unknown>
      details?: unknown
    }
    return err
  }
  throw new Error('Mong đợi hàm ném lỗi nhưng không ném')
}

describe('readVideoJob không rò rỉ bí mật', () => {
  it('error của provider được rửa key và cắt còn 500 ký tự', () => {
    const secret = 'sk-video-tuyet-mat-9999'
    const snapshot = readVideoJob(
      { id: 'v1', status: 'failed', error: { message: `${secret} ${'x'.repeat(1500)}` } },
      [secret],
    )

    expect(snapshot.state).toBe('failed')
    expect(snapshot.errorMessage).toContain('***')
    expect(snapshot.errorMessage).not.toContain(secret)
    expect(snapshot.errorMessage!.length).toBeLessThanOrEqual(500)
  })

  it('status lạ dội key bị rửa trong message lẫn messageParams', () => {
    const secret = 'sk-video-tuyet-mat-8888'
    const rawState = `${secret}-${'y'.repeat(1500)}`

    const error = capturedError(() => readVideoJob({ id: 'v1', status: rawState }, [secret]))

    expect(error.message).toContain('***')
    expect(error.message).not.toContain(secret)
    expect(String(error.messageParams?.state)).not.toContain(secret)
    expect(String(error.messageParams?.state)).toContain('***')
    expect(String(error.messageParams?.state).length).toBeLessThanOrEqual(500)
    expect(JSON.stringify(error)).not.toContain(secret)
  })

  it('không có secrets thì giữ nguyên hành vi cũ', () => {
    expect(readVideoJob({ id: 'v1', status: 'error', error: { message: 'lỗi' } }).errorMessage).toBe('lỗi')
    expect(() => readVideoJob({ id: 'v1', status: 'khong-biet' })).toThrow()
  })
})

// ── C. Provider giả HTTP thật (live) ────────────────────────────────────────

type Captured = {
  method: string
  path: string
  authorization: string | null
  bodyText: string
}

type Responder = (request: Captured, response: ServerResponse) => void

type FakeProvider = {
  server: Server
  port: number
  captured: Captured[]
  setResponder: (responder: Responder) => void
}

function startFakeProvider(responder: Responder): Promise<FakeProvider> {
  const captured: Captured[] = []
  let current = responder

  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const entry: Captured = {
        method: request.method ?? 'GET',
        path: request.url ?? '',
        authorization: request.headers.authorization ?? null,
        bodyText: Buffer.concat(chunks).toString('utf8'),
      }
      captured.push(entry)
      current(entry, response)
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: (server.address() as { port: number }).port,
        captured,
        setResponder(next) {
          current = next
        },
      })
    })
  })
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(payload))
}

type LiveHarness = {
  live: TestContext
  fake: FakeProvider
  userId: string
  providerId: string
  credentialId: string
  modelId: string
  baseUrl: string
}

async function withLiveHarness(
  options: { apiKey: string; responder: Responder },
  run: (harness: LiveHarness) => Promise<void>,
): Promise<void> {
  const fake = await startFakeProvider(options.responder)
  const live = await startTestServer({ allowPrivate: true, providerMode: 'live' })
  try {
    const { userId } = await registerUser(live)
    const baseUrl = `http://127.0.0.1:${fake.port}/v1`
    const created = await call(live, '/api/providers', {
      method: 'POST',
      body: { name: 'Chẩn đoán live', baseUrl, apiKey: options.apiKey },
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const providerId = created.body.provider.id
    const credentialId = created.body.provider.credentials[0].id

    const model = await call(live, '/api/models', {
      method: 'POST',
      body: {
        providerId,
        modelId: `diag-video-${randomUUID().slice(0, 8)}`,
        displayName: 'Diag video',
        kind: 'video',
      },
    })
    expect(model.status).toBe(201)

    await run({
      live,
      fake,
      userId,
      providerId,
      credentialId,
      modelId: model.body.model.id,
      baseUrl,
    })
  } finally {
    await live.close().catch(() => undefined)
    await new Promise<void>((resolve) => fake.server.close(() => resolve()))
  }
}

/** Xếp một tác vụ video và chạy worker tới khi provider đã cấp ID job. */
async function startVideoJob(harness: LiveHarness, prompt: string): Promise<string> {
  const created = await call(harness.live, '/api/generations', {
    method: 'POST',
    body: { modelId: harness.modelId, prompt },
  })
  expect(created.status, JSON.stringify(created.body)).toBe(202)
  const id = created.body.generation.id as string

  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    await harness.live.worker.tick()
    const row = harness.live.db
      .prepare('SELECT provider_job_id AS jobId FROM generations WHERE id = ?')
      .get(id) as { jobId: string | null }
    if (row.jobId) return id
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Tác vụ ${id} không nhận được provider_job_id`)
}

function generationRow(harness: LiveHarness, id: string): GenerationRow {
  return harness.live.db.prepare('SELECT * FROM generations WHERE id = ?').get(id) as GenerationRow
}

describe('Payload video dội key không lọt ra API/DB', () => {
  it('job thất bại ngay ở POST: errorMessage và metadata đều bị rửa + cắt', async () => {
    const secret = 'sk-video-post-tuyet-mat-7777'
    const jobId = 'job-diagnostic-1'

    await withLiveHarness(
      {
        apiKey: secret,
        responder: (request, response) => {
          if (request.method === 'POST' && request.path === '/v1/videos') {
            return json(response, 200, {
              id: jobId,
              status: 'failed',
              error: { message: `${secret} ${'x'.repeat(1500)}` },
            })
          }
          return json(response, 404, { error: 'not found' })
        },
      },
      async (harness) => {
        // Provider báo job 'failed' ngay ở POST nên không có provider_job_id:
        // worker chốt thất bại trong vòng xử lý đầu tiên.
        const created = await call(harness.live, '/api/generations', {
          method: 'POST',
          body: { modelId: harness.modelId, prompt: 'video lỗi ngay' },
        })
        expect(created.status, JSON.stringify(created.body)).toBe(202)
        const id = created.body.generation.id as string
        const done = await waitForGeneration(harness.live, id, { timeoutMs: 15_000 })

        expect(done.status).toBe('failed')
        expect(String(done.errorMessage)).toContain('***')
        expect(String(done.errorMessage)).not.toContain(secret)
        expect(String(done.errorMessage).length).toBeLessThanOrEqual(500)
        expect(JSON.stringify(done)).not.toContain(secret)

        const params = done.errorMessageParams as Record<string, unknown>
        expect(String(params?.detail)).not.toContain(secret)
        expect(String(params?.detail).length).toBeLessThanOrEqual(500)

        const stored = harness.live.db
          .prepare('SELECT error_message AS message, error_message_params AS params FROM generations WHERE id = ?')
          .get(id) as { message: string | null; params: string | null }
        expect(stored.message ?? '').not.toContain(secret)
        expect(stored.params ?? '').not.toContain(secret)
        expect((stored.message ?? '').length).toBeLessThanOrEqual(500)
      },
    )
  })

  it('poll gặp status lạ dội key: lỗi bị rửa + cắt', async () => {
    const secret = 'sk-video-poll-tuyet-mat-6666'
    const jobId = 'job-diagnostic-2'
    const pollState = `${secret}-${'z'.repeat(1500)}`

    await withLiveHarness(
      {
        apiKey: secret,
        responder: (request, response) => {
          if (request.method === 'POST' && request.path === '/v1/videos') {
            return json(response, 200, { id: jobId, status: 'queued', progress: 0 })
          }
          if (request.method === 'GET' && request.path === `/v1/videos/${jobId}`) {
            return json(response, 200, { id: jobId, status: pollState, progress: 10 })
          }
          return json(response, 404, { error: 'not found' })
        },
      },
      async (harness) => {
        const id = await startVideoJob(harness, 'video poll lạ')
        const row = generationRow(harness, id)
        const target = pinnedTargetForRow(harness.live.db, harness.live.env, row)!

        const error = await pollVideoGeneration({
          generation: row,
          provider: target,
          db: harness.live.db,
          mediaStore: harness.live.mediaStore,
          env: harness.live.env,
        }).then(
          () => null,
          (thrown: unknown) => thrown as { message: string; messageParams?: Record<string, unknown>; details?: unknown },
        )

        expect(error).toBeTruthy()
        expect(error!.message).toContain('***')
        expect(error!.message).not.toContain(secret)
        expect(String(error!.messageParams?.state)).not.toContain(secret)
        expect(String(error!.messageParams?.state).length).toBeLessThanOrEqual(500)
        expect(JSON.stringify(error)).not.toContain(secret)
      },
    )
  })

  it('poll/tải thành công trên key đã ghim không xoá auth_failed/cooldown', async () => {
    const secret = 'sk-video-observe-tuyet-mat-5555'
    const jobId = 'job-diagnostic-3'

    await withLiveHarness(
      {
        apiKey: secret,
        responder: (request, response) => {
          if (request.method === 'POST' && request.path === '/v1/videos') {
            return json(response, 200, { id: jobId, status: 'queued', progress: 0 })
          }
          if (request.method === 'GET' && request.path === `/v1/videos/${jobId}`) {
            return json(response, 200, { id: jobId, status: 'completed', progress: 100 })
          }
          return json(response, 404, { error: 'not found' })
        },
      },
      async (harness) => {
        const id = await startVideoJob(harness, 'video observe')
        const row = generationRow(harness, id)
        const target = pinnedTargetForRow(harness.live.db, harness.live.env, row)!

        // Tác vụ KHÁC vừa đánh dấu key này sai quyền.
        recordCredentialResult(harness.live.db, harness.credentialId, { status: 401, message: 'invalid key' })
        expect(listCredentials(harness.live.db, harness.userId, harness.providerId)[0]!.healthStatus).toBe(
          'auth_failed',
        )

        const snapshot = await pollVideoGeneration({
          generation: row,
          provider: target,
          db: harness.live.db,
          mediaStore: harness.live.mediaStore,
          env: harness.live.env,
        })
        expect(snapshot.state).toBe('completed')
        expect(listCredentials(harness.live.db, harness.userId, harness.providerId)[0]!.healthStatus).toBe(
          'auth_failed',
        )

        // Cooldown do tác vụ khác cũng phải được giữ nguyên.
        recordCredentialResult(harness.live.db, harness.credentialId, {
          status: 429,
          retryAfterSeconds: 600,
        })
        const cooling = listCredentials(harness.live.db, harness.userId, harness.providerId)[0]!
        expect(cooling.healthStatus).toBe('cooldown')
        const cooldownUntil = cooling.cooldownUntil

        await pollVideoGeneration({
          generation: row,
          provider: target,
          db: harness.live.db,
          mediaStore: harness.live.mediaStore,
          env: harness.live.env,
        })
        const after = listCredentials(harness.live.db, harness.userId, harness.providerId)[0]!
        expect(after.healthStatus).toBe('cooldown')
        expect(after.cooldownUntil).toBe(cooldownUntil)

        // Không hề gửi lại POST /videos.
        const posts = harness.fake.captured.filter(
          (entry) => entry.method === 'POST' && entry.path === '/v1/videos',
        )
        expect(posts).toHaveLength(1)
      },
    )
  })
})

describe('Lỗi mạng thô từ readWithPool', () => {
  it('GET /models không kết nối được ⇒ 502 có khoá ngữ nghĩa, không lộ key', async () => {
    const secret = 'sk-diag-network-4444'

    await withLiveHarness(
      {
        apiKey: secret,
        responder: (_request, response) => json(response, 200, { data: [] }),
      },
      async (harness) => {
        // Đóng provider giả: request kế tiếp sẽ lỗi mạng thô (ECONNREFUSED),
        // không phải AppError của tầng pool.
        await new Promise<void>((resolve) => harness.fake.server.close(() => resolve()))

        const result = await call(harness.live, `/api/providers/${harness.providerId}/test`, {
          method: 'POST',
        })

        expect(result.status, JSON.stringify(result.body)).toBe(502)
        expect(result.body.error.code).toBe('PROVIDER_ERROR')
        expect(result.body.error.messageKey).toBe('providers.test_failed')
        expect(String(result.body.error.message)).toContain('Kết nối provider thất bại')
        expect(JSON.stringify(result.body)).not.toContain(secret)
      },
    )
  })
})
