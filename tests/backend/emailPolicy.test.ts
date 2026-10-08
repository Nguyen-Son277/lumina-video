import { afterAll, beforeAll, expect, test } from 'vitest'
import { call, startTestServer, type TestContext } from './helpers'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { if (ctx) await ctx.close() })

test.each(['person@gmail.com', 'person@sub.gigone.com', 'person@gigone.com.evil.com', 'person@notgigone.com'])('rejects registration outside exact domain: %s', async (email) => {
  const result = await call(ctx, '/api/auth/register', { method: 'POST', body: { email, password: 'long-test-password-123' } })
  expect(result.status).toBe(400)
  expect(result.body.error.message).toContain('@gigone.com')
  expect(ctx.db.prepare('SELECT id FROM users WHERE email = ?').get(email)).toBeUndefined()
})

test('normalizes domain and allows registration and login for gigone.com', async () => {
  const email = ' Domain-Policy@GIGONE.COM '
  const password = 'long-test-password-123'
  const created = await call(ctx, '/api/auth/register', { method: 'POST', body: { email, password } })
  expect(created.status).toBe(201)
  expect(created.body.user.email).toBe('domain-policy@gigone.com')
  await call(ctx, '/api/auth/logout', { method: 'POST' })
  const login = await call(ctx, '/api/auth/login', { method: 'POST', body: { email, password } })
  expect(login.status).toBe(200)
})
