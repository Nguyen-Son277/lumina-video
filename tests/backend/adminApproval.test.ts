import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDatabase } from '../../server/db/index'
import { parseAdminEmails, syncAdminAllowlist } from '../../server/auth/accounts'
import {
  call,
  registerPendingUser,
  ensureSuperAdmin,
  registerUser,
  signIn,
  startTestServer,
  type TestContext,
} from './helpers'

/**
 * Duyệt tài khoản: đăng ký mới chờ super admin duyệt mới đăng nhập được.
 * Tài khoản tạo trước tính năng này mặc định đã duyệt (DEFAULT của migration 020).
 */

const ADMIN = 'admin@gigone.com'
const ADMIN_PASSWORD = 'matkhau-admin-rat-dai-123'
const SECOND_ADMIN = 'admin2@gigone.com'

let ctx: TestContext
beforeAll(async () => {
  ctx = await startTestServer({ superAdminEmails: `${ADMIN}, ${SECOND_ADMIN}` })
})
afterAll(async () => {
  if (ctx) await ctx.close()
})

type AdminUser = {
  id: string
  email: string
  status: string
  role: string
  createdAt: number
  approvedAt: number | null
}
type UsersPayload = { users: AdminUser[]; counts: { pending: number; approved: number; rejected: number; total: number } }

describe('Duyệt tài khoản — hàng rào đăng nhập', () => {
  it('đăng ký mới ở trạng thái chờ duyệt, không có phiên và không gọi được API', async () => {
    const pending = await registerPendingUser(ctx)

    const me = await call(ctx, '/api/auth/me')
    expect(me.body.user).toBeNull()

    const providers = await call(ctx, '/api/providers')
    expect(providers.status).toBe(401)

    const row = ctx.db
      .prepare('SELECT status, role FROM users WHERE id = ?')
      .get(pending.userId) as { status: string; role: string }
    expect(row).toEqual({ status: 'pending', role: 'user' })
  })

  it('trả về cờ approvalRequired khi đăng ký và không đặt cookie', async () => {
    const email = `no-cookie-${Date.now()}@gigone.com`
    const result = await call(ctx, '/api/auth/register', {
      method: 'POST',
      body: { email, password: 'matkhau-rat-dai-123' },
    })
    expect(result.status).toBe(201)
    expect(result.body.approvalRequired).toBe(true)
    expect(result.body.user.status).toBe('pending')
    expect(result.headers.getSetCookie()).toHaveLength(0)
  })

  it('đăng nhập khi chờ duyệt trả 403 với khoá auth.pending_approval', async () => {
    const pending = await registerPendingUser(ctx)
    const result = await call(ctx, '/api/auth/login', {
      method: 'POST',
      body: { email: pending.email, password: pending.password },
    })
    expect(result.status).toBe(403)
    expect(result.body.error.code).toBe('AUTH_PENDING')
    expect(result.body.error.messageKey).toBe('auth.pending_approval')
    expect(result.headers.getSetCookie()).toHaveLength(0)
  })

  it('đăng nhập khi bị từ chối trả 403 với khoá auth.account_rejected', async () => {
    const pending = await registerPendingUser(ctx)
    await ensureSuperAdmin(ctx, ADMIN, ADMIN_PASSWORD)
    const rejected = await call(ctx, `/api/admin/users/${pending.userId}/reject`, { method: 'POST' })
    expect(rejected.status).toBe(200)
    expect(rejected.body.user.status).toBe('rejected')

    const result = await call(ctx, '/api/auth/login', {
      method: 'POST',
      body: { email: pending.email, password: pending.password },
    })
    expect(result.status).toBe(403)
    expect(result.body.error.code).toBe('AUTH_REJECTED')
    expect(result.body.error.messageKey).toBe('auth.account_rejected')
  })

  it('sai mật khẩu vẫn trả 401 chung, không lộ tài khoản đang chờ duyệt', async () => {
    const pending = await registerPendingUser(ctx)
    const result = await call(ctx, '/api/auth/login', {
      method: 'POST',
      body: { email: pending.email, password: 'sai-mat-khau-hoan-toan' },
    })
    expect(result.status).toBe(401)
    expect(result.body.error.message).toBe('Email hoặc mật khẩu không đúng')
  })
})

