/**
 * Pool API key ở tầng LLM: `resolveLlmTarget` + `chatText` gọi provider GIẢ chạy
 * thật trên 127.0.0.1 (chế độ `live`, `ALLOW_PRIVATE_PROVIDER_URLS=true`).
 *
 * Mục tiêu: xác minh hành vi chọn key thật sự của đường chat, không chỉ ở tầng
 * service. Vì provider là server cục bộ tự viết nên KHÔNG có chi phí thật và mọi
 * request đều quan sát được `Authorization` chính xác.
 *
 * Phạm vi:
 *   · POST /api/providers gieo key đầu tiên vào pool; credential API thêm key kế;
 *     /api/models phân loại model thành 'llm'; `resolveLlmTarget` trả đúng đích.
 *   · 403 và 429 ⇒ chatText failover sang key kế với Authorization chính xác.
 *   · Cooldown 429 được tôn trọng (bỏ qua key đang nghỉ, dùng lại khi hết hạn) và
 *     route kiểm tra MỘT key (`POST .../credentials/:id/test`) đưa key
 *     `auth_failed` trở lại `ok` để chat dùng lại.
 *   · round_robin: bốn lời gọi chat dùng A/B/A/B.
 *   · An toàn chi phí: timeout POST (timeoutMs nhỏ) và 5xx ⇒ chỉ MỘT request,
 *     không gọi key kế.
 *   · Con trỏ round-robin nguyên tử qua hai kết nối DatabaseSync cùng file DB và
 *     còn nguyên sau khi mở lại.
 *
 * CỐ Ý KHÔNG kiểm tra ở đây: "stale fingerprint health guard" (xoay apiKey làm
 * sạch sức khỏe cũ / fingerprint NULL backfill) đã có bài riêng ở
 * providerCredentialsFoundation.test.ts và providerCredentialsRoutes.test.ts —
 * tránh trùng lặp.
 */
import { randomUUID } from 'node:crypto'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { call, registerUser, startTestServer, type TestContext } from './helpers'
import { openDatabase, type Database } from '../../server/db/index'
import { chatText } from '../../server/llm/chat'
import { resolveLlmTarget } from '../../server/llm/connections'
import {
  listCredentials,
  selectCredential,
  type ProviderCredential,
} from '../../server/providers/credentials'

// ── Hằng số ──────────────────────────────────────────────────────────────────

const KEY_A = 'sk-llm-pool-a-1111'
const KEY_B = 'sk-llm-pool-b-2222'
const CHAT_PATH = '/v1/chat/completions'
const MODELS_PATH = '/v1/models'
const MODEL_ID = 'pool-chat-model'

// ── Provider giả HTTP (chỉ cục bộ, không ra mạng ngoài) ──────────────────────

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

function respondNotFound(response: ServerResponse): void {
  json(response, 404, { error: { message: 'not found' } })
}

function chatPayload(content: string) {
  return { choices: [{ message: { role: 'assistant', content } }] }
}

function bearer(key: string): string {
  return `Bearer ${key}`
}

// ── Gieo dữ liệu qua API thật ────────────────────────────────────────────────

type PoolSeed = {
  providerId: string
  /** Body `provider` của POST /api/providers (gồm pool sau khi gieo key đầu). */
  provider: any
  /** Pool theo thứ tự ưu tiên sau khi thêm các key kế. */
  credentials: ProviderCredential[]
  modelPk: string
}

function credentialsOf(body: any): ProviderCredential[] {
  const found = body?.credentials ?? body?.pool?.credentials
  if (!Array.isArray(found)) {
    throw new Error(`Không tìm thấy mảng credentials: ${JSON.stringify(body)?.slice(0, 200)}`)
  }
  return found as ProviderCredential[]
}

/**
 * Tạo provider qua HTTP (route gieo key đầu tiên trong cùng transaction), thêm
 * các key kế qua credential API, rồi phân loại một model thành 'llm'.
 */
