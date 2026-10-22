import { expect, type Locator, type Page, type Request, type Response } from '@playwright/test'
import { BASE } from './auth'

/** Exact endpoint matching keeps preview, list and generation requests independent. */
export function isApiRequest(request: Request, pathname: string, method: string): boolean {
  return new URL(request.url()).pathname === pathname && request.method() === method
}

/** Open a new composer explicitly, or a particular persisted session without replacing it. */
export async function openQuickComposer(page: Page, sessionId?: string): Promise<void> {
  await page.goto(`${BASE}/?page=quick${sessionId ? `&session=${encodeURIComponent(sessionId)}` : ''}`)
  if (!sessionId) await page.getByTestId('quick-new-session').click()
  await expect(page.locator('#prompt')).toBeVisible()
  await expect(page.locator('#prompt')).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Cấu hình', exact: true })).toBeEnabled()
}

export async function setQuickMode(page: Page, mode: 'image' | 'video'): Promise<void> {
  const tab = page.locator('.mode-tabs').getByRole('button', { name: mode === 'image' ? 'Tạo ảnh' : /Tạo video/, exact: mode === 'image' })
  await tab.click()
  await expect(tab).toHaveAttribute('aria-pressed', 'true')
}

export async function openQuickConfiguration(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Cấu hình', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Cấu hình', exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}

/** Persist configuration only; this helper must never submit a generation. */
export async function saveQuickConfiguration(page: Page): Promise<Response> {
  const dialog = page.getByRole('dialog', { name: 'Cấu hình', exact: true })
  const saved = page.waitForResponse(response => response.request().method() === 'PUT'
    && /^\/api\/quick-generation-preferences\/(image|video)$/.test(new URL(response.url()).pathname))
  await dialog.getByRole('button', { name: 'Lưu cấu hình', exact: true }).click()
  const response = await saved
  expect(response.status(), await response.text()).toBe(200)
  await expect(dialog).toHaveCount(0)
  return response
}

/** Disclosures may already be open after adding references; do not toggle blindly. */
export async function openQuickOptionGroup(page: Page, label: string): Promise<Locator> {
  const group = page.locator('.quick-option-group').filter({ has: page.locator('summary').filter({ hasText: label }) })
  if (await group.getAttribute('open') === null) await group.locator(':scope > summary').click()
  await expect(group).toHaveAttribute('open', '')
  return group
}

/** Preview and paid confirmation are separate so callers can hold the generation response. */
export async function requestQuickPreview(page: Page): Promise<{ dialog: Locator; response: Response }> {
  const preview = page.waitForResponse(response => isApiRequest(response.request(), '/api/generations/preview', 'POST'))
  await page.locator('.generate-button').click()
  const response = await preview
  expect(response.status(), await response.text()).toBe(200)
  const dialog = page.getByRole('dialog', { name: 'Xác nhận yêu cầu tạo nội dung', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Xác nhận & tạo nội dung', exact: true })).toBeEnabled()
  return { dialog, response }
}

/** Click once, without waiting for HTTP 202: progress tests intentionally gate that response. */
export async function confirmQuickPreview(dialog: Locator): Promise<void> {
  await dialog.getByRole('button', { name: 'Xác nhận & tạo nội dung', exact: true }).click()
}
