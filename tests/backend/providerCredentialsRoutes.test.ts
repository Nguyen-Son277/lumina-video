/**
 * Tích hợp HTTP cho pool API key đa khóa: `server/providers/routes.ts`.
 *
 * Phạm vi: chỉ kiểm tra tầng route + service công khai qua HTTP thật
 * (PROVIDER_MODE=mock, không gọi mạng, không tốn phí):
 *   · POST /api/providers tạo provider + key đầu tiên trong MỘT transaction;
 *   · CRUD key lồng dưới provider (GET/POST/PATCH/DELETE + reorder);
 *   · PATCH provider thay key ưu tiên / đổi selectionMode;
 *   · POST kiểm tra đúng một key (không failover) và test/sync dùng pool;
 *   · giới hạn tần suất gọi provider ra ngoài + bảo vệ tác vụ có thể phục hồi;
 *   · không bao giờ trả bí mật (apiKey/ciphertext/iv/tag) ra phản hồi.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, startTestServer, type TestContext } from './helpers'
import { listCredentials, selectCredential } from '../../server/providers/credentials'

let ctx: TestContext

beforeAll(async () => {
  ctx = await startTestServer()
})

afterAll(async () => {
  if (ctx) await ctx.close()
})

// ── Tiện ích ────────────────────────────────────────────────────────────────

async function newUser(): Promise<string> {
  const { userId } = await registerUser(ctx)
  return userId
}

/** Tạo provider qua HTTP (đúng luồng người dùng) và trả về provider đã tạo. */
async function createProvider(
  body: Record<string, unknown> = {},
): Promise<{ providerId: string; provider: any; credentialId: string }> {
  const created = await call(ctx, '/api/providers', {
    method: 'POST',
    body: {
      name: 'Provider pool',
      baseUrl: 'https://pool.mock.test/v1',
      apiKey: 'sk-init-1111',
      ...body,
    },
  })
  if (created.status !== 201) {
    throw new Error(`Tạo provider thất bại: ${JSON.stringify(created.body)}`)
  }
  const credentials = created.body.provider.credentials
  if (!Array.isArray(credentials) || credentials.length !== 1) {
    throw new Error(`Provider mới phải có đúng 1 key: ${JSON.stringify(created.body)}`)
  }
  return {
    providerId: created.body.provider.id,
    provider: created.body.provider,
    credentialId: credentials[0].id,
  }
}

function insertGeneration(options: {
  userId: string
  providerId: string
  credentialId: string | null
  status: string
  providerJobId?: string | null
}): string {
  const id = `gen-${Math.random().toString(36).slice(2, 12)}`
  const now = Date.now()
  ctx.db
    .prepare(
      `INSERT INTO generations
         (id, user_id, provider_id, credential_id, kind, prompt, params_json,
          snap_provider, snap_base_url, snap_model_id, status, provider_job_id,
          attempt_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'image', 'x', '{}', 'p', 'https://pool.mock.test/v1', 'm', ?, ?, 0, ?, ?)`,
    )
    .run(
      id,
      options.userId,
      options.providerId,
      options.credentialId,
      options.status,
      options.providerJobId ?? null,
      now,
      now,
    )
  return id
}

function credentialCount(providerId: string): number {
  return Number(
    (
      ctx.db
        .prepare('SELECT COUNT(*) AS total FROM provider_credentials WHERE provider_id = ?')
        .get(providerId) as { total: number }
    ).total,
  )
}

// ── POST provider + key đầu tiên ────────────────────────────────────────────