async function seedPoolViaApi(
  live: TestContext,
  options: { baseUrl: string; keys: string[]; mode?: 'failover' | 'round_robin' },
): Promise<PoolSeed> {
  const firstKey = options.keys[0]
  if (!firstKey) throw new Error('Cần ít nhất một API key')

  const created = await call(live, '/api/providers', {
    method: 'POST',
    body: {
      name: `Pool LLM ${randomUUID().slice(0, 8)}`,
      baseUrl: options.baseUrl,
      apiKey: firstKey,
    },
  })
  if (created.status !== 201) {
    throw new Error(`Tạo provider thất bại: ${JSON.stringify(created.body)}`)
  }
  const providerId = created.body.provider.id as string

  for (const [index, key] of options.keys.slice(1).entries()) {
    const added = await call(live, `/api/providers/${providerId}/credentials`, {
      method: 'POST',
      body: { apiKey: key, label: `key ${index + 2}` },
    })
    if (added.status !== 201) {
      throw new Error(`Thêm key thất bại: ${JSON.stringify(added.body)}`)
    }
  }

  const model = await call(live, '/api/models', {
    method: 'POST',
    body: { providerId, modelId: MODEL_ID, displayName: 'Pool chat model', kind: 'llm' },
  })
  if (model.status !== 201) {
    throw new Error(`Tạo model thất bại: ${JSON.stringify(model.body)}`)
  }

  if (options.mode) {
    const patched = await call(live, `/api/providers/${providerId}`, {
      method: 'PATCH',
      body: { selectionMode: options.mode },
    })
    if (patched.status !== 200) {
      throw new Error(`Đổi selectionMode thất bại: ${JSON.stringify(patched.body)}`)
    }
  }

  const listed = await call(live, `/api/providers/${providerId}/credentials`)
  if (listed.status !== 200) {
    throw new Error(`Đọc pool thất bại: ${JSON.stringify(listed.body)}`)
  }

  return {
    providerId,
    provider: created.body.provider,
    credentials: credentialsOf(listed.body),
    modelPk: model.body.model.id as string,
  }
}

// ── Harness (server thật + provider giả) ─────────────────────────────────────

type LlmHarness = PoolSeed & {
  live: TestContext
  fake: FakeProvider
  userId: string
  baseUrl: string
}

type HarnessConfig = {
  keys?: string[]
  mode?: 'failover' | 'round_robin'
  responder: Responder
}

const openHarnesses: Array<{ live: TestContext; fake: FakeProvider }> = []

async function closeHarness(live: TestContext, fake: FakeProvider): Promise<void> {
  const index = openHarnesses.findIndex((item) => item.live === live)
  if (index >= 0) openHarnesses.splice(index, 1)
  // Đóng cả socket đang treo (bài timeout) để server.close() không chờ vô hạn.
  fake.server.closeAllConnections()
  await Promise.all([
    live.close(),
    new Promise<void>((resolve) => fake.server.close(() => resolve())),
  ])
}

async function withHarness(
  config: HarnessConfig,
  run: (harness: LlmHarness) => Promise<void>,
): Promise<void> {
  const keys = config.keys ?? [KEY_A, KEY_B]
  const fake = await startFakeProvider(config.responder)
  const live = await startTestServer({ allowPrivate: true, providerMode: 'live' })
  openHarnesses.push({ live, fake })

  try {
    const { userId } = await registerUser(live)
    const baseUrl = `http://127.0.0.1:${fake.port}/v1`
    const seed = await seedPoolViaApi(live, { baseUrl, keys, mode: config.mode })
    await run({ ...seed, live, fake, userId, baseUrl })
  } finally {
    await closeHarness(live, fake)
  }
}

afterEach(async () => {
  // Dọn harness còn sót nếu một bài test ném lỗi giữa chừng.
  const leftover = openHarnesses.splice(0)
  for (const item of leftover) {
    await closeHarness(item.live, item.fake).catch(() => undefined)
  }
})

// ── Tiện ích bài test ────────────────────────────────────────────────────────