describe('Duyệt tài khoản — quyền quản trị', () => {
  it('email trong SUPER_ADMIN_EMAILS được duyệt và có vai trò admin ngay khi đăng ký', async () => {
    const email = `boot-admin-${Date.now()}@gigone.com`
    const other = await startTestServer({ superAdminEmails: email })
    try {
      const created = await call(other, '/api/auth/register', {
        method: 'POST',
        body: { email, password: 'matkhau-admin-rat-dai-123' },
      })
      expect(created.status).toBe(201)
      expect(created.body.user.role).toBe('admin')
      expect(created.body.user.status).toBe('approved')
      const me = await call(other, '/api/auth/me')
      expect(me.body.user.role).toBe('admin')
    } finally {
      await other.close()
    }
  })

  it('admin duyệt tài khoản rồi tài khoản đó đăng nhập được', async () => {
    const pending = await registerPendingUser(ctx)
    await ensureSuperAdmin(ctx, ADMIN, ADMIN_PASSWORD)

    const approved = await call(ctx, `/api/admin/users/${pending.userId}/approve`, { method: 'POST' })
    expect(approved.status).toBe(200)
    expect(approved.body.user.status).toBe('approved')
    expect(approved.body.user.approvedAt).toBeGreaterThan(0)

    const session = await signIn(ctx, pending.email, pending.password)
    expect(session.role).toBe('user')
    const me = await call(ctx, '/api/auth/me')
    expect(me.body.user.email).toBe(pending.email)
  })

  it('thu hồi duyệt làm phiên đang sống mất hiệu lực ngay', async () => {
    const pending = await registerPendingUser(ctx)
    await ensureSuperAdmin(ctx, ADMIN, ADMIN_PASSWORD)
    await call(ctx, `/api/admin/users/${pending.userId}/approve`, { method: 'POST' })
    await signIn(ctx, pending.email, pending.password)
    const liveCookie = ctx.cookie
    expect((await call(ctx, '/api/providers', { cookie: liveCookie })).status).toBe(200)

    await signIn(ctx, ADMIN, ADMIN_PASSWORD)
    const revoked = await call(ctx, `/api/admin/users/${pending.userId}/revoke`, { method: 'POST' })
    expect(revoked.status).toBe(200)
    expect(revoked.body.user.status).toBe('pending')

    expect((await call(ctx, '/api/providers', { cookie: liveCookie })).status).toBe(401)
    // Trạng thái mới cũng chặn đăng nhập lại.
    const denied = await call(ctx, '/api/auth/login', {
      method: 'POST',
      body: { email: pending.email, password: pending.password },
    })
    expect(denied.status).toBe(403)
  })

  it('người dùng thường không gọi được API quản trị', async () => {
    await registerUser(ctx)
    const forbidden = await call(ctx, '/api/admin/users')
    expect(forbidden.status).toBe(403)
    expect(forbidden.body.error.messageKey).toBe('errors.admin_required')

    const anonymous = await call(ctx, '/api/admin/users', { cookie: '' })
    expect(anonymous.status).toBe(401)
  })

  it('không tự đổi trạng thái chính mình và không sửa được tài khoản admin khác', async () => {
    const first = await ensureSuperAdmin(ctx, ADMIN, ADMIN_PASSWORD)
    const self = await call(ctx, `/api/admin/users/${first.userId}/reject`, { method: 'POST' })
    expect(self.status).toBe(403)
    expect(self.body.error.messageKey).toBe('admin.self_review_forbidden')

    const second = await ensureSuperAdmin(ctx, SECOND_ADMIN, ADMIN_PASSWORD)
    await signIn(ctx, ADMIN, ADMIN_PASSWORD)
    const other = await call(ctx, `/api/admin/users/${second.userId}/reject`, { method: 'POST' })
    expect(other.status).toBe(403)
    expect(other.body.error.messageKey).toBe('admin.protected_account')
  })

  it('trả 404 cho tài khoản không tồn tại và 400 cho trạng thái không hợp lệ', async () => {
    await ensureSuperAdmin(ctx, ADMIN, ADMIN_PASSWORD)
    const missing = await call(ctx, '/api/admin/users/khong-ton-tai/approve', { method: 'POST' })
    expect(missing.status).toBe(404)
    expect(missing.body.error.messageKey).toBe('admin.user_not_found')

    const bad = await call(ctx, '/api/admin/users?status=bi-mat')
    expect(bad.status).toBe(400)
  })
})

