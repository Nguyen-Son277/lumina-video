import { expect, test, type Page } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh } from './helpers/auth'

/**
 * Đơn giá model được nhập trong tab Model catalog của API & Models, mở rộng ngay
 * trong hàng model; trang Nhật ký sử dụng chỉ đọc để ước tính chi phí.
 */

async function seedCatalog(page: Page): Promise<{ llmId: string; imageId: string }> {
  const provider = await seedProvider(page)
  const llmId = await seedModel(page, provider, { modelId: 'mock-chat-model', displayName: 'Chat Model', kind: 'llm' })
  const imageId = await seedModel(page, provider, { modelId: 'mock-image-model', displayName: 'Image Model', kind: 'image' })
  return { llmId, imageId }
}

async function openCatalog(page: Page): Promise<void> {
  await page.goto(BASE)
  await page.getByRole('button', { name: 'API & Models', exact: true }).click()
  await page.getByRole('button', { name: /Model catalog/ }).click()
}

test('nhập đơn giá token cho model chat ngay trong hàng model', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await signUpFresh(page)
  await seedCatalog(page)
  await openCatalog(page)

  const row = page.locator('.model-row').filter({ hasText: 'Chat Model' })
  // Chưa nhập giá thì hàng model nói rõ.
  await expect(row.locator('.model-price-summary')).toContainText('Chưa đặt đơn giá')

  await row.getByRole('button', { name: 'Đơn giá của Chat Model' }).click()
  await row.getByLabel('Vào / 1K token Chat Model').fill('0.01')
  await row.getByLabel('Ra / 1K token Chat Model').fill('0.02')
  await row.getByRole('button', { name: 'Lưu đơn giá' }).click()

  await expect(row.locator('.model-price-status')).toContainText('Đã lưu')
  await expect(row.locator('.model-price-summary')).toContainText('Vào 0,01 USD / 1K')
  await expect(row.locator('.model-price-summary')).toContainText('Ra 0,02 USD / 1K')

  // Bền sau khi tải lại: giá đã nằm trong dữ liệu model.
  await page.reload()
  await page.getByRole('button', { name: /Model catalog/ }).click()
  const reloaded = page.locator('.model-row').filter({ hasText: 'Chat Model' })
  await expect(reloaded.locator('.model-price-summary')).toContainText('Vào 0,01 USD / 1K')
})

test('đơn giá sai bị chặn, để trống là xoá giá', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await signUpFresh(page)
  const { imageId } = await seedCatalog(page)
  await openCatalog(page)

  const row = page.locator('.model-row').filter({ hasText: 'Image Model' })
  await row.getByRole('button', { name: 'Đơn giá của Image Model' }).click()

  // Số âm: báo lỗi và KHÔNG gọi API.
  let patched = false
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && request.url().includes(`/api/models/${imageId}`)) patched = true
  })
  await row.getByLabel('Giá mỗi lượt Image Model').fill('-3')
  await row.getByRole('button', { name: 'Lưu đơn giá' }).click()
  await expect(row.locator('.model-price-status')).toContainText('lớn hơn hoặc bằng 0')
  expect(patched).toBe(false)

  // Giá hợp lệ rồi lưu.
  await row.getByLabel('Giá mỗi lượt Image Model').fill('0.5')
  await row.getByRole('button', { name: 'Lưu đơn giá' }).click()
  await expect(row.locator('.model-price-summary')).toContainText('0,5 USD / lượt')

  // Để trống rồi lưu: xoá đơn giá.
  await row.getByLabel('Giá mỗi lượt Image Model').fill('')
  await row.getByRole('button', { name: 'Lưu đơn giá' }).click()
  await expect(row.locator('.model-price-summary')).toContainText('Chưa đặt đơn giá')
})

test('mỗi lần chỉ mở một hàng, giữ chữ đang gõ khi đóng mở lại', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await signUpFresh(page)
  await seedCatalog(page)
  await openCatalog(page)

  const chat = page.locator('.model-row').filter({ hasText: 'Chat Model' })
  const image = page.locator('.model-row').filter({ hasText: 'Image Model' })

  await chat.getByRole('button', { name: 'Đơn giá của Chat Model' }).click()
  await expect(chat.locator('.model-price-editor')).toBeVisible()
  await chat.getByLabel('Vào / 1K token Chat Model').fill('0.03')

  // Mở hàng khác: hàng trước tự đóng.
  await image.getByRole('button', { name: 'Đơn giá của Image Model' }).click()
  await expect(chat.locator('.model-price-editor')).toHaveCount(0)

  // Quay lại hàng đầu: chữ đang gõ vẫn còn.
  await chat.getByRole('button', { name: 'Đơn giá của Chat Model' }).click()
  await expect(chat.getByLabel('Vào / 1K token Chat Model')).toHaveValue('0.03')
})

test('khối đơn giá không tràn ngang ở 390px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await signUpFresh(page)
  await seedCatalog(page)
  await page.goto(BASE)
  await page.getByRole('button', { name: 'Mở menu', exact: true }).click()
  await page.getByRole('button', { name: 'API & Models', exact: true }).click()
  await page.getByRole('button', { name: /Model catalog/ }).click()

  const row = page.locator('.model-row').filter({ hasText: 'Chat Model' })
  await row.getByRole('button', { name: 'Đơn giá của Chat Model' }).click()
  await row.getByLabel('Vào / 1K token Chat Model').fill('0.01')
  await row.getByRole('button', { name: 'Lưu đơn giá' }).click()
  await expect(row.locator('.model-price-status')).toContainText('Đã lưu')

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)
})