function llmTarget(harness: LlmHarness) {
  return resolveLlmTarget(harness.live.db, harness.live.env, harness.userId, harness.modelPk)
}

async function chat(
  harness: LlmHarness,
  content = 'xin chào',
  options: { timeoutMs?: number; maxTokens?: number } = {},
): Promise<string> {
  return chatText(harness.live.env, llmTarget(harness), [{ role: 'user', content }], options)
}

function chatAuthorizations(harness: LlmHarness): Array<string | null> {
  return harness.fake.captured
    .filter((entry) => entry.path === CHAT_PATH)
    .map((entry) => entry.authorization)
}

function modelAuthorizations(harness: LlmHarness): Array<string | null> {
  return harness.fake.captured
    .filter((entry) => entry.path === MODELS_PATH)
    .map((entry) => entry.authorization)
}

function poolOf(harness: LlmHarness): ProviderCredential[] {
  return listCredentials(harness.live.db, harness.userId, harness.providerId)
}

function readCursor(db: Database, providerId: string): number | null {
  const row = db.prepare('SELECT rr_cursor FROM provider_connections WHERE id = ?').get(providerId) as {
    rr_cursor: number | null
  }
  return row.rr_cursor === null ? null : Number(row.rr_cursor)
}

// ════════════════════════════════════════════════════════════════════════════

describe('Nền tảng: provider + pool key + model LLM', () => {
  it('POST provider gieo key đầu tiên, credential API thêm key kế, resolveLlmTarget trả đúng đích', async () => {
    await withHarness(
      {
        keys: [KEY_A, KEY_B],
        responder: (request, response) => {
          if (request.path !== CHAT_PATH) return respondNotFound(response)
          return json(response, 200, chatPayload('ok'))
        },
      },
      async (harness) => {
        // POST /api/providers đã gieo đúng MỘT key vào pool và không lộ bí mật.
        expect(harness.provider.credentials).toHaveLength(1)
        expect(harness.provider.credentials[0].hint).toBe('••••1111')
        expect(JSON.stringify(harness.provider)).not.toContain(KEY_A)

        // Credential API thêm key thứ hai với thứ tự ưu tiên kế tiếp.
        const pool = poolOf(harness)
        expect(pool).toHaveLength(2)
        expect(pool.map((item) => item.position)).toEqual([0, 1])
        expect(pool[0]!.hint).toBe('••••1111')
        expect(pool[1]!.hint).toBe('••••2222')
        expect(pool[0]!.id).not.toBe(pool[1]!.id)

        // resolveLlmTarget thật: model LLM của chính người dùng + Base URL provider.
        const target = llmTarget(harness)
        expect(target.modelPk).toBe(harness.modelPk)
        expect(target.modelId).toBe(MODEL_ID)
        expect(target.providerId).toBe(harness.providerId)
        expect(target.baseUrl).toBe(harness.baseUrl)
        expect(target.db).toBe(harness.live.db)

        // chatText dùng đúng key ưu tiên (failover mặc định) và gửi đúng model.
        expect(await chat(harness)).toBe('ok')
        expect(chatAuthorizations(harness)).toEqual([bearer(KEY_A)])
        expect(harness.fake.captured[0]!.bodyText).toContain(MODEL_ID)
      },
    )
  })
})

// ════════════════════════════════════════════════════════════════════════════

