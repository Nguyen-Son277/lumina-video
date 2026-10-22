import { expect, test } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh } from './helpers/auth'

test('quick home uses shared Lumina palette across desktop and mobile', async ({ page }) => {
  await signUpFresh(page)
  await page.goto(`${BASE}/?page=quick`)
  await expect(page.locator('.quick-home-composer')).toBeVisible()
  for (const width of [1440, 760, 390]) {
    await page.setViewportSize({ width, height: 900 })
    const colors = await page.locator('.quick-home').evaluate(root => {
      const tokens = getComputedStyle(document.documentElement)
      const style = (selector: string) => getComputedStyle(root.querySelector(selector)!)
      return {
        background: getComputedStyle(root).backgroundColor,
        expectedBackground: tokens.getPropertyValue('--bg').trim(),
        filter: style('.quick-home-filters button[aria-pressed="true"]').color,
        accent: tokens.getPropertyValue('--accent').trim(),
        panel: style('.quick-home-composer .composer-card').backgroundColor,
      }
    })
    expect(colors.background).toBe('rgb(10, 11, 13)')
    expect(colors.expectedBackground).toBe('#0a0b0d')
    expect(colors.filter).toBe('rgb(186, 140, 255)')
    expect(colors.accent).toBe('#ba8cff')
    expect(colors.panel).toBe('rgb(22, 24, 29)')
    await expect.poll(() => page.locator('.quick-home').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
  }
})

test('configuration modal remains usable on desktop and mobile', async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  await seedModel(page, provider, { modelId: 'config-design-image', displayName: 'Studio Image', kind: 'image' })
  await page.goto(`${BASE}/?page=quick`)
  await expect(page.locator('.quick-home-composer')).toBeVisible()
  await page.getByRole('button', { name: 'Cấu hình', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Cấu hình', exact: true })
  await expect(dialog).toBeVisible()
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(dialog.getByRole('combobox', { name: 'Provider', exact: true })).toBeVisible()
    await expect(dialog.getByRole('combobox', { name: 'Model ảnh', exact: true })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Lưu cấu hình', exact: true })).toBeEnabled()
    await expect.poll(() => dialog.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
    await page.screenshot({ path: `test-results/quick-config-${width}.png`, fullPage: true })
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await page.getByRole('button', { name: 'Cấu hình', exact: true }).click()
  await expect(dialog).toBeVisible()
})
