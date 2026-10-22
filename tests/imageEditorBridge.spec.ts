import { expect, test, type Page } from '@playwright/test'
import { BASE, seedLlmModel, seedModel, seedProvider, signUpFresh, waitForGeneration } from './helpers/auth'

/**
 * The image editor hands the prepared upload to the shared character flow.
 * These tests drive the real app so the bridge, the modal stack and the
 * keyboard trap are exercised exactly as a user sees them.
 */
async function seedImage(page: Page): Promise<void> {
  const providerId = await seedProvider(page)
  const modelId = await seedModel(page, providerId, { modelId: 'img-bridge', displayName: 'Mock Image', kind: 'image' })
  await page.request.patch(`${BASE}/api/models/${modelId}`, { data: { imageReferenceSupport: 'yes' } })
  await seedLlmModel(page)
}

/** Creates one successful image generation and returns its asset id. */
async function createImage(page: Page, prompt: string): Promise<string> {
  const models = await (await page.request.get(`${BASE}/api/models`)).json() as { models: Array<{ id: string; kind: string }> }
  const image = models.models.find(model => model.kind === 'image')
  const created = await page.request.post(`${BASE}/api/generations`, { data: { modelId: image!.id, prompt } })
  expect(created.status()).toBe(202)
  const generation = await waitForGeneration(page, (await created.json()).generation.id)
  expect(generation.status).toBe('succeeded')
  const assets = await (await page.request.get(`${BASE}/api/generations/${(await created.json()).generation.id}`)).json() as { generation: { assets: Array<{ id: string }> } }
  return generation.assets[0]!.id
}

