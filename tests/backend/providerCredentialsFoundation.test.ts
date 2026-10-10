/**
 * Nền tảng đa API key: migration 016, service `server/providers/credentials.ts`.
 *
 * Bài test dùng backend thật (database tạm) + service trực tiếp. Không sửa
 * route/worker nên các luồng HTTP hiện có vẫn giữ nguyên hành vi.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDatabase, type Database } from '../../server/db/index'
import { generateMasterKey } from '../../server/crypto/providerKey'
import { loadEnv } from '../../server/env'
import {
  CREDENTIAL_COOLDOWN_DEFAULT_SECONDS,
  CREDENTIAL_COOLDOWN_MAX_SECONDS,
  MAX_CREDENTIALS_PER_PROVIDER,
  addCredential,
  credentialFingerprint,
  decryptCredentialSecret,
  encryptCredentialSecret,
  getCredentialPool,
  isCredentialPinned,
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
import { call, registerUser, startTestServer, type TestContext } from './helpers'

let ctx: TestContext

beforeAll(async () => {
  ctx = await startTestServer()
})

afterAll(async () => {
  if (ctx) await ctx.close()
})

type CapturedError = {
  code?: string
  status?: number
  message: string
  messageKey?: string
  messageParams?: Record<string, string | number>
}

function captureError(fn: () => unknown): CapturedError {
  let result: unknown
  try {
    result = fn()
  } catch (error) {
    return error as CapturedError
  }
  // Chỉ dùng cho hàm đồng bộ (service). Hàm async phải được await trước.
  if (result && typeof (result as Promise<unknown>).then === 'function') {
    void (result as Promise<unknown>).catch(() => undefined)
    throw new Error('captureError chỉ nhận hàm đồng bộ; hãy await hàm bất đồng bộ trước')
  }
  throw new Error('Mong đợi hàm ném lỗi nhưng không ném')
}

/**
 * Tạo user mới + provider.
 *
 * Route POST /api/providers seed luôn key đầu tiên vào pool trong cùng
 * transaction với provider. Các bài test nền tảng ở đây cần xuất phát từ pool
 * rỗng (chỉ còn cột legacy), nên fixture xóa key đã seed qua service
 * `removeCredential` (đúng luồng sản phẩm). Bài kiểm tra pool rỗng truyền
 * `keepSeededCredential: true` để tự tay xóa và kiểm chứng.
 */
async function newProvider(
  apiKey = 'sk-legacy-0000',
  options: { keepSeededCredential?: boolean } = {},
): Promise<{ userId: string; providerId: string }> {
  const { userId } = await registerUser(ctx)
  const created = await call(ctx, '/api/providers', {
    method: 'POST',
    body: { name: 'Pool provider', baseUrl: 'https://pool.mock.test/v1', apiKey },
  })
  if (created.status !== 201) throw new Error(`Tạo provider thất bại: ${JSON.stringify(created.body)}`)

  const providerId = created.body.provider.id
  if (!options.keepSeededCredential) {
    for (const credential of listCredentials(ctx.db, userId, providerId)) {
      removeCredential(ctx.db, userId, providerId, credential.id)
    }
  }
  return { userId, providerId }
}

async function addKey(
  userId: string,
  providerId: string,
  apiKey: string,
  extra: { label?: string; position?: number; enabled?: boolean } = {},
): Promise<ProviderCredential> {
  return addCredential(ctx.db, ctx.env, userId, providerId, { apiKey, ...extra })
}

function insertGeneration(options: {
  userId: string
  providerId: string | null
  credentialId: string | null
  status: string
  providerJobId?: string | null
}): string {
  const id = `gen-${Math.random().toString(36).slice(2, 10)}`
  const now = Date.now()
  ctx.db
    .prepare(
      `INSERT INTO generations
         (id, user_id, provider_id, credential_id, kind, prompt, params_json,
          snap_provider, snap_base_url, snap_model_id, status, provider_job_id,
          attempt_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'image', 'x', '{}', 'p', 'https://pool.mock.test/v1', 'm', ?, ?, 0, ?, ?)`,
    )
    .run(id, options.userId, options.providerId, options.credentialId, options.status, options.providerJobId ?? null, now, now)
  return id
}

