import { expect, test, type Page } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh, waitForGeneration } from './helpers/auth'

async function seedTrash(page: Page) {
  const character = (await (await page.request.post(`${BASE}/api/shared-characters`, { data: { name: 'Lan khôi phục', appearance: 'áo hồng' } })).json()).character
  const libraryResponse = await page.request.post(`${BASE}/api/entity-library/assets`, { data: { kind: 'logo', name: 'Logo được lưu giữ', description: 'Biểu trưng trong thùng rác', continuityNotes: 'Không đổi màu thương hiệu' } })
  expect(libraryResponse.ok()).toBe(true)
  const library = (await libraryResponse.json()).asset
  expect((await page.request.delete(`${BASE}/api/entity-library/assets/${library.id}`)).ok()).toBe(true)
  const project = (await (await page.request.post(`${BASE}/api/projects`, { data: { name: 'Studio trong thùng rác' } })).json()).project
  const plan = (await (await page.request.post(`${BASE}/api/plans`, { data: { title: 'Kịch bản và Timeline' } })).json()).session
  const provider = await seedProvider(page), modelId = await seedModel(page, provider)
  const created = await page.request.post(`${BASE}/api/generations`, { data: { modelId, prompt: 'Ảnh lưu giữ ba mươi ngày' } })
  expect(created.ok()).toBe(true)
  const generationId = (await created.json()).generation.id as string
  expect((await waitForGeneration(page, generationId)).status).toBe('succeeded')
  for (const path of [`shared-characters/${character.id}`, `generations/${generationId}`, `plans/${plan.id}`]) {
    expect((await page.request.delete(`${BASE}/api/${path}`)).ok()).toBe(true)
  }
  expect((await page.request.post(`${BASE}/api/projects/${project.id}/trash`, { data: { deleteResults: false } })).ok()).toBe(true)
  return { characterId: character.id as string, projectId: project.id as string, planId: plan.id as string, generationId }
}

test.beforeEach(async ({ page }) => { await signUpFresh(page) })