describe('chatText failover khi key bị từ chối (403/429)', () => {
  it('403 ở key đầu ⇒ đổi sang key kế với đúng Authorization và đánh dấu auth_failed', async () => {
    await withHarness(
      {
        keys: [KEY_A, KEY_B],
        responder: (request, response) => {
          if (request.path !== CHAT_PATH) return respondNotFound(response)
          if (request.authorization === bearer(KEY_A)) {
            return json(response, 403, { error: { message: 'key bị từ chối' } })
          }
          return json(response, 200, chatPayload('ok-B'))
        },
      },
      async (harness) => {
        expect(await chat(harness, 'lần một')).toBe('ok-B')
        // Đúng hai request, đúng thứ tự key: không thừa, không thiếu.
        expect(chatAuthorizations(harness)).toEqual([bearer(KEY_A), bearer(KEY_B)])

        const pool = poolOf(harness)
        expect(pool[0]!.healthStatus).toBe('auth_failed')
        expect(pool[0]!.lastErrorKey).toBe('providers.api_key_invalid')
        expect(pool[1]!.healthStatus).toBe('ok')

        // Lần gọi sau: key hỏng bị bỏ qua nên chỉ có MỘT request mới, bằng key B.
        expect(await chat(harness, 'lần hai')).toBe('ok-B')
        expect(chatAuthorizations(harness)).toEqual([bearer(KEY_A), bearer(KEY_B), bearer(KEY_B)])
      },
    )
  })

  it('429 ⇒ ghi cooldown theo Retry-After, bỏ qua key đang nghỉ và dùng lại khi hết hạn', async () => {
    await withHarness(
      {
        keys: [KEY_A, KEY_B],
        responder: (request, response) => {
          if (request.path !== CHAT_PATH) return respondNotFound(response)
          if (request.authorization === bearer(KEY_A)) {
            response.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '30' })
            response.end(JSON.stringify({ error: { message: 'rate limited' } }))
            return
          }
          return json(response, 200, chatPayload('ok-B'))
        },
      },
      async (harness) => {
        expect(await chat(harness, 'lần một')).toBe('ok-B')
        expect(chatAuthorizations(harness)).toEqual([bearer(KEY_A), bearer(KEY_B)])

        // Retry-After: 30 ⇒ cooldown ~30 giây, đúng key A.
        const pool = poolOf(harness)
        expect(pool[0]!.healthStatus).toBe('cooldown')
        const cooldownUntil = pool[0]!.cooldownUntil ?? 0
        expect(cooldownUntil - Date.now()).toBeGreaterThan(20_000)
        expect(cooldownUntil - Date.now()).toBeLessThanOrEqual(30_000)
        expect(pool[1]!.healthStatus).toBe('ok')

        // Key đang nghỉ bị bỏ qua: lần gọi sau chỉ có một request mới, bằng key B.
        expect(await chat(harness, 'lần hai')).toBe('ok-B')
        expect(chatAuthorizations(harness)).toEqual([bearer(KEY_A), bearer(KEY_B), bearer(KEY_B)])

        // Hết thời gian nghỉ ⇒ key A được chọn lại (cooldown theo thời điểm).
        harness.live.db
          .prepare('UPDATE provider_credentials SET cooldown_until = ? WHERE id = ?')
          .run(Date.now() - 1000, harness.credentials[0]!.id)
        expect(await chat(harness, 'lần ba')).toBe('ok-B')
        expect(chatAuthorizations(harness)).toEqual([
          bearer(KEY_A),
          bearer(KEY_B),
          bearer(KEY_B),
          bearer(KEY_A),
          bearer(KEY_B),
        ])
      },
    )
  })
})

// ════════════════════════════════════════════════════════════════════════════

