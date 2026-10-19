import { expect, test, type Page } from '@playwright/test'
import { MOCK_PNG_BYTES } from '../server/generations/adapters/mock'
import { BASE, seedLlmModel, signUpFresh } from './helpers/auth'

const suggestion = { name: 'AI brass lamp', handle: 'ai-brass-lamp', description: 'A curved brass lamp', continuityNotes: 'Keep the green shade' }
const image = { name: 'lamp.png', mimeType: 'image/png', buffer: MOCK_PNG_BYTES }
const editor = (page: Page) => page.getByTestId('entity-library-editor')

async function setup(page: Page) {
  await signUpFresh(page)
  const modelId = await seedLlmModel(page)
  await page.goto(`${BASE}/?page=entities`)
  await page.getByTestId('entity-library-create').click()
  return modelId
}

test('real mock-provider analysis fills Vietnamese suggestions and persists reference after reload', async ({ page }) => {
  const modelId = await setup(page)
  await page.getByTestId('entity-library-draft-file').setInputFiles(image)
  await page.getByTestId('entity-library-ai-model').selectOption(modelId)
  const analyzed = page.waitForResponse(response => response.url().includes('/api/entity-library/analyze-reference?') && response.request().method() === 'POST')
  await page.getByTestId('entity-library-ai').click()
  const analysis = await analyzed
  expect(analysis.ok(), await analysis.text()).toBe(true)
  const result = (await analysis.json()).suggestion
  expect(result.name).toBe('Ảnh tham chiếu')
  expect(result.handle).toBe('anh-tham-chieu')
  expect(result.description).toContain('màu sắc tự nhiên')
  expect(result.continuityNotes).toContain('Giữ nhất quán')
  await expect(editor(page).locator('[name=name]')).toHaveValue(result.name)
  await expect(editor(page).locator('[name=handle]')).toHaveValue(result.handle)
  await expect(editor(page).locator('[name=description]')).toHaveValue(result.description)
  await expect(editor(page).locator('[name=continuityNotes]')).toHaveValue(result.continuityNotes)
  await editor(page).getByRole('button', { name: 'Lưu', exact: true }).click()
  await expect(editor(page)).toHaveCount(0)
  await page.reload()
  const saved = page.getByTestId('entity-library-card').filter({ hasText: result.name })
  await expect(saved).toContainText(`@${result.handle}`)
  await expect(saved).toContainText(result.description)
  await expect(saved).toContainText(result.continuityNotes)
  await expect(saved.locator('.entity-library-reference img')).toBeVisible()
})

test('local preview, explicit AI selection, overwrite confirmation and generated handle flag', async ({ page }) => {
  const modelId = await setup(page)
  let aiCalls = 0
  let uploads = 0
  let createInput: Record<string, unknown> | undefined
  page.on('request', request => {
    if (/\/assets\/[^/]+\/reference$/.test(request.url()) && request.method() === 'POST') uploads++
    if (request.url().endsWith('/api/entity-library/assets') && request.method() === 'POST') createInput = request.postDataJSON()
  })
  await page.route('**/api/entity-library/analyze-reference?**', async route => {
    aiCalls++
    expect(new URL(route.request().url()).searchParams.get('modelId')).toBe(modelId)
    expect(route.request().headers()['content-type']).toBe('image/png')
    await route.fulfill({ json: { suggestion } })
  })
  await page.getByTestId('entity-library-draft-file').setInputFiles(image)
  await expect(editor(page).locator('.entity-library-draft-preview img')).toHaveAttribute('src', /^blob:/)
  await expect(page.getByTestId('entity-library-ai')).toBeDisabled()
  expect(aiCalls).toBe(0)
  expect(uploads).toBe(0)
  await page.getByTestId('entity-library-ai-model').selectOption(modelId)
  await page.getByTestId('entity-library-ai').click()
  await expect(editor(page).locator('[name=name]')).toHaveValue(suggestion.name)
  await expect(editor(page).locator('[name=handle]')).toHaveValue(suggestion.handle)
  await expect(editor(page).locator('[name=description]')).toHaveValue(suggestion.description)
  page.once('dialog', dialog => dialog.dismiss())
  await page.getByTestId('entity-library-ai').click()
  expect(aiCalls).toBe(1)
  await editor(page).getByRole('button', { name: 'Lưu', exact: true }).click()
  await expect(editor(page)).toHaveCount(0)
  expect(createInput?.autoHandle).toBe(true)
  expect(uploads).toBe(1)
  await page.reload()
  const saved = page.getByTestId('entity-library-card').filter({ hasText: suggestion.name })
  await expect(saved).toContainText(suggestion.description)
  await expect(saved.locator('.entity-library-reference img')).toBeVisible()
})

