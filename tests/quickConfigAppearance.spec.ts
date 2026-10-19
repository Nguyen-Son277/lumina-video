import { expect, test } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh } from './helpers/auth'

test('configuration modal remains usable on desktop and mobile', async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  await seedModel(page, provider, { modelId: 'config-design-image', displayName: 'Studio Image', kind: 'image' })
  await page.goto(`${BASE}/?page=quick`)
  await page.getByRole('button', { name: 'Phiên mới', exact: true }).first().click()
  await page.getByRole('button', { name: 'Cấu hình', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Cấu hình', exact: true })
  await expect(dialog).toBeVisible()
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(dialog.getByRole('combobox', { name: 'Provider', exact: true })).toBeVisible()
    await expect(dialog.getByRole('combobox', { name: 'Model ảnh', exact: true })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Lưu cấu hình', exact: true })).toBeEnabled()
    await expect.poll(() => dialog.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
    await page.screenshot({ path: `shots/quick-config-${width}.png`, fullPage: true })
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await page.getByRole('button', { name: 'Cấu hình', exact: true }).click()
  await expect(dialog).toBeVisible()
})