describe('Kiểm tra MỘT key đưa auth_failed trở lại pool', () => {
  it('POST key/test chỉ gọi đúng key A và chat dùng lại key đó sau khi hồi sức khỏe', async () => {
    let keyAWorks = false

    await withHarness(
      {
        keys: [KEY_A, KEY_B],
        responder: (request, response) => {
          if (request.path === MODELS_PATH) {
            return json(response, 200, { data: [{ id: 'm1', name: 'Model 1' }] })
          }
          if (request.path !== CHAT_PATH) return respondNotFound(response)
          if (request.authorization === bearer(KEY_A) && !keyAWorks) {
            return json(response, 403, { error: { message: 'key bị từ chối' } })
          }
          return json(
            response,
            200,
            chatPayload(request.authorization === bearer(KEY_A) ? 'ok-A' : 'ok-B'),
          )
        },
      },
      async (harness) => {
        expect(await chat(harness, 'lần một')).toBe('ok-B')
        expect(chatAuthorizations(harness)).toEqual([bearer(KEY_A), bearer(KEY_B)])

        // A đang auth_failed ⇒ lần gọi sau chỉ còn B.
        expect(await chat(harness, 'lần hai')).toBe('ok-B')
        expect(chatAuthorizations(harness)).toEqual([bearer(KEY_A), bearer(KEY_B), bearer(KEY_B)])
        expect(poolOf(harness)[0]!.healthStatus).toBe('auth_failed')

        // Route kiểm tra ĐÚNG key A: GET /models (chỉ đọc, không failover) bằng A.
        const tested = await call(
          harness.live,
          `/api/providers/${harness.providerId}/credentials/${harness.credentials[0]!.id}/test`,
          { method: 'POST' },
        )
        expect(tested.status, JSON.stringify(tested.body)).toBe(200)
        expect(tested.body.ok).toBe(true)
        expect(tested.body.credential.id).toBe(harness.credentials[0]!.id)
        expect(tested.body.credential.healthStatus).toBe('ok')
        // Authorization chính xác: chỉ key A, không gọi key B.
        expect(modelAuthorizations(harness)).toEqual([bearer(KEY_A)])
        expect(poolOf(harness)[0]!.healthStatus).toBe('ok')

        // Chat dùng lại key A ngay (A trở lại vị trí ưu tiên cao nhất).
        keyAWorks = true
        expect(await chat(harness, 'lần ba')).toBe('ok-A')
        expect(chatAuthorizations(harness)).toEqual([bearer(KEY_A), bearer(KEY_B), bearer(KEY_B), bearer(KEY_A)])
      },
    )
  })
})

// ════════════════════════════════════════════════════════════════════════════

describe('round_robin qua chatText', () => {
  it('bốn lời gọi chat dùng A/B/A/B và con trỏ lưu trong DB', async () => {
    await withHarness(
      {
        keys: [KEY_A, KEY_B],
        mode: 'round_robin',
        responder: (request, response) => {
          if (request.path !== CHAT_PATH) return respondNotFound(response)
          return json(response, 200, chatPayload('ok'))
        },
      },
      async (harness) => {
        for (let index = 0; index < 4; index += 1) {
          expect(await chat(harness, `lần ${index + 1}`)).toBe('ok')
        }

        expect(chatAuthorizations(harness)).toEqual([
          bearer(KEY_A),
          bearer(KEY_B),
          bearer(KEY_A),
          bearer(KEY_B),
        ])

        const pool = await call(harness.live, `/api/providers/${harness.providerId}/credentials`)
        expect(pool.body.pool.selectionMode).toBe('round_robin')
        // Sau A → B → A → B, con trỏ là vị trí của key B.
        expect(pool.body.pool.rrCursor).toBe(harness.credentials[1]!.position)
      },
    )
  })
})

// ════════════════════════════════════════════════════════════════════════════

