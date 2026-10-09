/**
 * Vòng đời AN TOÀN của pool API key (tầng dịch vụ, không gọi mạng).
 *
 * Bổ sung cho `providerCredentialsFoundation.test.ts` / `providerPoolSecurity.test.ts`
 * bốn bất biến của các bản vá an toàn cuối:
 *
 *   1. Quan sát từ tác vụ ĐÃ GHIM (`observeOnly`) không được xóa
 *      `auth_failed`/cooldown do tác vụ khác gây ra.
 *   2. Request bất đồng bộ không có ghim bền (LLM/GET/poll) có thể kết thúc sau
 *      khi key bị xoay: kết quả cũ phải bị bỏ qua nhờ `expectedFingerprint`.
 *   3. URL của provider được ĐÓNG BĂNG trong một lần gửi: đổi key an toàn không
 *      đổi luôn đích đến nếu provider đổi `base_url` giữa chừng.
 *   4. Mọi thao tác đổi thứ tự/vị trí key (reorder, dời, thêm vào giữa, xóa)
 *      đặt lại `rr_cursor` để vòng chọn bắt đầu từ thứ tự đã lưu.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerUser, startTestServer, type TestContext } from './helpers'
import {
  CREDENTIAL_COOLDOWN_DEFAULT_SECONDS,
  CREDENTIAL_COOLDOWN_MAX_SECONDS,
  addCredential,
  credentialFingerprint,
  listCredentials,
  recordCredentialResult,
  removeCredential,
  reorderCredentials,
  resolvePinnedCredential,
  selectCredential,
  setProviderSelectionMode,
  updateCredential,
  type ProviderCredential,
} from '../../server/providers/credentials'
import {
  readWithPool,
  recordPinnedCredentialResult,
  submitWithPool,
} from '../../server/providers/pool'
import type { ProviderResponse } from '../../server/providers/client'

let ctx: TestContext

beforeAll(async () => {
  ctx = await startTestServer()
})

afterAll(async () => {
  if (ctx) await ctx.close()
})

// ── Tiện ích ─────────────────────────────────────────────────────────────────

/** Chèn provider thẳng vào DB (blob legacy giả, không bao giờ được dùng). */
function insertProvider(
  server: TestContext,
  userId: string,
  baseUrl = 'https://life.mock.test/v1',
  mode: 'failover' | 'round_robin' = 'failover',
): string {
  const id = randomUUID()
  const now = Date.now()
  const dummy = Buffer.from([0, 1, 2, 3])
  server.db
    .prepare(
      `INSERT INTO provider_connections
         (id, user_id, name, base_url, api_key_ciphertext, api_key_iv, api_key_tag, key_hint,
          image_api_style, status, selection_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '', 'openai', 'untested', ?, ?, ?)`,
    )
    .run(id, userId, `Life ${id.slice(0, 6)}`, baseUrl, dummy, dummy, dummy, mode, now, now)
  return id
}

async function newProvider(
  baseUrl = 'https://life.mock.test/v1',
): Promise<{ userId: string; providerId: string }> {
  const { userId } = await registerUser(ctx)
  return { userId, providerId: insertProvider(ctx, userId, baseUrl) }
}

function addKey(
  userId: string,
  providerId: string,
  apiKey: string,
  extra: { label?: string; position?: number; enabled?: boolean } = {},
): ProviderCredential {
  return addCredential(ctx.db, ctx.env, userId, providerId, { apiKey, ...extra })
}

function credentialRow(credentialId: string): {
  health_status: string
  cooldown_until: number | null
  last_error_key: string | null
  last_error: string | null
  fingerprint: string | null
} {
  return ctx.db
    .prepare(
      'SELECT health_status, cooldown_until, last_error_key, last_error, fingerprint FROM provider_credentials WHERE id = ?',
    )
    .get(credentialId) as any
}

function rrCursor(providerId: string): number | null {
  const row = ctx.db
    .prepare('SELECT rr_cursor FROM provider_connections WHERE id = ?')
    .get(providerId) as { rr_cursor: number | null }
  return row.rr_cursor === null ? null : Number(row.rr_cursor)
}

function fakeResponse(status: number, ok = status >= 200 && status < 300): ProviderResponse {
  return {
    status,
    ok,
    headers: new Headers(),
    json: async () => ({}),
    text: async () => '',
    body: null,
  }
}

