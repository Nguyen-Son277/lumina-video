import { expect, request, test, type Page } from '@playwright/test'
import { BASE, ensureAdminSession, signUpFresh, type TestAccount } from './helpers/auth'
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './helpers/e2eAccounts'
import { accountSettingsCatalog as C } from '../src/i18n/catalogs/accountSettings'
import { shellCatalog as S } from '../src/i18n/catalogs/shell'
import { formatErrorMessage } from '../shared/errorCatalog'

const SETTINGS_URL = `${BASE}/?page=account-settings`
const CHANGE_PASSWORD = '**/api/auth/change-password'
const NEW_PASSWORD = 'new-account-password-e2e-456'

type Role = 'user' | 'admin'

async function signInAs(page: Page, role: Role): Promise<TestAccount> {
  if (role === 'user') return signUpFresh(page)
  await ensureAdminSession(page)
  return { email: E2E_ADMIN_EMAIL, password: E2E_ADMIN_PASSWORD }
}

async function fillPasswords(page: Page, current: string, next = NEW_PASSWORD, confirm = next) {
  await page.getByLabel(C.currentPassword.vi, { exact: true }).fill(current)
  await page.getByLabel(C.newPassword.vi, { exact: true }).fill(next)
  await page.getByLabel(C.confirmPassword.vi, { exact: true }).fill(confirm)
}

async function expectSignedIn(page: Page, account: TestAccount, role: Role) {
  const response = await page.request.get(`${BASE}/api/auth/me`)
  expect(response.ok()).toBeTruthy()
  expect((await response.json()).user).toMatchObject({ email: account.email, role })
  await expect(page.locator('.auth-form')).toHaveCount(0)
  await expect(page.getByLabel(C.email.vi, { exact: true })).toHaveValue(account.email)
}

async function expectFieldsCleared(page: Page) {
  for (const label of [C.currentPassword.vi, C.newPassword.vi, C.confirmPassword.vi]) {
    await expect(page.getByLabel(label, { exact: true })).toHaveValue('')
  }
}

for (const role of ['user', 'admin'] as const) {
  test.describe(`Account settings: ${role}`, () => {
    test('sidebar navigation survives refresh, translates en/vi and fits small viewports', async ({ page }) => {
      const account = await signInAs(page, role)
      await page.goto(BASE)
      const settingsNav = page.locator('.sidebar').getByRole('button', { name: S.navAccountSettings.vi, exact: true })
      await settingsNav.click()
      await expect(page).toHaveURL(SETTINGS_URL)
      await expect(settingsNav).toHaveClass(/active/)
      await expect(page.getByRole('heading', { name: C.title.vi, exact: true })).toBeVisible()
      await expect(page.getByLabel(C.email.vi, { exact: true })).toHaveAttribute('readonly', '')

      await page.reload()
      await expect(page).toHaveURL(SETTINGS_URL)
      await expect(settingsNav).toHaveClass(/active/)
      await expectSignedIn(page, account, role)

      const language = page.locator('.topbar select:has(option[value="en"]):has(option[value="vi"])')
      for (const locale of ['en', 'vi'] as const) {
        await language.selectOption(locale)
        await expect(page.getByRole('heading', { name: C.title[locale], exact: true })).toBeVisible()
        await expect(page.locator('.sidebar').getByRole('button', { name: S.navAccountSettings[locale], exact: true })).toHaveClass(/active/)
        await expect(page.getByLabel(C.email[locale], { exact: true })).toHaveValue(account.email)
        for (const label of [C.currentPassword, C.newPassword, C.confirmPassword]) {
          await expect(page.getByLabel(label[locale], { exact: true })).toBeVisible()
        }
        await expect(page.getByRole('button', { name: C.submit[locale], exact: true })).toBeVisible()
        for (const width of [320, 390]) {
          await page.setViewportSize({ width, height: 640 })
          await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
          const form = page.locator('.account-settings-form')
          await expect.poll(() => form.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
        }
      }
      await page.reload()
      await expect(page.getByRole('heading', { name: C.title.vi, exact: true })).toBeVisible()
      await expectSignedIn(page, account, role)
    })

    test('mismatch prevents the API call; wrong current password shows an error without signing out', async ({ page }) => {
      const account = await signInAs(page, role)
      await page.goto(SETTINGS_URL)
      const submissions: unknown[] = []
      page.on('request', req => {
        if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/auth/change-password') {
          submissions.push(req.postDataJSON())
        }
      })

      await fillPasswords(page, account.password, NEW_PASSWORD, 'different-confirmation-789')
      await page.getByRole('button', { name: C.submit.vi, exact: true }).click()
      await expect(page.getByRole('alert')).toHaveText(C.passwordMismatch.vi)
      await expect(page.getByLabel(C.confirmPassword.vi, { exact: true })).toHaveAttribute('aria-invalid', 'true')
      await expect(page.getByLabel(C.confirmPassword.vi, { exact: true })).toBeFocused()
      expect(submissions).toEqual([])

      await fillPasswords(page, 'definitely-wrong-current-password')
      const failedChange = page.waitForResponse(res => new URL(res.url()).pathname === '/api/auth/change-password' && res.request().method() === 'POST')
      await page.getByRole('button', { name: C.submit.vi, exact: true }).click()
      expect((await failedChange).status()).toBe(401)
      await expect(page.getByRole('alert')).toHaveText(formatErrorMessage('auth.current_password_incorrect', undefined, 'vi'))
      expect(submissions).toEqual([{ currentPassword: 'definitely-wrong-current-password', newPassword: NEW_PASSWORD }])
      await expect(page.getByLabel(C.currentPassword.vi, { exact: true })).toHaveValue('definitely-wrong-current-password')
      await expect(page.getByLabel(C.newPassword.vi, { exact: true })).toHaveValue(NEW_PASSWORD)
      await expectSignedIn(page, account, role)
      await page.reload()
      await expect(page.getByRole('heading', { name: C.title.vi, exact: true })).toBeVisible()
      await expectSignedIn(page, account, role)
    })
  })
}

