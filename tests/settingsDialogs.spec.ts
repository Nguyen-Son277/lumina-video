import { expect, test, type Locator, type Page } from '@playwright/test'
import { BASE, seedProvider, signUpFresh } from './helpers/auth'
import { shellCatalog as S } from '../src/i18n/catalogs/shell'

async function openSettings(page: Page) {
  await signUpFresh(page)
  await page.goto(`${BASE}/?page=settings`)
  await expect(page.locator('.settings-page')).toBeVisible()
}

/** Empty forms leave Save disabled, so Cancel is the last tabbable control. */
async function expectFocusTrapAndEscape(page: Page, dialog: Locator, opener: Locator) {
  const close = dialog.getByRole('button', { name: S.close.vi, exact: true })
  const cancel = dialog.getByRole('button', { name: S.cancel.vi, exact: true })
  await expect(dialog).toHaveAttribute('aria-modal', 'true')
  await expect(close).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(cancel).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(close).toBeFocused()
  // Programmatic outside focus must also be redirected into the modal.
  await opener.evaluate(element => (element as HTMLButtonElement).focus())
  await expect(close).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(opener).toBeFocused()
}

test('provider dialog traps/restores focus and locks every close path during a single same-tick save', async ({ page }) => {
  await openSettings(page)
  const opener = page.locator('.settings-page .heading-actions').getByRole('button', { name: S.addProvider.vi, exact: true })
  await opener.click()
  const dialog = page.getByRole('dialog', { name: S.addProvider.vi, exact: true })
  await expectFocusTrapAndEscape(page, dialog, opener)
  await opener.click()
  await dialog.getByLabel(S.displayNameLabel.vi, { exact: true }).fill('Dialog guarded provider')
  await dialog.getByLabel(S.baseUrlLabel.vi, { exact: true }).fill('https://e2e.mock.test/v1')
  await dialog.getByLabel(S.apiKeyLabel.vi, { exact: true }).fill('  sk-dialog-guard-test  ')

  let requests = 0
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/providers', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    requests += 1
    expect(route.request().postDataJSON()).toMatchObject({ name: 'Dialog guarded provider', apiKey: 'sk-dialog-guard-test' })
    await gate
    await route.continue()
  })
  try {
    // Both events run before React can commit busy=true; only the ref guard can stop the second.
    await dialog.locator('form').evaluate(form => {
      ;(form as HTMLFormElement).requestSubmit()
      ;(form as HTMLFormElement).requestSubmit()
    })
    await expect.poll(() => requests).toBe(1)
    await expect(dialog.getByRole('button', { name: S.saveProvider.vi, exact: true })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: S.close.vi, exact: true })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: S.cancel.vi, exact: true })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    await page.locator('.modal-backdrop').click({ position: { x: 2, y: 2 } })
    await expect(dialog).toBeVisible()
    expect(requests).toBe(1)
  } finally {
    release()
  }
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('.provider-item').filter({ hasText: 'Dialog guarded provider' })).toBeVisible()
  await expect(opener).toBeFocused()
  expect(requests).toBe(1)
})

test('model dialog is named, traps/restores focus and submits native form with Enter', async ({ page }) => {
  await signUpFresh(page)
  const providerId = await seedProvider(page, { name: 'Model dialog provider' })
  await page.goto(`${BASE}/?page=settings`)
  const opener = page.locator('.settings-page .heading-actions').getByRole('button', { name: S.addModel.vi, exact: true })
  await opener.click()
  const dialog = page.getByRole('dialog', { name: S.addModel.vi, exact: true })
  await expectFocusTrapAndEscape(page, dialog, opener)
  await opener.click()
  await dialog.getByLabel(S.modelIdLabel.vi, { exact: true }).fill('mock-image-model')
  const name = dialog.getByLabel(S.displayNameOptionalLabel.vi, { exact: true })
  await name.fill('Native Enter model')
  const request = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/models'))
  await name.press('Enter')
  expect((await request).postDataJSON()).toMatchObject({ providerId, modelId: 'mock-image-model', displayName: 'Native Enter model', kind: 'image' })
  await expect(dialog).toHaveCount(0)
  await expect(opener).toBeFocused()
  await page.getByRole('button', { name: /Model catalog/ }).click()
  await expect(page.locator('.model-row').filter({ hasText: 'Native Enter model' })).toBeVisible()
})
