/**
 * Định tuyến API key theo pool ở tầng RUNTIME (worker + adapter + LLM).
 *
 * Bài test dựng provider giả HTTP thật trên 127.0.0.1 (chế độ `live`) và chèn
 * provider/credential thẳng vào database để không phụ thuộc hợp đồng của
 * `POST /api/providers`. Các hành vi được kiểm chứng:
 *
 *   - 401 ⇒ thử key kế tiếp; RR chỉ tiến một lần cho mỗi tác vụ mới.
 *   - 5xx / bad-2xx / lỗi mạng ⇒ KHÔNG gửi lại (tránh tính phí hai lần).
 *   - 4xx khác ⇒ dừng hẳn, tác vụ thất bại rõ ràng.
 *   - poll/tải video luôn dùng đúng key + URL đã ghim, kể cả khi key đã bị tắt.
 *   - retry-download đặt lại `poll_started_at` và không tạo job mới.
 *   - key thô không bao giờ lộ trong chẩn đoán lỗi.
 */
import { randomUUID } from 'node:crypto'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { call, registerUser, startTestServer, waitForGeneration, type TestContext } from './helpers'
import { MOCK_PNG_BYTES, mockVideoContent } from '../../server/generations/adapters/mock'
import { callProvider } from '../../server/providers/client'
import { readWithPool, submitWithPool } from '../../server/providers/pool'
import {
  addCredential,
  listCredentials,
  setProviderSelectionMode,
  updateCredential,
  type ProviderCredential,
} from '../../server/providers/credentials'

// ── Provider giả HTTP ────────────────────────────────────────────────────────

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

const PNG_B64 = Buffer.from(MOCK_PNG_BYTES).toString('base64')
const VIDEO_BYTES = mockVideoContent()

/** Chèn provider thẳng vào DB (cột legacy chỉ là blob giả, không được dùng). */
function insertProvider(
  context: TestContext,
  userId: string,
  baseUrl: string,
  mode: 'failover' | 'round_robin' = 'failover',
): string {
  const id = randomUUID()
  const now = Date.now()
  const dummy = Buffer.from([0, 1, 2, 3])
  context.db
    .prepare(
      `INSERT INTO provider_connections
         (id, user_id, name, base_url, api_key_ciphertext, api_key_iv, api_key_tag, key_hint,
          image_api_style, status, selection_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '', 'openai', 'untested', ?, ?, ?)`,
    )
    .run(id, userId, `Routing ${id.slice(0, 6)}`, baseUrl, dummy, dummy, dummy, mode, now, now)
  return id
}

type Harness = {
  live: TestContext
  fake: FakeProvider
  userId: string
  providerId: string
  baseUrl: string
  modelId: string
  credentials: ProviderCredential[]
}

type HarnessConfig = {
  kind: 'image' | 'video'
  keys: Array<{ apiKey: string; position?: number; enabled?: boolean }>
  mode?: 'failover' | 'round_robin'
  responder: Responder
}

const openHarnesses: Array<{ live: TestContext; fake: FakeProvider }> = []

async function withHarness(config: HarnessConfig, run: (harness: Harness) => Promise<void>): Promise<void> {
  const fake = await startFakeProvider(config.responder)
  const live = await startTestServer({ allowPrivate: true, providerMode: 'live' })
  openHarnesses.push({ live, fake })

  try {
    const { userId } = await registerUser(live)
    const baseUrl = `http://127.0.0.1:${fake.port}/v1`
    const providerId = insertProvider(live, userId, baseUrl, config.mode ?? 'failover')

    const credentials = config.keys.map((key) =>
      addCredential(live.db, live.env, userId, providerId, {
        apiKey: key.apiKey,
        position: key.position,
        enabled: key.enabled,
      }),
    )

    const model = await call(live, '/api/models', {
      method: 'POST',
      body: {
        providerId,
        modelId: `routing-${config.kind}-${randomUUID().slice(0, 8)}`,
        displayName: 'Routing',
        kind: config.kind,
      },
    })
    expect(model.status).toBe(201)

    await run({ live, fake, userId, providerId, baseUrl, modelId: model.body.model.id, credentials })
  } finally {
    await closeHarness(live, fake)
  }
}

async function closeHarness(live: TestContext, fake: FakeProvider): Promise<void> {
  const index = openHarnesses.findIndex((item) => item.live === live)
  if (index >= 0) openHarnesses.splice(index, 1)
  await live.close()
  await new Promise<void>((resolve) => fake.server.close(() => resolve()))
}

