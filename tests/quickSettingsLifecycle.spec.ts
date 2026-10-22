import { expect, test } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh } from './helpers/auth'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64')

async function openQuick(page: import('@playwright/test').Page): Promise<void> {
  const response = await page.request.post(`${BASE}/api/quick-sessions`, { data: { title: 'Lifecycle regression' } })
  expect(response.status()).toBe(201)
  const { session } = await response.json()
  await page.goto(`${BASE}/?page=quick&session=${session.id}`)
  await expect(page.getByRole('button', { name: 'Cấu hình', exact: true })).toBeVisible()
}

test('account video preferences load before delayed models and initialize the config popup', async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page, { name: 'Higgsfield', baseUrl: 'https://api.higgsfield.ai', apiKey: 'test-hf-id:test-hf-secret' })
  const modelId = await seedModel(page, provider, { modelId: 'bytedance/seedance-2.5', displayName: 'Higgsfield video', kind: 'video' })
  const savedResponse = await page.request.put(`${BASE}/api/quick-generation-preferences/video`, {
    data: { version: 1, settings: { modelId, params: { duration: 12, resolution: '1080p', aspectRatio: '9:16', outputFormat: 'mov' } } },
  })
  expect(savedResponse.ok()).toBe(true)

  let releaseModels!: () => void
  let modelsArrived!: () => void
  const modelsGate = new Promise<void>(resolve => { releaseModels = resolve })
  const modelsStarted = new Promise<void>(resolve => { modelsArrived = resolve })
  await page.route('**/api/models**', async route => {
    const response = await route.fetch()
    modelsArrived()
    await modelsGate
    await route.fulfill({ response })
  })
  const preferencesResponse = page.waitForResponse(response => response.url().endsWith('/api/quick-generation-preferences') && response.request().method() === 'GET')
  await page.goto(`${BASE}/?page=quick`)
  await modelsStarted
  // The page's own preferences request completes while its models request is gated.
  expect((await preferencesResponse).ok()).toBe(true)
  await expect(page.locator('.quick-home-composer')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Cấu hình', exact: true })).toBeVisible()
  releaseModels()
  await page.locator('.mode-tabs:visible button').nth(1).click()
  await page.getByRole('button', { name: 'Cấu hình', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Model video', exact: true })).toHaveValue(modelId)
  await expect(page.getByRole('spinbutton', { name: 'Thời lượng' })).toHaveValue('12')
  await expect(page.getByRole('combobox', { name: 'Độ phân giải', exact: true })).toHaveValue('1080p')
  await expect(page.getByRole('combobox', { name: 'Tỷ lệ khung hình', exact: true })).toHaveValue('9:16')
  await expect(page.getByRole('combobox', { name: 'Định dạng đầu ra', exact: true })).toHaveValue('mov')
})

test('a deleted saved model remains selected but blocks generation without fallback', async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  const savedModel = await seedModel(page, provider, { modelId: 'saved-model-to-delete', kind: 'image' })
  const fallbackModel = await seedModel(page, provider, { modelId: 'available-fallback', kind: 'image' })
  const saved = await page.request.put(`${BASE}/api/quick-generation-preferences/image`, {
    data: { version: 1, settings: { modelId: savedModel, size: '1024x1024', quality: '', count: 1 } },
  })
  expect(saved.ok(), await saved.text()).toBe(true)
  expect((await page.request.delete(`${BASE}/api/models/${savedModel}`)).ok()).toBe(true)
  const preferences = await page.request.get(`${BASE}/api/quick-generation-preferences`)
  expect((await preferences.json()).preferences.image.modelId).toBe(savedModel)

  await openQuick(page)
  await expect(page.locator('.generate-button:visible')).toBeDisabled()
  await expect(page.locator('.control-section:visible').getByRole('alert')).toContainText('Model đã lưu không còn khả dụng')
  await page.getByRole('button', { name: 'Cấu hình', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Model đã lưu không còn khả dụng')
  await expect(page.getByRole('combobox', { name: 'Model ảnh', exact: true })).toHaveValue(savedModel)
  await expect(page.getByRole('combobox', { name: 'Model ảnh', exact: true })).not.toHaveValue(fallbackModel)
})

// These E2E checks use only seeded account data and mocked local upload/model routes.
// No provider generation endpoint is contacted.

test('returning from a session clears session media without leaking it into home', async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  const modelId = await seedModel(page, provider, { modelId: 'video-lifecycle-model', kind: 'video' })
  const sessionResponse = await page.request.post(`${BASE}/api/quick-sessions`, { data: { title: 'Media lifecycle' } })
  expect(sessionResponse.status()).toBe(201)
  const { session } = await sessionResponse.json()
  await page.goto(`${BASE}/?page=quick&session=${session.id}`)
  await page.locator('.mode-tabs:visible button').nth(1).click()
  await page.getByRole('button', { name: 'Cấu hình', exact: true }).click()
  await page.getByRole('combobox', { name: 'Model video', exact: true }).selectOption(modelId)
  await page.getByRole('button', { name: 'Lưu cấu hình', exact: true }).click()
  await page.route('**/api/uploads', route => route.fulfill({ status: 201, json: { upload: { id: 'mock-video-source', mimeType: 'image/png', byteSize: png.length, url: '/api/uploads/mock-video-source' } } }))
  await page.getByLabel('Ảnh đầu vào video (tuỳ chọn)').setInputFiles({ name: 'source.png', mimeType: 'image/png', buffer: png })
  await expect(page.getByRole('button', { name: 'Xóa ảnh nguồn', exact: true })).toBeVisible()
  await page.getByTestId('quick-session-back').click()
  await expect(page).not.toHaveURL(/session=/)
  await expect(page.getByTestId('quick-home')).toBeVisible()
  await expect(page.locator('.quick-home-composer')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Xóa ảnh nguồn', exact: true })).toHaveCount(0)
})