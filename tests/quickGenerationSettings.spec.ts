import { expect, test } from '@playwright/test'
import { BASE, seedModel, seedProvider, signInViaApi, signUpFresh } from './helpers/auth'

async function openQuick(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`${BASE}/?page=quick`)
  await page.getByRole('button', { name: 'Phiên mới', exact: true }).first().click()
  await expect(page.getByRole('button', { name: 'Cấu hình', exact: true })).toBeVisible()
}

async function saveConfiguration(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'Lưu cấu hình', exact: true }).click()
}

async function cancelConfiguration(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('.project-actions button').first().click()
}

async function openSettings(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'Cấu hình', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Cấu hình', exact: true })).toBeVisible()
}

test('saved quick settings persist after reload and can be reopened in a fresh page', async ({ page, context }) => {
  const account = await signUpFresh(page)
  const provider = await seedProvider(page)
  const imageModel = await seedModel(page, provider, { modelId: 'image-settings', displayName: 'Image settings', kind: 'image' })

  await openQuick(page)
  await openSettings(page)
  const saveRequest = page.waitForRequest(request => /\/api\/quick-generation-preferences\/image$/.test(request.url()) && request.method() === 'PUT')
  await page.getByRole('combobox', { name: 'Model ảnh', exact: true }).selectOption(imageModel)
  await page.getByRole('combobox', { name: 'Tỷ lệ khung hình ảnh', exact: true }).selectOption('16:9')
  await page.getByRole('combobox', { name: 'Độ phân giải ảnh', exact: true }).selectOption('2K')
  await page.getByRole('combobox', { name: 'Chất lượng', exact: true }).selectOption('high')
  await page.getByRole('button', { name: 'Lưu cấu hình', exact: true }).click()
  const payload = (await saveRequest).postDataJSON() as { settings: Record<string, unknown> }
  expect(payload.settings).toMatchObject({ modelId: imageModel, size: '2048x1152', quality: 'high' })
  await expect(page.getByRole('heading', { name: 'Cấu hình', exact: true })).toHaveCount(0)

  await page.reload()
  await page.getByRole('button', { name: 'Phiên mới', exact: true }).first().click()
  await openSettings(page)
  await expect(page.getByRole('combobox', { name: 'Model ảnh', exact: true })).toHaveValue(imageModel)
  await expect(page.getByRole('combobox', { name: 'Tỷ lệ khung hình ảnh', exact: true })).toHaveValue('16:9')
  await expect(page.getByRole('combobox', { name: 'Độ phân giải ảnh', exact: true })).toHaveValue('2K')
  await expect(page.getByRole('combobox', { name: 'Chất lượng', exact: true })).toHaveValue('high')

  const freshPage = await context.newPage()
  await openQuick(freshPage)
  await openSettings(freshPage)
  await expect(freshPage.getByRole('combobox', { name: 'Model ảnh', exact: true })).toHaveValue(imageModel)
  await freshPage.close()

  const independentContext = await context.browser()!.newContext()
  await independentContext.addInitScript(() => localStorage.setItem('lumina.locale', 'vi'))
  const independentPage = await independentContext.newPage()
  await signInViaApi(independentPage, account.email, account.password)
  await openQuick(independentPage)
  await openSettings(independentPage)
  await expect(independentPage.getByRole('combobox', { name: 'Model ảnh', exact: true })).toHaveValue(imageModel)
  await independentContext.close()
})

test('cancel discards settings draft without persisting or applying it', async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  const imageModel = await seedModel(page, provider, { modelId: 'image-cancel-original', kind: 'image' })
  const draftModel = await seedModel(page, provider, { modelId: 'image-cancel-draft', kind: 'image' })
  await openQuick(page)
  await openSettings(page)
  const putRequests: string[] = []
  page.on('request', request => { if (request.method() === 'PUT' && request.url().includes('/quick-generation-preferences/')) putRequests.push(request.url()) })
  await page.getByRole('combobox', { name: 'Model ảnh', exact: true }).selectOption(draftModel)
  await cancelConfiguration(page)
  await expect(page.getByRole('heading', { name: 'Cấu hình', exact: true })).toHaveCount(0)
  expect(putRequests).toHaveLength(0)
  await openSettings(page)
  await expect(page.getByRole('combobox', { name: 'Model ảnh', exact: true })).toHaveValue(imageModel)
})

test('saved image and video preferences persist independently', async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  const imageModel = await seedModel(page, provider, { modelId: 'image-independent', kind: 'image' })
  const videoModel = await seedModel(page, provider, { modelId: 'video-independent', kind: 'video' })
  await openQuick(page)
  await openSettings(page)
  await page.getByRole('combobox', { name: 'Model ảnh', exact: true }).selectOption(imageModel)
  await page.getByRole('button', { name: 'Lưu cấu hình', exact: true }).click()

  await page.locator('.mode-tabs button').nth(1).click()
  await openSettings(page)
  await page.getByRole('combobox', { name: 'Model video', exact: true }).selectOption(videoModel)
  await page.getByRole('button', { name: 'Lưu cấu hình', exact: true }).click()

  await page.locator('.mode-tabs button').first().click()
  await openSettings(page)
  await expect(page.getByRole('combobox', { name: 'Model ảnh', exact: true })).toHaveValue(imageModel)
  await cancelConfiguration(page)
  await page.locator('.mode-tabs button').nth(1).click()
  await openSettings(page)
  await expect(page.getByRole('combobox', { name: 'Model video', exact: true })).toHaveValue(videoModel)
})

