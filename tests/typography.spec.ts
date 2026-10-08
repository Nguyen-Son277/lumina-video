import { expect, test } from '@playwright/test'
import { BASE, signUpFresh } from './helpers/auth'

async function readType(page: import('@playwright/test').Page, selector: string) {
  return page.locator(selector).first().evaluate((el) => {
    const style = getComputedStyle(el)
    return { size: parseFloat(style.fontSize), weight: Number(style.fontWeight) || 400 }
  })
}

test.describe('Cỡ chữ dễ đọc', () => {
  test.beforeEach(async ({ page }) => {
    await signUpFresh(page)
  })

  test('chữ nội dung chính tối thiểu 14px và đủ đậm', async ({ page }) => {
    await page.goto(BASE)
    await page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true }).click()

    const targets: Array<[string, number]> = [
      ['.nav-item', 14],
      ['.page-heading p', 14],
      ['.field-label-row label', 14],
      ['.prompt-box textarea', 14],
      ['.generate-button', 14],
      ['.mode-tabs button', 14],
    ]

    for (const [selector, min] of targets) {
      const { size, weight } = await readType(page, selector)
      expect(size, `${selector} phải >= ${min}px`).toBeGreaterThanOrEqual(min)
      expect(weight, `${selector} phải đậm >= 500`).toBeGreaterThanOrEqual(500)
    }
  })

  test('chữ phụ tối thiểu 11px thay vì 7-9px', async ({ page }) => {
    await page.goto(BASE)
    await page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true }).click()

    const targets = [
      '.nav-label',
      '.brand-caption',
      '.workspace-copy span',
      '.user-info span',
      '.counter',
      '.cost-note',
      '.plan-text span',
    ]

    for (const selector of targets) {
      const el = page.locator(selector).first()
      if (await el.count() === 0) continue
      const { size } = await readType(page, selector)
      expect(size, `${selector} phải >= 11px`).toBeGreaterThanOrEqual(11)
    }
  })

  test('trang API & Models và modal cũng dùng cỡ chữ mới', async ({ page }) => {
    await page.goto(BASE)
    await page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true }).click()
    await page.getByRole('button', { name: 'API & Models', exact: true }).click()

    for (const selector of ['.settings-tabs button', '.empty-settings span', '.notice-banner p', '.primary-small-button']) {
      const { size, weight } = await readType(page, selector)
      expect(size, `${selector} phải >= 13px`).toBeGreaterThanOrEqual(13)
      expect(weight, `${selector} phải đậm >= 500`).toBeGreaterThanOrEqual(500)
    }

    await page.getByRole('button', { name: 'Thêm provider' }).first().click()
    for (const selector of ['.modal-description', '.modal-form input', '.modal-form label', '.modal-warning']) {
      const { size, weight } = await readType(page, selector)
      expect(size, `${selector} phải >= 12px`).toBeGreaterThanOrEqual(12)
      expect(weight, `${selector} phải đậm >= 500`).toBeGreaterThanOrEqual(500)
    }
  })

  test('metadata provider/model không dùng chữ 8-9px', async ({ page }) => {
    await page.goto(BASE)
    await page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true }).click()
    await page.getByRole('button', { name: 'API & Models', exact: true }).click()

    await page.getByRole('button', { name: 'Thêm provider' }).first().click()
    await page.getByPlaceholder('Ví dụ: Production gateway').fill('Gateway kiểm tra')
    await page.getByPlaceholder('https://api.example.com/v1').fill('https://api.example.com/v1')
    await page.getByPlaceholder('sk-••••••••••••••••').fill('sk-test')
    await page.getByRole('button', { name: 'Lưu provider' }).click()

    const row = page.locator('.provider-row').first()
    for (const selector of ['.provider-name-row strong', '.provider-url', '.provider-key', '.not-connected-pill', '.row-action']) {
      const { size } = await readType(page, `${selector}`)
      expect(size, `${selector} phải >= 11px`).toBeGreaterThanOrEqual(11)
    }
    await expect(row).toBeVisible()
  })
})