test('failed image save retains created identity and retries upload without metadata writes', async ({ page }) => {
  await setup(page)
  let creates = 0
  let updates = 0
  let uploads = 0
  page.on('request', request => {
    if (request.url().endsWith('/api/entity-library/assets') && request.method() === 'POST') creates++
    if (/\/assets\/[^/]+$/.test(request.url()) && request.method() === 'PATCH') updates++
  })
  await page.route('**/api/entity-library/assets/*/reference', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    uploads++
    if (uploads === 1) return route.fulfill({ status: 503, json: { error: 'Image upload temporarily unavailable' } })
    await route.continue()
  })
  await editor(page).locator('[name=name]').fill('Manual lamp')
  await page.getByTestId('entity-library-draft-file').setInputFiles(image)
  await editor(page).getByRole('button', { name: 'Lưu', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Đã lưu thông tin')
  await expect(editor(page)).toBeVisible()
  await expect(editor(page).locator('[name=name]')).toHaveValue('Manual lamp')
  await editor(page).getByRole('button', { name: 'Lưu', exact: true }).click()
  await expect(editor(page)).toHaveCount(0)
  expect({ creates, updates, uploads }).toEqual({ creates: 1, updates: 0, uploads: 2 })
})

test('existing reference AI never edits handle and replacement stays local until save', async ({ page }) => {
  const modelId = await setup(page)
  await editor(page).getByRole('button', { name: 'Huỷ', exact: true }).last().click()
  const created = await page.request.post(`${BASE}/api/entity-library/assets`, { data: { kind: 'item', name: 'Old lamp', handle: 'keep-this-handle' } })
  let asset = (await created.json()).asset
  const uploaded = await page.request.post(`${BASE}/api/entity-library/assets/${asset.id}/reference`, { headers: { 'Content-Type': 'image/png' }, data: MOCK_PNG_BYTES })
  asset = (await uploaded.json()).asset
  await page.reload()
  await page.getByRole('button', { name: 'Sửa — Old lamp', exact: true }).click()
  await page.route(`**/api/entity-library/assets/${asset.id}/analyze-reference`, async route => {
    expect(route.request().postDataJSON()).toEqual({ modelId })
    await route.fulfill({ json: { suggestion, revision: asset.revision, referenceUploadId: asset.reference.uploadId } })
  })
  await page.getByTestId('entity-library-ai-model').selectOption(modelId)
  page.once('dialog', dialog => dialog.accept())
  await page.getByTestId('entity-library-ai').click()
  await expect(editor(page).locator('[name=name]')).toHaveValue(suggestion.name)
  await expect(editor(page).locator('[name=handle]')).toHaveCount(0)
  let referenceWrites = 0
  page.on('request', request => { if (request.url().endsWith(`/${asset.id}/reference`) && request.method() !== 'GET') referenceWrites++ })
  await page.getByTestId('entity-library-draft-file').setInputFiles(image)
  expect(referenceWrites).toBe(0)
  await editor(page).getByRole('button', { name: 'Lưu', exact: true }).click()
  await expect(editor(page)).toHaveCount(0)
  const card = page.getByTestId('entity-library-card').filter({ hasText: suggestion.name })
  await expect(card).toContainText('@keep-this-handle')
  expect(referenceWrites).toBe(1)
})

test('cancel aborts in-flight AI and a new draft ignores its late result', async ({ page }) => {
  const modelId = await setup(page)
  let finish: (() => void) | undefined
  const pending = new Promise<void>(resolve => { finish = resolve })
  let markStarted: (() => void) | undefined
  const started = new Promise<void>(resolve => { markStarted = resolve })
  await page.route('**/api/entity-library/analyze-reference?**', async route => {
    markStarted!()
    await pending
    await route.fulfill({ json: { suggestion } }).catch(() => {})
  })
  await page.getByTestId('entity-library-draft-file').setInputFiles(image)
  await page.getByTestId('entity-library-ai-model').selectOption(modelId)
  await page.getByTestId('entity-library-ai').click()
  await started
  await expect(page.getByTestId('entity-library-ai')).toBeDisabled()
  await editor(page).getByRole('button', { name: 'Huỷ', exact: true }).last().click()
  await page.getByTestId('entity-library-create').click()
  await editor(page).locator('[name=name]').fill('New draft must survive')
  finish!()
  await expect(editor(page).locator('[name=name]')).toHaveValue('New draft must survive')
  await expect(editor(page).locator('[name=description]')).toHaveValue('')
})

test('AI failure retains form; edited generated handle is explicitly manual; mobile fits', async ({ page }) => {
  const modelId = await setup(page)
  await page.setViewportSize({ width: 390, height: 844 })
  let fail = true
  let createInput: Record<string, unknown> | undefined
  await page.route('**/api/entity-library/analyze-reference?**', route => fail
    ? route.fulfill({ status: 502, json: { error: 'Mock vision unavailable' } })
    : route.fulfill({ json: { suggestion } }))
  page.on('request', request => { if (request.url().endsWith('/api/entity-library/assets') && request.method() === 'POST') createInput = request.postDataJSON() })
  await page.getByTestId('entity-library-draft-file').setInputFiles(image)
  await page.getByTestId('entity-library-ai-model').selectOption(modelId)
  await page.getByTestId('entity-library-ai').click()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(editor(page)).toBeVisible()
  fail = false
  await page.getByTestId('entity-library-ai').click()
  await expect(editor(page).locator('[name=handle]')).toHaveValue(suggestion.handle)
  await editor(page).locator('[name=handle]').fill('my-manual-handle')
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
  await editor(page).getByRole('button', { name: 'Lưu', exact: true }).click()
  await expect(editor(page)).toHaveCount(0)
  expect(createInput?.autoHandle).toBe(false)
})