function generationRow(id: string): { credential_id: string | null; status: string } {
  return ctx.db.prepare('SELECT credential_id, status FROM generations WHERE id = ?').get(id) as any
}

function tableColumns(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>).map(
    (column) => column.name,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
describe('Migration 016 — schema', () => {
  it('tạo bảng provider_credentials đúng cột và thêm cột mới', () => {
    const columns = tableColumns(ctx.db, 'provider_credentials')
    expect(columns.sort()).toEqual(
      [
        'id',
        'provider_id',
        'label',
        'ciphertext',
        'iv',
        'tag',
        'hint',
        'fingerprint',
        'position',
        'enabled',
        'health_status',
        'cooldown_until',
        'last_used_at',
        'last_error',
        'last_error_key',
        'last_error_params',
        'created_at',
        'updated_at',
      ].sort(),
    )

    const providerColumns = tableColumns(ctx.db, 'provider_connections')
    expect(providerColumns).toContain('selection_mode')
    expect(providerColumns).toContain('rr_cursor')
    // Cột legacy vẫn còn để rollback.
    expect(providerColumns).toContain('api_key_ciphertext')

    const generationColumns = tableColumns(ctx.db, 'generations')
    expect(generationColumns).toContain('credential_id')
    expect(generationColumns).toContain('snap_credential_hint')
    expect(generationColumns).toContain('snap_credential_base_url')

    const indexes = (
      ctx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as unknown as Array<{ name: string }>
    ).map((row) => row.name)
    expect(indexes).toContain('idx_provider_credentials_fingerprint')
    expect(indexes).toContain('idx_provider_credentials_provider')
    expect(indexes).toContain('idx_generations_credential')
  })

  it('backfill provider cũ thành key mặc định và ghim generation cũ', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lumina-cred-migrate-'))
    const path = join(dir, 'legacy.db')
    const providerId = 'legacy-provider-1'
    const generationId = 'legacy-generation-1'
    const migrationsDir = fileURLToPath(new URL('../../server/db/migrations', import.meta.url))

    try {
      const raw = new DatabaseSync(path)
      raw.exec(`
        CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
        CREATE TABLE users (
          id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
          password_salt TEXT NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE TABLE provider_connections (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          base_url TEXT NOT NULL,
          api_key_ciphertext BLOB NOT NULL,
          api_key_iv BLOB NOT NULL,
          api_key_tag BLOB NOT NULL,
          key_hint TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'untested',
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          image_api_style TEXT NOT NULL DEFAULT 'openai',
          last_error_key TEXT,
          last_error_params TEXT
        );
        CREATE TABLE generations (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          provider_id TEXT REFERENCES provider_connections(id) ON DELETE SET NULL,
          kind TEXT NOT NULL,
          prompt TEXT NOT NULL,
          params_json TEXT NOT NULL DEFAULT '{}',
          snap_provider TEXT NOT NULL,
          snap_base_url TEXT NOT NULL,
          snap_model_id TEXT NOT NULL,
          status TEXT NOT NULL,
          provider_job_id TEXT,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          snap_image_style TEXT
        );
      `)

      const applied = readdirSync(migrationsDir)
        .filter((file) => file.endsWith('.sql'))
        .sort()
        .filter((file) => file < '016_')
      // 017/018 dựng bảng plan_sessions và plan_image_batch_items không có trong
      // fixture legacy này, nên đánh dấu đã áp dụng để migration 016 chạy đúng
      // phạm vi đang kiểm tra.
      applied.push('017_locations.sql', '018_batch_item_error_metadata.sql', '019_batch_retry_count.sql')
      const insertMigration = raw.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
      for (const name of applied) insertMigration.run(name, Date.now())

      const now = Date.now()
      raw.prepare(
        'INSERT INTO users (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run('u1', 'legacy@test.local', 'h', 's', now)
      raw.prepare(
        `INSERT INTO provider_connections
           (id, user_id, name, base_url, api_key_ciphertext, api_key_iv, api_key_tag, key_hint, status, created_at, updated_at)
         VALUES (?, 'u1', 'Legacy', 'https://legacy.mock.test/v1', ?, ?, ?, '••••9999', 'untested', ?, ?)`,
      ).run(providerId, Buffer.from('cipher'), Buffer.from('iv'), Buffer.from('tag'), now, now)
      raw.prepare(
        `INSERT INTO generations
           (id, user_id, provider_id, kind, prompt, snap_provider, snap_base_url, snap_model_id, status, created_at, updated_at)
         VALUES (?, 'u1', ?, 'image', 'x', 'Legacy', 'https://legacy.mock.test/v1', 'm', 'succeeded', ?, ?)`,
      ).run(generationId, providerId, now, now)
      raw.close()

      const db = openDatabase(path)
      try {
        const credential = db
          .prepare('SELECT * FROM provider_credentials WHERE provider_id = ?')
          .get(providerId) as any
        expect(credential).toBeTruthy()
        expect(credential.id).toBe(`cred_${providerId}`)
        expect(credential.hint).toBe('••••9999')
        expect(credential.position).toBe(0)
        expect(credential.enabled).toBe(1)
        expect(credential.health_status).toBe('unknown')
        expect(credential.fingerprint).toBeNull()

        const provider = db
          .prepare('SELECT selection_mode, rr_cursor FROM provider_connections WHERE id = ?')
          .get(providerId) as any
        expect(provider.selection_mode).toBe('failover')
        expect(provider.rr_cursor).toBeNull()

        const generation = db
          .prepare('SELECT credential_id, snap_credential_hint, snap_credential_base_url FROM generations WHERE id = ?')
          .get(generationId) as any
        expect(generation.credential_id).toBe(`cred_${providerId}`)
        expect(generation.snap_credential_hint).toBe('••••9999')
        expect(generation.snap_credential_base_url).toBe('https://legacy.mock.test/v1')

        // Cột legacy vẫn đọc được (không bị xóa).
        const legacy = db
          .prepare('SELECT api_key_ciphertext FROM provider_connections WHERE id = ?')
          .get(providerId) as any
        expect(Buffer.from(legacy.api_key_ciphertext).toString('utf8')).toBe('cipher')
      } finally {
        db.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('Mã hóa và dấu vân tay', () => {
  it('mã hóa AES-GCM giải mã đúng và không lộ key thô', () => {
    const encrypted = encryptCredentialSecret(ctx.env, 'sk-secret-abcd')
    expect(encrypted.ciphertext.toString('utf8')).not.toContain('sk-secret-abcd')
    expect(decryptCredentialSecret(ctx.env, encrypted)).toBe('sk-secret-abcd')
  })

  it('fingerprint HMAC ổn định, khác nhau theo key và không lộ key', () => {
    const first = credentialFingerprint(ctx.env, 'sk-aaaa-1111')
    const again = credentialFingerprint(ctx.env, '  sk-aaaa-1111  ')
    const other = credentialFingerprint(ctx.env, 'sk-bbbb-2222')
    expect(first).toBe(again)
    expect(first).not.toBe(other)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(first).not.toContain('sk-aaaa')
  })

  it('lưu key đã mã hóa, read model không có bí mật', async () => {
    const { userId, providerId } = await newProvider()
    await addKey(userId, providerId, 'sk-plain-4321')

    const stored = ctx.db
      .prepare('SELECT ciphertext, fingerprint FROM provider_credentials WHERE provider_id = ?')
      .get(providerId) as any
    expect(Buffer.from(stored.ciphertext).toString('utf8')).not.toContain('sk-plain-4321')
    expect(stored.fingerprint).toMatch(/^[0-9a-f]{64}$/)

    const credential = listCredentials(ctx.db, userId, providerId)[0]!
    expect(JSON.stringify(credential)).not.toContain('sk-plain-4321')
    expect(credential.hint).toBe('••••4321')
    // Dấu vân tay chỉ dùng nội bộ: read model công khai không được lộ ra.
    expect(credential).not.toHaveProperty('fingerprint')
    expect(JSON.stringify(credential)).not.toContain('fingerprint')

    // Key giải mã được qua lựa chọn thông thường.
    const target = selectCredential(ctx.db, ctx.env, providerId)
    expect(target.apiKey).toBe('sk-plain-4321')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('CRUD pool key', () => {
  it('giới hạn tối đa 10 key mỗi provider', async () => {
    const { userId, providerId } = await newProvider()
    for (let index = 0; index < MAX_CREDENTIALS_PER_PROVIDER; index += 1) {
      await addKey(userId, providerId, `sk-limit-${index}-0000`)
    }
    expect(listCredentials(ctx.db, userId, providerId)).toHaveLength(MAX_CREDENTIALS_PER_PROVIDER)

    const error = captureError(() =>
      addCredential(ctx.db, ctx.env, userId, providerId, { apiKey: 'sk-limit-11-0000' }),
    )
    expect(error.code).toBe('CONFLICT')
    expect(error.message).toContain('10')
  })

  it('từ chối key trùng theo fingerprint trong cùng provider', async () => {
    const { userId, providerId } = await newProvider()
    await addKey(userId, providerId, 'sk-dup-1234')
    const error = captureError(() =>
      addCredential(ctx.db, ctx.env, userId, providerId, { apiKey: 'sk-dup-1234' }),
    )
    expect(error.code).toBe('CONFLICT')
    expect(error.message).toContain('đã tồn tại')

    // Cùng key ở provider khác vẫn được (fingerprint chỉ chống trùng trong pool).
    const second = await newProvider()
    const added = await addKey(second.userId, second.providerId, 'sk-dup-1234')
    expect(added.id).toBeTruthy()
    // Provider khác không nhìn thấy key của nhau.
    expect(listCredentials(ctx.db, second.userId, second.providerId)).toHaveLength(1)
    expect(listCredentials(ctx.db, userId, providerId)).toHaveLength(1)
  })

  it('backfill fingerprint lười: key cũ fingerprint NULL vẫn bị chặn trùng', async () => {
    const { userId, providerId } = await newProvider()
    const legacyKey = 'sk-backfill-lazy-0001'
    const legacy = await addKey(userId, providerId, legacyKey)
    const readFingerprint = () =>
      (ctx.db.prepare('SELECT fingerprint FROM provider_credentials WHERE id = ?').get(legacy.id) as any)
        .fingerprint

    // Mô phỏng bản ghi do migration 016 backfill: có bí mật nhưng fingerprint NULL.
    ctx.db.prepare('UPDATE provider_credentials SET fingerprint = NULL WHERE id = ?').run(legacy.id)
    expect(readFingerprint()).toBeNull()

    // Thêm một key KHÁC: trong transaction, fingerprintForRow phải tính lại và ghi
    // fingerprint cho bản ghi backfill (đọc bí mật ra để băm, không so key thô).
    await addKey(userId, providerId, 'sk-backfill-lazy-0002')
    expect(readFingerprint()).toBe(credentialFingerprint(ctx.env, legacyKey))

    // Gặp lại đúng key cũ (fingerprint lại NULL): phải bị từ chối nhờ backfill lười.
    ctx.db.prepare('UPDATE provider_credentials SET fingerprint = NULL WHERE id = ?').run(legacy.id)
    const error = captureError(() =>
      addCredential(ctx.db, ctx.env, userId, providerId, { apiKey: legacyKey }),
    )
    expect(error.code).toBe('CONFLICT')
    expect(error.message).toContain('đã tồn tại')
    // Không có bản ghi trùng nào được tạo thêm.
    expect(listCredentials(ctx.db, userId, providerId)).toHaveLength(2)
  })

  it('thêm với position, cập nhật nhãn/bật-tắt, xóa chuẩn hóa vị trí', async () => {
    const { userId, providerId } = await newProvider()
    const first = await addKey(userId, providerId, 'sk-order-0001')
    const second = await addKey(userId, providerId, 'sk-order-0002')
    const inserted = await addKey(userId, providerId, 'sk-order-0003', { position: 0 })

    let pool = listCredentials(ctx.db, userId, providerId)
    expect(pool.map((item) => item.id)).toEqual([inserted.id, first.id, second.id])
    expect(pool.map((item) => item.position)).toEqual([0, 1, 2])

    const renamed = updateCredential(ctx.db, ctx.env, userId, providerId, inserted.id, {
      label: 'Key chính',
      enabled: false,
    })
    expect(renamed.label).toBe('Key chính')
    expect(renamed.enabled).toBe(false)
    // position được phép thay đổi trực tiếp qua update.
    updateCredential(ctx.db, ctx.env, userId, providerId, inserted.id, { position: 2 })
    pool = listCredentials(ctx.db, userId, providerId)
    expect(pool.map((item) => item.id)).toEqual([first.id, second.id, inserted.id])
    expect(pool.map((item) => item.position)).toEqual([0, 1, 2])

    removeCredential(ctx.db, userId, providerId, first.id)
    pool = listCredentials(ctx.db, userId, providerId)
    expect(pool).toHaveLength(2)
    expect(pool.map((item) => item.position)).toEqual([0, 1])
  })

  it('reorder đòi hỏi đúng toàn bộ tập key và ghi trong transaction', async () => {
    const { userId, providerId } = await newProvider()
    const a = await addKey(userId, providerId, 'sk-reorder-0001')
    const b = await addKey(userId, providerId, 'sk-reorder-0002')
    const c = await addKey(userId, providerId, 'sk-reorder-0003')

    const reordered = reorderCredentials(ctx.db, userId, providerId, [c.id, a.id, b.id])
    expect(reordered.map((item) => item.id)).toEqual([c.id, a.id, b.id])
    expect(reordered.map((item) => item.position)).toEqual([0, 1, 2])

    const missing = captureError(() => reorderCredentials(ctx.db, userId, providerId, [c.id, a.id]))
    expect(missing.code).toBe('BAD_REQUEST')
    const extra = captureError(() => reorderCredentials(ctx.db, userId, providerId, [c.id, a.id, b.id, 'khong-co']))
    expect(extra.code).toBe('BAD_REQUEST')
    const duplicated = captureError(() => reorderCredentials(ctx.db, userId, providerId, [c.id, c.id, b.id]))
    expect(duplicated.code).toBe('BAD_REQUEST')

    // Thứ tự không đổi sau các lần từ chối.
    expect(listCredentials(ctx.db, userId, providerId).map((item) => item.id)).toEqual([c.id, a.id, b.id])
  })

  it('kiểm tra quyền sở hữu provider cho mọi thao tác CRUD', async () => {
    const owner = await newProvider()
    const intruder = await newProvider()
    const credential = await addKey(owner.userId, owner.providerId, 'sk-owner-0001')

    expect(captureError(() => listCredentials(ctx.db, intruder.userId, owner.providerId)).code).toBe('NOT_FOUND')
    expect(
      captureError(() =>
        addCredential(ctx.db, ctx.env, intruder.userId, owner.providerId, { apiKey: 'sk-x-000000' }),
      ).code,
    ).toBe('NOT_FOUND')
    expect(
      captureError(() =>
        updateCredential(ctx.db, ctx.env, intruder.userId, owner.providerId, credential.id, { label: 'hack' }),
      ).code,
    ).toBe('NOT_FOUND')
    expect(
      captureError(() => removeCredential(ctx.db, intruder.userId, owner.providerId, credential.id)).code,
    ).toBe('NOT_FOUND')
    // Key của chủ vẫn nguyên vẹn.
    expect(listCredentials(ctx.db, owner.userId, owner.providerId)).toHaveLength(1)
  })

  it('pool rỗng thì báo lỗi rõ ràng, KHÔNG fallback cột legacy', async () => {
    // Giữ key đã seed để tự tay làm rỗng pool ngay trong bài test này.
    const { userId, providerId } = await newProvider('sk-legacy-khong-duoc-dung', {
      keepSeededCredential: true,
    })
    const seeded = listCredentials(ctx.db, userId, providerId)
    expect(seeded).toHaveLength(1)

    const legacy = ctx.db
      .prepare('SELECT api_key_ciphertext FROM provider_connections WHERE id = ?')
      .get(providerId) as any
    expect(legacy.api_key_ciphertext).toBeTruthy()

    // Làm rỗng pool một cách tường minh qua service (không còn key nào).
    removeCredential(ctx.db, userId, providerId, seeded[0]!.id)
    expect(listCredentials(ctx.db, userId, providerId)).toHaveLength(0)

    const error = captureError(() => selectCredential(ctx.db, ctx.env, providerId))
    expect(error.code).toBe('PROVIDER_ERROR')
    expect(error.messageKey).toBe('providers.no_available_credentials')
    expect(error.message).not.toContain('sk-legacy-khong-duoc-dung')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('Chọn key', () => {
  it('failover lấy key ưu tiên cao nhất và tôn trọng exclude', async () => {
    const { userId, providerId } = await newProvider()
    const first = await addKey(userId, providerId, 'sk-fo-0001')
    const second = await addKey(userId, providerId, 'sk-fo-0002')

    const picked = selectCredential(ctx.db, ctx.env, providerId)
    expect(picked.credentialId).toBe(first.id)
    expect(picked.apiKey).toBe('sk-fo-0001')
    expect(picked.keyHint).toBe('••••0001')
    expect(picked.baseUrl).toBe('https://pool.mock.test/v1')
    expect(picked.allowPrivate).toBe(false)

    const skipped = selectCredential(ctx.db, ctx.env, providerId, { exclude: [first.id] })
    expect(skipped.credentialId).toBe(second.id)

    const override = selectCredential(ctx.db, ctx.env, providerId, {
      baseUrlOverride: 'https://snapshot.mock.test/v1',
    })
    expect(override.baseUrl).toBe('https://snapshot.mock.test/v1')
  })

  it('advance=false không đổi last_used_at hay con trỏ', async () => {
    const { userId, providerId } = await newProvider()
    const first = await addKey(userId, providerId, 'sk-adv-0001')
    selectCredential(ctx.db, ctx.env, providerId, { advance: false })
    let row = ctx.db.prepare('SELECT last_used_at FROM provider_credentials WHERE id = ?').get(first.id) as any
    expect(row.last_used_at).toBeNull()

    selectCredential(ctx.db, ctx.env, providerId)
    row = ctx.db.prepare('SELECT last_used_at FROM provider_credentials WHERE id = ?').get(first.id) as any
    expect(typeof row.last_used_at).toBe('number')
  })

  it('round_robin quay vòng theo con trỏ đã lưu', async () => {
    const { userId, providerId } = await newProvider()
    const a = await addKey(userId, providerId, 'sk-rr-0001')
    const b = await addKey(userId, providerId, 'sk-rr-0002')
    const c = await addKey(userId, providerId, 'sk-rr-0003')
    setProviderSelectionMode(ctx.db, userId, providerId, 'round_robin')

    const order = [0, 1, 2, 3, 4].map(() => selectCredential(ctx.db, ctx.env, providerId).credentialId)
    expect(order).toEqual([a.id, b.id, c.id, a.id, b.id])

    const pool = getCredentialPool(ctx.db, userId, providerId)
    expect(pool.selectionMode).toBe('round_robin')
    expect(pool.rrCursor).toBe(b.position)

    // advance=false chỉ xem trước: con trỏ không nhích.
    const before = getCredentialPool(ctx.db, userId, providerId).rrCursor
    selectCredential(ctx.db, ctx.env, providerId, { advance: false })
    expect(getCredentialPool(ctx.db, userId, providerId).rrCursor).toBe(before)
  })

  it('bỏ qua key đã tắt', async () => {
    const { userId, providerId } = await newProvider()
    const a = await addKey(userId, providerId, 'sk-off-0001')
    const b = await addKey(userId, providerId, 'sk-off-0002')
    updateCredential(ctx.db, ctx.env, userId, providerId, a.id, { enabled: false })
    expect(selectCredential(ctx.db, ctx.env, providerId).credentialId).toBe(b.id)
  })

  it('401/403 đánh dấu auth_failed và không dùng lại', async () => {
    const { userId, providerId } = await newProvider()
    const a = await addKey(userId, providerId, 'sk-auth-0001')
    const b = await addKey(userId, providerId, 'sk-auth-0002')

    recordCredentialResult(ctx.db, a.id, { status: 401, message: 'unauthorized' })
    const credential = listCredentials(ctx.db, userId, providerId)[0]!
    expect(credential.healthStatus).toBe('auth_failed')
    expect(credential.lastErrorKey).toBe('providers.api_key_invalid')

    expect(selectCredential(ctx.db, ctx.env, providerId).credentialId).toBe(b.id)

    recordCredentialResult(ctx.db, a.id, { status: 200 })
    expect(listCredentials(ctx.db, userId, providerId)[0]!.healthStatus).toBe('ok')
  })

  it('429 tạo cooldown (mặc định 60s, trần 1h) và key hết nghỉ được dùng lại', async () => {
    const { userId, providerId } = await newProvider()
    const a = await addKey(userId, providerId, 'sk-cool-0001')
    const b = await addKey(userId, providerId, 'sk-cool-0002')
    const before = Date.now()

    recordCredentialResult(ctx.db, a.id, { status: 429 })
    let cooldown = (ctx.db.prepare('SELECT cooldown_until FROM provider_credentials WHERE id = ?').get(a.id) as any)
      .cooldown_until
    expect(cooldown - before).toBeGreaterThanOrEqual(CREDENTIAL_COOLDOWN_DEFAULT_SECONDS * 1000 - 1500)
    expect(cooldown - before).toBeLessThanOrEqual(CREDENTIAL_COOLDOWN_DEFAULT_SECONDS * 1000 + 1500)

    recordCredentialResult(ctx.db, b.id, { status: 429, retryAfterSeconds: 99_999 })
    cooldown = (ctx.db.prepare('SELECT cooldown_until FROM provider_credentials WHERE id = ?').get(b.id) as any)
      .cooldown_until
    expect(cooldown - Date.now()).toBeLessThanOrEqual(CREDENTIAL_COOLDOWN_MAX_SECONDS * 1000)
    expect(cooldown - Date.now()).toBeGreaterThan(CREDENTIAL_COOLDOWN_MAX_SECONDS * 1000 - 2000)

    const error = captureError(() => selectCredential(ctx.db, ctx.env, providerId))
    expect(error.code).toBe('RATE_LIMITED')
    expect(error.status).toBe(429)
    expect(Number(error.messageParams?.retryAfter)).toBeGreaterThan(0)

    // Hết thời gian nghỉ thì key được chọn lại (không cần reset thủ công).
    ctx.db
      .prepare("UPDATE provider_credentials SET cooldown_until = ?, health_status = 'cooldown' WHERE id = ?")
      .run(Date.now() - 1000, a.id)
    expect(selectCredential(ctx.db, ctx.env, providerId).credentialId).toBe(a.id)
  })

  it('resolvePinnedCredential bỏ qua enabled/health và dùng baseUrl đã chụp', async () => {
    const { userId, providerId } = await newProvider()
    const a = await addKey(userId, providerId, 'sk-pin-0001')
    updateCredential(ctx.db, ctx.env, userId, providerId, a.id, { enabled: false })
    recordCredentialResult(ctx.db, a.id, { status: 401 })

    const pinned = resolvePinnedCredential(ctx.db, ctx.env, a.id, 'https://snap.mock.test/v1')
    expect(pinned.apiKey).toBe('sk-pin-0001')
    expect(pinned.baseUrl).toBe('https://snap.mock.test/v1')
    expect(pinned.credentialId).toBe(a.id)
    expect(pinned.keyHint).toBe('••••0001')

    expect(captureError(() => resolvePinnedCredential(ctx.db, ctx.env, 'khong-co', 'https://x')).code).toBe('NOT_FOUND')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('Ghim key — bảo vệ bí mật và xóa', () => {
  it('chặn đổi bí mật/xóa khi key đang ghim, vẫn cho sửa nhãn/ưu tiên/tắt', async () => {
    const { userId, providerId } = await newProvider()
    const key = await addKey(userId, providerId, 'sk-guard-0001')
    const generationId = insertGeneration({
      userId,
      providerId,
      credentialId: key.id,
      status: 'running',
    })

    expect(isCredentialPinned(ctx.db, key.id)).toBe(true)
    expect(captureError(() => removeCredential(ctx.db, userId, providerId, key.id)).code).toBe('CONFLICT')
    expect(
      captureError(() =>
        updateCredential(ctx.db, ctx.env, userId, providerId, key.id, { apiKey: 'sk-guard-9999' }),
      ).code,
    ).toBe('CONFLICT')

    // Được phép: nhãn, ưu tiên, tắt key.
    const updated = updateCredential(ctx.db, ctx.env, userId, providerId, key.id, {
      label: 'Đang chạy',
      position: 0,
      enabled: false,
    })
    expect(updated.label).toBe('Đang chạy')

    // running → downloading/unknown vẫn chặn.
    ctx.db.prepare("UPDATE generations SET status = 'downloading' WHERE id = ?").run(generationId)
    expect(captureError(() => removeCredential(ctx.db, userId, providerId, key.id)).code).toBe('CONFLICT')
    ctx.db.prepare("UPDATE generations SET status = 'unknown' WHERE id = ?").run(generationId)
    expect(captureError(() => removeCredential(ctx.db, userId, providerId, key.id)).code).toBe('CONFLICT')

    // failed nhưng đã có provider_job_id (có thể thử tải lại) vẫn chặn.
    ctx.db
      .prepare("UPDATE generations SET status = 'failed', provider_job_id = 'job-1' WHERE id = ?")
      .run(generationId)
    expect(captureError(() => removeCredential(ctx.db, userId, providerId, key.id)).code).toBe('CONFLICT')

    // failed không có job ID thì được xóa.
    ctx.db.prepare("UPDATE generations SET provider_job_id = NULL WHERE id = ?").run(generationId)
    expect(isCredentialPinned(ctx.db, key.id)).toBe(false)
    removeCredential(ctx.db, userId, providerId, key.id)
    expect(listCredentials(ctx.db, userId, providerId)).toHaveLength(0)
    expect(generationRow(generationId).credential_id).toBeNull()
  })

  it('bản ghi queued đã ghim key từ trước vẫn chặn xóa', async () => {
    const { userId, providerId } = await newProvider()
    const key = await addKey(userId, providerId, 'sk-queued-0001')
    insertGeneration({ userId, providerId, credentialId: key.id, status: 'queued' })

    expect(isCredentialPinned(ctx.db, key.id)).toBe(true)
    expect(captureError(() => removeCredential(ctx.db, userId, providerId, key.id)).code).toBe('CONFLICT')
  })

  it('chỉ ghim theo credential_id: tác vụ chưa ghim key không ảnh hưởng', async () => {
    const { userId, providerId } = await newProvider()
    const key = await addKey(userId, providerId, 'sk-null-0001')
    insertGeneration({ userId, providerId, credentialId: null, status: 'running' })

    expect(isCredentialPinned(ctx.db, key.id)).toBe(false)
    removeCredential(ctx.db, userId, providerId, key.id)
    expect(listCredentials(ctx.db, userId, providerId)).toHaveLength(0)
  })
})
