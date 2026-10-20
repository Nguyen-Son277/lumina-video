import { test, expect, type Page } from '@playwright/test'
import { BASE, seedProvider, seedModel, signUpFresh } from './helpers/auth'

function opener(page: Page) {
  return page.getByRole('button', { name: 'Cấu hình video hàng loạt', exact: true })
}

function dialog(page: Page) {
  return page.getByRole('dialog', { name: 'Cấu hình video hàng loạt', exact: true }).and(page.locator('.project-scene-modal'))
}

async function openScenes(page: Page, projectName: string) {
  await page.goto(`${BASE}/?page=studio`)
  await page.getByText(projectName, { exact: true }).click()
  await page.getByRole('tab', { name: 'Cảnh video', exact: true }).click()
  await page.getByRole('button', { name: 'Tạo nhiều cảnh — nâng cao', exact: true }).click()
}

async function uploadBackground(page: Page) {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
  const response = await page.request.post(`${BASE}/api/uploads`, {
    headers: { 'Content-Type': 'image/png' },
    data: Buffer.from(png, 'base64'),
  })
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { upload: { id: string } }).upload.id
}

test('without a selection bulk settings targets only scenes missing a model and never generates', async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page, { name: 'Missing-only provider' })
  const model = await seedModel(page, provider, { modelId: 'missing-only-video', displayName: 'Missing-only video', kind: 'video' })
  const project = (await (await page.request.post(`${BASE}/api/projects`, { data: { name: 'Missing-only bulk project' } })).json()).project
  const existing = (await (await page.request.post(`${BASE}/api/projects/${project.id}/scenes`, {
    data: { title: 'Already modeled', prompt: 'Preserve current model', modelId: model },
  })).json()).scene
  const missing = (await (await page.request.post(`${BASE}/api/projects/${project.id}/scenes`, {
    data: { title: 'Needs a model', prompt: 'Assign a model' },
  })).json()).scene

  let generationRequests = 0
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/scenes\/[^/]+\/generate$/.test(request.url())) generationRequests++
  })
  await openScenes(page, 'Missing-only bulk project')
  await opener(page).click()
  const modal = dialog(page)
  await expect(modal.locator('.project-bulk-video-settings .project-hint').first()).toContainText('1 cảnh chưa có model')
  const settings = modal.locator('.project-bulk-video-settings')
  await settings.getByLabel('Nhà cung cấp video').selectOption(provider)
  await settings.getByRole('combobox', { name: 'Model video', exact: true }).selectOption(model)
  await settings.getByRole('button', { name: 'Áp dụng model và cấu hình', exact: true }).click()
  await expect(modal).toHaveCount(0)

  const saved = (await (await page.request.get(`${BASE}/api/projects/${project.id}/scenes`)).json()).scenes as Array<{ id: string; modelId: string | null }>
  expect(saved.find(scene => scene.id === existing.id)?.modelId).toBe(model)
  expect(saved.find(scene => scene.id === missing.id)?.modelId).toBe(model)
  const generations = (await (await page.request.get(`${BASE}/api/generations?projectId=${project.id}`)).json()).generations
  expect(generations).toHaveLength(0)
  expect(generationRequests).toBe(0)
})

test('successful bulk save closes after results refresh fails and leaves settings persisted', async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page, { name: 'Results-failure provider' })
  const model = await seedModel(page, provider, { modelId: 'results-failure-video', displayName: 'Results-failure video', kind: 'video' })
  const project = (await (await page.request.post(`${BASE}/api/projects`, { data: { name: 'Results-failure bulk project' } })).json()).project
  const scene = (await (await page.request.post(`${BASE}/api/projects/${project.id}/scenes`, {
    data: { title: 'Save despite refresh', prompt: 'Persist this scene' },
  })).json()).scene

  await openScenes(page, 'Results-failure bulk project')
  await opener(page).click()
  const modal = dialog(page)
  let refreshFailed!: () => void
  const failedRefresh = new Promise<void>(resolve => { refreshFailed = resolve })
  await page.route(`**/api/generations?projectId=${project.id}`, route => {
    refreshFailed()
    return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporarily unavailable' }) })
  })
  const settings = modal.locator('.project-bulk-video-settings')
  await settings.getByLabel('Nhà cung cấp video').selectOption(provider)
  await settings.getByRole('combobox', { name: 'Model video', exact: true }).selectOption(model)
  await settings.getByRole('button', { name: 'Áp dụng model và cấu hình', exact: true }).click()
  await failedRefresh
  await expect(modal).toHaveCount(0)

  const saved = (await (await page.request.get(`${BASE}/api/projects/${project.id}/scenes`)).json()).scenes as Array<{ id: string; modelId: string | null }>
  expect(saved.find(item => item.id === scene.id)?.modelId).toBe(model)
})

test('initial latest-generation request failure does not blank project scenes', async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page, { name: 'Latest unavailable provider' })
  const model = await seedModel(page, provider, { modelId: 'latest-unavailable-video', displayName: 'Latest unavailable video', kind: 'video' })
  const project = (await (await page.request.post(`${BASE}/api/projects`, { data: { name: 'Latest unavailable project' } })).json()).project
  const backgroundUploadId = await uploadBackground(page)
  const created = await page.request.post(`${BASE}/api/projects/${project.id}/scenes`, {
    data: { title: 'Scene survives latest failure', prompt: 'Keep this scene visible', modelId: model, params: { size: '1280x720', seconds: '5' }, backgroundUploadId, autoGenerate: true },
  })
  expect(created.ok()).toBe(true)

  let latestFailed!: () => void
  const failedLatest = new Promise<void>(resolve => { latestFailed = resolve })
  await page.route('**/api/generations?*latestPerScene=true', route => {
    latestFailed()
    return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporarily unavailable' }) })
  })
  await openScenes(page, 'Latest unavailable project')
  await page.keyboard.press('Escape')
  await expect(page.locator('.project-scene-modal')).toHaveCount(0)
  await failedLatest
  await expect(page.getByRole('checkbox', { name: 'Chọn cảnh Scene survives latest failure', exact: true })).toBeVisible()
  await expect(page.locator('.project-scene-card')).toHaveCount(1)
})

// Seeded mock providers/models keep these scenarios isolated from paid services.
