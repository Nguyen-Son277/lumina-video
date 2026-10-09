import { expect, test } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh } from './helpers/auth'

/** Integration contract: lead mounts LocationReferences in the planner's locations panel.
 * Uses the isolated mock-provider backend configured by Playwright; no external AI call.
 */
test.beforeEach(async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  await seedModel(page, provider, { modelId: 'mock-chat-model', displayName: 'Chat', kind: 'llm' })
  await seedModel(page, provider, { modelId: 'mock-image-model', displayName: 'Image', kind: 'image' })
})

async function openLocations(page: import('@playwright/test').Page) {
  await page.goto(`${BASE}/?page=planner`)
  await page.getByRole('button', { name: 'Phiên mới', exact: true }).first().click()
  // The owner may expose a tab/button or keep the reusable panel directly on the page.
  // The planner bar renders after the session loads, so wait for the opener first.
  const opener = page.getByRole('button', { name: /Bối cảnh|Locations/ }).first()
  if (await opener.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false)) {
    await opener.click()
  }
  await expect(page.getByTestId('location-references')).toBeVisible()
  return page.getByTestId('location-references')
}

for (const width of [1440, 390, 320]) {
  test(`location metadata CRUD and locale-preserved draft at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const panel = await openLocations(page)
    await panel.getByRole('button', { name: 'Thêm bối cảnh', exact: true }).click()
    const dialog = page.locator('.locations-dialog')
    await dialog.getByLabel('Tên bối cảnh', { exact: true }).fill('Sân ga trung tâm')
    await dialog.getByLabel('Giai đoạn / biến thể', { exact: true }).fill('Buổi sáng')
    await dialog.getByLabel('Mô tả bối cảnh', { exact: true }).fill('Sân ga có đồng hồ tròn và ghế gỗ.')
    await dialog.getByLabel('Ghi chú liên tục', { exact: true }).fill('Đồng hồ luôn ở bên trái khung hình.')
    await dialog.getByLabel('Prompt ảnh nền không có người', { exact: true }).fill('Empty railway station, wooden benches.')
    // Locale switching must not replace/reinitialize editor state.
    await page.evaluate(() => localStorage.setItem('lumina.locale', 'en'))
    await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'lumina.locale', newValue: 'en' })))
    await expect(dialog.getByLabel('Location name', { exact: true })).toHaveValue('Sân ga trung tâm')
    await dialog.getByRole('button', { name: 'Save location', exact: true }).click()
    await expect(panel.getByRole('heading', { name: 'Sân ga trung tâm', exact: true })).toBeVisible()
    await expect(panel).toContainText('Revision')
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
    await panel.getByRole('button', { name: 'Edit location', exact: true }).first().click()
    const edit = page.getByRole('dialog', { name: 'Edit location', exact: true })
    await edit.getByLabel('Stage / variation', { exact: true }).fill('Sau cơn bão')
    await edit.getByRole('button', { name: 'Save location', exact: true }).click()
    await expect(panel).toContainText('Sau cơn bão')
    await panel.getByRole('button', { name: 'Delete location', exact: true }).first().click()
    const confirmation = page.getByRole('dialog', { name: 'Delete this location?', exact: true })
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(panel).toContainText('Sân ga trung tâm')
    await panel.getByRole('button', { name: 'Delete location', exact: true }).first().click()
    await page.getByRole('dialog', { name: 'Delete this location?', exact: true }).getByRole('button', { name: 'Delete location', exact: true }).click()
    await expect(panel.getByRole('heading', { name: 'No locations yet' })).toBeVisible()
  })
}