function captureError(fn: () => unknown): {
  code?: string
  status?: number
  message?: string
  messageParams?: Record<string, string | number>
} {
  try {
    fn()
  } catch (error) {
    return error as { code?: string; status?: number; message?: string; messageParams?: Record<string, string | number> }
  }
  throw new Error('Mong đợi một lỗi nhưng hàm đã chạy thành công')
}

// ════════════════════════════════════════════════════════════════════════════
describe('observeOnly: quan sát từ tác vụ đã ghim không hồi sinh key', () => {
  it('thành công observeOnly KHÔNG xóa auth_failed; ghi nhận thường vẫn xóa', async () => {
    const { userId, providerId } = await newProvider()
    const key = await addKey(userId, providerId, 'sk-observe-auth-1111')

    recordCredentialResult(ctx.db, key.id, { status: 401, message: 'unauthorized' })
    expect(credentialRow(key.id).health_status).toBe('auth_failed')

    // Poll/tải lại của tác vụ ghim thành công: KHÔNG được hồi sinh key.
    recordCredentialResult(ctx.db, key.id, { status: 200, ok: true, observeOnly: true })
    expect(credentialRow(key.id).health_status).toBe('auth_failed')
    expect(listCredentials(ctx.db, userId, providerId)[0]!.lastErrorKey).toBe('providers.api_key_invalid')

    // Một lần chọn mới (ghi nhận thường) mới được đặt lại 'ok'.
    recordCredentialResult(ctx.db, key.id, { status: 200, ok: true })
    expect(credentialRow(key.id).health_status).toBe('ok')
  })

  it('thành công observeOnly KHÔNG xóa cooldown hay kéo dài thời gian nghỉ', async () => {
    const { userId, providerId } = await newProvider()
    const key = await addKey(userId, providerId, 'sk-observe-cool-1111')

    recordCredentialResult(ctx.db, key.id, { status: 429, retryAfterSeconds: 120, message: 'slow down' })
    const cooling = credentialRow(key.id)
    expect(cooling.health_status).toBe('cooldown')
    expect(cooling.cooldown_until).toBeGreaterThan(Date.now())

    recordCredentialResult(ctx.db, key.id, { status: 200, ok: true, observeOnly: true })
    const observed = credentialRow(key.id)
    expect(observed.health_status).toBe('cooldown')
    expect(observed.cooldown_until).toBe(cooling.cooldown_until)
    expect(observed.last_error_key).toBe('errors.rate_limited')

    // Kể cả khi đã hết thời gian nghỉ, quan sát vẫn không tự đổi trạng thái…
    ctx.db
      .prepare('UPDATE provider_credentials SET cooldown_until = ? WHERE id = ?')
      .run(Date.now() - 1_000, key.id)
    recordCredentialResult(ctx.db, key.id, { status: 200, ok: true, observeOnly: true })
    expect(credentialRow(key.id).health_status).toBe('cooldown')

    // …còn ghi nhận thường thì có.
    recordCredentialResult(ctx.db, key.id, { status: 200, ok: true })
    const healed = credentialRow(key.id)
    expect(healed.health_status).toBe('ok')
    expect(healed.cooldown_until).toBeNull()
  })

  it('recordPinnedCredentialResult luôn đặt observeOnly và truyền fingerprint', async () => {
    const { userId, providerId } = await newProvider()
    const key = await addKey(userId, providerId, 'sk-observe-helper-1111')
    const target = selectCredential(ctx.db, ctx.env, providerId)

    recordCredentialResult(ctx.db, key.id, { status: 401 })
    recordPinnedCredentialResult(ctx.db, key.id, { status: 200, ok: true }, target.expectedFingerprint)
    expect(credentialRow(key.id).health_status).toBe('auth_failed')

    // Không có credentialId (context dựng thủ công) ⇒ không ném lỗi.
    expect(() => recordPinnedCredentialResult(ctx.db, undefined, { status: 401 })).not.toThrow()
    expect(() => recordPinnedCredentialResult(ctx.db, null, { status: 401 })).not.toThrow()
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('Xoay key giữa request: expectedFingerprint bảo vệ key mới', () => {
  it('kết quả của request cũ bị bỏ qua sau khi đổi bí mật', async () => {
    const { userId, providerId } = await newProvider()
    const key = await addKey(userId, providerId, 'sk-xoay-cu-1111')

    const stale = selectCredential(ctx.db, ctx.env, providerId)
    expect(stale.expectedFingerprint).toBe(credentialFingerprint(ctx.env, 'sk-xoay-cu-1111'))
    // Vân tay chỉ dùng nội bộ: không bao giờ lộ trong read model công khai.
    expect(JSON.stringify(listCredentials(ctx.db, userId, providerId))).not.toContain(
      stale.expectedFingerprint,
    )
    expect(Object.keys(listCredentials(ctx.db, userId, providerId)[0]!)).not.toContain(
      'expectedFingerprint',
    )

    // Người dùng xoay key trong lúc request cũ đang bay.
    updateCredential(ctx.db, ctx.env, userId, providerId, key.id, { apiKey: 'sk-xoay-moi-2222' })

    recordCredentialResult(ctx.db, key.id, {
      status: 401,
      message: 'kết quả của key cũ',
      expectedFingerprint: stale.expectedFingerprint,
    })
    expect(credentialRow(key.id).health_status).toBe('unknown')
    expect(credentialRow(key.id).last_error).toBeNull()

    // Request mới (chọn sau khi xoay) áp dụng bình thường.
    const fresh = selectCredential(ctx.db, ctx.env, providerId)
    expect(fresh.apiKey).toBe('sk-xoay-moi-2222')
    recordCredentialResult(ctx.db, key.id, {
      status: 401,
      expectedFingerprint: fresh.expectedFingerprint,
    })
    expect(credentialRow(key.id).health_status).toBe('auth_failed')
  })

  it('bản ghi backfill fingerprint NULL được băm lười ngay khi chọn', async () => {
    const { userId, providerId } = await newProvider()
    const secret = 'sk-backfill-life-1111'
    const key = await addKey(userId, providerId, secret)

    // Mô phỏng bản ghi do migration 016 backfill (không có khoá chủ lúc đó).
    ctx.db.prepare('UPDATE provider_credentials SET fingerprint = NULL WHERE id = ?').run(key.id)
    expect(credentialRow(key.id).fingerprint).toBeNull()

    const target = selectCredential(ctx.db, ctx.env, providerId)
    const expected = credentialFingerprint(ctx.env, secret)
    expect(target.expectedFingerprint).toBe(expected)
    expect(credentialRow(key.id).fingerprint).toBe(expected)

    // Guard hoạt động với bản ghi backfill (không bị bỏ qua nhầm).
    recordCredentialResult(ctx.db, key.id, {
      status: 429,
      retryAfterSeconds: 30,
      expectedFingerprint: expected,
    })
    expect(credentialRow(key.id).health_status).toBe('cooldown')
  })

  it('key bị xóa khi request đang bay: kết quả bị bỏ qua, không ném lỗi', async () => {
    const { userId, providerId } = await newProvider()
    const key = await addKey(userId, providerId, 'sk-xoa-khi-bay-1111')
    const target = selectCredential(ctx.db, ctx.env, providerId)

    removeCredential(ctx.db, userId, providerId, key.id)
    expect(listCredentials(ctx.db, userId, providerId)).toHaveLength(0)

    expect(() =>
      recordCredentialResult(ctx.db, key.id, {
        status: 401,
        expectedFingerprint: target.expectedFingerprint,
      }),
    ).not.toThrow()
  })

  it('resolvePinnedCredential trả fingerprint để poll/tải tự bảo vệ', async () => {
    const { userId, providerId } = await newProvider()
    const key = await addKey(userId, providerId, 'sk-pin-fingerprint-1111')

    const pinned = resolvePinnedCredential(ctx.db, ctx.env, key.id, 'https://snap.life.test/v1')
    expect(pinned.expectedFingerprint).toBe(credentialFingerprint(ctx.env, 'sk-pin-fingerprint-1111'))

    // Xoay xong mới ghi kết quả quan sát của key cũ ⇒ bị bỏ qua.
    updateCredential(ctx.db, ctx.env, userId, providerId, key.id, { apiKey: 'sk-pin-moi-2222' })
    recordPinnedCredentialResult(ctx.db, key.id, { status: 401 }, pinned.expectedFingerprint)
    expect(credentialRow(key.id).health_status).toBe('unknown')
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('Cooldown 429: luôn bị kẹp ở trần', () => {
  it('retryAfterSeconds khổng lồ không vượt CREDENTIAL_COOLDOWN_MAX_SECONDS và không cộng dồn', async () => {
    const { userId, providerId } = await newProvider()
    const key = await addKey(userId, providerId, 'sk-cool-max-1111')

    const before = Date.now()
    recordCredentialResult(ctx.db, key.id, { status: 429, retryAfterSeconds: 99_999 })
    let until = credentialRow(key.id).cooldown_until!
    expect(until - before).toBeLessThanOrEqual(CREDENTIAL_COOLDOWN_MAX_SECONDS * 1000 + 1_000)
    expect(until - before).toBeGreaterThan(CREDENTIAL_COOLDOWN_MAX_SECONDS * 1000 - 2_000)

    // 429 lặp lại: thời gian nghỉ neo theo hiện tại, không cộng dồn vượt trần.
    const second = Date.now()
    recordCredentialResult(ctx.db, key.id, { status: 429, retryAfterSeconds: 99_999 })
    until = credentialRow(key.id).cooldown_until!
    expect(until - second).toBeLessThanOrEqual(CREDENTIAL_COOLDOWN_MAX_SECONDS * 1000 + 1_000)

    // retryAfterSeconds thiếu/không hợp lệ ⇒ mặc định 60 giây.
    const other = await addKey(userId, providerId, 'sk-cool-default-2222')
    const t = Date.now()
    recordCredentialResult(ctx.db, other.id, { status: 429, retryAfterSeconds: null })
    const untilOther = credentialRow(other.id).cooldown_until!
    expect(untilOther - t).toBeLessThanOrEqual(CREDENTIAL_COOLDOWN_DEFAULT_SECONDS * 1000 + 1_000)
    expect(untilOther - t).toBeGreaterThan(CREDENTIAL_COOLDOWN_DEFAULT_SECONDS * 1000 - 2_000)

    // Lỗi 429 khi chọn key cũng báo retryAfter trong khoảng hợp lệ.
    const error = captureError(() => selectCredential(ctx.db, ctx.env, providerId))
    expect(error.code).toBe('RATE_LIMITED')
    expect(Number(error.messageParams?.retryAfter)).toBeLessThanOrEqual(CREDENTIAL_COOLDOWN_MAX_SECONDS)
    expect(Number(error.messageParams?.retryAfter)).toBeGreaterThan(0)
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('Đóng băng baseUrl trong một lần gửi', () => {
  it('submitWithPool đổi key an toàn nhưng giữ nguyên URL của lần chọn đầu', async () => {
    const one = 'https://one.life.test/v1'
    const two = 'https://two.life.test/v1'
    const { userId, providerId } = await newProvider(one)
    const keyA = await addKey(userId, providerId, 'sk-freeze-submit-a-1111')
    const keyB = await addKey(userId, providerId, 'sk-freeze-submit-b-2222')

    const seen: string[] = []
    const outcome = await submitWithPool({
      db: ctx.db,
      env: ctx.env,
      providerId,
      initial: { baseUrl: one, apiKey: '', allowPrivate: false },
      call: async (target) => {
        seen.push(target.baseUrl)
        if (target.apiKey === 'sk-freeze-submit-a-1111') {
          // Provider đổi base_url ngay giữa lần thử: lần kế phải vẫn dùng URL cũ.
          ctx.db.prepare('UPDATE provider_connections SET base_url = ? WHERE id = ?').run(two, providerId)
          return fakeResponse(401)
        }
        return fakeResponse(200)
      },
    })

    expect(outcome.attempts).toBe(2)
    expect(outcome.target.credentialId).toBe(keyB.id)
    expect(seen).toEqual([one, one])
    expect(credentialRow(keyA.id).health_status).toBe('auth_failed')

    // Sanity: provider thật sự đã đổi URL (nếu không đóng băng thì lần 2 đã dùng URL mới).
    const provider = ctx.db
      .prepare('SELECT base_url FROM provider_connections WHERE id = ?')
      .get(providerId) as { base_url: string }
    expect(provider.base_url).toBe(two)
  })

  it('readWithPool cũng đóng băng baseUrl khi thử key kế tiếp', async () => {
    const one = 'https://one.life.test/v1'
    const two = 'https://two.life.test/v1'
    const { userId, providerId } = await newProvider(one)
    const keyA = await addKey(userId, providerId, 'sk-freeze-read-a-1111')
    const keyB = await addKey(userId, providerId, 'sk-freeze-read-b-2222')

    const seen: string[] = []
    const outcome = await readWithPool({
      db: ctx.db,
      env: ctx.env,
      providerId,
      initial: { baseUrl: one, apiKey: '', allowPrivate: false },
      call: async (target) => {
        seen.push(target.baseUrl)
        if (target.apiKey === 'sk-freeze-read-a-1111') {
          ctx.db.prepare('UPDATE provider_connections SET base_url = ? WHERE id = ?').run(two, providerId)
          return fakeResponse(401)
        }
        return fakeResponse(200)
      },
    })

    expect(outcome.attempts).toBe(2)
    expect(outcome.target.credentialId).toBe(keyB.id)
    expect(seen).toEqual([one, one])
    expect(credentialRow(keyA.id).health_status).toBe('auth_failed')
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('Con trỏ round-robin đặt lại khi thứ tự thay đổi', () => {
  it('sắp xếp lại bắt đầu từ thứ tự đã lưu (không dùng con trỏ cũ)', async () => {
    const { userId, providerId } = await newProvider()
    const a = await addKey(userId, providerId, 'sk-rr-order-a-1111')
    const b = await addKey(userId, providerId, 'sk-rr-order-b-2222')
    const c = await addKey(userId, providerId, 'sk-rr-order-c-3333')
    setProviderSelectionMode(ctx.db, userId, providerId, 'round_robin')

    expect(selectCredential(ctx.db, ctx.env, providerId).credentialId).toBe(a.id)
    expect(rrCursor(providerId)).toBe(0)

    reorderCredentials(ctx.db, userId, providerId, [c.id, a.id, b.id])
    expect(rrCursor(providerId)).toBeNull()

    // Con trỏ cũ = 0 sẽ chọn a; reset đúng phải chọn c (đầu thứ tự mới).
    expect(selectCredential(ctx.db, ctx.env, providerId).credentialId).toBe(c.id)
    expect(selectCredential(ctx.db, ctx.env, providerId).credentialId).toBe(a.id)
  })

  it('dời một key đặt lại con trỏ', async () => {
    const { userId, providerId } = await newProvider()
    const a = await addKey(userId, providerId, 'sk-rr-move-a-1111')
    const b = await addKey(userId, providerId, 'sk-rr-move-b-2222')
    const c = await addKey(userId, providerId, 'sk-rr-move-c-3333')
    setProviderSelectionMode(ctx.db, userId, providerId, 'round_robin')

    expect(selectCredential(ctx.db, ctx.env, providerId).credentialId).toBe(a.id)
    expect(rrCursor(providerId)).toBe(0)

    updateCredential(ctx.db, ctx.env, userId, providerId, c.id, { position: 0 })
    expect(rrCursor(providerId)).toBeNull()
    expect(listCredentials(ctx.db, userId, providerId).map((item) => item.id)).toEqual([
      c.id,
      a.id,
      b.id,
    ])

    // Con trỏ cũ = 0 sẽ chọn a; reset đúng phải chọn c.
    expect(selectCredential(ctx.db, ctx.env, providerId).credentialId).toBe(c.id)
  })

  it('thêm key vào giữa đặt lại con trỏ', async () => {
    const { userId, providerId } = await newProvider()
    const a = await addKey(userId, providerId, 'sk-rr-insert-a-1111')
    const b = await addKey(userId, providerId, 'sk-rr-insert-b-2222')
    setProviderSelectionMode(ctx.db, userId, providerId, 'round_robin')

    expect(selectCredential(ctx.db, ctx.env, providerId).credentialId).toBe(a.id)
    expect(rrCursor(providerId)).toBe(0)

    const inserted = addKey(userId, providerId, 'sk-rr-insert-c-3333', { position: 0 })
    expect(rrCursor(providerId)).toBeNull()
    expect(selectCredential(ctx.db, ctx.env, providerId).credentialId).toBe(inserted.id)
  })

  it('xóa một key đặt lại con trỏ', async () => {
    const { userId, providerId } = await newProvider()
    const a = await addKey(userId, providerId, 'sk-rr-remove-a-1111')
    const b = await addKey(userId, providerId, 'sk-rr-remove-b-2222')
    const c = await addKey(userId, providerId, 'sk-rr-remove-c-3333')
    setProviderSelectionMode(ctx.db, userId, providerId, 'round_robin')

    expect(selectCredential(ctx.db, ctx.env, providerId).credentialId).toBe(a.id)
    expect(rrCursor(providerId)).toBe(0)

    removeCredential(ctx.db, userId, providerId, c.id)
    expect(rrCursor(providerId)).toBeNull()

    // Con trỏ cũ = 0 sẽ chọn b; reset đúng phải quay về a (đầu danh sách).
    expect(selectCredential(ctx.db, ctx.env, providerId).credentialId).toBe(a.id)
  })
})
