import { expect, test } from '@playwright/test'
import { BASE, signUpFresh } from './helpers/auth'

async function readType(page: import('@playwright/test').Page, selector: string) {
  return page.locator(selector).filter({ visible: true }).first().evaluate((el) => {
    const style = getComputedStyle(el)
    return { size: parseFloat(style.fontSize), weight: Number(style.fontWeight) || 400, family: style.fontFamily }
  })
}

test.describe('Cỡ chữ dễ đọc', () => {
  test.beforeEach(async ({ page }) => {
    await signUpFresh(page)
  })

  test('font tiếng Việt local dùng cho quick home và phiên, không cần Google Fonts', async ({ page }) => {
    const externalFonts: string[] = []
    page.on('request', request => {
      if (/fonts\.(googleapis|gstatic)\.com/.test(request.url())) externalFonts.push(request.url())
    })
    await page.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.abort())
    await page.goto(`${BASE}/?page=quick`)
    await expect(page.locator('.quick-home-composer')).toBeVisible()
    const sample = 'Tạo nội dung đơn lẻ — Mô tả tiếng Việt: Ắ Ằ Ẳ Ẵ Ặ Ế Ề Ể Ễ Ệ Ớ Ờ Ở Ỡ Ợ Ứ Ừ Ử Ữ Ự đ'
    const loaded = await page.evaluate(async text => {
      const faces = await Promise.all([400, 500, 600, 700].map(weight => document.fonts.load(`${weight} 16px "Be Vietnam Pro"`, text)))
      await document.fonts.ready
      return faces.every(items => items.length > 0 && items.every(face => face.status === 'loaded'))
    }, sample)
    expect(loaded).toBe(true)
    for (const selector of ['body', '.quick-home-header h1', '.prompt-box textarea', '.mode-tabs button', '.quick-config-trigger']) {
      expect((await readType(page, selector)).family).toContain('Be Vietnam Pro')
    }
    const prompt = page.locator('.quick-home-composer #quick-home-prompt')
    await prompt.fill(sample)
    await expect(prompt).toHaveValue(sample)
    const response = await page.request.post(`${BASE}/api/quick-sessions`, { data: { title: 'Phiên tiếng Việt' } })
    expect(response.ok()).toBeTruthy()
    const { session } = await response.json()
    await page.goto(`${BASE}/?page=quick&session=${session.id}`)
    await expect(page.locator('#prompt').filter({ visible: true })).toBeVisible()
    expect((await readType(page, '#prompt')).family).toContain('Be Vietnam Pro')
    expect(externalFonts).toEqual([])
  })

  test('chữ nội dung chính tối thiểu 14px và đủ đậm', async ({ page }) => {
    await page.goto(BASE)
    await page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true }).click()

    await expect(page.locator('.quick-home-composer')).toBeVisible()
    const targets: Array<[string, number]> = [
      ['.nav-item', 14],
      ['.quick-home-header p', 14],
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
      const el = page.locator(selector).filter({ visible: true }).first()
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
