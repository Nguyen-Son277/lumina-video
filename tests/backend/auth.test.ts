import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, startTestServer, type TestContext } from './helpers'

let ctx: TestContext

beforeAll(async () => {
  ctx = await startTestServer()
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
    const { email } = await registerUser(ctx)
    const me = await call(ctx, '/api/auth/me')
    expect(me.status).toBe(200)
    expect(me.body.user.email).toBe(email)
  })

  it('từ chối mật khẩu ngắn', async () => {
    const result = await call(ctx, '/api/auth/register', {
      method: 'POST',
      body: { email: `short-${Date.now()}@gigone.com`, password: 'ngan' },
    })
    expect(result.status).toBe(400)
  })

  it('từ chối email trùng', async () => {
    const email = `dup-${Date.now()}@gigone.com`
    await registerUser(ctx, email)
    const result = await call(ctx, '/api/auth/register', {
      method: 'POST',
      body: { email, password: 'matkhau-rat-dai-123' },
    })
    expect(result.status).toBe(409)
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

  it('đổi mật khẩu yêu cầu đúng mật khẩu hiện tại', async () => {
    const { email } = await registerUser(ctx)

    const wrong = await call(ctx, '/api/auth/change-password', {
      method: 'POST',
      body: { currentPassword: 'sai-hoan-toan', newPassword: 'mat-khau-moi-dai-123' },
    })
    expect(wrong.status).toBe(401)

    const ok = await call(ctx, '/api/auth/change-password', {
      method: 'POST',
      body: { currentPassword: 'matkhau-rat-dai-123', newPassword: 'mat-khau-moi-dai-123' },
    })
    expect(ok.status).toBe(200)

    // Mật khẩu cũ không còn dùng được.
    await call(ctx, '/api/auth/logout', { method: 'POST' })
    const oldLogin = await call(ctx, '/api/auth/login', {
      method: 'POST',
      body: { email, password: 'matkhau-rat-dai-123' },
    })
    expect(oldLogin.status).toBe(401)

    const newLogin = await call(ctx, '/api/auth/login', {
      method: 'POST',
      body: { email, password: 'mat-khau-moi-dai-123' },
    })
    expect(newLogin.status).toBe(200)
  })
})
