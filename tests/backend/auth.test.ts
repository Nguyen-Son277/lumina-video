import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { call, ensureSuperAdmin, registerUser, startTestServer, type TestContext } from './helpers'

let ctx: TestContext

beforeAll(async () => {
  ctx = await startTestServer({ superAdminEmails: 'admin@gigone.com' })
})

afterAll(async () => {
  if (ctx) await ctx.close()
})

describe('Xác thực và phiên đăng nhập', () => {
  it('chặn truy cập khi chưa đăng nhập', async () => {
    const result = await call(ctx, '/api/providers', { cookie: '' })
    expect(result.status).toBe(401)
    expect(result.body.error.code).toBe('UNAUTHORIZED')
  })

  it('đăng ký rồi trả về người dùng hiện tại', async () => {
    const { email } = await registerUser(ctx, undefined, undefined, 'Test Person')
    const me = await call(ctx, '/api/auth/me')
    expect(me.status).toBe(200)
    expect(me.body.user.email).toBe(email)
    expect(me.body.user.name).toBe('Test Person')
    const login = await call(ctx, '/api/auth/login', {
      method: 'POST', body: { email, password: 'matkhau-rat-dai-123' },
    })
    expect(login.body.user.name).toBe('Test Person')
    await ensureSuperAdmin(ctx)
    const adminUsers = await call(ctx, '/api/admin/users')
    expect(adminUsers.body.users.find((user: { email: string }) => user.email === email).name).toBe('Test Person')
  })

  it('validates registration names and preserves trimmed Vietnamese names', async () => {
    for (const name of [undefined, '', '   ', 'x'.repeat(101), 'Bad\u0000Name', 'Bad\nName']) {
      const response = await call(ctx, '/api/auth/register', {
        method: 'POST', body: { email: 'invalid-name@gigone.com', password: 'matkhau-rat-dai-123', name },
      })
      expect(response.status).toBe(400)
    }
    const response = await call(ctx, '/api/auth/register', {
      method: 'POST', body: { email: 'vietnamese-name@gigone.com', password: 'matkhau-rat-dai-123', name: '  Nguyễn Diễn  ' },
    })
    expect(response.status).toBe(201)
    expect(response.body.user.name).toBe('Nguyễn Diễn')
    expect(response.body.approvalRequired).toBe(true)
  })

  it('từ chối mật khẩu ngắn', async () => {
    const result = await call(ctx, '/api/auth/register', {
      method: 'POST',
      body: { email: `short-${Date.now()}@gigone.com`, password: 'ngan', name: 'Short User' },
    })
    expect(result.status).toBe(400)
  })

  it('từ chối email trùng', async () => {
    const email = `dup-${Date.now()}@gigone.com`
    await registerUser(ctx, email)
    const result = await call(ctx, '/api/auth/register', {
      method: 'POST',
      body: { email, password: 'matkhau-rat-dai-123', name: 'Duplicate User' },
    })
    expect(result.status).toBe(409)
  })

  it('rejects ordinary external emails without creating an account or session', async () => {
    const email = 'ordinary-external@example.com'
    const result = await call(ctx, '/api/auth/register', {
      method: 'POST', cookie: '',
      body: { email, password: 'matkhau-rat-dai-123', name: 'External User' },
    })
    expect(result.status).toBe(400)
    expect(result.headers.getSetCookie()).toHaveLength(0)
    expect(ctx.db.prepare('SELECT id FROM users WHERE email = ?').get(email)).toBeUndefined()
  })

  it('concurrent duplicate registration returns 409 without overwriting the winner', async () => {
    const email = `concurrent-${Date.now()}@gigone.com`
    const passwords = ['first-registration-123', 'second-registration-123']
    const results = await Promise.all(passwords.map((password, index) => call(ctx, '/api/auth/register', {
      method: 'POST', cookie: '', body: { email, password, name: `Registrant ${index}` },
    })))
    expect(results.map(result => result.status).sort()).toEqual([201, 409])
    const winner = results.findIndex(result => result.status === 201)
    expect(ctx.db.prepare('SELECT name FROM users WHERE email = ?').get(email)).toEqual({ name: `Registrant ${winner}` })
    ctx.db.prepare("UPDATE users SET status = 'approved' WHERE email = ?").run(email)
    for (const [index, password] of passwords.entries()) {
      const login = await call(ctx, '/api/auth/login', { method: 'POST', cookie: '', body: { email, password } })
      expect(login.status).toBe(index === winner ? 200 : 401)
    }
  })

  it('đăng nhập sai mật khẩu trả 401 với thông báo chung', async () => {
    const email = `wrong-${Date.now()}@gigone.com`
    await registerUser(ctx, email)
    const result = await call(ctx, '/api/auth/login', {
      method: 'POST',
      body: { email, password: 'mat-khau-sai-hoan-toan' },
    })
    expect(result.status).toBe(401)
    expect(result.body.error.message).toBe('Email hoặc mật khẩu không đúng')
  })

  it('không tiết lộ email có tồn tại hay không', async () => {
    const result = await call(ctx, '/api/auth/login', {
      method: 'POST',
      body: { email: 'khong-ton-tai@gigone.com', password: 'bat-ky-mat-khau-nao' },
    })
    expect(result.status).toBe(401)
    expect(result.body.error.message).toBe('Email hoặc mật khẩu không đúng')
  })

  it('đăng xuất thu hồi phiên', async () => {
    await registerUser(ctx)
    const before = await call(ctx, '/api/auth/me')
    expect(before.body.user).not.toBeNull()

    await call(ctx, '/api/auth/logout', { method: 'POST' })
    const after = await call(ctx, '/api/auth/me')
    expect(after.body.user).toBeNull()
  })

  it('requires authentication to change a password', async () => {
    const result = await call(ctx, '/api/auth/change-password', {
      method: 'POST', cookie: '',
      body: { currentPassword: 'matkhau-rat-dai-123', newPassword: 'mat-khau-moi-dai-123' },
    })
    expect(result.status).toBe(401)
    expect(result.headers.getSetCookie()).toHaveLength(0)
  })

  it.each(['user', 'admin'] as const)('changes %s passwords and rotates all sessions atomically', async (role) => {
    const password = role === 'admin' ? 'matkhau-admin-rat-dai-123' : 'matkhau-rat-dai-123'
    const { email, userId } = role === 'admin'
      ? await ensureSuperAdmin(ctx)
      : await registerUser(ctx)
    const firstCookie = ctx.cookie
    expect((await call(ctx, '/api/auth/login', { method: 'POST', body: { email, password } })).status).toBe(200)
    const secondCookie = ctx.cookie
    expect(secondCookie).not.toBe(firstCookie)
    const credentials = () => ctx.db.prepare('SELECT password_hash, password_salt FROM users WHERE id = ?').get(userId)
    const sessions = () => ctx.db.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY id').all(userId)
    const originalCredentials = credentials()
    const originalSessions = sessions()

    for (const body of [
      { currentPassword: 'sai-hoan-toan', newPassword: 'mat-khau-moi-dai-123' },
      { currentPassword: password, newPassword: 'short' },
    ]) {
      const invalid = await call(ctx, '/api/auth/change-password', { method: 'POST', body })
      expect(invalid.status).toBe(body.newPassword === 'short' ? 400 : 401)
      expect(invalid.headers.getSetCookie()).toHaveLength(0)
      expect(credentials()).toEqual(originalCredentials)
      expect(sessions()).toEqual(originalSessions)
    }

    // A session-insert failure must roll back BOTH the credential update and revocation.
    const prepare = ctx.db.prepare.bind(ctx.db)
    const failure = vi.spyOn(ctx.db, 'prepare').mockImplementation((sql) => {
      if (sql.startsWith('INSERT INTO sessions')) throw new Error('Injected session failure')
      return prepare(sql)
    })
    try {
      const failed = await call(ctx, '/api/auth/change-password', {
        method: 'POST', body: { currentPassword: password, newPassword: 'mat-khau-moi-dai-123' },
      })
      expect(failed.status).toBe(500)
      expect(failed.headers.getSetCookie()).toHaveLength(0)
    } finally {
      failure.mockRestore()
    }
    expect(credentials()).toEqual(originalCredentials)
    expect(sessions()).toEqual(originalSessions)
    expect(ctx.db.isTransaction).toBe(false)

    const ok = await call(ctx, '/api/auth/change-password', {
      method: 'POST', body: { currentPassword: password, newPassword: 'mat-khau-moi-dai-123' },
    })
    expect(ok.status).toBe(200)
    expect(ok.body.ok).toBe(true)
    expect(ok.headers.getSetCookie()).toHaveLength(1)
    const newCookie = ctx.cookie
    expect(newCookie).not.toBe(firstCookie)
    expect(newCookie).not.toBe(secondCookie)
    expect(sessions()).toHaveLength(1)
    for (const cookie of [firstCookie, secondCookie]) {
      expect((await call(ctx, '/api/auth/me', { cookie })).body.user).toBeNull()
      expect((await call(ctx, '/api/providers', { cookie })).status).toBe(401)
    }
    const me = await call(ctx, '/api/auth/me', { cookie: newCookie })
    expect(me.body.user).toMatchObject({ id: userId, email, role })
    expect((await call(ctx, '/api/providers', { cookie: newCookie })).status).toBe(200)

    const oldLogin = await call(ctx, '/api/auth/login', {
      method: 'POST', cookie: '', body: { email, password },
    })
    expect(oldLogin.status).toBe(401)
    const newLogin = await call(ctx, '/api/auth/login', {
      method: 'POST', cookie: '', body: { email, password: 'mat-khau-moi-dai-123' },
    })
    expect(newLogin.status).toBe(200)
    expect(newLogin.body.user.role).toBe(role)
  })
})