describe('POST /api/providers tạo provider kèm key đầu tiên', () => {
  it('tạo provider và key trong cùng một transaction, phản hồi không lộ bí mật', async () => {
    const userId = await newUser()
    const secret = 'sk-tao-moi-1234'
    const { providerId, provider, credentialId } = await createProvider({ apiKey: secret })

    // Provider trả kèm metadata pool: selectionMode + credentials công khai.
    expect(provider.selectionMode).toBe('failover')
    expect(provider.keyHint).toBe('••••1234')
    expect(provider.credentials).toHaveLength(1)
    expect(JSON.stringify(provider)).not.toContain(secret)
    for (const field of ['apiKey', 'ciphertext', '"iv"', '"tag"']) {
      expect(JSON.stringify(provider), `không được lộ ${field}`).not.toContain(field)
    }

    // Key nằm đúng trong pool của provider, không phải bản ghi mồ côi.
    const pool = listCredentials(ctx.db, userId, providerId)
    expect(pool).toHaveLength(1)
    expect(pool[0]!.id).toBe(credentialId)
    expect(pool[0]!.hint).toBe('••••1234')
    expect(pool[0]!.position).toBe(0)

    // Bí mật chỉ được lưu dạng mã hóa; cột legacy vẫn giữ để rollback.
    const row = ctx.db
      .prepare(
        'SELECT ciphertext, api_key_ciphertext FROM provider_credentials c JOIN provider_connections p ON p.id = c.provider_id WHERE c.id = ?',
      )
      .get(credentialId) as any
    expect(Buffer.from(row.ciphertext).toString('utf8')).not.toContain(secret)
    expect(row.api_key_ciphertext).toBeTruthy()

    // Key chọn được lúc chạy và giải mã đúng.
    expect(selectCredential(ctx.db, ctx.env, providerId).apiKey).toBe(secret)
  })

  it('từ chối Base URL nguy hiểm mà không để lại provider/key mồ côi', async () => {
    const userId = await newUser()
    const before = ctx.db
      .prepare('SELECT COUNT(*) AS total FROM provider_connections WHERE user_id = ?')
      .get(userId) as { total: number }

    const created = await call(ctx, '/api/providers', {
      method: 'POST',
      body: { name: 'SSRF', baseUrl: 'khong-phai-url', apiKey: 'sk-ssrf-0000' },
    })
    expect(created.status).toBe(400)

    const after = ctx.db
      .prepare('SELECT COUNT(*) AS total FROM provider_connections WHERE user_id = ?')
      .get(userId) as { total: number }
    expect(Number(after.total)).toBe(Number(before.total))
    const orphans = ctx.db
      .prepare('SELECT COUNT(*) AS total FROM provider_credentials WHERE provider_id NOT IN (SELECT id FROM provider_connections)')
      .get() as { total: number }
    expect(Number(orphans.total)).toBe(0)
  })
})

// ── CRUD key lồng dưới provider ─────────────────────────────────────────────

