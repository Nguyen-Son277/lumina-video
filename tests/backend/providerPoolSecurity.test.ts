/**
 * Kiểm thử độc lập cho nền tảng NHIỀU API KEY mỗi provider (multi-key pool).
 *
 * Bối cảnh tại thời điểm viết tệp:
 *   - Tầng dịch vụ ĐÃ có:  server/providers/credentials.ts + migration 016.
 *   - Tầng HTTP /api/providers/:id/credentials do bước routing đảm nhiệm. Nhóm B
 *     dưới đây là HỢP ĐỒNG ĐÃ DUYỆT và chạy vô điều kiện: không còn dò-tính-năng
 *     rồi tự bỏ qua (một probe như vậy che mất lệch hợp đồng, ví dụ lộ
 *     fingerprint hoặc sai phương thức reorder).
 *
 * Vì vậy tệp gồm hai nhóm:
 *   A. "Tầng dịch vụ pool key" — gọi trực tiếp credentials.ts trên DB thật của
 *      startTestServer (không gọi mạng, không tốn phí). Nhóm này chạy ngay và là
 *      nguồn xác minh chính cho các bất biến bảo mật:
 *        · owner404  : mọi thao tác của tài khoản khác đều 404.
 *        · secret    : mô hình công khai không lộ bí mật; DB không lưu bản rõ.
 *        · max10     : trần 10 key/provider (409).
 *        · duplicate : trùng key trong cùng provider bị chặn (409), khác provider thì được.
 *        · fingerprint: KHÔNG bao giờ được công khai (kế hoạch đã duyệt). Chỉ dùng
 *          nội bộ để chống trùng; không có trong read model, JSON hay HTTP.
 *        · reorder   : {ids} phải khớp đúng toàn bộ pool (400 nếu thiếu/thừa/trùng).
 *        · disabled  : key đã tắt KHÔNG bao giờ được chọn.
 *        · empty pool: pool rỗng ⇒ lỗi rõ ràng, KHÔNG fallback cột api_key_* legacy.
 *        · selectionMode: 'failover' giữ key ưu tiên, 'round_robin' quay vòng.
 *   B. "Hợp đồng HTTP /providers/:id/credentials" — hợp đồng đã duyệt:
 *        phương thức/đường dẫn/bao kết quả kỳ vọng, kèm owner404 và không lộ key.
 *
 * Hợp đồng HTTP đã duyệt:
 *   GET    /api/providers/:id/credentials            → 200 { credentials: [...],
 *                                                        pool, selectionMode }
 *   POST   /api/providers/:id/credentials            → 201 { credential }
 *   PATCH  /api/providers/:id/credentials/:credId    → 200 { credential }
 *   DELETE /api/providers/:id/credentials/:credId    → 204
 *   POST   /api/providers/:id/credentials/reorder    → 200 { credentials } (body { ids })
 *          (route còn nhận PATCH cùng đường dẫn để tương thích hợp đồng cũ)
 *   PATCH  /api/providers/:id                        → 200 { provider }   (body { selectionMode })
 * Trường công khai của credential: id, providerId, label, hint, position, enabled,
 * healthStatus, cooldownUntil, lastUsedAt, lastError*, createdAt, updatedAt.
 * KHÔNG có apiKey/ciphertext/iv/tag và KHÔNG BAO GIỜ có fingerprint.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  registerUser,
  startTestServer,
  waitForGeneration,
  type ApiResult,
  type TestContext,
} from './helpers'
import {
  MAX_CREDENTIALS_PER_PROVIDER,
  addCredential,
  credentialFingerprint,
  getCredential,
  getCredentialPool,
  listCredentials,
  removeCredential,
  reorderCredentials,
  selectCredential,
  setProviderSelectionMode,
  updateCredential,
  type ProviderSelectionMode,
} from '../../server/providers/credentials'

let ctx: TestContext

beforeAll(async () => {
  ctx = await startTestServer()
})

afterAll(async () => {
  if (ctx) await ctx.close()
})

// ── Tiện ích dùng chung ──────────────────────────────────────────────────────

/** Tạo tài khoản mới (đổi ctx.cookie sang tài khoản đó) và trả về userId. */
async function newUser(): Promise<string> {
  const { userId } = await registerUser(ctx)
  return userId
}

/**
 * Chèn thẳng một provider vào DB để kiểm thử không phụ thuộc hợp đồng của
 * POST /api/providers (vốn có thể đổi khi thêm pool key). Cột legacy api_key_*
 * được điền blob giả: nền tảng mới KHÔNG được dùng chúng làm fallback.
 */
function insertProvider(server: TestContext, userId: string, name: string, mode = 'failover'): string {
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
    .run(id, userId, name, `https://${id}.mock.test/v1`, dummy, dummy, dummy, mode, now, now)
  return id
}