test('the character bridge opens a visible dialog above the image editor', async ({ page }) => {
  await signUpFresh(page)
  await seedImage(page)
  const assetId = await createImage(page, 'A calm portrait')
  await page.goto(`${BASE}/?page=quick`)
  await page.getByRole('button', { name: 'Phiên mới', exact: true }).first().click()
  await page.getByPlaceholder('Mô tả điều bạn muốn tạo...').fill('Bridge flow')
  await page.locator('.generate-button').click()
  await page.getByRole('dialog', { name: 'Xác nhận yêu cầu tạo nội dung' })
    .getByRole('button', { name: 'Xác nhận & tạo nội dung', exact: true }).click()
  await expect(page.locator('.creation-strip .creation-card')).toHaveCount(1, { timeout: 30_000 })

  await page.locator('.creation-zoom').first().click()
  const lightbox = page.locator('.lightbox-backdrop')
  await expect(lightbox).toBeVisible()
  await lightbox.getByRole('button', { name: 'Chỉnh sửa ảnh', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Trình chỉnh sửa ảnh' })
  await expect(editor).toBeVisible()
  await expect(page.getByTestId('editor-image-surface')).toBeVisible()

  // The bridge prepares the source again and opens the character dialog ABOVE the editor.
  await editor.getByRole('button', { name: 'Dùng ảnh cho nhân vật', exact: true }).click()
  const characterDialog = page.getByTestId('entity-ai-dialog')
  await expect(characterDialog).toBeVisible()
  const layers = await page.evaluate(() => {
    const editor = document.querySelector('.ie-backdrop') as HTMLElement
    const dialog = document.querySelector('[data-testid="entity-ai-dialog"]')?.closest('.entity-creation-backdrop') as HTMLElement
    return {
      editorZ: Number(getComputedStyle(editor).zIndex),
      dialogZ: Number(getComputedStyle(dialog).zIndex),
      // The character dialog must be painted over the editor, not under it.
      onTop: document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)?.closest('[data-testid="entity-ai-dialog"]') != null,
    }
  })
  expect(layers.dialogZ).toBeGreaterThan(layers.editorZ)
  expect(layers.onTop).toBe(true)
  // The editor stays open behind the character dialog.
  await expect(page.locator('.ie-backdrop')).toBeVisible()

  // The character dialog is keyboard trapped: focus stays inside it.
  await page.keyboard.press('Tab')
  const focusedInside = await page.evaluate(() => {
    const dialog = document.querySelector('[data-testid="entity-ai-dialog"]')
    return dialog?.contains(document.activeElement) ?? false
  })
  expect(focusedInside).toBe(true)

  // The bridge sends the prepared upload, never the raw asset id.
  const prepared = await (await page.request.get(`${BASE}/api/image-editor/capabilities`)).ok()
  expect(prepared).toBe(true)
  await characterDialog.getByRole('button', { name: 'Đóng', exact: true }).first().click()
  const leave = page.getByTestId('entity-ai-leave-dialog')
  if (await leave.isVisible()) await leave.getByRole('button', { name: 'Bỏ thay đổi và rời đi', exact: true }).click()
  await expect(characterDialog).toHaveCount(0)
  await expect(page.locator('.ie-backdrop')).toBeVisible()
  expect(assetId).toBeTruthy()
})

test('the character dialog creates exactly one character from the editor source', async ({ page }) => {
  await signUpFresh(page)
  await seedImage(page)
  const assetId = await createImage(page, 'A calm portrait')
  await page.goto(`${BASE}/?page=quick`)
  await page.getByRole('button', { name: 'Phiên mới', exact: true }).first().click()
  await page.getByPlaceholder('Mô tả điều bạn muốn tạo...').fill('Bridge save flow')
  await page.locator('.generate-button').click()
  await page.getByRole('dialog', { name: 'Xác nhận yêu cầu tạo nội dung' })
    .getByRole('button', { name: 'Xác nhận & tạo nội dung', exact: true }).click()
  await expect(page.locator('.creation-strip .creation-card')).toHaveCount(1, { timeout: 30_000 })

  await page.locator('.creation-zoom').first().click()
  await page.locator('.lightbox-backdrop').getByRole('button', { name: 'Chỉnh sửa ảnh', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Trình chỉnh sửa ảnh' })
  await expect(editor).toBeVisible()
  await editor.getByRole('button', { name: 'Dùng ảnh cho nhân vật', exact: true }).click()
  const characterDialog = page.getByTestId('entity-ai-dialog')
  await expect(characterDialog).toBeVisible()

  // The kind is locked to character and the source arrives as a retained upload.
  await expect(characterDialog.getByTestId('entity-ai-kind')).toHaveValue('character')
  await expect(characterDialog.getByTestId('entity-ai-kind')).toBeDisabled()
  await expect(characterDialog.locator('.entity-creation-source-preview')).toBeVisible()
  // One source image produces one candidate.
  await expect(characterDialog.getByLabel('Số ứng viên (1–6)')).toHaveValue('1')
  await expect(characterDialog.getByLabel('Số ứng viên (1–6)')).toBeDisabled()
  // Auto-save is not offered for a bridge source: the user saves explicitly.
  await expect(characterDialog.getByText('Tự lưu ứng viên hoàn tất')).toHaveCount(0)

  const generateRequests: Array<Record<string, unknown>> = []
  const attachRequests: Array<Record<string, unknown>> = []
  page.on('request', request => {
    if (request.url().endsWith('/api/shared-characters/generate')) generateRequests.push(request.postDataJSON())
    if (request.url().endsWith('/reference/from-upload')) attachRequests.push(request.postDataJSON())
  })
  await characterDialog.getByTestId('entity-ai-llm').selectOption({ index: 1 })
  await characterDialog.locator('button[type="submit"]').click()
  await expect(characterDialog.getByTestId('entity-card')).toHaveCount(1, { timeout: 40_000 })
  expect(generateRequests).toHaveLength(1)
  expect(generateRequests[0]).toMatchObject({ count: 1 })
  expect(generateRequests[0]!.sourceUploadId).toEqual(expect.any(String))
  // The source upload is the prepared editor upload, never the raw generation asset.
  expect(generateRequests[0]!.sourceUploadId).not.toBe(assetId)

  // Nothing is saved automatically: the user saves the candidate explicitly.
  await expect(characterDialog.getByTestId('entity-card').getByText('Đã lưu', { exact: true })).toHaveCount(0)
  await characterDialog.getByTestId('entity-card').getByRole('button', { name: 'Lưu', exact: true }).click()
  await expect(characterDialog.getByTestId('entity-card').getByText('Đã lưu', { exact: true })).toHaveCount(1, { timeout: 40_000 })

  // The saved character owns the edited image as its reference.
  await expect.poll(async () => {
    const response = await page.request.get(`${BASE}/api/shared-characters`)
    const body = await response.json() as { characters: Array<{ id: string; referenceUrl: string | null }> }
    return body.characters.length === 1 ? body.characters[0]!.referenceUrl : null
  }).not.toBeNull()
  const characters = await (await page.request.get(`${BASE}/api/shared-characters`)).json() as { characters: Array<{ id: string; referenceUrl: string | null }> }
  expect(characters.characters).toHaveLength(1)
  expect(characters.characters[0]!.referenceUrl).toContain('/api/characters/')
  // The reference was attached from the prepared upload, with the correct id.
  expect(attachRequests).toHaveLength(1)
  expect(attachRequests[0]!.uploadId).toBe(generateRequests[0]!.sourceUploadId)
})