describe('CRUD /api/providers/:id/credentials', () => {
  it('liệt kê pool kèm selectionMode và không lộ bí mật', async () => {
    const userId = await newUser()
    const { providerId } = await createProvider({ apiKey: 'sk-list-1111' })
    await call(ctx, `/api/providers/${providerId}/credentials`, {
      method: 'POST',
      body: { apiKey: 'sk-list-2222', label: 'dự phòng' },
    })

    const listed = await call(ctx, `/api/providers/${providerId}/credentials`)
    expect(listed.status).toBe(200)
    expect(listed.body.pool.selectionMode).toBe('failover')
    expect(listed.body.selectionMode).toBe('failover')
    expect(listed.body.pool.credentials.map((item: any) => item.hint)).toEqual([
      '••••1111',
      '••••2222',
    ])
    expect(listed.body.credentials).toHaveLength(2)
    expect(JSON.stringify(listed.body)).not.toContain('sk-list-')
  })

  it('thêm, đọc một key, sửa nhãn/bật-tắt, dời vị trí và xóa', async () => {
    const userId = await newUser()
    const { providerId } = await createProvider({ apiKey: 'sk-crud-0001' })

    const second = await call(ctx, `/api/providers/${providerId}/credentials`, {
      method: 'POST',
      body: { apiKey: 'sk-crud-0002', label: 'hai' },
    })
    expect(second.status).toBe(201)
    const secondId = second.body.credential.id
    expect(second.body.credential.position).toBe(1)
    expect(second.body.credential.enabled).toBe(true)

    // Chèn vào đầu bằng position.
    const inserted = await call(ctx, `/api/providers/${providerId}/credentials`, {
      method: 'POST',
      body: { apiKey: 'sk-crud-0003', position: 0, enabled: false },
    })
    expect(inserted.status).toBe(201)
    expect(inserted.body.credential.position).toBe(0)
    expect(inserted.body.credential.enabled).toBe(false)

    const one = await call(ctx, `/api/providers/${providerId}/credentials/${secondId}`)
    expect(one.status).toBe(200)
    expect(one.body.credential.id).toBe(secondId)
    expect(JSON.stringify(one.body)).not.toContain('sk-crud-0002')

    const patched = await call(ctx, `/api/providers/${providerId}/credentials/${secondId}`, {
      method: 'PATCH',
      body: { label: 'đổi tên', enabled: false },
    })
    expect(patched.status).toBe(200)
    expect(patched.body.credential.label).toBe('đổi tên')
    expect(patched.body.credential.enabled).toBe(false)

    const removed = await call(ctx, `/api/providers/${providerId}/credentials/${inserted.body.credential.id}`, {
      method: 'DELETE',
    })
    expect(removed.status).toBe(204)
    expect(credentialCount(providerId)).toBe(2)

    // Vị trí được chuẩn hóa 0..n-1 sau khi xóa.
    const pool = listCredentials(ctx.db, userId, providerId)
    expect(pool.map((item) => item.position)).toEqual([0, 1])
  })

  it('sắp xếp lại bằng POST và PATCH; từ chối danh sách sai', async () => {
    const userId = await newUser()
    const { providerId } = await createProvider({ apiKey: 'sk-order-0001' })
    const second = await call(ctx, `/api/providers/${providerId}/credentials`, {
      method: 'POST',
      body: { apiKey: 'sk-order-0002' },
    })
    const third = await call(ctx, `/api/providers/${providerId}/credentials`, {
      method: 'POST',
      body: { apiKey: 'sk-order-0003' },
    })
    expect(second.status).toBe(201)
    expect(third.status).toBe(201)

    const listRes = await call(ctx, `/api/providers/${providerId}/credentials`)
    const ids = listRes.body.credentials.map((item: any) => item.id)

    const moved = await call(ctx, `/api/providers/${providerId}/credentials/reorder`, {
      method: 'POST',
      body: { ids: [ids[2], ids[0], ids[1]] },
    })
    expect(moved.status).toBe(200)
    expect(moved.body.credentials.map((item: any) => item.id)).toEqual([ids[2], ids[0], ids[1]])

    // PATCH cùng đường dẫn vẫn tương thích với hợp đồng HTTP cũ.
    const viaPatch = await call(ctx, `/api/providers/${providerId}/credentials/reorder`, {
      method: 'PATCH',
      body: { ids: [ids[1], ids[2], ids[0]] },
    })
    expect(viaPatch.status).toBe(200)
    expect(viaPatch.body.credentials.map((item: any) => item.position)).toEqual([0, 1, 2])

    const missing = await call(ctx, `/api/providers/${providerId}/credentials/reorder`, {
      method: 'POST',
      body: { ids: [ids[0], ids[1]] },
    })
    expect(missing.status).toBe(400)
    // Thứ tự không đổi sau lần từ chối.
    const after = listCredentials(ctx.db, userId, providerId)
    expect(after.map((item) => item.id)).toEqual([ids[1], ids[2], ids[0]])
  })

  it('trả 404 cho key không tồn tại và không rò rỉ bí mật', async () => {
    await newUser()
    const { providerId } = await createProvider({ apiKey: 'sk-missing-0001' })
    const cases: Array<[string, () => Promise<any>]> = [
      ['GET', () => call(ctx, `/api/providers/${providerId}/credentials/khong-co`)],
      [
        'PATCH',
        () =>
          call(ctx, `/api/providers/${providerId}/credentials/khong-co`, {
            method: 'PATCH',
            body: { label: 'x' },
          }),
      ],
      [
        'DELETE',
        () => call(ctx, `/api/providers/${providerId}/credentials/khong-co`, { method: 'DELETE' }),
      ],
      [
        'POST test',
        () => call(ctx, `/api/providers/${providerId}/credentials/khong-co/test`, { method: 'POST' }),
      ],
    ]
    for (const [label, attempt] of cases) {
      const result = await attempt()
      expect(result.status, label).toBe(404)
      expect(JSON.stringify(result.body), label).not.toContain('sk-missing-0001')
    }
  })

  it('cô lập theo chủ sở hữu: tài khoản khác nhận 404, ẩn danh nhận 401', async () => {
    const owner = await newUser()
    const ownerCookie = ctx.cookie
    const { providerId, credentialId } = await createProvider({ apiKey: 'sk-chu-7777' })

    await newUser()
    const strangerList = await call(ctx, `/api/providers/${providerId}/credentials`)
    expect(strangerList.status).toBe(404)
    const strangerDelete = await call(
      ctx,
      `/api/providers/${providerId}/credentials/${credentialId}`,
      { method: 'DELETE' },
    )
    expect(strangerDelete.status).toBe(404)
    expect(JSON.stringify(strangerDelete.body)).not.toContain('sk-chu-7777')

    const anonymous = await fetch(`${ctx.baseUrl}/api/providers/${providerId}/credentials`, {
      headers: { Cookie: '' },
    })
    expect(anonymous.status).toBe(401)

    const asOwner = await call(ctx, `/api/providers/${providerId}/credentials`, { cookie: ownerCookie })
    expect(asOwner.status).toBe(200)
    expect(asOwner.body.credentials).toHaveLength(1)
    expect(JSON.stringify(asOwner.body)).not.toContain('sk-chu-7777')
  })
})

