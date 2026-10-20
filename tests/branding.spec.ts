import { expect, test, type Locator } from '@playwright/test'
import { BASE, signUpFresh } from './helpers/auth'

async function expectLoadedMark(mark: Locator) {
  await expect(mark).toBeVisible()
  await expect.poll(() => mark.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true)
  const box = (await mark.boundingBox())!
  expect(box.width).toBe(32)
  expect(box.height).toBe(32)
}

test('brand assets are public images and favicon declarations are valid', async ({ page, request }) => {
  await page.goto(BASE)
  await expectLoadedMark(page.locator('.auth-brand .brand-mark'))
  await expect(page.locator('.auth-brand .brand-mark')).toHaveAttribute('alt', '')
  await expect(page.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveAttribute('href', '/favicon.svg')
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('sizes', '180x180')
  for (const [path, mime] of [
    ['/brand/lumina-mark.svg', 'image/svg+xml'],
    ['/brand/lumina-logo.svg', 'image/svg+xml'],
    ['/brand/lumina-logo.png', 'image/png'],
    ['/favicon.svg', 'image/svg+xml'],
    ['/favicon.ico', 'image/'],
    ['/apple-touch-icon.png', 'image/png'],
  ]) {
    const response = await request.get(`${BASE}${path}`)
    expect(response.ok()).toBe(true)
    expect(response.headers()['content-type']).toContain(mime)
    expect((await response.body()).length).toBeGreaterThan(100)
  }
  const ico = await (await request.get(`${BASE}/favicon.ico`)).body()
  expect(ico.readUInt16LE(2)).toBe(1)
  expect(ico.readUInt16LE(4)).toBe(3)
  expect([ico[6], ico[22], ico[38]]).toEqual([16, 32, 48])
  await page.screenshot({ path: 'test-results/branding-auth.png' })
})

test('brand mark fits expanded, collapsed and mobile sidebar', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await signUpFresh(page)
  await page.goto(BASE)
  const sidebar = page.locator('.sidebar')
  const mark = sidebar.locator('.brand-mark')
  await expectLoadedMark(mark)
  await expect(mark).toHaveAttribute('alt', '')
  await sidebar.locator('.sidebar-collapse-toggle').click()
  await expect(sidebar).toHaveClass(/is-collapsed/)
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(72)
  await expectLoadedMark(mark)
  await expect(mark).toHaveAttribute('alt', 'Lumina Studio')
  await expect(sidebar.locator('.brand-copy')).toBeHidden()
  const markBox = (await mark.boundingBox())!
  const sidebarBox = (await sidebar.boundingBox())!
  expect(markBox.x).toBeGreaterThanOrEqual(sidebarBox.x)
  expect(markBox.x + markBox.width).toBeLessThanOrEqual(sidebarBox.x + sidebarBox.width)
  await page.screenshot({ path: 'test-results/branding-collapsed.png' })
  await sidebar.locator('.sidebar-collapse-toggle').click()
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(248)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Mở menu' }).click()
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.x)).toBe(0)
  await expectLoadedMark(mark)
  const mobileMark = (await mark.boundingBox())!
  const close = (await sidebar.locator('.sidebar-mobile-close').boundingBox())!
  expect(mobileMark.x + mobileMark.width).toBeLessThan(close.x)
  await page.screenshot({ path: 'test-results/branding-mobile.png' })
})
