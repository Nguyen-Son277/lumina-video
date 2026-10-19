import { expect, test, type Page } from '@playwright/test'
import { MOCK_PNG_BYTES } from '../server/generations/adapters/mock'
import type { PromptDocument } from '../shared/promptMentions'
import type { EntityLibraryEntity } from '../src/api/entityLibrary'
import type { Generation } from '../src/api/types'
import { BASE, seedModel, seedProvider, signUpFresh, waitForGeneration } from './helpers/auth'

/** Uses the isolated mock provider configured by Playwright; never calls a live provider. */
async function createAsset(page: Page, kind: 'item' | 'logo', name: string, handle: string): Promise<EntityLibraryEntity> {
  const response = await page.request.post(`${BASE}/api/entity-library/assets`, {
    data: { kind, name, handle, description: `${name}, màu xanh`, continuityNotes: 'Giữ nguyên nhận diện' },
  })
  expect(response.status(), await response.text()).toBe(201)
  return (await response.json()).asset as EntityLibraryEntity
}

async function uploadLogo(page: Page, id: string): Promise<void> {
  const response = await page.request.post(`${BASE}/api/entity-library/assets/${id}/reference`, {
    headers: { 'Content-Type': 'image/png' }, data: MOCK_PNG_BYTES,
  })
  expect(response.status(), await response.text()).toBe(201)
  expect((await response.json()).asset.reference.uploadId).toBeTruthy()
}

async function listGenerations(page: Page, sessionId: string): Promise<Generation[]> {
  const response = await page.request.get(`${BASE}/api/generations?quickSessionId=${sessionId}`)
  expect(response.ok()).toBe(true)
  return (await response.json()).generations as Generation[]
}

async function draftDocument(page: Page, sessionId: string): Promise<PromptDocument | null> {
  const response = await page.request.get(`${BASE}/api/quick-sessions/${sessionId}`)
  expect(response.ok()).toBe(true)
  return (await response.json()).session.promptDocument as PromptDocument | null
}

async function addMention(page: Page, handle: string, separator = ''): Promise<void> {
  const prompt = page.locator('#prompt')
  await prompt.focus()
  await prompt.press('End')
  await prompt.pressSequentially(`${separator}@${handle}`)
  const suggestions = page.getByRole('listbox', { name: 'Gợi ý đối tượng' })
  await expect(suggestions).toBeVisible()
  await suggestions.getByRole('option').filter({ hasText: `@${handle}` }).click()
  await expect(page.locator('.entity-mention-chips')).toContainText(`@${handle}`)
}