// ── PATCH provider: selectionMode + thay key ưu tiên ────────────────────────

describe('PATCH /api/providers/:id', () => {
  it('đổi selectionMode và từ chối giá trị không hợp lệ', async () => {
    await newUser()
    const { providerId } = await createProvider({ apiKey: 'sk-mode-0001' })

    const set = await call(ctx, `/api/providers/${providerId}`, {
      method: 'PATCH',
      body: { selectionMode: 'round_robin' },
    })
    expect(set.status).toBe(200)
    expect(set.body.provider.selectionMode).toBe('round_robin')

    const list = await call(ctx, '/api/providers')
    const fromList = list.body.providers.find((item: any) => item.id === providerId)
    expect(fromList.selectionMode).toBe('round_robin')

    const invalid = await call(ctx, `/api/providers/${providerId}`, {
      method: 'PATCH',
      body: { selectionMode: 'linh-tinh' },
    })
    expect(invalid.status).toBe(400)
    expect(invalid.body.error.messageKey).toBeTruthy()
  })

  it('thay apiKey cập nhật key ưu tiên cao nhất, không thêm key mới', async () => {
    const userId = await newUser()
    const { providerId } = await createProvider({ apiKey: 'sk-cu-1111' })
    await call(ctx, `/api/providers/${providerId}/credentials`, {
      method: 'POST',
      body: { apiKey: 'sk-du-phong-2222' },
    })

    const patched = await call(ctx, `/api/providers/${providerId}`, {
      method: 'PATCH',
      body: { apiKey: 'sk-moi-3333' },
    })
    expect(patched.status).toBe(200)
    expect(patched.body.provider.keyHint).toBe('••••3333')
    expect(JSON.stringify(patched.body)).not.toContain('sk-moi-3333')

    const pool = listCredentials(ctx.db, userId, providerId)
    expect(pool).toHaveLength(2)
    expect(pool[0]!.hint).toBe('••••3333')
    expect(pool[1]!.hint).toBe('••••2222')
    expect(selectCredential(ctx.db, ctx.env, providerId).apiKey).toBe('sk-moi-3333')
  })
})

// ── Kiểm tra kết nối qua pool ───────────────────────────────────────────────

describe('Kiểm tra kết nối dùng pool key', () => {
  it('POST /:id/test chọn key trong pool và ghi sức khỏe', async () => {
    const userId = await newUser()
    const { providerId, credentialId } = await createProvider({ apiKey: 'sk-test-0001' })

    const result = await call(ctx, `/api/providers/${providerId}/test`, { method: 'POST' })
    expect(result.status).toBe(200)
    expect(result.body.ok).toBe(true)
    expect(result.body.modelCount).toBeGreaterThan(0)

    const credential = listCredentials(ctx.db, userId, providerId).find((item) => item.id === credentialId)!
    expect(credential.healthStatus).toBe('ok')
    expect(credential.lastUsedAt).toBeTypeOf('number')
  })

  it('POST key/test kiểm tra ĐÚNG key đó, kể cả key đang tắt (không failover)', async () => {
    const userId = await newUser()
    const { providerId, credentialId: firstId } = await createProvider({ apiKey: 'sk-first-0001' })
    const disabled = await call(ctx, `/api/providers/${providerId}/credentials`, {
      method: 'POST',
      body: { apiKey: 'sk-tat-0002', enabled: false },
    })
    const disabledId = disabled.body.credential.id

    const tested = await call(ctx, `/api/providers/${providerId}/credentials/${disabledId}/test`, {
      method: 'POST',
    })
    expect(tested.status).toBe(200)
    expect(tested.body.ok).toBe(true)
    expect(tested.body.credential.id).toBe(disabledId)
    expect(tested.body.credential.healthStatus).toBe('ok')

    // Key ưu tiên không hề được dùng: vẫn 'unknown'.
    const pool = listCredentials(ctx.db, userId, providerId)
    expect(pool.find((item) => item.id === disabledId)!.healthStatus).toBe('ok')
    expect(pool.find((item) => item.id === firstId)!.healthStatus).toBe('unknown')
  })

  it('sync-models dùng pool và cập nhật key đã dùng', async () => {
    const userId = await newUser()
    const { providerId, credentialId } = await createProvider({ apiKey: 'sk-sync-0001' })

    const sync = await call(ctx, `/api/providers/${providerId}/sync-models`, { method: 'POST' })
    expect(sync.status).toBe(200)
    expect(sync.body.added).toBeGreaterThan(0)
    expect(sync.body.total).toBeGreaterThan(0)

    expect(listCredentials(ctx.db, userId, providerId).find((item) => item.id === credentialId)!.healthStatus).toBe(
      'ok',
    )
  })

  it('giới hạn tần suất gọi provider ra ngoài', async () => {
    await newUser()
    const { providerId } = await createProvider({ apiKey: 'sk-limit-0001' })

    let limited: any = null
    for (let index = 0; index < 25; index += 1) {
      const result = await call(ctx, `/api/providers/${providerId}/test`, { method: 'POST' })
      if (result.status === 429) {
        limited = result
        break
      }
      expect(result.status, `lần ${index + 1}`).toBe(200)
    }

    expect(limited, 'phải chạm giới hạn tần suất').toBeTruthy()
    expect(limited.body.error.messageKey).toBe('providers.test_rate_limited')
  })
})