afterEach(async () => {
  // Dọn mọi harness còn sót nếu một bài test ném lỗi giữa chừng.
  const leftover = openHarnesses.splice(0)
  for (const item of leftover) {
    await item.live.close().catch(() => undefined)
    await new Promise<void>((resolve) => item.fake.server.close(() => resolve()))
  }
})

/** Xếp một tác vụ và chờ tới trạng thái kết thúc. */
async function runGeneration(harness: Harness, prompt: string): Promise<any> {
  const created = await call(harness.live, '/api/generations', {
    method: 'POST',
    body: { modelId: harness.modelId, prompt },
  })
  expect(created.status).toBe(202)
  return waitForGeneration(harness.live, created.body.generation.id, { timeoutMs: 20_000 })
}

/** Cho worker chạy tới khi provider đã cấp ID job (đồng bộ, tránh đua với wake()). */
async function startGeneration(harness: Harness, prompt: string): Promise<string> {
  const created = await call(harness.live, '/api/generations', {
    method: 'POST',
    body: { modelId: harness.modelId, prompt },
  })
  expect(created.status).toBe(202)
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

function polarize(harness: Harness, path: string): Array<string | null> {
  return harness.fake.captured.filter((entry) => entry.path === path).map((entry) => entry.authorization)
}

function bearer(key: string): string {
  return `Bearer ${key}`
}

// ════════════════════════════════════════════════════════════════════════════

describe('Định tuyến pool: đổi key khi 401/403/429', () => {
  it('401 ở key đầu ⇒ tự chuyển sang key kế và hoàn tất', async () => {
    const keyA = 'sk-routing-auth-a-1111'
    const keyB = 'sk-routing-auth-b-2222'

    await withHarness(
      {
        kind: 'image',
        keys: [{ apiKey: keyA, position: 0 }, { apiKey: keyB, position: 1 }],
        responder: (request, response) => {
          if (request.path !== '/v1/images/generations') return json(response, 404, { error: 'not found' })
          if (request.authorization === bearer(keyA)) {
            return json(response, 401, { error: { message: 'invalid api key' } })
          }
          return json(response, 200, { data: [{ b64_json: PNG_B64 }] })
        },
      },
      async (harness) => {
        const done = await runGeneration(harness, 'failover 401')

        expect(done.status).toBe('succeeded')
        expect(done.assets.length).toBeGreaterThan(0)

        // Chỉ MỘT yêu cầu gửi lại, sang đúng key kế tiếp.
        expect(polarize(harness, '/v1/images/generations')).toEqual([bearer(keyA), bearer(keyB)])

        // Key bị 401 được đánh dấu sai quyền để không dùng cho tác vụ mới.
        const keys = listCredentials(harness.live.db, harness.userId, harness.providerId)
        expect(keys[0]!.healthStatus).toBe('auth_failed')
        expect(keys[1]!.healthStatus).toBe('ok')
      },
    )
  })

  it('round-robin: mỗi tác vụ mới dùng key kế tiếp và con trỏ tiến đúng một lần', async () => {
    const keyA = 'sk-routing-rr-a-1111'
    const keyB = 'sk-routing-rr-b-2222'

    await withHarness(
      {
        kind: 'image',
        mode: 'round_robin',
        keys: [{ apiKey: keyA, position: 0 }, { apiKey: keyB, position: 1 }],
        responder: (request, response) => {
          if (request.path !== '/v1/images/generations') return json(response, 404, { error: 'not found' })
          return json(response, 200, { data: [{ b64_json: PNG_B64 }] })
        },
      },
      async (harness) => {
        const first = await runGeneration(harness, 'rr 1')
        expect(first.status).toBe('succeeded')

        const second = await runGeneration(harness, 'rr 2')
        expect(second.status).toBe('succeeded')

        expect(polarize(harness, '/v1/images/generations')).toEqual([bearer(keyA), bearer(keyB)])

        // Con trỏ RR = vị trí key vừa dùng (1), không phải số lần thử.
        const cursor = harness.live.db
          .prepare('SELECT rr_cursor AS cursor FROM provider_connections WHERE id = ?')
          .get(harness.providerId) as { cursor: number | null }
        expect(cursor.cursor).toBe(1)
      },
    )
  })

  it('round-robin: failover trong cùng tác vụ không đẩy con trỏ thêm lần nữa', async () => {
    const keyA = 'sk-routing-rrfail-a-1111'
    const keyB = 'sk-routing-rrfail-b-2222'

    await withHarness(
      {
        kind: 'image',
        mode: 'round_robin',
        keys: [{ apiKey: keyA, position: 0 }, { apiKey: keyB, position: 1 }],
        responder: (request, response) => {
          if (request.path !== '/v1/images/generations') return json(response, 404, { error: 'not found' })
          if (request.authorization === bearer(keyA)) {
            return json(response, 401, { error: { message: 'invalid api key' } })
          }
          return json(response, 200, { data: [{ b64_json: PNG_B64 }] })
        },
      },
      async (harness) => {
        const first = await runGeneration(harness, 'rr failover 1')
        expect(first.status).toBe('succeeded')

        // Key A bị 401 ⇒ key B xử lý. Con trỏ vẫn là vị trí của key A (0).
        const cursor = harness.live.db
          .prepare('SELECT rr_cursor AS cursor FROM provider_connections WHERE id = ?')
          .get(harness.providerId) as { cursor: number | null }
        expect(cursor.cursor).toBe(0)

        const second = await runGeneration(harness, 'rr failover 2')
        expect(second.status).toBe('succeeded')

        // Không đổi key thêm: A đã hỏng nên B là key khả dụng duy nhất.
        expect(polarize(harness, '/v1/images/generations')).toEqual([bearer(keyA), bearer(keyB), bearer(keyB)])
      },
    )
  })
})

describe('An toàn chi phí: không gửi lại khi chưa chắc chắn', () => {
  it('5xx ⇒ một yêu cầu duy nhất và tác vụ "unknown"', async () => {
    const keyA = 'sk-routing-500-a-1111'
    const keyB = 'sk-routing-500-b-2222'

    await withHarness(
      {
        kind: 'image',
        keys: [{ apiKey: keyA, position: 0 }, { apiKey: keyB, position: 1 }],
        responder: (request, response) => {
          json(response, 500, { error: { message: 'server exploded' } })
        },
      },
      async (harness) => {
        const done = await runGeneration(harness, '5xx')

        expect(done.status).toBe('unknown')
        expect(done.errorCode).toBe('OUTCOME_UNKNOWN')
        // Không được thử key thứ hai sau 5xx.
        const posts = polarize(harness, '/v1/images/generations')
        expect(posts).toEqual([bearer(keyA)])
      },
    )
  })

  it('timeout của POST thật ⇒ một yêu cầu duy nhất, không đổi key', async () => {
    const keyA = 'sk-routing-timeout-a-1111'
    const keyB = 'sk-routing-timeout-b-2222'

    await withHarness(
      {
        kind: 'image',
        keys: [{ apiKey: keyA, position: 0 }, { apiKey: keyB, position: 1 }],
        // Provider "treo": không bao giờ trả lời.
        responder: () => undefined,
      },
      async (harness) => {
        let calls = 0

        await expect(
          submitWithPool({
            db: harness.live.db,
            env: harness.live.env,
            providerId: harness.providerId,
            initial: { baseUrl: harness.baseUrl, apiKey: '', allowPrivate: true },
            call: (target) => {
              calls += 1
              return callProvider(target, 'chat/completions', {
                method: 'POST',
                body: { model: 'x', messages: [] },
                timeoutMs: 250,
              })
            },
          }),
        ).rejects.toThrow()

        // Hết thời gian chờ nghĩa là request CÓ THỂ đã tới provider ⇒ không gửi lại.
        expect(calls).toBe(1)
        expect(harness.fake.captured).toHaveLength(1)
        expect(harness.fake.captured[0]!.authorization).toBe(bearer(keyA))
      },
    )
  })

  it('2xx không đọc được ⇒ một yêu cầu duy nhất và tác vụ "unknown"', async () => {
    await withHarness(
      {
        kind: 'image',
        keys: [{ apiKey: 'sk-routing-bad2xx-1111', position: 0 }],
        responder: (_request, response) => {
          json(response, 200, { unexpected: true })
        },
      },
      async (harness) => {
        const done = await runGeneration(harness, 'bad 2xx')

        expect(done.status).toBe('unknown')
        expect(polarize(harness, '/v1/images/generations')).toHaveLength(1)
      },
    )
  })

  it('4xx không thuộc key ⇒ dừng hẳn, tác vụ thất bại rõ ràng', async () => {
    const keyA = 'sk-routing-400-a-1111'
    const keyB = 'sk-routing-400-b-2222'

    await withHarness(
      {
        kind: 'image',
        keys: [{ apiKey: keyA, position: 0 }, { apiKey: keyB, position: 1 }],
        responder: (_request, response) => {
          json(response, 400, { error: { message: 'size must be 1024x1024' } })
        },
      },
      async (harness) => {
        const done = await runGeneration(harness, '400')

        expect(done.status).toBe('failed')
        expect(done.errorCode).toBe('PROVIDER_INCOMPATIBLE')
        // Lỗi tham số không phải lỗi key: không thử key khác.
        expect(polarize(harness, '/v1/images/generations')).toEqual([bearer(keyA)])
      },
    )
  })

  it('key thô không bao giờ lộ trong chẩn đoán lỗi', async () => {
    const secret = 'sk-routing-tuyet-mat-9999'

    await withHarness(
      {
        kind: 'image',
        keys: [{ apiKey: secret, position: 0 }],
        responder: (_request, response) => {
          json(response, 400, { error: { message: `request rejected for key ${secret}` } })
        },
      },
      async (harness) => {
        const done = await runGeneration(harness, 'sanitize')

        expect(done.status).toBe('failed')
        expect(String(done.errorMessage)).not.toContain(secret)
        expect(String(done.errorMessage)).toContain('***')
      },
    )
  })
})

describe('Ghim key: poll và tải luôn bám đúng key đã gửi', () => {
  it('poll/tải video dùng key đã ghim kể cả khi key bị tắt và đổi chế độ chọn', async () => {
    const keyA = 'sk-routing-pin-a-1111'
    const keyB = 'sk-routing-pin-b-2222'
    const jobId = 'job-pin-1'

    await withHarness(
      {
        kind: 'video',
        keys: [{ apiKey: keyA, position: 0 }, { apiKey: keyB, position: 1 }],
        responder: (request, response) => {
          if (request.method === 'POST' && request.path === '/v1/videos') {
            return json(response, 200, { id: jobId, status: 'queued', progress: 0 })
          }
          if (request.method === 'GET' && request.path === `/v1/videos/${jobId}`) {
            return json(response, 200, { id: jobId, status: 'completed', progress: 100 })
          }
          if (request.method === 'GET' && request.path === `/v1/videos/${jobId}/content`) {
            response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': VIDEO_BYTES.length })
            response.end(VIDEO_BYTES)
            return
          }
          return json(response, 404, { error: 'not found' })
        },
      },
      async (harness) => {
        const id = await startGeneration(harness, 'video ghim')

        const started = harness.live.db
          .prepare('SELECT credential_id AS credentialId, provider_job_id AS jobId FROM generations WHERE id = ?')
          .get(id) as { credentialId: string | null; jobId: string | null }
        expect(started.jobId).toBe(jobId)
        expect(started.credentialId).toBe(harness.credentials[0]!.id)

        // Tắt key đã ghim và đổi sang round-robin: nếu poll không bám ghim thì
        // nó sẽ gọi key B.
        updateCredential(harness.live.db, harness.live.env, harness.userId, harness.providerId, harness.credentials[0]!.id, {
          enabled: false,
        })
        setProviderSelectionMode(harness.live.db, harness.userId, harness.providerId, 'round_robin')

        // Bỏ qua backoff để vòng poll chạy ngay.
        harness.live.db.prepare('UPDATE generations SET next_poll_at = NULL WHERE id = ?').run(id)

        const done = await waitForGeneration(harness.live, id, { timeoutMs: 20_000 })
        expect(done.status).toBe('succeeded')
        expect(done.assets.length).toBeGreaterThan(0)

        // Mọi lời gọi đều bằng key A; key B chưa từng được dùng.
        const usedKeys = new Set(harness.fake.captured.map((entry) => entry.authorization))
        expect(usedKeys.has(bearer(keyB))).toBe(false)

        expect(polarize(harness, '/v1/videos')).toEqual([bearer(keyA)])
        expect(polarize(harness, `/v1/videos/${jobId}`)).toEqual([bearer(keyA)])
        expect(polarize(harness, `/v1/videos/${jobId}/content`)).toEqual([bearer(keyA)])
      },
    )
  })

  it('retry-download đặt lại poll_started_at và không tạo job mới', async () => {
    const keyA = 'sk-routing-retry-a-1111'
    const jobId = 'job-retry-1'
    let contentCalls = 0

    await withHarness(
      {
        kind: 'video',
        keys: [{ apiKey: keyA, position: 0 }],
        responder: (request, response) => {
          if (request.method === 'POST' && request.path === '/v1/videos') {
            return json(response, 200, { id: jobId, status: 'queued', progress: 0 })
          }
          if (request.method === 'GET' && request.path === `/v1/videos/${jobId}`) {
            return json(response, 200, { id: jobId, status: 'completed', progress: 100 })
          }
          if (request.method === 'GET' && request.path === `/v1/videos/${jobId}/content`) {
            contentCalls += 1
            if (contentCalls === 1) {
              return json(response, 500, { error: { message: 'content not ready' } })
            }
            response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': VIDEO_BYTES.length })
            response.end(VIDEO_BYTES)
            return
          }
          return json(response, 404, { error: 'not found' })
        },
      },
      async (harness) => {
        const id = await startGeneration(harness, 'video retry')
        harness.live.db.prepare('UPDATE generations SET next_poll_at = NULL WHERE id = ?').run(id)

        // Vòng poll đầu: job completed nhưng tải nội dung lỗi 500 ⇒ thất bại.
        const failed = await waitForGeneration(harness.live, id, { timeoutMs: 20_000 })
        expect(failed.status).toBe('failed')
        expect(String(failed.errorMessage)).toContain('Không tải được video')
        expect(failed.providerJobId).toBe(jobId)

        // Thử tải lại: không gửi lại POST /videos.
        const retried = await call(harness.live, `/api/generations/${id}/retry-download`, {
          method: 'POST',
        })
        expect(retried.status).toBe(200)

        const afterRetry = harness.live.db
          .prepare('SELECT poll_started_at AS pollStartedAt, status FROM generations WHERE id = ?')
          .get(id) as { pollStartedAt: number | null; status: string }
        expect(afterRetry.pollStartedAt).toBeNull()
        expect(afterRetry.status).toBe('running')

        const done = await waitForGeneration(harness.live, id, { timeoutMs: 20_000 })
        expect(done.status).toBe('succeeded')

        // Vẫn chỉ có MỘT yêu cầu tạo job.
        expect(polarize(harness, '/v1/videos')).toEqual([bearer(keyA)])
      },
    )
  })
})

describe('Lựa chọn key chỉ đọc và pool rỗng', () => {
  it('readWithPool thử key kế tiếp cho GET /models (lỗi an toàn)', async () => {
    const keyA = 'sk-routing-models-a-1111'
    const keyB = 'sk-routing-models-b-2222'

    await withHarness(
      {
        kind: 'image',
        keys: [{ apiKey: keyA, position: 0 }, { apiKey: keyB, position: 1 }],
        responder: (request, response) => {
          if (request.path !== '/v1/models') return json(response, 404, { error: 'not found' })
          if (request.authorization === bearer(keyA)) {
            return json(response, 401, { error: { message: 'invalid api key' } })
          }
          return json(response, 200, { data: [{ id: 'model-1', name: 'Model 1' }] })
        },
      },
      async (harness) => {
        const outcome = await readWithPool({
          db: harness.live.db,
          env: harness.live.env,
          providerId: harness.providerId,
          call: (target) => callProvider(target, 'models', { timeoutMs: 5_000 }),
        })

        expect(outcome.response.ok).toBe(true)
        expect(outcome.attempts).toBe(2)
        expect(outcome.target.credentialId).toBe(harness.credentials[1]!.id)
        expect(polarize(harness, '/v1/models')).toEqual([bearer(keyA), bearer(keyB)])
      },
    )
  })

  it('pool rỗng ⇒ tác vụ thất bại rõ ràng, KHÔNG fallback cột api_key_* legacy', async () => {
    await withHarness(
      {
        kind: 'image',
        keys: [],
        responder: (_request, response) => json(response, 200, { data: [{ b64_json: PNG_B64 }] }),
      },
      async (harness) => {
        const done = await runGeneration(harness, 'pool rỗng')

        expect(done.status).toBe('failed')
        expect(String(done.errorMessage ?? '')).not.toBe('')
        // Không có lời gọi mạng nào: key legacy trong provider_connections bị bỏ qua.
        expect(harness.fake.captured).toHaveLength(0)
      },
    )
  })
})