test('thùng rác chung giữ đủ năm loại, khôi phục và xoá vĩnh viễn có xác nhận', async ({ page }) => {
  const ids = await seedTrash(page)
  await page.goto(`${BASE}/?page=trash`)
  await expect(page.getByRole('heading', { name: 'Thùng rác', exact: true })).toBeVisible()
  await expect(page.locator('.trash-card')).toHaveCount(5)
  await page.screenshot({ path: 'test-results/trash-page.png', fullPage: false })
  await expect(page.locator('.trash-expiry').first()).toHaveText('Còn 30 ngày')
  const image = page.locator('.trash-card').filter({ hasText: 'Ảnh lưu giữ ba mươi ngày' }).locator('img')
  await expect(image).toBeVisible()
  expect(await image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)

  await page.locator('.trash-filters').getByRole('button', { name: /Nhân vật/ }).click()
  await expect(page.locator('.trash-card')).toHaveCount(1)
  await page.getByRole('button', { name: 'Khôi phục Lan khôi phục' }).click()
  await expect(page.locator('.trash-card')).toHaveCount(0)
  expect((await page.request.get(`${BASE}/api/shared-characters/${ids.characterId}`)).status()).toBe(200)

  await page.locator('.trash-filters').getByRole('button', { name: /Tất cả/ }).click()
  await expect(page.locator('.trash-card')).toHaveCount(4)
  await page.getByRole('button', { name: 'Xóa vĩnh viễn Kịch bản và Timeline', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Xóa vĩnh viễn mục này?' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Hủy' }).click()
  await expect(page.locator('.trash-card')).toHaveCount(4)
  await page.getByRole('button', { name: 'Xóa vĩnh viễn Kịch bản và Timeline', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Xóa vĩnh viễn', exact: true }).click()
  await expect(page.locator('.trash-card')).toHaveCount(3)

  await page.getByRole('button', { name: 'Dọn sạch thùng rác', exact: true }).click()
  await page.getByRole('dialog', { name: 'Dọn sạch toàn bộ thùng rác?' }).getByRole('button', { name: 'Dọn sạch thùng rác' }).click()
  await expect(page.locator('.trash-card')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Thùng rác trống' })).toBeVisible()
})

test('chi tiết đầy đủ, Unicode, zoom và modal lồng giữ focus', async ({ page }) => {
  const longText = '😀'.repeat(240) + '\nFULL DESCRIPTION END'
  const longName = 'Tên nhân vật dài '.repeat(10)
  const response = await page.request.post(`${BASE}/api/shared-characters`, { data: { name: longName, appearance: longText, voice: { language: 'Vietnamese', habits: 'Nói chậm và rõ' } } })
  expect(response.ok()).toBe(true)
  const character = (await response.json()).character
  expect((await page.request.delete(`${BASE}/api/shared-characters/${character.id}`)).ok()).toBe(true)
  await seedTrash(page)
  await page.goto(`${BASE}/?page=trash`)
  const card = page.locator('.trash-card').filter({ hasText: longName.trim() })
  await expect(card).toBeVisible()
  await expect(card.getByTestId('entity-card-description')).toHaveText('😀'.repeat(197) + '...')
  expect(await card.getByTestId('entity-card-name').evaluate(el => getComputedStyle(el).webkitLineClamp)).toBe('2')
  expect(await card.getByTestId('entity-card-description').evaluate(el => getComputedStyle(el).webkitLineClamp)).toBe('3')
  await card.getByTestId('entity-card-details').click()
  const details = page.getByTestId('entity-details-dialog')
  await expect(details.getByTestId('entity-details-description')).toHaveText(longText)
  await expect(details).toContainText('Nói chậm và rõ')
  await details.getByRole('button', { name: /Xóa vĩnh viễn/ }).click()
  await expect(page.getByRole('dialog', { name: 'Xóa vĩnh viễn mục này?' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(details).toBeVisible()
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden')
  await page.keyboard.press('Escape')
  await expect(details).toHaveCount(0)
  await expect(card.getByTestId('entity-card-details')).toBeFocused()
  const media = page.locator('.trash-card').filter({ hasText: 'Ảnh lưu giữ ba mươi ngày' })
  await media.getByTestId('entity-card-details').click()
  await page.getByTestId('entity-details-zoom').click()
  const lightbox = page.locator('.lightbox-backdrop')
  await expect(lightbox).toBeVisible()
  expect(await lightbox.locator('img').getAttribute('src')).toMatch(/^\/api\/assets\//)
  await page.keyboard.press('Tab')
  expect(await lightbox.evaluate(el => el.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(lightbox).toHaveCount(0)
  await expect(page.getByTestId('entity-details-dialog')).toBeVisible()
  await expect(page.getByTestId('entity-details-zoom')).toBeFocused()
  await page.keyboard.press('Escape')
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden')
})

test('ngày lỗi không crash và lỗi khôi phục hiện trong chi tiết đang mở', async ({ page }) => {
  const now = Date.now()
  const valid = { kind: 'character', entityKind: 'character', id: 'restore-conflict', title: 'Khôi phục bị chặn', subtitle: '', thumbnailUrl: null, deletedAt: now, purgeAfter: now + 86400000, description: 'Mô tả đầy đủ' }
  const invalid = { ...valid, id: 'invalid-dates', title: 'Ngày cũ không hợp lệ', deletedAt: 1e20, purgeAfter: 1e20 }
  await page.route('**/api/trash?*', route => route.fulfill({ json: { items: [invalid, valid], counts: { project: 0, character: 2, generation: 0, plan_session: 0, library_asset: 0 }, total: 2, retentionDays: 30 } }))
  await page.route('**/api/trash/character/*', route => route.fulfill({ json: { item: { ...(route.request().url().endsWith('/invalid-dates') ? invalid : valid), createdAt: null, updatedAt: null } } }))
  await page.route('**/api/trash/character/restore-conflict/restore', route => route.fulfill({ status: 409, json: { error: { code: 'CONFLICT', message: 'Restore conflict', messageKey: 'errors.conflict' } } }))
  await page.goto(`${BASE}/?page=trash`)
  await expect(page.locator('.trash-card')).toHaveCount(2)
  const invalidCard = page.locator('.trash-card').filter({ hasText: invalid.title })
  await expect(invalidCard.locator('time')).toHaveCount(2)
  expect(await invalidCard.locator('time').first().getAttribute('datetime')).toBeNull()
  await expect(invalidCard.getByRole('button', { name: `Khôi phục ${invalid.title}`, exact: true })).toBeDisabled()
  await invalidCard.getByTestId('entity-card-details').click()
  await expect(page.getByTestId('entity-details-dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.locator('.trash-card').filter({ hasText: valid.title }).getByTestId('entity-card-details').click()
  const details = page.getByTestId('entity-details-dialog')
  await details.getByRole('button', { name: `Khôi phục ${valid.title}`, exact: true }).click()
  await expect(details.getByRole('alert')).toContainText('Dữ liệu xung đột với trạng thái hiện tại')
  await expect(details.getByRole('button', { name: 'Thử lại', exact: true })).toHaveCount(0)
  await details.getByRole('button', { name: /Xóa vĩnh viễn/ }).click()
  await page.keyboard.press('Escape')
  await expect(details.getByRole('alert')).toContainText('Dữ liệu xung đột với trạng thái hiện tại')
  await page.keyboard.press('Escape')
  await expect(details).toHaveCount(0)
})

test('thùng rác trên điện thoại không tràn ngang và đổi ngôn ngữ', async ({ page }) => {
  await seedTrash(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${BASE}/?page=trash`)
  await expect(page.locator('.trash-card')).toHaveCount(5)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.evaluate(() => localStorage.setItem('lumina.locale', 'en'))
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Trash', exact: true })).toBeVisible()
  await expect(page.locator('.trash-expiry').first()).toHaveText('30 days remaining')
  const logo = page.locator('.trash-card').filter({ hasText: 'Logo được lưu giữ' })
  await logo.getByRole('button', { name: 'Details: Logo được lưu giữ', exact: true }).click()
  const details = page.getByTestId('entity-details-dialog')
  await expect(details).toContainText('Continuity notes')
  await expect(details).toContainText('Không đổi màu thương hiệu')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/trash-mobile-details.png', fullPage: false })
  await details.getByRole('button', { name: 'Close', exact: true }).click()
})
