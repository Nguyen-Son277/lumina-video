import { expect, test } from '@playwright/test'
import { MOCK_PNG_BYTES } from '../server/generations/adapters/mock'
import { BASE, seedLlmModel, seedModel, seedProvider, signUpFresh } from './helpers/auth'

const image = { name: 'source.png', mimeType: 'image/png', buffer: MOCK_PNG_BYTES }

test('thử lại sheet giữ ảnh gốc của ứng viên dù người dùng đổi ảnh đầu vào', async ({ page }) => {
  await signUpFresh(page)
  await seedLlmModel(page)
  const providerId = await seedProvider(page)
  const imageModelId = await seedModel(page, providerId)
  await page.request.patch(`${BASE}/api/models/${imageModelId}`, { data: { imageReferenceSupport: 'yes' } })
  await page.goto(`${BASE}/?page=characters`)
  await page.getByRole('button', { name: 'AI tạo nhân vật', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'AI tạo nhân vật' })
  await dialog.getByRole('button', { name: 'Từ ảnh', exact: true }).click()
  await dialog.locator('input[type=file]').setInputFiles(image)
  const sourceIds: string[] = []
  await page.route('**/api/shared-characters/illustrations', async route => {
    sourceIds.push(route.request().postDataJSON().sourceUploadId)
    if (sourceIds.length === 1) {
      await route.fulfill({ status: 502, json: { error: { code: 'PROVIDER_ERROR', message: 'Reference image generation failed.', messageKey: 'provider.request_failed', messageParams: { detail: 'Mock failure' } } } })
    } else await route.continue()
  })
  await dialog.locator('.character-ai-generate').click()
  await expect(dialog.locator('.character-ai-status.is-error')).toBeVisible()
  expect(sourceIds[0]).toEqual(expect.any(String))
  await dialog.locator('input[type=file]').setInputFiles({ ...image, name: 'new-source.png' })
  await dialog.getByRole('button', { name: 'Thử lại ảnh', exact: true }).click()
  await expect(dialog.locator('.character-ai-status.is-ok')).toBeVisible({ timeout: 40_000 })
  expect(sourceIds).toHaveLength(2)
  expect(sourceIds[1]).toBe(sourceIds[0])
})

test('lỗi gắn sheet thử lại không tạo trùng hồ sơ hoặc tạo lại ảnh tính phí', async ({ page }) => {
  await signUpFresh(page)
  await seedLlmModel(page)
  const providerId = await seedProvider(page)
  await seedModel(page, providerId)
  let charactersCreated = 0
  let imagesCreated = 0
  let attachments = 0
  page.on('request', request => {
    if (request.url().endsWith('/api/shared-characters') && request.method() === 'POST') charactersCreated++
    if (request.url().endsWith('/api/shared-characters/illustrations')) imagesCreated++
  })
  await page.route('**/api/shared-characters/*/reference/from-generation', async route => {
    attachments++
    if (attachments === 1) await route.fulfill({ status: 502, json: { error: { code: 'PROVIDER_ERROR', message: 'Attach failed' } } })
    else await route.continue()
  })
  await page.goto(`${BASE}/?page=characters`)
  await page.getByRole('button', { name: 'AI tạo nhân vật', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'AI tạo nhân vật' })
  await dialog.getByRole('button', { name: 'Từ ảnh', exact: true }).click()
  await dialog.locator('input[type=file]').setInputFiles(image)
  await dialog.locator('.character-ai-generate').click()
  await expect(dialog.locator('.character-ai-status.is-error')).toBeVisible({ timeout: 40_000 })
  await dialog.getByRole('button', { name: 'Thử lại ảnh', exact: true }).click()
  await expect(dialog.locator('.character-ai-status.is-ok')).toBeVisible()
  expect(charactersCreated).toBe(1)
  expect(imagesCreated).toBe(1)
  expect(attachments).toBe(2)
})

test('giao diện tải ảnh trên điện thoại và lưu thủ công hồ sơ kèm sheet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await signUpFresh(page)
  await seedLlmModel(page)
  const providerId = await seedProvider(page)
  await seedModel(page, providerId)
  await page.goto(`${BASE}/?page=characters`)
  await page.getByRole('button', { name: 'AI tạo nhân vật', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'AI tạo nhân vật' })
  await dialog.getByRole('button', { name: 'Từ ảnh', exact: true }).click()
  await dialog.locator('input[type=file]').setInputFiles(image)
  await page.screenshot({ path: 'shots/character-ai-upload-390.png', fullPage: true })
  await dialog.getByLabel('Lưu vào thư viện ngay').uncheck()
  await dialog.locator('.character-ai-generate').click()
  await expect(dialog.locator('.illustration-image')).toBeVisible({ timeout: 40_000 })
  await expect(dialog.locator('.character-ai-status.is-ok')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await dialog.getByRole('button', { name: 'Thêm kèm ảnh', exact: true }).click()
  await expect(dialog.locator('.character-ai-status.is-ok')).toHaveCount(1)
  await dialog.locator('.modal-actions').getByRole('button', { name: 'Đóng', exact: true }).click()
  await expect(page.locator('.character-library-media img')).toBeVisible()
})