// ── Bảo vệ key đang ghim + xóa provider ─────────────────────────────────────

describe('Bảo vệ tác vụ đang ghim key', () => {
  it('chặn đổi bí mật/xóa key đang ghim nhưng vẫn cho sửa nhãn', async () => {
    const userId = await newUser()
    const { providerId, credentialId } = await createProvider({ apiKey: 'sk-pin-0001' })
    insertGeneration({ userId, providerId, credentialId, status: 'running' })

    const rotate = await call(ctx, `/api/providers/${providerId}/credentials/${credentialId}`, {
      method: 'PATCH',
      body: { apiKey: 'sk-pin-9999' },
    })
    expect(rotate.status).toBe(409)
    expect(rotate.body.error.messageKey).toBe('providers.credential_in_use')

    const remove = await call(ctx, `/api/providers/${providerId}/credentials/${credentialId}`, {
      method: 'DELETE',
    })
    expect(remove.status).toBe(409)

    const rename = await call(ctx, `/api/providers/${providerId}/credentials/${credentialId}`, {
      method: 'PATCH',
      body: { label: 'đang chạy', enabled: false },
    })
    expect(rename.status).toBe(200)
    expect(rename.body.credential.label).toBe('đang chạy')

    // PATCH provider đổi apiKey cũng bị chặn vì nó thay chính key ưu tiên đó.
    const rotateViaProvider = await call(ctx, `/api/providers/${providerId}`, {
      method: 'PATCH',
      body: { apiKey: 'sk-pin-8888' },
    })
    expect(rotateViaProvider.status).toBe(409)
  })

  it('chặn xóa provider khi còn tác vụ có thể phục hồi, cho xóa khi đã kết thúc', async () => {
    const userId = await newUser()
    const { providerId, credentialId } = await createProvider({ apiKey: 'sk-xoa-0001' })

    // failed nhưng đã có provider_job_id ⇒ có thể thử tải lại ⇒ giữ provider.
    const recoverable = insertGeneration({
      userId,
      providerId,
      credentialId,
      status: 'failed',
      providerJobId: 'job-1',
    })

    const blocked = await call(ctx, `/api/providers/${providerId}`, { method: 'DELETE' })
    expect(blocked.status).toBe(400)
    expect(blocked.body.error.messageKey).toBe('providers.has_active_jobs')
    expect(JSON.stringify(blocked.body)).not.toContain('sk-xoa-0001')

    // unknown cũng là trạng thái có thể phục hồi.
    ctx.db.prepare("UPDATE generations SET status = 'unknown' WHERE id = ?").run(recoverable)
    const blockedUnknown = await call(ctx, `/api/providers/${providerId}`, { method: 'DELETE' })
    expect(blockedUnknown.status).toBe(400)

    // Tác vụ đã kết thúc hẳn ⇒ xóa được, key cascade theo provider.
    ctx.db
      .prepare("UPDATE generations SET status = 'succeeded', provider_job_id = NULL WHERE id = ?")
      .run(recoverable)
    const removed = await call(ctx, `/api/providers/${providerId}`, { method: 'DELETE' })
    expect(removed.status).toBe(204)
    expect(credentialCount(providerId)).toBe(0)
  })
})
