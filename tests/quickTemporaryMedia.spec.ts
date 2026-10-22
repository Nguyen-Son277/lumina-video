import { expect, test } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh } from './helpers/auth'

async function openQuick(page: import('@playwright/test').Page): Promise<void> {
  const response = await page.request.post(`${BASE}/api/quick-sessions`, { data: { title: 'Media regression' } })
  expect(response.status()).toBe(201)
  const { session } = await response.json()
  await page.goto(`${BASE}/?page=quick&session=${session.id}`)
  await page.locator('.quick-option-group > summary').filter({ hasText: 'Tùy chọn bổ sung' }).click()
}

async function createRestorationGeneration(page: import('@playwright/test').Page): Promise<{ sessionId: string; generation: Record<string, unknown> }> {
  const provider = await seedProvider(page)
  const modelId = await seedModel(page, provider, { modelId: 'image-model', displayName: 'Image model', kind: 'image' })
  const sessionResponse = await page.request.post(`${BASE}/api/quick-sessions`, { data: { title: 'History restoration' } })
  expect(sessionResponse.ok()).toBe(true)
  const { session } = await sessionResponse.json()
  const created = await page.request.post(`${BASE}/api/generations`, {
    data: { modelId, prompt: 'A saved history prompt', quickSessionId: session.id },
  })
  expect(created.status()).toBe(202)
  return { sessionId: session.id, generation: (await created.json()).generation as Record<string, unknown> }
}

async function restoreHistoryWithParams(page: import('@playwright/test').Page, params: Record<string, unknown>): Promise<void> {
  const { sessionId, generation } = await createRestorationGeneration(page)
  const originalParams = (generation.params ?? {}) as Record<string, unknown>
  await page.route(/\/api\/generations\?quickSessionId=/, async route => {
    await route.fulfill({
      json: { generations: [{ ...generation, status: 'succeeded', assets: [], params: { ...originalParams, ...params } }] },
    })
  })
  await page.goto(`${BASE}/?page=quick&session=${sessionId}`)
  await page.getByRole('button', { name: 'Sửa mô tả', exact: true }).first().click()
}

test.beforeEach(async ({ page }) => {
  await signUpFresh(page)
})

test('quick consent defaults on and hides only temporary-media help accessibly', async ({ page }) => {
  await openQuick(page)

  const consent = page.locator('.entity-options__consent input[type="checkbox"]')
  await expect(consent).toBeChecked()
  await expect(page.locator('.entity-options__fieldset').last().locator('.entity-options__help')).toHaveCount(0)
  const describedBy = await consent.getAttribute('aria-describedby')
  expect(describedBy).toBeNull()
  if (describedBy) {
    for (const id of describedBy.split(/\s+/)) {
      await expect(page.locator(`#${id}`)).toHaveCount(1)
    }
  }
})

test('quick generation explicitly sends temporary-media opt-out', async ({ page }) => {
  const provider = await seedProvider(page)
  await seedModel(page, provider, { modelId: 'image-model', displayName: 'Image model', kind: 'image' })
  await openQuick(page)

  const consent = page.locator('.entity-options__consent input[type="checkbox"]')
  await consent.uncheck()
  await page.locator('#prompt').fill('A local test prompt')

  let generationPayload: Record<string, unknown> | undefined
  await page.route('**/api/generations', async route => {
    generationPayload = route.request().postDataJSON()
    await route.fulfill({ status: 202, json: { generation: { id: 'test-generation', status: 'queued' } } })
  })
  await page.locator('.generate-button:visible').click()

  await expect.poll(() => generationPayload).toBeDefined()
  expect(generationPayload).toHaveProperty('allowTemporaryMedia', false)
})

test('history restores explicit temporary-media opt-out when editing description', async ({ page }) => {
  await restoreHistoryWithParams(page, { allowTemporaryMedia: false })
  await expect(page.locator('.entity-options__consent input[type="checkbox"]')).not.toBeChecked()
})

test('history defaults temporary-media consent on when the saved parameter is missing', async ({ page }) => {
  await restoreHistoryWithParams(page, {})
  await expect(page.locator('.entity-options__consent input[type="checkbox"]')).toBeChecked()
})

test('default-enabled quick generation requests preview without accepting generation', async ({ page }) => {
  const provider = await seedProvider(page)
  await seedModel(page, provider, { modelId: 'image-model', displayName: 'Image model', kind: 'image' })
  await openQuick(page)
  await page.locator('#prompt').fill('Preview only test prompt')

  let previewPayload: Record<string, unknown> | undefined
  await page.route('**/api/generations/preview', async route => {
    previewPayload = route.request().postDataJSON()
    await route.fulfill({ json: { preview: { entities: [] } } })
  })
  await page.locator('.generate-button:visible').click()

  await expect.poll(() => previewPayload).toBeDefined()
  expect(previewPayload).toHaveProperty('allowTemporaryMedia', true)
  // No confirmation click: this only exercises the preview path, never paid generation.
})

test('quick consent stays off across composer changes and resets for a new session', async ({ page }) => {
  const provider = await seedProvider(page)
  const imageModel = await seedModel(page, provider, { modelId: 'image-model', displayName: 'Image model', kind: 'image' })
  const secondImageModel = await seedModel(page, provider, { modelId: 'image-model-2', displayName: 'Second image model', kind: 'image' })
  const videoModel = await seedModel(page, provider, { modelId: 'video-model', displayName: 'Video model', kind: 'video' })
  await openQuick(page)

  const consent = page.locator('.entity-options__consent input[type="checkbox"]')
  await expect(consent).toBeChecked()
  await consent.uncheck()
  await expect(consent).not.toBeChecked()

  await page.locator('#prompt').fill('Prompt with consent disabled')
  await expect(consent).not.toBeChecked()

  await page.locator('.mode-tabs:visible button').nth(1).click()
  await expect(consent).not.toBeChecked()
  await page.getByRole('button', { name: 'Cấu hình', exact: true }).click()
  await page.getByRole('combobox', { name: 'Model video', exact: true }).selectOption(videoModel)
  await page.getByRole('button', { name: 'Lưu cấu hình', exact: true }).click()
  await expect(consent).not.toBeChecked()
  await page.locator('.mode-tabs:visible button').first().click()
  await page.getByRole('button', { name: 'Cấu hình', exact: true }).click()
  await page.getByRole('combobox', { name: 'Model ảnh', exact: true }).selectOption(secondImageModel)
  await page.getByRole('button', { name: 'Lưu cấu hình', exact: true }).click()
  await expect(consent).not.toBeChecked()

  await openQuick(page)
  await expect(consent).toBeChecked()
})