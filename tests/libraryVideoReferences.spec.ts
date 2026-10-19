import { test, expect, type Page } from '@playwright/test'
import { BASE, signUpFresh, seedProvider, seedModel } from './helpers/auth'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64')
async function libraryImage(page: Page, kind: 'item' | 'location', name: string) {
  const created = await page.request.post(`${BASE}/api/entity-library/assets`, { data: { kind, name } })
  expect(created.status()).toBe(201)
  const { asset } = await created.json()
  const uploaded = await page.request.post(`${BASE}/api/entity-library/assets/${asset.id}/reference`, { headers: { 'Content-Type': 'image/png' }, data: png })
  expect(uploaded.status()).toBe(201)
  return (await uploaded.json()).asset
}
async function openVideo(page: Page, modelId: string) {
  const created = await page.request.post(`${BASE}/api/quick-sessions`, { data: { title: 'Video library references' } })
  expect(created.status()).toBe(201)
  const { session } = await created.json()
  await page.goto(`${BASE}/?page=quick&session=${session.id}`)
  await page.locator('.mode-tabs button').nth(1).click()
  await page.getByRole('button', { name: 'Cấu hình', exact: true }).click()
  await page.getByRole('combobox', { name: 'Model video', exact: true }).selectOption(modelId)
  await page.getByRole('button', { name: 'Lưu cấu hình', exact: true }).click()
  await page.getByPlaceholder('Mô tả điều bạn muốn tạo...').fill('Camera moves through the reference environment')
}
async function pick(page: Page, name: string) {
  await page.getByRole('button', { name: 'Chọn từ thư viện', exact: true }).click()
  await page.locator('.quick-library-picker .entity-library-grid').getByRole('button').filter({ hasText: name }).click()
}

test('Higgsfield library references require image-mode consent and pin explicit start/end slots', async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  const model = await seedModel(page, provider, { kind: 'video', modelId: 'bytedance/seedance-2.5' })
  const start = await libraryImage(page, 'item', 'Start object')
  const end = await libraryImage(page, 'location', 'End landscape')
  await openVideo(page, model)
  page.once('dialog', dialog => { expect(dialog.message()).toContain('Chuyển sang chế độ ảnh thành video'); void dialog.dismiss() })
  await page.getByRole('button', { name: 'Cấu hình', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Tạo từ văn bản', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('dialog').locator('button[title="Hủy"]').click()
  await pick(page, 'Start object')
  await expect(page.locator('.prompt-box .project-source-item')).toHaveCount(0)
  page.once('dialog', dialog => { expect(dialog.message()).toContain('Chuyển sang chế độ ảnh thành video'); void dialog.accept() })
  await pick(page, 'Start object')
  await page.getByRole('button', { name: 'Cấu hình', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Tạo từ ảnh', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('dialog').locator('button[title="Hủy"]').click()
  await page.getByRole('combobox', { name: 'Vị trí ảnh thư viện', exact: true }).selectOption('endImage')
  await pick(page, 'End landscape')
  await expect(page.locator('.prompt-box .project-source-item')).toHaveCount(2)
  const preview = page.waitForResponse(r => r.url().endsWith('/api/generations/preview') && r.request().method() === 'POST')
  await page.locator('.generate-button').click()
  const response = await preview
  expect(response.status(), await response.text()).toBe(200)
  const input = response.request().postDataJSON()
  expect(input.params).toMatchObject({ mode: 'image', imageUploadId: start.reference.uploadId, endImageUploadId: end.reference.uploadId })
  expect(input.params).not.toHaveProperty('aspectRatio')
  expect(input.params).not.toHaveProperty('outputFormat')
  expect(input.promptDocument.mentions.map((m: { entity: { kind: string; id: string } }) => m.entity)).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'item', id: start.id }), expect.objectContaining({ kind: 'location', id: end.id }),
  ]))
  const generated = page.waitForResponse(r => r.url().endsWith('/api/generations') && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Xác nhận & tạo nội dung', exact: true }).click()
  const generationResponse = await generated
  expect(generationResponse.status()).toBe(202)
  expect(generationResponse.request().postDataJSON().params).toMatchObject(input.params)
})

test('late video upload cannot attach to a different quick session', async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  const model = await seedModel(page, provider, { kind: 'video', modelId: 'video' })
  const nextResponse = await page.request.post(`${BASE}/api/quick-sessions`, { data: { title: 'Upload destination session' } })
  const { session: nextSession } = await nextResponse.json()
  await openVideo(page, model)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let arrived!: () => void
  const started = new Promise<void>(resolve => { arrived = resolve })
  await page.route('**/api/uploads', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    const response = await route.fetch()
    arrived()
    await gate
    await route.fulfill({ response })
  })
  await page.getByLabel('Ảnh đầu vào video (tuỳ chọn)').setInputFiles({ name: 'late.png', mimeType: 'image/png', buffer: png })
  await started
  // A client-side session switch keeps the same upload continuation alive.
  await page.getByRole('combobox', { name: 'Phiên', exact: true }).selectOption(nextSession.id)
  await expect(page.getByRole('textbox', { name: 'Tên phiên', exact: true })).toHaveValue('Upload destination session')
  const uploadResponse = page.waitForResponse(response => response.url().endsWith('/api/uploads') && response.request().method() === 'POST')
  release()
  await uploadResponse
  await expect(page.getByLabel('Ảnh đầu vào video (tuỳ chọn)')).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Xóa ảnh nguồn', exact: true })).toHaveCount(0)
})

test('Agnes library consent opts into temporary media but local origin is rejected before enqueue', async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  const model = await seedModel(page, provider, { kind: 'video', modelId: 'agnes-video-2.5' })
  const item = await libraryImage(page, 'item', 'Agnes reference')
  await openVideo(page, model)
  const temporaryMediaConsent = page.locator('.entity-options__consent input')
  await expect(temporaryMediaConsent).toBeChecked()
  await temporaryMediaConsent.uncheck()
  page.once('dialog', dialog => { expect(dialog.message()).toContain('HTTPS công khai tạm'); void dialog.dismiss() })
  await pick(page, 'Agnes reference')
  await expect(page.locator('.prompt-box .project-source-item')).toHaveCount(0)
  page.once('dialog', dialog => { expect(dialog.message()).toContain('HTTPS công khai tạm'); void dialog.accept() })
  await pick(page, 'Agnes reference')
  await expect(page.locator('.prompt-box .project-source-item')).toHaveCount(1)
  let generationRequests = 0
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/generations')) generationRequests++ })
  const preview = page.waitForResponse(r => r.url().endsWith('/api/generations/preview') && r.request().method() === 'POST')
  await page.locator('.generate-button').click()
  const response = await preview
  expect(response.status()).toBe(400)
  expect(response.request().postDataJSON()).toMatchObject({ allowTemporaryMedia: true, params: { mode: 'reference' } })
  expect(response.request().postDataJSON().promptDocument.mentions[0].entity).toEqual({ kind: 'item', id: item.id })
  expect(await response.text()).toMatch(/HTTPS|nội bộ/)
  await expect(page.getByRole('button', { name: 'Xác nhận & tạo nội dung', exact: true })).toHaveCount(0)
  expect(generationRequests).toBe(0)
  const listed = await page.request.get(`${BASE}/api/generations`)
  expect((await listed.json()).generations).toHaveLength(0)
})