test('saved Higgsfield nondefault parameters persist without media settings regressing', async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page, { name: 'Higgsfield', baseUrl: 'https://api.higgsfield.ai', apiKey: 'test-hf-id:test-hf-secret' })
  const videoModel = await seedModel(page, provider, { modelId: 'bytedance/seedance-2.5', displayName: 'Higgsfield video', kind: 'video' })
  await openQuick(page)
  await page.locator('.mode-tabs button').nth(1).click()
  await openSettings(page)
  await page.getByRole('combobox', { name: 'Model video', exact: true }).selectOption(videoModel)
  await page.getByRole('spinbutton', { name: 'Thời lượng' }).fill('12')
  await page.getByRole('combobox', { name: 'Độ phân giải', exact: true }).selectOption('1080p')
  await page.getByRole('combobox', { name: 'Tỷ lệ khung hình', exact: true }).selectOption('9:16')
  await page.getByRole('combobox', { name: 'Định dạng đầu ra', exact: true }).selectOption('mov')
  await saveConfiguration(page)
  await page.reload()
  await page.getByRole('button', { name: 'Phiên mới', exact: true }).first().click()
  await page.locator('.mode-tabs button').nth(1).click()
  await openSettings(page)
  await expect(page.getByRole('combobox', { name: 'Model video', exact: true })).toHaveValue(videoModel)
  await expect(page.getByRole('spinbutton', { name: 'Thời lượng' })).toHaveValue('12')
  await expect(page.getByRole('combobox', { name: 'Độ phân giải', exact: true })).toHaveValue('1080p')
  await expect(page.getByRole('combobox', { name: 'Tỷ lệ khung hình', exact: true })).toHaveValue('9:16')
  await expect(page.getByRole('combobox', { name: 'Định dạng đầu ra', exact: true })).toHaveValue('mov')
})

test('unavailable saved model blocks generation rather than selecting a replacement', async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  const savedModel = await seedModel(page, provider, { modelId: 'image-unavailable', kind: 'image' })
  await openQuick(page)
  await openSettings(page)
  await page.getByRole('combobox', { name: 'Model ảnh', exact: true }).selectOption(savedModel)
  await page.getByRole('button', { name: 'Lưu cấu hình', exact: true }).click()
  expect((await page.request.patch(`${BASE}/api/models/${savedModel}`, { data: { enabled: false } })).ok()).toBe(true)

  await page.reload()
  await page.getByRole('button', { name: 'Phiên mới', exact: true }).first().click()
  await expect(page.getByRole('button', { name: 'Cấu hình', exact: true })).toBeVisible()
  await expect(page.locator('.generate-button')).toBeDisabled()
  await openSettings(page)
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Model đã lưu không còn khả dụng')
  await expect(page.getByRole('combobox', { name: 'Model ảnh', exact: true })).toHaveValue(savedModel)
})

test('failed save keeps modal draft available for retry', async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  const imageModel = await seedModel(page, provider, { modelId: 'image-save-failure', kind: 'image' })
  await openQuick(page)
  await openSettings(page)
  await page.getByRole('combobox', { name: 'Model ảnh', exact: true }).selectOption(imageModel)
  await page.route('**/api/quick-generation-preferences/image', route => route.fulfill({ status: 500, body: '{}' }))
  await page.getByRole('button', { name: 'Lưu cấu hình', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Không thể lưu cấu hình')
  await expect(page.getByRole('combobox', { name: 'Model ảnh', exact: true })).toHaveValue(imageModel)
})

// Saving defaults is an explicit action; editing an existing generation must not write defaults.
test('opening historical image editor does not autosave quick defaults', async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  const modelId = await seedModel(page, provider, { modelId: 'image-history-settings', kind: 'image' })
  const { session } = await (await page.request.post(`${BASE}/api/quick-sessions`, { data: { title: 'History settings' } })).json()
  const created = await page.request.post(`${BASE}/api/generations`, { data: { modelId, prompt: 'Historical image', quickSessionId: session.id, params: { size: '1536x1024', quality: 'medium' } } })
  expect(created.status()).toBe(202)
  await page.goto(`${BASE}/?page=quick&session=${session.id}`)
  const writes: string[] = []
  page.on('request', request => { if (request.method() === 'PUT' && request.url().includes('/quick-generation-preferences/')) writes.push(request.url()) })
  await page.getByRole('button', { name: 'Sửa mô tả' }).first().click()
  await openSettings(page)
  await expect(page.getByRole('combobox', { name: 'Độ phân giải ảnh' })).toHaveValue('1536x1024')
  expect(writes).toHaveLength(0)
})
