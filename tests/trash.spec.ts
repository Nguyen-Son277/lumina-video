import { expect, test, type Page } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh, waitForGeneration } from './helpers/auth'

async function seedTrash(page: Page) {
  const character = (await (await page.request.post(`${BASE}/api/shared-characters`, { data: { name: 'Lan khôi phục', appearance: 'áo hồng' } })).json()).character
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

test('thùng rác chung giữ đủ bốn loại, khôi phục và xoá vĩnh viễn có xác nhận', async ({ page }) => {
  const ids = await seedTrash(page)
  await page.goto(`${BASE}/?page=trash`)
  await expect(page.getByRole('heading', { name: 'Thùng rác', exact: true })).toBeVisible()
  await expect(page.locator('.trash-card')).toHaveCount(4)
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
  await expect(page.locator('.trash-card')).toHaveCount(3)
  await page.getByRole('button', { name: 'Xóa vĩnh viễn Kịch bản và Timeline', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Xóa vĩnh viễn mục này?' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Hủy' }).click()
  await expect(page.locator('.trash-card')).toHaveCount(3)
  await page.getByRole('button', { name: 'Xóa vĩnh viễn Kịch bản và Timeline', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Xóa vĩnh viễn', exact: true }).click()
  await expect(page.locator('.trash-card')).toHaveCount(2)

  await page.getByRole('button', { name: 'Dọn sạch thùng rác', exact: true }).click()
  await page.getByRole('dialog', { name: 'Dọn sạch toàn bộ thùng rác?' }).getByRole('button', { name: 'Dọn sạch thùng rác' }).click()
  await expect(page.locator('.trash-card')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Thùng rác trống' })).toBeVisible()
})

test('thùng rác trên điện thoại không tràn ngang và đổi ngôn ngữ', async ({ page }) => {
  await seedTrash(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${BASE}/?page=trash`)
  await expect(page.locator('.trash-card')).toHaveCount(4)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.evaluate(() => localStorage.setItem('lumina.locale', 'en'))
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Trash', exact: true })).toBeVisible()
  await expect(page.locator('.trash-expiry').first()).toHaveText('30 days remaining')
})
