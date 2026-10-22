import { expect, test, type Locator, type Page } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh } from './helpers/auth'

async function openQuick(page: Page): Promise<void> {
  const response = await page.request.post(`${BASE}/api/quick-sessions`, { data: { title: 'Workspace regression' } })
  expect(response.status()).toBe(201)
  const { session } = await response.json()
  await page.goto(`${BASE}/?page=quick&session=${session.id}`)
  await expect(page.getByRole('button', { name: 'Cấu hình', exact: true })).toBeVisible()
  await expect(page.locator('#prompt')).toBeEnabled()
}

async function toggleWithKeyboard(group: Locator, key: 'Enter' | 'Space' = 'Enter'): Promise<void> {
  const summary = group.locator(':scope > summary')
  await summary.focus()
  await expect(summary).toBeFocused()
  await summary.press(key)
}

async function expectNoOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )).toBeLessThanOrEqual(1)
}

test.beforeEach(async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  await seedModel(page, provider, { modelId: 'studio-ux-image', displayName: 'Studio UX image', kind: 'image' })
  await seedModel(page, provider, { modelId: 'studio-ux-video', displayName: 'Studio UX video', kind: 'video' })
})

for (const width of [1440, 1024, 390, 360]) {
  test(`quick workspace hierarchy, 44px main controls and no overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await openQuick(page)
    const toolbar = page.locator('.quick-workspace-toolbar')
    const grid = page.locator('.studio-grid:visible')
    await expect(toolbar).toBeVisible()
    await expect(grid).toBeVisible()
    expect(await grid.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(width > 1050 ? 2 : 1)
    expect(await toolbar.evaluate(element => element.nextElementSibling?.classList.contains('studio-grid'))).toBe(true)
    const toolbarBox = (await toolbar.boundingBox())!
    const gridBox = (await grid.boundingBox())!
    expect(toolbarBox.y + toolbarBox.height).toBeLessThanOrEqual(gridBox.y + 1)

    const generate = page.locator('.generate-button:visible')
    const groups = page.locator('.studio-page:not(.quick-home):not(.quick-home-composer) .quick-option-group')
    await expect(groups).toHaveCount(3)
    const generateBox = (await generate.boundingBox())!
    for (const group of await groups.all()) {
      await expect(group).not.toHaveAttribute('open')
      expect(await group.evaluate(details => Boolean(
        details.closest('.composer-card')!.querySelector('.generate-button')!
          .compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING,
      ))).toBe(true)
      const summaryBox = (await group.locator(':scope > summary').boundingBox())!
      expect(generateBox.y + generateBox.height).toBeLessThanOrEqual(summaryBox.y + 1)
    }

    const controls = page.locator('.studio-page:not(.quick-home):not(.quick-home-composer)').locator([
      '.quick-workspace-toolbar button', '.quick-workspace-toolbar select', '.quick-session-title',
      '.mode-tabs button', '.quick-config-trigger', '.generate-button', '.quick-option-group > summary',
    ].join(', '))
    for (const control of await controls.all()) {
      await expect(control).toBeVisible()
      expect((await control.boundingBox())!.height, await control.evaluate(element => element.outerHTML)).toBeGreaterThanOrEqual(44)
    }
    await expectNoOverflow(page)
    await page.screenshot({ path: `test-results/quick-studio-${width}.png`, fullPage: true })
    // Expanded optional content must fit too, not only the compact initial state.
    for (const group of await groups.all()) await toggleWithKeyboard(group)
    await expect(page.locator('.quick-source')).toBeVisible()
    await expect(page.locator('.quick-character')).toBeVisible()
    await expectNoOverflow(page)
    await page.locator('.mode-tabs:visible button').nth(1).click()
    await expect(page.locator('.mode-tabs:visible button').nth(1)).toHaveAttribute('aria-pressed', 'true')
    await expectNoOverflow(page)
  })
}

test('optional groups open by keyboard and preserve references, characters and options after collapse', async ({ page }) => {
  const characterResponse = await page.request.post(`${BASE}/api/shared-characters`, {
    data: { name: 'Lan UX', appearance: 'Áo xanh' },
  })
  expect(characterResponse.ok()).toBe(true)
  const assetResponse = await page.request.post(`${BASE}/api/entity-library/assets`, {
    data: { kind: 'item', name: 'Bình gốm UX', handle: 'binh-gom-ux', description: 'Bình gốm màu xanh' },
  })
  expect(assetResponse.ok()).toBe(true)
  await openQuick(page)
  const groups = page.locator('.studio-page:not(.quick-home):not(.quick-home-composer) .quick-option-group')
  for (const group of await groups.all()) await expect(group).not.toHaveAttribute('open')
  const references = groups.nth(0)
  const characters = groups.nth(1)
  const options = groups.nth(2)

  await toggleWithKeyboard(references)
  await expect(references).toHaveAttribute('open', '')
  await references.getByRole('button', { name: 'Chọn từ thư viện', exact: true }).click()
  await references.locator('.qlp-select').filter({ hasText: 'Bình gốm UX' }).click()
  await expect(references.locator('.project-source-item')).toContainText('Bình gốm UX')
  const prompt = page.locator('#prompt')
  await expect(prompt).toHaveValue(/#binh-gom-ux/)
  const promptValue = await prompt.inputValue()
  await toggleWithKeyboard(references, 'Space')
  await expect(references).not.toHaveAttribute('open')
  await toggleWithKeyboard(references)
  await expect(references.locator('.project-source-item')).toContainText('Bình gốm UX')
  await expect(prompt).toHaveValue(promptValue)

  await toggleWithKeyboard(characters, 'Space')
  await characters.locator('select').selectOption({ label: 'Lan UX · chỉ mô tả' })
  await expect(characters.locator('.quick-cast-chip')).toContainText('Lan UX')
  await toggleWithKeyboard(characters)
  await expect(characters).not.toHaveAttribute('open')
  await toggleWithKeyboard(characters, 'Space')
  await expect(characters.locator('.quick-cast-chip')).toContainText('Lan UX')
  await expect(characters.locator('.quick-character-preview')).toContainText('Áo xanh')

  await toggleWithKeyboard(options)
  const purpose = options.getByRole('combobox', { name: 'Mục đích ảnh / nơi lưu', exact: true })
  await purpose.selectOption('item')
  const name = options.getByRole('textbox', { name: 'Tên đối tượng trong thư viện', exact: true })
  const description = options.getByRole('textbox', { name: 'Mô tả thư viện (tuỳ chọn)', exact: true })
  await name.fill('Bình mới')
  await description.fill('Giữ nguyên mô tả sau khi thu gọn')
  await toggleWithKeyboard(options, 'Space')
  await expect(options).not.toHaveAttribute('open')
  await expect(name).not.toBeVisible()
  await toggleWithKeyboard(options)
  await expect(purpose).toHaveValue('item')
  await expect(name).toHaveValue('Bình mới')
  await expect(description).toHaveValue('Giữ nguyên mô tả sau khi thu gọn')

  // Clearing the last value must not hide the control the user is operating.
  await purpose.selectOption('none')
  await expect(options).toHaveAttribute('open', '')
  await characters.getByRole('button', { name: 'Bỏ Lan UX khỏi phiên', exact: true }).click()
  await expect(characters).toHaveAttribute('open', '')
  await expect(characters.locator('.quick-cast-chip')).toHaveCount(0)
  await references.locator('.project-source-item button').click()
  await expect(references).toHaveAttribute('open', '')
  await expect(references.locator('.project-source-item')).toHaveCount(0)
})

test('configuration modal traps keyboard focus and Escape returns focus to its trigger', async ({ page }) => {
  await openQuick(page)
  const trigger = page.getByRole('button', { name: 'Cấu hình', exact: true })
  await trigger.focus()
  await trigger.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Cấu hình', exact: true })
  await expect(dialog).toBeVisible()
  await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
  const first = dialog.locator('button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex="0"]').first()
  const last = dialog.locator('button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex="0"]').last()
  await first.focus()
  await page.keyboard.press('Shift+Tab')
  await expect(last).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(first).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test('mobile result shortcut moves focus to the result section, including its empty state', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openQuick(page)
  const results = page.locator('.quick-session-results')
  await expect(results.getByRole('heading', { name: 'Phiên này chưa có ảnh', exact: true })).toBeVisible()
  const shortcut = page.getByRole('button', { name: 'Xem kết quả (0)', exact: true })
  await shortcut.focus()
  await shortcut.press('Enter')
  await expect(results).toBeFocused()
  await expect(results).toBeInViewport()
  await expectNoOverflow(page)
  await page.locator('.mode-tabs:visible button').nth(1).click()
  await expect(results.getByRole('heading', { name: 'Phiên này chưa có video', exact: true })).toBeVisible()
  await shortcut.click()
  await expect(results).toBeFocused()
})

test('reference library filters cards and clears an empty search without losing the catalog', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 844 })
  const response = await page.request.post(`${BASE}/api/entity-library/assets`, {
    data: { kind: 'item', name: 'Đèn đọc sách UX', handle: 'den-doc-sach-ux', description: 'Đèn bàn nhỏ' },
  })
  expect(response.ok()).toBe(true)
  await openQuick(page)
  const references = page.locator('.studio-page:not(.quick-home):not(.quick-home-composer) .quick-option-group').first()
  await toggleWithKeyboard(references)
  await references.getByRole('button', { name: 'Chọn từ thư viện', exact: true }).click()
  const panel = references.locator('.qlp-panel')
  await expect(panel.locator('.qlp-card')).toHaveCount(1)
  await expect(panel.locator('.qlp-card')).toContainText('Đèn đọc sách UX')
  const search = panel.getByRole('searchbox')
  await search.fill('không-có-kết-quả-ux')
  await expect(panel.locator('.qlp-card')).toHaveCount(0)
  await expect(panel.getByRole('status')).toBeVisible()
  await panel.getByRole('button', { name: 'Xoá bộ lọc', exact: true }).click()
  await expect(search).toHaveValue('')
  await expect(panel.locator('.qlp-card')).toHaveCount(1)
  await expectNoOverflow(page)
  await panel.locator('.qlp-select').click()
  await expect(panel).not.toBeVisible()
  await expect(references.getByRole('button', { name: 'Chọn từ thư viện', exact: true })).toBeFocused()
  await expect(references.locator('.project-source-item')).toContainText('Đèn đọc sách UX')
  await expectNoOverflow(page)
})

test('reference library exposes loading, error, retry and empty states', async ({ page }) => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  let attempts = 0
  await page.route('**/api/entity-library', async route => {
    attempts++
    if (attempts === 1) {
      await pending
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entities: [] }) })
    }
  })
  await openQuick(page)
  const references = page.locator('.studio-page:not(.quick-home):not(.quick-home-composer) .quick-option-group').first()
  await toggleWithKeyboard(references)
  const toggle = references.getByRole('button', { name: 'Chọn từ thư viện', exact: true })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  const panel = references.locator('.qlp-panel')
  try {
    await expect(panel.getByRole('status')).toBeVisible()
    await expect(panel.locator('.qlp-spinner')).toBeVisible()
    await expect(panel.locator('.qlp-grid')).toHaveCount(0)
  } finally {
    release()
  }
  await expect(panel.getByRole('alert')).toContainText('Không thể tải thư viện.')
  await panel.getByRole('button', { name: 'Thử lại', exact: true }).click()
  await expect(panel.getByRole('status')).toContainText('Chưa có đồ vật, bối cảnh hoặc logo.')
  await expect(panel.getByRole('alert')).toHaveCount(0)
  expect(attempts).toBe(2)
  await toggle.click()
  await expect(panel).not.toBeVisible()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
})