test('user changes the real password, clears fields, keeps this session and rejects the old password', async ({ page }) => {
  const account = await signUpFresh(page)
  // A separate API cookie jar proves other sessions are revoked without replacing
  // the browser session under test when we verify old/new credentials.
  const otherSession = await request.newContext()
  const credentialCheck = await request.newContext()
  try {
    const login = await otherSession.post(`${BASE}/api/auth/login`, { data: account })
    expect(login.ok()).toBeTruthy()
    await page.goto(SETTINGS_URL)
    await fillPasswords(page, account.password)
    const changed = page.waitForResponse(res => new URL(res.url()).pathname === '/api/auth/change-password' && res.request().method() === 'POST')
    await page.getByRole('button', { name: C.submit.vi, exact: true }).click()
    expect((await changed).status()).toBe(200)
    await expect(page.getByRole('status').filter({ hasText: C.success.vi })).toBeVisible()
    await expectFieldsCleared(page)
    await expectSignedIn(page, account, 'user')
    await page.reload()
    await expect(page.getByRole('heading', { name: C.title.vi, exact: true })).toBeVisible()
    await expectSignedIn(page, account, 'user')

    const revoked = await otherSession.get(`${BASE}/api/auth/me`)
    expect((await revoked.json()).user).toBeNull()
    const oldLogin = await credentialCheck.post(`${BASE}/api/auth/login`, {
      data: { email: account.email, password: account.password },
    })
    expect(oldLogin.status()).toBe(401)
    const newLogin = await credentialCheck.post(`${BASE}/api/auth/login`, {
      data: { email: account.email, password: NEW_PASSWORD },
    })
    expect(newLogin.ok()).toBeTruthy()
    expect((await newLogin.json()).user).toMatchObject({ email: account.email, role: 'user' })
    await expectSignedIn(page, account, 'user')
  } finally {
    await otherSession.dispose()
    await credentialCheck.dispose()
  }
})

test('admin success clears fields and preserves the session without changing shared credentials', async ({ page }) => {
  const account = await signInAs(page, 'admin')
  // Never forward this request: every worker shares the allowlisted admin.
  // Only the UI success path is mocked; sign-in, /me and refresh remain real.
  const payloads: unknown[] = []
  await page.route(CHANGE_PASSWORD, async route => {
    payloads.push(route.request().postDataJSON())
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
  })
  await page.goto(SETTINGS_URL)
  await fillPasswords(page, account.password)
  await page.getByRole('button', { name: C.submit.vi, exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: C.success.vi })).toBeVisible()
  expect(payloads).toEqual([{ currentPassword: E2E_ADMIN_PASSWORD, newPassword: NEW_PASSWORD }])
  await expectFieldsCleared(page)
  await expectSignedIn(page, account, 'admin')
  await page.reload()
  await expect(page.getByRole('heading', { name: C.title.vi, exact: true })).toBeVisible()
  await expectSignedIn(page, account, 'admin')

  const credentialCheck = await request.newContext()
  try {
    const originalLogin = await credentialCheck.post(`${BASE}/api/auth/login`, {
      data: { email: E2E_ADMIN_EMAIL, password: E2E_ADMIN_PASSWORD },
    })
    expect(originalLogin.ok()).toBeTruthy()
    const mockedPasswordLogin = await credentialCheck.post(`${BASE}/api/auth/login`, {
      data: { email: E2E_ADMIN_EMAIL, password: NEW_PASSWORD },
    })
    expect(mockedPasswordLogin.status()).toBe(401)
  } finally {
    await credentialCheck.dispose()
  }
})
