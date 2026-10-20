import { expect, test, type Page } from '@playwright/test'
import { MOCK_PNG_BYTES } from '../server/generations/adapters/mock'
import { BASE, seedLlmModel, seedModel, seedProvider, signUpFresh } from './helpers/auth'

const image = { name: 'character.png', mimeType: 'image/png', buffer: MOCK_PNG_BYTES }

async function setup(page: Page, withImageModel = true) {
  await signUpFresh(page)
  await seedLlmModel(page)
  let imageModelId = ''
  if (withImageModel) {
    const providerId = await seedProvider(page)
    imageModelId = await seedModel(page, providerId, { kind: 'image', displayName: 'Reference image model' })
    await page.request.patch(`${BASE}/api/models/${imageModelId}`, { data: { imageReferenceSupport: 'yes' } })
  }
  await page.goto(BASE)
  await page.getByRole('button', { name: 'Nhân vật & tài nguyên', exact: true }).click()
  await page.getByTestId('entity-library-ai-create').click()
  const dialog = page.getByTestId('entity-ai-dialog')
  await dialog.getByLabel('Tạo thêm ảnh (phát sinh phí)').check()
  await dialog.getByLabel('Tự lưu ứng viên hoàn tất').check()
  await dialog.getByTestId('entity-ai-llm').selectOption({ index: 1 })
  if (withImageModel) await dialog.getByTestId('entity-ai-image-model').selectOption({ index: 1 })
  return { dialog, imageModelId }
}

test('tạo nhân vật từ ảnh không cần mô tả, gửi cùng ảnh gốc để tạo sheet và tự lưu', async ({ page }) => {
  const { dialog } = await setup(page)
  const generate = dialog.locator('button[type="submit"]')
  await expect(generate).toBeDisabled()
  let uploadCount = 0
  let generateInput: Record<string, unknown> | undefined
  let illustrationInput: Record<string, unknown> | undefined
  page.on('request', request => {
    if (request.url().endsWith('/api/uploads') && request.method() === 'POST') uploadCount++
    if (request.url().endsWith('/api/shared-characters/generate')) generateInput = request.postDataJSON()
    if (request.url().endsWith('/api/shared-characters/illustrations')) illustrationInput = request.postDataJSON()
  })
  await dialog.locator('input[type=file]').setInputFiles(image)
  await expect(dialog.getByAltText('Ảnh tham chiếu')).toBeVisible()
  expect(uploadCount).toBe(0)
  await expect(dialog.getByLabel('Số ứng viên (1–6)')).toHaveValue('1')
  await expect(dialog.getByLabel('Số ứng viên (1–6)')).toBeDisabled()
  await expect(dialog.getByLabel('Mô tả', { exact: true })).toHaveValue('')
  await generate.click()
  await expect(dialog.getByTestId('entity-card').getByText('Đã lưu', { exact: true })).toHaveCount(1, { timeout: 40_000 })
  expect(uploadCount).toBe(1)
  expect(generateInput).toMatchObject({ count: 1, description: '' })
  expect(generateInput?.sourceUploadId).toEqual(expect.any(String))
  expect(illustrationInput?.sourceUploadId).toBe(generateInput?.sourceUploadId)
  await expect(dialog.locator('[data-testid="entity-card-zoom"] img')).toBeVisible()
  await dialog.locator('footer').getByRole('button', { name: 'Đóng', exact: true }).click()
  await page.getByTestId('entity-ai-leave-dialog').getByRole('button', { name: 'Bỏ thay đổi và rời đi', exact: true }).click()
  await expect(page.locator('[data-testid="entity-library-card"][data-entity-kind="character"]')).toHaveCount(1)
  await expect(page.getByTestId('entity-library-card').getByTestId('entity-card-zoom').locator('img')).toBeVisible()
  await page.reload()
  await expect(page.getByTestId('entity-library-card').getByTestId('entity-card-zoom').locator('img')).toBeVisible()
})

test('chọn đổi xóa ảnh chỉ xem trước; thiếu model ảnh không gọi AI', async ({ page }) => {
  const { dialog } = await setup(page, false)
  let uploads = 0
  page.on('request', request => { if (request.url().endsWith('/api/uploads') && request.method() === 'POST') uploads++ })
  const input = dialog.locator('input[type=file]')
  await input.setInputFiles(image)
  await expect(dialog.getByAltText('Ảnh tham chiếu')).toBeVisible()
  await expect(dialog.locator('button[type="submit"]')).toBeDisabled()
  await expect(dialog.getByTestId('entity-ai-image-model').locator('option')).toHaveCount(1)
  await input.setInputFiles({ ...image, name: 'other.png' })
  await dialog.getByRole('button', { name: 'Bỏ ảnh', exact: true }).click()
  await expect(dialog.getByAltText('Ảnh tham chiếu')).toHaveCount(0)
  expect(uploads).toBe(0)
  await expect(dialog.getByLabel('Số ứng viên (1–6)')).toBeEnabled()
  await expect(dialog.getByLabel('Số ứng viên (1–6)')).toHaveValue('1')
  await expect(dialog.getByLabel('Mô tả', { exact: true })).toBeVisible()
})

test('phân tích lỗi giữ ảnh để thử lại và dọn upload chưa dùng khi đóng', async ({ page }) => {
  const { dialog } = await setup(page)
  let uploadId = ''
  page.on('response', async response => {
    if (response.url().endsWith('/api/uploads') && response.request().method() === 'POST' && response.ok()) {
      uploadId = (await response.json()).upload.id
    }
  })
  await page.route('**/api/shared-characters/generate', route => route.fulfill({ status: 400, json: { error: {
    code: 'BAD_REQUEST', message: 'Ảnh cần có một nhân vật rõ ràng. Hãy chọn ảnh khác hoặc bổ sung mô tả.', messageKey: 'characters.image_subject_invalid',
  } } }))
  await dialog.locator('input[type=file]').setInputFiles(image)
  await dialog.locator('button[type="submit"]').click()
  await expect(dialog.getByRole('alert')).toContainText('Ảnh cần có một nhân vật rõ ràng')
  await expect(dialog.getByAltText('Ảnh tham chiếu')).toBeVisible()
  await expect(dialog.locator('button[type="submit"]')).toBeEnabled()
  await expect.poll(() => uploadId).not.toBe('')
  await dialog.locator('footer').getByRole('button', { name: 'Đóng', exact: true }).click()
  await page.getByTestId('entity-ai-leave-dialog').getByRole('button', { name: 'Bỏ thay đổi và rời đi', exact: true }).click()
  await expect.poll(async () => (await page.request.get(`${BASE}/api/uploads/${uploadId}`)).status()).toBe(404)
})