describe('An toàn chi phí: timeout và 5xx không gọi key kế', () => {
  it('timeout POST với timeoutMs nhỏ ⇒ chỉ MỘT request, không đổi key', async () => {
    await withHarness(
      {
        keys: [KEY_A, KEY_B],
        // Provider "treo": không bao giờ trả lời.
        responder: () => undefined,
      },
      async (harness) => {
        await expect(chat(harness, 'chậm', { timeoutMs: 200 })).rejects.toThrow(/quá lâu/)

        // Request CÓ THỂ đã tới provider ⇒ tuyệt đối không gửi lại sang key B.
        expect(chatAuthorizations(harness)).toEqual([bearer(KEY_A)])
        expect(harness.fake.captured).toHaveLength(1)

        // Kết quả không xác định không được hạ sức khỏe hay tạo cooldown.
        const pool = poolOf(harness)
        expect(pool[0]!.healthStatus).toBe('unknown')
        expect(pool[0]!.cooldownUntil).toBeNull()
      },
    )
  })

  it('5xx ⇒ chỉ MỘT request, không gọi key kế, lỗi rõ ràng', async () => {
    await withHarness(
      {
        keys: [KEY_A, KEY_B],
        responder: (request, response) => {
          if (request.path !== CHAT_PATH) return respondNotFound(response)
          return json(response, 500, { error: { message: 'máy chủ lỗi' } })
        },
      },
      async (harness) => {
        await expect(chat(harness, 'lỗi 5xx')).rejects.toThrow(/AI từ chối yêu cầu/)

        expect(chatAuthorizations(harness)).toEqual([bearer(KEY_A)])
        expect(harness.fake.captured).toHaveLength(1)

        // 5xx không phải lỗi key: giữ nguyên sức khỏe, chỉ ghi last_error.
        const pool = poolOf(harness)
        expect(pool[0]!.healthStatus).toBe('unknown')
        expect(pool[0]!.cooldownUntil).toBeNull()
        expect(String(pool[0]!.lastError)).toContain('500')
      },
    )
  })
})

// ════════════════════════════════════════════════════════════════════════════

describe('Con trỏ round-robin nguyên tử qua nhiều kết nối DatabaseSync', () => {
  it('hai kết nối cùng file DB chọn xen kẽ A/B/A/B và con trỏ còn nguyên sau khi mở lại', async () => {
    const live = await startTestServer({ allowPrivate: true, providerMode: 'live' })
    const extraConnections: DatabaseSync[] = []

    try {
      await registerUser(live)
      // Base URL không cần tồn tại: bài này chỉ gọi tầng chọn key, không gọi mạng.
      const seed = await seedPoolViaApi(live, {
        baseUrl: 'http://127.0.0.1:9/v1',
        keys: [KEY_A, KEY_B],
        mode: 'round_robin',
      })
      const a = seed.credentials[0]!
      const b = seed.credentials[1]!

      const openExtra = (): DatabaseSync => {
        const connection = new DatabaseSync(live.env.DATABASE_PATH)
        connection.exec('PRAGMA journal_mode = WAL')
        connection.exec('PRAGMA foreign_keys = ON')
        connection.exec('PRAGMA busy_timeout = 5000')
        extraConnections.push(connection)
        return connection
      }

      // Kết nối thứ hai trên CÙNG file DB. Mỗi lần chọn là một transaction
      // IMMEDIATE nên con trỏ tiến đúng một bước dù gọi xen kẽ hai kết nối.
      const connection2 = openExtra()
      const picks = [
        selectCredential(live.db, live.env, seed.providerId).credentialId,
        selectCredential(connection2, live.env, seed.providerId).credentialId,
        selectCredential(live.db, live.env, seed.providerId).credentialId,
        selectCredential(connection2, live.env, seed.providerId).credentialId,
      ]
      expect(picks).toEqual([a.id, b.id, a.id, b.id])

      // Cùng một con trỏ trong DB: đọc từ cả hai kết nối đều như nhau.
      expect(readCursor(connection2, seed.providerId)).toBe(b.position)
      expect(readCursor(live.db, seed.providerId)).toBe(b.position)

      connection2.close()
      extraConnections.splice(extraConnections.indexOf(connection2), 1)

      // "Khởi động lại": mở lại DB bằng chính openDatabase của ứng dụng.
      const restarted = openDatabase(live.env.DATABASE_PATH)
      extraConnections.push(restarted)
      expect(readCursor(restarted, seed.providerId)).toBe(b.position)

      // Con trỏ đã lưu ⇒ key kế tiếp là A, rồi con trỏ về vị trí A.
      expect(selectCredential(restarted, live.env, seed.providerId).credentialId).toBe(a.id)
      expect(readCursor(restarted, seed.providerId)).toBe(a.position)
    } finally {
      for (const connection of extraConnections) {
        try {
          connection.close()
        } catch {
          // Kết nối đã đóng: bỏ qua.
        }
      }
      await live.close()
    }
  })
})