/** Bắt lỗi có kiểu (AppError) do tầng dịch vụ ném ra. */
function thrownBy(fn: () => unknown): {
  status?: number
  code?: string
  message?: string
  messageKey?: string
} {
  try {
    fn()
  } catch (error) {
    const err = error as { status?: number; code?: string; message?: string; messageKey?: string }
    return { status: err.status, code: err.code, message: err.message, messageKey: err.messageKey }
  }
  throw new Error('Mong đợi một lỗi nhưng hàm đã chạy thành công')
}

/** Xác minh bí mật không hề xuất hiện dạng bản rõ ở BẤT KỲ bảng/cột nào. */
function secretAppearsInDatabase(server: TestContext, secret: string): boolean {
  const tables = server.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>

  for (const { name } of tables) {
    let rows: Array<Record<string, unknown>>
    try {
      rows = server.db
        .prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`)
        .all() as Array<Record<string, unknown>>
    } catch {
      continue
    }
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (value === null || value === undefined) continue
        const text =
          typeof value === 'string'
            ? value
            : value instanceof Uint8Array
              ? Buffer.from(value).toString('utf8')
              : String(value)
        if (text.includes(secret)) return true
      }
    }
  }
  return false
}

// ── Hợp đồng HTTP: tiện ích ──────────────────────────────────────────────────

function isEndpointMissing(body: unknown): boolean {
  const parsed = body as { error?: { messageKey?: string } } | null
  return parsed?.error?.messageKey === 'errors.endpoint_not_found'
}

/** Bao kết quả GET pool có thể là { credentials }, { pool: { credentials } } hoặc { data: {...} }. */
function credentialsOf(body: unknown): Array<Record<string, any>> {
  const parsed = body as any
  const candidates = [parsed?.credentials, parsed?.pool?.credentials, parsed?.data?.credentials]
  const found = candidates.find((item) => Array.isArray(item))
  if (!found) {
    throw new Error(`Không tìm thấy mảng credentials trong phản hồi: ${JSON.stringify(body)?.slice(0, 200)}`)
  }
  return found
}

function credentialOf(body: unknown): Record<string, any> {
  const parsed = body as any
  const found = parsed?.credential ?? parsed?.data?.credential
  if (!found) {
    throw new Error(`Không tìm thấy credential trong phản hồi: ${JSON.stringify(body)?.slice(0, 200)}`)
  }
  return found
}

function selectionModeOf(body: unknown): unknown {
  const parsed = body as any
  return parsed?.selectionMode ?? parsed?.pool?.selectionMode
}

async function httpAddCredential(
  server: TestContext,
  providerId: string,
  body: Record<string, unknown>,
): Promise<ApiResult> {
  return call(server, `/api/providers/${providerId}/credentials`, { method: 'POST', body })
}

async function httpListCredentials(server: TestContext, providerId: string): Promise<ApiResult> {
  return call(server, `/api/providers/${providerId}/credentials`)
}

/**
 * Sắp xếp lại pool: hợp đồng đã duyệt dùng POST (KHÔNG phải PATCH). Reorder là
 * một hành động ghi đè toàn bộ thứ tự nên không phải cập nhật một tài nguyên đơn.
 */
async function httpReorder(
  server: TestContext,
  providerId: string,
  ids: string[],
): Promise<ApiResult> {
  return call(server, `/api/providers/${providerId}/credentials/reorder`, {
    method: 'POST',
    body: { ids },
  })
}

async function httpPatchCredential(
  server: TestContext,
  providerId: string,
  credentialId: string,
  body: Record<string, unknown>,
): Promise<ApiResult> {
  return call(server, `/api/providers/${providerId}/credentials/${credentialId}`, {
    method: 'PATCH',
    body,
  })
}

/** Sinh nội dung phải bị chặn vì pool không có key khả dụng (không tốn phí: mock). */
async function expectGenerationBlocked(
  server: TestContext,
  modelId: string,
  prompt: string,
): Promise<void> {
  const created = await call(server, '/api/generations', {
    method: 'POST',
    body: { modelId, prompt },
  })
  if (created.status === 202) {
    const generation = await waitForGeneration(server, created.body.generation.id, {
      timeoutMs: 8_000,
    })
    expect(generation.status, JSON.stringify(generation)).toBe('failed')
    expect(String(generation.errorMessage ?? '')).not.toBe('')
    return
  }
  expect([400, 409, 502], JSON.stringify(created.body)).toContain(created.status)
}

// ════════════════════════════════════════════════════════════════════════════
// A. Tầng dịch vụ pool key (chạy ngay)
// ════════════════════════════════════════════════════════════════════════════

describe('Pool nhiều API key — tầng dịch vụ', () => {
  it('cô lập theo chủ sở hữu: mọi thao tác của tài khoản khác đều 404', async () => {
    const owner = await newUser()
    const providerId = insertProvider(ctx, owner, 'Riêng A')
    const credential = addCredential(ctx.db, ctx.env, owner, providerId, {
      apiKey: 'sk-chu-so-huu-1111',
      label: 'chính',
    })

    const stranger = await newUser()
    const otherProvider = insertProvider(ctx, stranger, 'Riêng B')

    const operations: Array<() => unknown> = [
      () => listCredentials(ctx.db, stranger, providerId),
      () => getCredentialPool(ctx.db, stranger, providerId),
      () => getCredential(ctx.db, stranger, providerId, credential.id),
      () => addCredential(ctx.db, ctx.env, stranger, providerId, { apiKey: 'sk-ke-la-2222' }),
      () => updateCredential(ctx.db, ctx.env, stranger, providerId, credential.id, { label: 'x' }),
      () => removeCredential(ctx.db, stranger, providerId, credential.id),
      () => reorderCredentials(ctx.db, stranger, providerId, [credential.id]),
      () => setProviderSelectionMode(ctx.db, stranger, providerId, 'round_robin'),
    ]

    for (const operation of operations) {
      const error = thrownBy(operation)
      expect(error.status, error.message).toBe(404)
    }

    // Key của A không xuất hiện khi hỏi provider của B (cùng tài khoản).
    expect(listCredentials(ctx.db, stranger, otherProvider)).toHaveLength(0)
    // Chủ sở hữu vẫn đọc bình thường.
    expect(listCredentials(ctx.db, owner, providerId)).toHaveLength(1)
    // Bí mật không rò rỉ trong thông báo lỗi.
    expect(JSON.stringify(thrownBy(() => listCredentials(ctx.db, stranger, providerId)))).not.toContain(
      'sk-chu-so-huu-1111',
    )
  })

  it('không lộ bí mật qua mô hình công khai và không lưu bản rõ trong DB', async () => {
    const userId = await newUser()
    const providerId = insertProvider(ctx, userId, 'Bí mật')
    const secret = 'sk-tuyet-mat-pool-1234'

    const created = addCredential(ctx.db, ctx.env, userId, providerId, {
      apiKey: secret,
      label: 'chính',
    })
    expect(created.hint).toBe('••••1234')

    const publicJson = JSON.stringify({
      created,
      pool: getCredentialPool(ctx.db, userId, providerId),
      list: listCredentials(ctx.db, userId, providerId),
    })
    expect(publicJson).not.toContain(secret)
    for (const field of ['ciphertext', 'apiKey', 'api_key_ciphertext', '"iv"', '"tag"', 'fingerprint']) {
      expect(publicJson, `trường ${field} không được lộ`).not.toContain(field)
    }

    // Bí mật không tồn tại dạng bản rõ ở bất kỳ bảng nào (chỉ ciphertext + hint 4 ký tự).
    expect(secretAppearsInDatabase(ctx, secret)).toBe(false)

    // Xoay key: cả bí mật cũ lẫn mới đều không lưu bản rõ.
    const rotated = 'sk-tuyet-mat-pool-5678'
    updateCredential(ctx.db, ctx.env, userId, providerId, created.id, { apiKey: rotated })
    expect(secretAppearsInDatabase(ctx, secret)).toBe(false)
    expect(secretAppearsInDatabase(ctx, rotated)).toBe(false)
    expect(getCredential(ctx.db, userId, providerId, created.id).hint).toBe('••••5678')
  })

  it(`giới hạn tối đa ${MAX_CREDENTIALS_PER_PROVIDER} key mỗi provider`, async () => {
    const userId = await newUser()
    const providerId = insertProvider(ctx, userId, 'Trần')

    for (let index = 0; index < MAX_CREDENTIALS_PER_PROVIDER; index += 1) {
      addCredential(ctx.db, ctx.env, userId, providerId, {
        apiKey: `sk-tran-${index}-${'x'.repeat(8)}`,
        label: `k${index}`,
      })
    }
    expect(listCredentials(ctx.db, userId, providerId)).toHaveLength(MAX_CREDENTIALS_PER_PROVIDER)

    const overflowSecret = 'sk-tran-11-khong-duoc-luu'
    const error = thrownBy(() =>
      addCredential(ctx.db, ctx.env, userId, providerId, { apiKey: overflowSecret }),
    )
    expect(error.status).toBe(409)
    expect(error.message).toContain(String(MAX_CREDENTIALS_PER_PROVIDER))
    expect(String(error.message)).not.toContain(overflowSecret)

    expect(listCredentials(ctx.db, userId, providerId)).toHaveLength(MAX_CREDENTIALS_PER_PROVIDER)
    expect(secretAppearsInDatabase(ctx, overflowSecret)).toBe(false)
  })

  it('chặn key trùng trong cùng provider nhưng cho phép ở provider khác', async () => {
    const userId = await newUser()
    const first = insertProvider(ctx, userId, 'Trùng 1')
    const second = insertProvider(ctx, userId, 'Trùng 2')
    const secret = 'sk-trung-9999'

    const credential = addCredential(ctx.db, ctx.env, userId, first, { apiKey: secret, label: 'a' })

    // Trùng kể cả khi có khoảng trắng thừa (so theo fingerprint sau khi trim).
    const duplicate = thrownBy(() =>
      addCredential(ctx.db, ctx.env, userId, first, { apiKey: `  ${secret}  `, label: 'b' }),
    )
    expect(duplicate.status).toBe(409)
    expect(listCredentials(ctx.db, userId, first)).toHaveLength(1)
    expect(secretAppearsInDatabase(ctx, secret)).toBe(false)

    // HỢP ĐỒNG ĐÃ DUYỆT: fingerprint KHÔNG BAO GIỜ được công khai. Nó vẫn tồn
    // tại trong DB (dùng nội bộ để chống trùng) nhưng tuyệt đối không có trong
    // read model, JSON hay HTTP — nếu lộ, người đọc suy ra được tương quan
    // "hai provider dùng chung một key" và có thêm bộ so khớp ngoại tuyến.
    const expectedFingerprint = credentialFingerprint(ctx.env, secret)
    const storedFingerprint = (
      ctx.db.prepare('SELECT fingerprint FROM provider_credentials WHERE id = ?').get(credential.id) as {
        fingerprint: string | null
      }
    ).fingerprint
    expect(storedFingerprint).toBe(expectedFingerprint)

    const published = JSON.stringify({
      created: credential,
      pool: getCredentialPool(ctx.db, userId, first),
      list: listCredentials(ctx.db, userId, first),
    })
    expect(published).not.toContain(expectedFingerprint)
    expect(Object.keys(credential)).not.toContain('fingerprint')
    expect((credential as Record<string, unknown>).fingerprint).toBeUndefined()

    // Cùng key ở provider khác thì hợp lệ; cả hai bản ghi đều không lộ
    // fingerprint nên không thể suy ra chúng dùng chung một key.
    const other = addCredential(ctx.db, ctx.env, userId, second, { apiKey: secret, label: 'a' })
    expect(other.id).not.toBe(credential.id)
    expect(JSON.stringify(other)).not.toContain(expectedFingerprint)
    expect(Object.keys(other)).not.toContain('fingerprint')
    expect((other as Record<string, unknown>).fingerprint).toBeUndefined()

    // Đổi key của credential khác sang key đã tồn tại cũng bị chặn.
    const another = addCredential(ctx.db, ctx.env, userId, first, { apiKey: 'sk-trung-8888' })
    const patchDuplicate = thrownBy(() =>
      updateCredential(ctx.db, ctx.env, userId, first, another.id, { apiKey: secret }),
    )
    expect(patchDuplicate.status).toBe(409)
  })

  it('sắp xếp lại toàn bộ pool bằng {ids} và từ chối danh sách sai', async () => {
    const userId = await newUser()
    const providerId = insertProvider(ctx, userId, 'Thứ tự')
    const a = addCredential(ctx.db, ctx.env, userId, providerId, { apiKey: 'sk-thu-tu-a-1111' })
    const b = addCredential(ctx.db, ctx.env, userId, providerId, { apiKey: 'sk-thu-tu-b-2222' })
    const c = addCredential(ctx.db, ctx.env, userId, providerId, { apiKey: 'sk-thu-tu-c-3333' })

    expect(listCredentials(ctx.db, userId, providerId).map((item) => item.id)).toEqual([
      a.id,
      b.id,
      c.id,
    ])

    const reordered = reorderCredentials(ctx.db, userId, providerId, [c.id, a.id, b.id])
    expect(reordered.map((item) => item.id)).toEqual([c.id, a.id, b.id])
    expect(reordered.map((item) => item.position)).toEqual([0, 1, 2])
    expect(listCredentials(ctx.db, userId, providerId).map((item) => item.id)).toEqual([
      c.id,
      a.id,
      b.id,
    ])

    // Thiếu id.
    expect(thrownBy(() => reorderCredentials(ctx.db, userId, providerId, [c.id, a.id])).status).toBe(400)
    // Thừa/không thuộc pool.
    expect(
      thrownBy(() => reorderCredentials(ctx.db, userId, providerId, [c.id, a.id, b.id, 'khong-co']))
        .status,
    ).toBe(400)
    // Trùng id.
    expect(
      thrownBy(() => reorderCredentials(ctx.db, userId, providerId, [c.id, a.id, a.id])).status,
    ).toBe(400)
    // Key thuộc provider khác.
    const otherProvider = insertProvider(ctx, userId, 'Thứ tự khác')
    const foreign = addCredential(ctx.db, ctx.env, userId, otherProvider, { apiKey: 'sk-thu-tu-x-9999' })
    expect(
      thrownBy(() =>
        reorderCredentials(ctx.db, userId, providerId, [c.id, a.id, b.id, foreign.id]),
      ).status,
    ).toBe(400)

    // Mọi lần từ chối đều không đổi thứ tự.
    expect(listCredentials(ctx.db, userId, providerId).map((item) => item.id)).toEqual([
      c.id,
      a.id,
      b.id,
    ])
  })

  it('bỏ qua key đã tắt và không bao giờ trả key bị tắt khi chọn', async () => {
    const userId = await newUser()
    const providerId = insertProvider(ctx, userId, 'Tắt')

    const disabled = addCredential(ctx.db, ctx.env, userId, providerId, {
      apiKey: 'sk-bi-tat-3333',
      label: 'tắt',
      enabled: false,
    })
    expect(disabled.enabled).toBe(false)

    // Chỉ có key bị tắt ⇒ pool không khả dụng.
    const emptyish = thrownBy(() => selectCredential(ctx.db, ctx.env, providerId))
    expect(emptyish.status).toBe(502)
    expect(emptyish.message).toContain('API key khả dụng')

    const enabled = addCredential(ctx.db, ctx.env, userId, providerId, {
      apiKey: 'sk-dang-bat-4444',
      label: 'bật',
    })
    const picked = selectCredential(ctx.db, ctx.env, providerId)
    expect(picked.credentialId).toBe(enabled.id)
    expect(picked.apiKey).toBe('sk-dang-bat-4444')
    expect(picked.apiKey).not.toBe('sk-bi-tat-3333')

    // Tắt nốt key đang bật ⇒ lại không còn key khả dụng.
    updateCredential(ctx.db, ctx.env, userId, providerId, enabled.id, { enabled: false })
    expect(thrownBy(() => selectCredential(ctx.db, ctx.env, providerId)).status).toBe(502)

    // Bật lại thì chọn được ngay.
    updateCredential(ctx.db, ctx.env, userId, providerId, enabled.id, { enabled: true })
    expect(selectCredential(ctx.db, ctx.env, providerId).credentialId).toBe(enabled.id)
  })

  it('pool rỗng báo lỗi rõ ràng và KHÔNG fallback cột api_key_* legacy', async () => {
    const userId = await newUser()
    // Provider có blob legacy giả (không giải mã được) nhưng pool rỗng.
    const providerId = insertProvider(ctx, userId, 'Rỗng')

    const pool = getCredentialPool(ctx.db, userId, providerId)
    expect(pool.credentials).toHaveLength(0)
    expect(pool.selectionMode).toBe('failover')

    const error = thrownBy(() => selectCredential(ctx.db, ctx.env, providerId))
    expect(error.status).toBe(502)
    expect(error.message).toContain('chưa có API key')
  })

  it('chế độ chọn key: failover giữ key ưu tiên, round_robin quay vòng', async () => {
    const userId = await newUser()
    const providerId = insertProvider(ctx, userId, 'Chế độ')
    const a = addCredential(ctx.db, ctx.env, userId, providerId, { apiKey: 'sk-che-do-a-1111' })
    const b = addCredential(ctx.db, ctx.env, userId, providerId, { apiKey: 'sk-che-do-b-2222' })

    // Mặc định failover: luôn chọn key ưu tiên cao nhất (position nhỏ nhất).
    expect(getCredentialPool(ctx.db, userId, providerId).selectionMode).toBe('failover')
    expect(selectCredential(ctx.db, ctx.env, providerId).credentialId).toBe(a.id)
    expect(selectCredential(ctx.db, ctx.env, providerId).credentialId).toBe(a.id)

    // round_robin: a → b → a.
    setProviderSelectionMode(ctx.db, userId, providerId, 'round_robin')
    const first = selectCredential(ctx.db, ctx.env, providerId)
    const second = selectCredential(ctx.db, ctx.env, providerId)
    const third = selectCredential(ctx.db, ctx.env, providerId)
    expect([first.credentialId, second.credentialId, third.credentialId]).toEqual([
      a.id,
      b.id,
      a.id,
    ])
    expect([first.apiKey, second.apiKey]).toEqual(['sk-che-do-a-1111', 'sk-che-do-b-2222'])

    expect(getCredentialPool(ctx.db, userId, providerId).selectionMode).toBe('round_robin')

    // Chế độ không hợp lệ bị từ chối và không đổi cấu hình.
    const invalid = thrownBy(() =>
      setProviderSelectionMode(ctx.db, userId, providerId, 'linh_tinh' as ProviderSelectionMode),
    )
    expect(invalid.status).toBe(400)
    expect(getCredentialPool(ctx.db, userId, providerId).selectionMode).toBe('round_robin')

    // round_robin bỏ qua key đã tắt.
    updateCredential(ctx.db, ctx.env, userId, providerId, a.id, { enabled: false })
    expect(selectCredential(ctx.db, ctx.env, providerId).credentialId).toBe(b.id)
    expect(selectCredential(ctx.db, ctx.env, providerId).credentialId).toBe(b.id)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// B. Hợp đồng HTTP /api/providers/:id/credentials (hợp đồng đã duyệt, chạy luôn)
// ════════════════════════════════════════════════════════════════════════════

describe('Hợp đồng HTTP pool API key', () => {
  it('tài khoản khác nhận 404 cho mọi thao tác credential, không lộ key', async () => {
    const owner = await newUser()
    const ownerCookie = ctx.cookie
    const providerId = insertProvider(ctx, owner, 'Chủ sở hữu')
    const secret = 'sk-chu-http-1111'
    const credential = addCredential(ctx.db, ctx.env, owner, providerId, { apiKey: secret, label: 'a' })

    const stranger = await newUser()
    const otherProvider = insertProvider(ctx, stranger, 'Người lạ')

    const attempts: Array<[string, () => Promise<ApiResult>]> = [
      ['GET list', () => httpListCredentials(ctx, providerId)],
      ['POST', () => httpAddCredential(ctx, providerId, { apiKey: 'sk-la-http-2222' })],
      [
        'PATCH',
        () => httpPatchCredential(ctx, providerId, credential.id, { label: 'x' }),
      ],
      [
        'DELETE',
        () => call(ctx, `/api/providers/${providerId}/credentials/${credential.id}`, { method: 'DELETE' }),
      ],
      ['POST reorder', () => httpReorder(ctx, providerId, [credential.id])],
      [
        'PATCH selectionMode',
        () => call(ctx, `/api/providers/${providerId}`, { method: 'PATCH', body: { selectionMode: 'round_robin' } }),
      ],
    ]

    for (const [label, attempt] of attempts) {
      const result = await attempt()
      expect(result.status, `${label}: ${JSON.stringify(result.body)}`).toBe(404)
      // 404 phải là "không tìm thấy tài nguyên", không phải "route chưa tồn tại".
      expect(isEndpointMissing(result.body), `${label} không được là endpoint thiếu`).toBe(false)
      expect(JSON.stringify(result.body), `${label} không được lộ key`).not.toContain(secret)
    }

    // Không đọc được credential của provider khác cùng tài khoản.
    const crossProvider = await httpListCredentials(ctx, otherProvider)
    expect(crossProvider.status).toBe(200)
    expect(credentialsOf(crossProvider.body)).toHaveLength(0)

    // GET một credential là endpoint tuỳ chọn: nếu routing có làm thì phải 404 cho người lạ.
    const itemRoute = await call(ctx, `/api/providers/${providerId}/credentials/${credential.id}`)
    if (!isEndpointMissing(itemRoute.body)) {
      expect(itemRoute.status).toBe(404)
      expect(JSON.stringify(itemRoute.body)).not.toContain(secret)
    }

    // Chưa đăng nhập ⇒ 401.
    const anonymous = await fetch(`${ctx.baseUrl}/api/providers/${providerId}/credentials`, {
      headers: { Cookie: '' },
    })
    expect(anonymous.status).toBe(401)

    // Chủ sở hữu vẫn đọc được và không thấy bí mật.
    const asOwner = await call(ctx, `/api/providers/${providerId}/credentials`, {
      cookie: ownerCookie,
    })
    expect(asOwner.status).toBe(200)
    expect(credentialsOf(asOwner.body).map((item) => item.id)).toEqual([credential.id])
    expect(JSON.stringify(asOwner.body)).not.toContain(secret)
    expect(JSON.stringify(asOwner.body)).not.toContain(credentialFingerprint(ctx.env, secret))
    for (const item of credentialsOf(asOwner.body)) {
      expect(Object.keys(item)).not.toContain('fingerprint')
    }
  })

  it('không bao giờ trả api key dạng bản rõ qua HTTP', async () => {
    const userId = await newUser()
    const providerId = insertProvider(ctx, userId, 'HTTP bí mật')
    const secret = 'sk-http-tuyet-mat-1234'

    const created = await httpAddCredential(ctx, providerId, { label: 'chính', apiKey: secret })
    expect(created.status).toBe(201)
    const credential = credentialOf(created.body)
    expect(credential.hint).toBe('••••1234')
    expect(JSON.stringify(created.body)).not.toContain(secret)

    // Fingerprint là dữ liệu nội bộ chống trùng: không bao giờ được trả qua HTTP.
    const fingerprint = credentialFingerprint(ctx.env, secret)
    expect(JSON.stringify(created.body)).not.toContain(fingerprint)
    expect(Object.keys(credential)).not.toContain('fingerprint')

    const listed = await httpListCredentials(ctx, providerId)
    expect(listed.status).toBe(200)
    expect(JSON.stringify(listed.body)).not.toContain(secret)
    expect(JSON.stringify(listed.body)).not.toContain(fingerprint)
    for (const item of credentialsOf(listed.body)) {
      expect(JSON.stringify(item)).not.toContain(secret)
      expect(Object.keys(item)).not.toContain('apiKey')
      expect(Object.keys(item)).not.toContain('ciphertext')
      expect(Object.keys(item)).not.toContain('fingerprint')
    }

    const rotated = 'sk-http-tuyet-mat-5678'
    const patched = await httpPatchCredential(ctx, providerId, credential.id, { apiKey: rotated })
    expect(patched.status).toBe(200)
    expect(JSON.stringify(patched.body)).not.toContain(secret)
    expect(JSON.stringify(patched.body)).not.toContain(rotated)
    expect(JSON.stringify(patched.body)).not.toContain(fingerprint)
    expect(credentialOf(patched.body).hint).toBe('••••5678')

    expect(secretAppearsInDatabase(ctx, secret)).toBe(false)
    expect(secretAppearsInDatabase(ctx, rotated)).toBe(false)
  })

  it(`chặn key thứ ${MAX_CREDENTIALS_PER_PROVIDER + 1} qua HTTP`, async () => {
    const userId = await newUser()
    const providerId = insertProvider(ctx, userId, 'HTTP trần')

    for (let index = 0; index < MAX_CREDENTIALS_PER_PROVIDER; index += 1) {
      const created = await httpAddCredential(ctx, providerId, {
        label: `k${index}`,
        apiKey: `sk-http-tran-${index}-${'y'.repeat(8)}`,
      })
      expect(created.status, `key ${index + 1}`).toBe(201)
    }

    const overflowSecret = 'sk-http-tran-11-bi-tu-choi'
    const overflow = await httpAddCredential(ctx, providerId, { apiKey: overflowSecret })
    expect([400, 409], JSON.stringify(overflow.body)).toContain(overflow.status)
    expect(JSON.stringify(overflow.body)).not.toContain(overflowSecret)

    const listed = await httpListCredentials(ctx, providerId)
    expect(credentialsOf(listed.body)).toHaveLength(MAX_CREDENTIALS_PER_PROVIDER)
    expect(JSON.stringify(listed.body)).not.toContain(overflowSecret)
  })

  it('chặn key trùng qua HTTP nhưng cho phép ở provider khác', async () => {
    const userId = await newUser()
    const providerA = insertProvider(ctx, userId, 'HTTP trùng A')
    const providerB = insertProvider(ctx, userId, 'HTTP trùng B')
    const secret = 'sk-http-trung-9999'

    const first = await httpAddCredential(ctx, providerA, { label: 'a', apiKey: secret })
    expect(first.status).toBe(201)

    const duplicate = await httpAddCredential(ctx, providerA, { label: 'b', apiKey: secret })
    expect([400, 409], JSON.stringify(duplicate.body)).toContain(duplicate.status)
    expect(JSON.stringify(duplicate.body)).not.toContain(secret)
    expect(credentialsOf((await httpListCredentials(ctx, providerA)).body)).toHaveLength(1)

    const other = await httpAddCredential(ctx, providerB, { label: 'a', apiKey: secret })
    expect(other.status).toBe(201)
  })

  it('sắp xếp lại pool qua HTTP bằng {ids}', async () => {
    const userId = await newUser()
    const providerId = insertProvider(ctx, userId, 'HTTP thứ tự')
    const a = addCredential(ctx.db, ctx.env, userId, providerId, { apiKey: 'sk-http-a-1111' })
    const b = addCredential(ctx.db, ctx.env, userId, providerId, { apiKey: 'sk-http-b-2222' })
    const c = addCredential(ctx.db, ctx.env, userId, providerId, { apiKey: 'sk-http-c-3333' })

    const before = await httpListCredentials(ctx, providerId)
    expect(credentialsOf(before.body).map((item) => item.id)).toEqual([a.id, b.id, c.id])

    const moved = await httpReorder(ctx, providerId, [c.id, a.id, b.id])
    expect(moved.status).toBe(200)

    const after = await httpListCredentials(ctx, providerId)
    expect(credentialsOf(after.body).map((item) => item.id)).toEqual([c.id, a.id, b.id])

    // Danh sách thiếu id bị từ chối và không đổi thứ tự.
    const invalid = await httpReorder(ctx, providerId, [c.id, a.id])
    expect(invalid.status).toBe(400)
    const unchanged = await httpListCredentials(ctx, providerId)
    expect(credentialsOf(unchanged.body).map((item) => item.id)).toEqual([c.id, a.id, b.id])
  })

  it('lưu trạng thái enabled của credential và selectionMode của provider', async () => {
    const userId = await newUser()
    const providerId = insertProvider(ctx, userId, 'HTTP chế độ')

    const disabled = await httpAddCredential(ctx, providerId, {
      label: 'tắt',
      apiKey: 'sk-http-tat-3333',
      enabled: false,
    })
    expect(disabled.status).toBe(201)
    expect(credentialOf(disabled.body).enabled).toBe(false)

    const enable = await httpPatchCredential(ctx, providerId, credentialOf(disabled.body).id, {
      enabled: true,
    })
    expect(enable.status).toBe(200)
    expect(credentialOf(enable.body).enabled).toBe(true)

    const disableAgain = await httpPatchCredential(ctx, providerId, credentialOf(disabled.body).id, {
      enabled: false,
    })
    expect(disableAgain.status).toBe(200)
    expect(credentialOf(disableAgain.body).enabled).toBe(false)

    // selectionMode round-trip (đọc từ pool credentials hoặc từ danh sách provider).
    const set = await call(ctx, `/api/providers/${providerId}`, {
      method: 'PATCH',
      body: { selectionMode: 'round_robin' },
    })
    expect(set.status, JSON.stringify(set.body)).toBe(200)

    const pool = await httpListCredentials(ctx, providerId)
    const providers = await call(ctx, '/api/providers')
    const fromList = (providers.body?.providers ?? []).find((item: any) => item.id === providerId)
    const observed = [selectionModeOf(pool.body), fromList?.selectionMode].filter(Boolean)
    expect(observed, JSON.stringify({ pool: pool.body, provider: fromList })).toContain('round_robin')

    const invalid = await call(ctx, `/api/providers/${providerId}`, {
      method: 'PATCH',
      body: { selectionMode: 'khong-hop-le' },
    })
    expect(invalid.status).toBe(400)
  })

  it('xoá key cuối cùng hoặc chỉ để lại key bị tắt thì tác vụ thất bại, không dùng key cũ', async () => {
    await newUser()
    const secret = 'sk-http-thu-hoi-4444'

    // Tạo provider qua API thật: provider + key đầu tiên vào pool trong cùng
    // transaction (route đã nối). Cột legacy api_key_* cũng được ghi — đó chính
    // là "di sản" phải bị vô hiệu khi pool không còn key.
    const created = await call(ctx, '/api/providers', {
      method: 'POST',
      body: { name: 'HTTP thu hồi', baseUrl: 'https://revoke.mock.test/v1', apiKey: secret },
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const providerId = created.body.provider.id

    const model = await call(ctx, '/api/models', {
      method: 'POST',
      body: { providerId, modelId: `pool-image-${Date.now()}`, displayName: 'Pool', kind: 'image' },
    })
    expect(model.status).toBe(201)

    // (1) Xoá key cuối cùng khỏi pool. Cột legacy vẫn giữ key cũ (để rollback),
    // nên nếu worker còn đọc cột đó thì tác vụ vẫn chạy ⇒ thu hồi key vô hiệu.
    const listed = await httpListCredentials(ctx, providerId)
    const only = credentialsOf(listed.body)[0]!
    expect(only, JSON.stringify(listed.body)).toBeTruthy()
    const removed = await call(ctx, `/api/providers/${providerId}/credentials/${only.id}`, {
      method: 'DELETE',
    })
    expect([204, 200]).toContain(removed.status)

    const legacy = ctx.db
      .prepare('SELECT api_key_ciphertext FROM provider_connections WHERE id = ?')
      .get(providerId) as { api_key_ciphertext: Uint8Array } | undefined
    expect(legacy?.api_key_ciphertext).toBeTruthy()

    await expectGenerationBlocked(ctx, model.body.model.id, 'key đã bị thu hồi không được dùng lại')

    // (2) Chỉ có một key nhưng đã tắt ⇒ vẫn không có key khả dụng.
    const disabled = await httpAddCredential(ctx, providerId, {
      label: 'tắt',
      apiKey: 'sk-http-chi-tat-5555',
      enabled: false,
    })
    expect(disabled.status).toBe(201)
    await expectGenerationBlocked(ctx, model.body.model.id, 'key bị tắt không được dùng')

    // (3) Xóa nốt key đã tắt ⇒ pool rỗng trở lại, vẫn không có key khả dụng.
    const removedDisabled = await call(
      ctx,
      `/api/providers/${providerId}/credentials/${credentialOf(disabled.body).id}`,
      { method: 'DELETE' },
    )
    expect([204, 200]).toContain(removedDisabled.status)
    await expectGenerationBlocked(ctx, model.body.model.id, 'pool rỗng trở lại')
  })
})