async function confirmGeneration(page: Page, sessionId: string, expectedIds: string[]): Promise<Generation> {
  const before = await listGenerations(page, sessionId)
  const previewResponse = page.waitForResponse(response => response.url().endsWith('/api/generations/preview') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Tạo hình ảnh', exact: true }).click()
  const response = await previewResponse
  expect(response.ok(), await response.text()).toBe(true)
  const preview = (await response.json()).preview
  expect(preview.entities.map((entity: { id: string }) => entity.id).sort()).toEqual([...expectedIds].sort())
  const dialog = page.getByRole('dialog', { name: 'Xác nhận yêu cầu tạo nội dung' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Xác nhận có thể phát sinh phí provider')
  for (const id of expectedIds) await expect(dialog).toContainText(id)
  // Preview and opening the native modal must not enqueue a paid generation.
  expect((await listGenerations(page, sessionId)).map(generation => generation.id)).toEqual(before.map(generation => generation.id))
  const createdResponse = page.waitForResponse(result => result.url().endsWith('/api/generations') && result.request().method() === 'POST')
  await dialog.getByRole('button', { name: 'Xác nhận & tạo nội dung', exact: true }).click()
  const created = await createdResponse
  expect(created.status(), await created.text()).toBe(202)
  const id = (await created.json()).generation.id as string
  expect((await waitForGeneration(page, id)).status).toBe('succeeded')
  const persisted = await page.request.get(`${BASE}/api/generations/${id}`)
  expect(persisted.ok()).toBe(true)
  const generation = (await persisted.json()).generation as Generation
  expect(generation.promptDocument?.mentions.map(binding => binding.entity.id).sort()).toEqual([...expectedIds].sort())
  await expect(page.locator('.quick-results-list .creation-card img').first()).toBeVisible()
  return generation
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
}

test.beforeEach(async ({ page }) => { await signUpFresh(page) })

test('mention @ lưu ID qua preview, đổi handle, sửa và reload; xoá/tạo lại không nối token cũ', async ({ page }) => {
  test.setTimeout(90_000)
  const provider = await seedProvider(page)
  const modelId = await seedModel(page, provider, { modelId: 'entity-image', displayName: 'Ảnh thử nghiệm', kind: 'image' })
  const item = await createAsset(page, 'item', 'Đèn xanh', 'den-xanh')
  const logo = await createAsset(page, 'logo', 'Logo Lumina', 'lumina-logo')
  await uploadLogo(page, logo.id)
  const conflict = await page.request.post(`${BASE}/api/entity-library/assets`, { data: { kind: 'logo', name: 'Trùng tên @', handle: item.handle } })
  expect(conflict.status()).toBe(409)
  const sessionResponse = await page.request.post(`${BASE}/api/quick-sessions`, { data: { title: 'Nhận diện theo ID' } })
  expect(sessionResponse.status()).toBe(201)
  const sessionId = (await sessionResponse.json()).session.id as string

  await page.goto(`${BASE}/?page=quick&session=${sessionId}`)
  await expect(page.locator('#prompt')).toBeEnabled()
  // Explicitly select the mock model rather than relying on first-model defaults.
  await page.locator('.controls-grid select').nth(1).selectOption(modelId)
  await page.locator('#prompt').fill('Ảnh sản phẩm ')
  await addMention(page, item.handle)
  await addMention(page, logo.handle, ' và ')
  await page.locator('#prompt').blur()
  // Wait for the actual server draft, not a timer/sleep, before reload or running.
  await expect.poll(async () => (await draftDocument(page, sessionId))?.mentions.map(binding => binding.entity.id)).toEqual([item.id, logo.id])
  const first = await confirmGeneration(page, sessionId, [item.id, logo.id])
  expect(first.sourceImageCount).toBe(1) // Uploaded logo is the only AI reference image.
  const original = first.promptDocument!
  expect(original.mentions.map(binding => binding.label)).toEqual([item.handle, logo.handle])

  const renamed = await page.request.patch(`${BASE}/api/entity-library/item/${item.id}/handle`, { data: { handle: 'den-doi-ten' } })
  expect(renamed.status()).toBe(200)
  await page.getByRole('button', { name: 'Sửa mô tả', exact: true }).first().click()
  await expect(page.locator('.quick-edit-banner')).toBeVisible()
  await expect(page.locator('#prompt')).toHaveValue(original.text)
  await page.locator('#prompt').focus()
  await page.locator('#prompt').press('End')
  await page.locator('#prompt').pressSequentially(', trên bàn gỗ')
  await page.locator('#prompt').blur()
  const editedText = `${original.text}, trên bàn gỗ`
  await expect.poll(async () => (await draftDocument(page, sessionId))?.text).toBe(editedText)
  const saved = (await draftDocument(page, sessionId))!
  expect(saved.mentions).toEqual(original.mentions)
  await page.reload()
  await expect(page.locator('#prompt')).toHaveValue(editedText)
  await page.locator('#prompt').focus() // Refresh existence/metadata catalog after rename.
  await expect(page.locator('.entity-mention-chip.is-unresolved')).toHaveCount(0)
  const second = await confirmGeneration(page, sessionId, [item.id, logo.id])
  expect(second.promptDocument?.mentions).toEqual(original.mentions)
  expect(second.promptDocument?.text).toBe(editedText)
  const firstAfterRename = await page.request.get(`${BASE}/api/generations/${first.id}`)
  expect((await firstAfterRename.json()).generation.promptDocument).toEqual(original)

  expect((await page.request.delete(`${BASE}/api/entity-library/assets/${item.id}`)).status()).toBe(204)
  // Reusing even the exact token label creates a NEW identity, never a repair of old bindings.
  const replacement = await createAsset(page, 'item', item.name, item.handle)
  expect(replacement.id).not.toBe(item.id)
  const beforeRejected = (await listGenerations(page, sessionId)).map(generation => generation.id)
  await page.reload()
  await expect(page.locator('#prompt')).toHaveValue(editedText)
  await page.locator('#prompt').focus()
  await expect(page.locator('.entity-mention-chip.is-unresolved')).toContainText(`@${item.handle}`)
  const rejectedPreview = page.waitForResponse(response => response.url().endsWith('/api/generations/preview') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Tạo hình ảnh', exact: true }).click()
  expect((await rejectedPreview).status()).toBe(404)
  await expect(page.locator('.composer-card [role="alert"]')).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Xác nhận yêu cầu tạo nội dung' })).toHaveCount(0)
  expect((await draftDocument(page, sessionId))?.mentions).toEqual(original.mentions)
  expect((await listGenerations(page, sessionId)).map(generation => generation.id)).toEqual(beforeRejected)
  // Also exercise the central enqueue guard directly, independent of the preview UI.
  const rejectedCreate = await page.request.post(`${BASE}/api/generations`, {
    data: { modelId, prompt: saved.text, promptDocument: saved, quickSessionId: sessionId },
  })
  expect(rejectedCreate.status()).toBe(404)
  expect((await listGenerations(page, sessionId)).map(generation => generation.id)).toEqual(beforeRejected)
})

test('thư viện đồ vật/logo có form tiếng Việt, tìm @handle và gợi ý bàn phím trên mobile không tràn', async ({ page }) => {
  const provider = await seedProvider(page)
  await seedModel(page, provider, { modelId: 'mobile-entity-image', kind: 'image' })
  const item = await createAsset(page, 'item', 'Tách trà', 'tach-tra')
  await page.goto(BASE)
  await page.getByRole('button', { name: 'Đồ vật, cảnh vật & logo', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Thư viện đồ vật, bối cảnh & logo', exact: true })).toBeVisible()
  await expect(page.getByTestId('entity-library-card').filter({ hasText: item.name })).toContainText(`@${item.handle}`)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByTestId('entity-library-create').click()
  const editor = page.getByTestId('entity-library-editor')
  await expect(editor.getByRole('heading', { name: 'Thêm đồ vật, bối cảnh hoặc logo', exact: true })).toBeVisible()
  await editor.getByLabel('Tên hiển thị', { exact: true }).fill('Logo Việt')
  await editor.getByRole('combobox', { name: 'Loại', exact: true }).selectOption('logo')
  await editor.getByLabel(/^Tên @ duy nhất/).fill('vi-logo')
  await editor.getByLabel('Ngoại hình / mô tả', { exact: true }).fill('Biểu tượng xanh Việt Nam')
  await editor.getByLabel('Chi tiết cần giữ nguyên', { exact: true }).fill('Giữ màu và tỷ lệ')
  await expectNoHorizontalOverflow(page)
  await editor.getByRole('button', { name: 'Lưu', exact: true }).click()
  await expect(editor).toHaveCount(0)
  const cards = page.getByTestId('entity-library-card')
  await expect(cards).toHaveCount(2)
  const logoCard = cards.filter({ hasText: 'Logo Việt' })
  await expect(logoCard).toContainText('@vi-logo')
  await logoCard.getByLabel('Tải ảnh tham chiếu — Logo Việt', { exact: true }).setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: MOCK_PNG_BYTES })
  await expect(logoCard.getByRole('img', { name: 'Logo Việt', exact: true })).toBeVisible()
  await page.getByRole('searchbox', { name: 'Tìm đối tượng', exact: true }).fill('@vi-logo')
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText('Logo Việt')
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await expectNoHorizontalOverflow(page)
  }

  const sessionResponse = await page.request.post(`${BASE}/api/quick-sessions`, { data: { title: 'Mobile mention' } })
  expect(sessionResponse.status()).toBe(201)
  const sessionId = (await sessionResponse.json()).session.id as string
  await page.goto(`${BASE}/?page=quick&session=${sessionId}`)
  const prompt = page.locator('#prompt')
  await prompt.fill('@')
  const suggestions = page.getByRole('listbox', { name: 'Gợi ý đối tượng' })
  await expect(suggestions.getByRole('option')).toHaveCount(2)
  await expectNoHorizontalOverflow(page)
  await prompt.pressSequentially('vi-logo')
  await expect(suggestions.getByRole('option')).toHaveCount(1)
  // Enter binds the active option by ID; a raw typed handle alone is not bound.
  await prompt.press('Enter')
  await expect(page.locator('.entity-mention-chips')).toContainText('@vi-logo')
  await prompt.blur()
  await expect.poll(async () => (await draftDocument(page, sessionId))?.mentions.length).toBe(1)
  const draft = (await draftDocument(page, sessionId))!
  const catalog = await page.request.get(`${BASE}/api/entity-library`)
  const logo = (await catalog.json()).entities.find((entity: EntityLibraryEntity) => entity.handle === 'vi-logo') as EntityLibraryEntity
  expect(draft.mentions[0]?.entity).toEqual({ kind: 'logo', id: logo.id })
  await page.reload()
  await expect(prompt).toHaveValue('@vi-logo')
  await expect(page.locator('.entity-mention-chips')).toContainText('@vi-logo')
  await expectNoHorizontalOverflow(page)
})
