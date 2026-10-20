import { expect, test } from '@playwright/test'
import sharp from 'sharp'
import { BASE, seedLlmModel, seedModel, seedProvider, signUpFresh } from './helpers/auth'

const image = { name: 'reference.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64') }

test('manual editor keeps local preview, guards navigation and retains partial metadata ID', async ({ page }) => {
  await signUpFresh(page)
  await page.goto(BASE)
  await page.getByRole('button', { name: 'Nhân vật & tài nguyên', exact: true }).click()
  await page.getByTestId('entity-library-create').click()
  let editor = page.getByTestId('entity-editor-dialog')
  await editor.getByTestId('entity-editor-kind').selectOption('item')
  editor = page.getByTestId('entity-editor-dialog')
  await editor.getByLabel('Tên', { exact: true }).fill('Partial prop')
  let creates = 0
  let uploads = 0
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/entity-library/assets') creates++ })
  await page.route('**/api/entity-library/assets/*/reference', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    uploads++
    if (uploads === 1) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Upload interrupted' }) })
    return route.continue()
  })
  await editor.getByTestId('entity-editor-file').setInputFiles(image)
  await expect(editor.locator('img')).toHaveAttribute('src', /^blob:/)
  expect(uploads).toBe(0)
  await page.screenshot({ path: 'artifacts/creation-editor.png', fullPage: true })
  await editor.getByRole('button', { name: 'Đóng', exact: true }).last().click()
  await expect(page.getByTestId('entity-dirty-dialog')).toBeVisible()
  await page.getByTestId('entity-dirty-dialog').getByRole('button', { name: 'Ở lại', exact: true }).click()
  await editor.getByRole('button', { name: 'Lưu', exact: true }).click()
  await expect(editor.getByRole('alert')).toContainText('Đã lưu thông tin')
  expect(creates).toBe(1)
  await editor.getByRole('button', { name: 'Lưu', exact: true }).click()
  await expect(editor).toHaveCount(0)
  expect(creates).toBe(1)
  await expect(page.getByTestId('entity-library-card')).toContainText('Partial prop')
})

test('AI requires explicit model and autosaves metadata without image jobs', async ({ page }) => {
  await signUpFresh(page)
  await seedLlmModel(page)
  await page.goto(BASE)
  await page.getByRole('button', { name: 'Nhân vật & tài nguyên', exact: true }).click()
  await page.getByTestId('entity-library-ai-create').click()
  const ai = page.getByTestId('entity-ai-dialog')
  await ai.getByTestId('entity-ai-kind').selectOption('logo')
  await ai.getByLabel('Mô tả', { exact: true }).fill('A round green studio logo')
  await expect(ai.getByRole('button', { name: 'Tạo bằng AI', exact: true })).toBeDisabled()
  await ai.getByTestId('entity-ai-llm').selectOption({ index: 1 })
  await ai.getByLabel('Tự lưu ứng viên hoàn tất', { exact: true }).check()
  let imageJobs = 0
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/illustrations')) imageJobs++ })
  await ai.getByRole('button', { name: 'Tạo bằng AI', exact: true }).click()
  await expect(ai.getByTestId('entity-card')).toHaveCount(1)
  await expect(ai.getByTestId('entity-card')).toContainText('Đã lưu')
  expect(imageJobs).toBe(0)
  await page.screenshot({ path: 'artifacts/creation-ai.png', fullPage: true })
})

test('AI source forces one candidate and stop/resume retains one accepted paid job', async ({ page }) => {
  await signUpFresh(page)
  await seedLlmModel(page)
  await seedModel(page, await seedProvider(page))
  await page.goto(BASE)
  await page.getByRole('button', { name: 'Nhân vật & tài nguyên', exact: true }).click()
  await page.getByTestId('entity-library-ai-create').click()
  const ai = page.getByTestId('entity-ai-dialog')
  await ai.getByTestId('entity-ai-kind').selectOption('item')
  await ai.getByTestId('entity-ai-source').setInputFiles({ ...image, buffer: await sharp({ create: { width: 32, height: 32, channels: 4, background: '#5f7fff' } }).png().toBuffer() })
  await expect(ai.getByLabel('Số ứng viên (1–6)')).toHaveValue('1')
  await expect(ai.getByLabel('Số ứng viên (1–6)')).toBeDisabled()
  await ai.getByTestId('entity-ai-llm').selectOption({ index: 1 })
  await ai.getByLabel('Tạo thêm ảnh (phát sinh phí)', { exact: true }).check()
  await ai.getByTestId('entity-ai-image-model').selectOption({ index: 1 })
  let accepted = 0
  let release: (() => void) | undefined
  const barrier = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/entity-library/illustrations', async route => {
    accepted++
    const response = await route.fetch()
    await barrier
    await route.fulfill({ response })
  })
  await ai.getByRole('button', { name: 'Tạo bằng AI', exact: true }).click()
  await expect.poll(() => accepted).toBe(1)
  await ai.getByRole('button', { name: 'Dừng chờ', exact: true }).click()
  const card = ai.getByTestId('entity-card')
  await card.getByRole('button', { name: 'Tiếp tục tác vụ cũ', exact: true }).click()
  release!()
  await expect(card.getByRole('button', { name: 'Lưu', exact: true })).toBeEnabled({ timeout: 30000 })
  expect(accepted).toBe(1)
  await card.getByRole('button', { name: 'Lưu', exact: true }).click()
  await expect(card).toContainText('Đã lưu')
  expect(accepted).toBe(1)
})