describe('Duyệt tài khoản — danh sách quản trị', () => {
  it('lọc theo trạng thái, tìm theo email và không lộ hash mật khẩu', async () => {
    await ensureSuperAdmin(ctx, ADMIN, ADMIN_PASSWORD)
    // Đăng ký tài khoản chờ duyệt sẽ xóa phiên trong context, nên giữ cookie admin.
    const adminCookie = ctx.cookie
    const marker = `loc-${Date.now()}`
    const pending = await registerPendingUser(ctx, `${marker}@gigone.com`)

    const all = await call(ctx, '/api/admin/users?limit=100', { cookie: adminCookie })
    expect(all.status).toBe(200)
    const payload = all.body as UsersPayload
    // Không có trường nhạy cảm nào trong payload.
    for (const user of payload.users) {
      expect(Object.keys(user).sort()).toEqual(['approvedAt', 'createdAt', 'email', 'id', 'role', 'status'])
    }
    expect(JSON.stringify(payload)).not.toContain('password')

    const pendingOnly = (
      await call(ctx, '/api/admin/users?status=pending&limit=100', { cookie: adminCookie })
    ).body as UsersPayload
    expect(pendingOnly.users.every((user) => user.status === 'pending')).toBe(true)
    expect(pendingOnly.counts.pending).toBeGreaterThan(0)

    const searched = (
      await call(ctx, `/api/admin/users?q=${marker}&limit=100`, { cookie: adminCookie })
    ).body as UsersPayload
    expect(searched.users.map((user) => user.id)).toEqual([pending.userId])

    // Ký tự đại diện của LIKE không được hiểu là mẫu tìm kiếm.
    const wildcard = (
      await call(ctx, '/api/admin/users?q=%25&limit=100', { cookie: adminCookie })
    ).body as UsersPayload
    expect(wildcard.users).toHaveLength(0)
  })

  it('số đếm khớp với trạng thái sau mỗi quyết định', async () => {
    await ensureSuperAdmin(ctx, ADMIN, ADMIN_PASSWORD)
    const adminCookie = ctx.cookie
    const before = (
      await call(ctx, '/api/admin/users?limit=1', { cookie: adminCookie })
    ).body as UsersPayload
    const pending = await registerPendingUser(ctx)
    const afterRegister = (
      await call(ctx, '/api/admin/users?limit=1', { cookie: adminCookie })
    ).body as UsersPayload
    expect(afterRegister.counts.pending).toBe(before.counts.pending + 1)

    const approved = await call(ctx, `/api/admin/users/${pending.userId}/approve`, {
      method: 'POST',
      cookie: adminCookie,
    })
    expect(approved.body.counts.pending).toBe(afterRegister.counts.pending - 1)
    expect(approved.body.counts.approved).toBe(afterRegister.counts.approved + 1)
    expect(approved.body.counts.total).toBe(afterRegister.counts.total)
  })
})

describe('Migration 020 — tài khoản cũ mặc định đã duyệt', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  it('hàng users cũ nhận status approved, role user; hàng mới tôn trọng pending', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lumina-approval-migration-'))
    dirs.push(dir)
    const path = join(dir, 'legacy.db')

    const raw = new DatabaseSync(path)
    raw.exec(`
      CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `)
    const migrationsDir = join(process.cwd(), 'server', 'db', 'migrations')
    const applied = readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort()
      .filter((file) => file < '020_')
    // 021 thêm cột vào `models`; fixture này chỉ dựng bảng `users`.
    applied.push('021_usage_log.sql')
    const insert = raw.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
    for (const name of applied) insert.run(name, Date.now())
    raw
      .prepare('INSERT INTO users (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('legacy-1', 'legacy@gigone.com', 'hash', 'salt', 1)
    raw.close()

    const db = openDatabase(path)
    try {
      const legacy = db
        .prepare('SELECT status, role, approved_at FROM users WHERE id = ?')
        .get('legacy-1') as { status: string; role: string; approved_at: number | null }
      expect(legacy.status).toBe('approved')
      expect(legacy.role).toBe('user')
      expect(legacy.approved_at).toBeNull()

      // Đăng ký mới ghi tường minh pending nên không bị DEFAULT kéo sang approved.
      db.prepare(
        'INSERT INTO users (id, email, password_hash, password_salt, created_at, status, role) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('new-1', 'new@gigone.com', 'hash', 'salt', 2, 'pending', 'user')
      const fresh = db.prepare('SELECT status FROM users WHERE id = ?').get('new-1') as { status: string }
      expect(fresh.status).toBe('pending')
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  it('đồng bộ danh sách admin là promote-only và idempotent', async () => {
    const email = `promote-${Date.now()}@gigone.com`
    ctx.db
      .prepare(
        'INSERT INTO users (id, email, password_hash, password_salt, created_at, status, role) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(`promote-${Date.now()}`, email, 'hash', 'salt', Date.now(), 'pending', 'user')

    expect(syncAdminAllowlist(ctx.db, [email])).toBe(1)
    const promoted = ctx.db.prepare('SELECT status, role FROM users WHERE email = ?').get(email) as {
      status: string
      role: string
    }
    expect(promoted).toEqual({ status: 'approved', role: 'admin' })

    // Lần chạy lại không đổi gì; bỏ email khỏi danh sách cũng không giáng quyền.
    expect(syncAdminAllowlist(ctx.db, [email])).toBe(0)
    expect(syncAdminAllowlist(ctx.db, [])).toBe(0)
    const after = ctx.db.prepare('SELECT role FROM users WHERE email = ?').get(email) as { role: string }
    expect(after.role).toBe('admin')
  })

  it('parseAdminEmails chuẩn hóa và bỏ trùng', () => {
    expect(parseAdminEmails(' A@gigone.com , b@GIGONE.com ,, a@gigone.com ')).toEqual([
      'a@gigone.com',
      'b@gigone.com',
    ])
    expect(parseAdminEmails(undefined)).toEqual([])
  })
})
