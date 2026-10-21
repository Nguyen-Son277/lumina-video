import { expect, test, type Locator, type Page } from '@playwright/test'
import sharp from 'sharp'
import { entityLibraryPreferencesDefaults } from '../shared/entityLibraryPreferences'
import { imageSizeFor } from '../shared/imageControls'
import type { CharacterVoice } from '../src/api/projectTypes'
import { BASE, seedLlmModel, seedModel, seedProvider, signUpFresh } from './helpers/auth'

const preferencesPath = '/api/entity-library/preferences'
const voice: CharacterVoice = {
  language: 'vi', accent: 'Miền Nam', pitch: 'Trung trầm', timbre: 'Ấm riêng',
  pace: 'Chậm rãi', articulation: 'Rõ ràng', habits: 'Ngắt nhịp nhẹ',
}
const suggestion = { name: 'Tên do thị giác đề xuất', appearance: 'Áo xanh, tóc ngắn và kính tròn.' }

async function referenceImage() {
  return { name: 'private-reference.png', mimeType: 'image/png', buffer: await sharp({
    create: { width: 32, height: 32, channels: 4, background: '#5f7fff' },
  }).png().toBuffer() }
}
async function openLibrary(page: Page) {
  await page.goto(`${BASE}/?page=entities`)
  await expect(page.getByTestId('entity-library-page')).toBeVisible()
}
async function openAi(page: Page) {
  await page.getByTestId('entity-library-ai-create').click()
  const ai = page.getByTestId('entity-ai-dialog')
  await expect(ai.getByTestId('entity-ai-kind')).toBeEnabled()
  return ai
}
async function closeAi(page: Page, dirty = false) {
  await page.getByTestId('entity-ai-dialog').getByRole('button', { name: 'Đóng', exact: true }).last().click()
  if (dirty) await page.getByTestId('entity-ai-leave-dialog').getByRole('button', { name: 'Bỏ thay đổi và rời đi', exact: true }).click()
  await expect(page.getByTestId('entity-ai-dialog')).toHaveCount(0)
}
async function savedSettings(page: Page) {
  const response = await page.request.get(`${BASE}${preferencesPath}`)
  expect(response.ok()).toBeTruthy()
  return (await response.json()).settings
}
async function expectVoice(editor: Locator, expected = voice) {
  for (const [key, value] of Object.entries(expected)) await expect(editor.locator(`[name="voice.${key}"]`)).toHaveValue(value)
}
async function mockCandidates(page: Page) {
  await page.route('**/api/entity-library/generate', route => route.fulfill({ json: {
    candidates: [{ name: 'Ứng viên được giữ', handle: 'retained-candidate', description: 'Mô tả ứng viên gốc', continuityNotes: 'Không đổi loại ứng viên' }],
    modelId: 'mock', model: 'mock',
  } }))
  await page.route('**/api/shared-characters/generate', route => route.fulfill({ json: {
    candidates: [{ name: 'Ứng viên nhân vật', appearance: 'Ngoại hình ứng viên', voice }], modelId: 'mock', model: 'mock',
  } }))
}

test('AI selections persist without generating, on reopen and full page reload', async ({ page }) => {
  await signUpFresh(page)
  const llmId = await seedLlmModel(page)
  const imageId = await seedModel(page, await seedProvider(page))
  const paidRequests: string[] = []
  page.on('request', request => {
    if (request.method() === 'POST' && /\/(generate|illustrations)$/.test(new URL(request.url()).pathname)) paidRequests.push(request.url())
  })
  await openLibrary(page)
  let ai = await openAi(page)
  await expect(ai.getByTestId('entity-image-ratio')).toHaveCount(0)
  await ai.getByTestId('entity-ai-kind').selectOption('location')
  await ai.getByLabel('Số ứng viên (1–6)', { exact: true }).fill('4')
  await ai.getByTestId('entity-ai-llm').selectOption(llmId)
  await ai.getByLabel('Tạo thêm ảnh (phát sinh phí)', { exact: true }).check()
  await expect(ai.getByTestId('entity-image-ratio')).toBeVisible()
  await ai.getByTestId('entity-ai-image-model').selectOption(imageId)
  await ai.getByTestId('entity-image-ratio').selectOption('16:9')
  await ai.getByTestId('entity-image-resolution').selectOption('2K')
  await ai.getByTestId('entity-image-quality').selectOption('high')
  await ai.getByLabel('Tự lưu ứng viên hoàn tất', { exact: true }).check()
  const expected = { ...entityLibraryPreferencesDefaults, kind: 'location', count: 4,
    modelId: llmId, imageModelId: imageId, includeImages: true, autoSave: true,
    size: imageSizeFor('16:9', '2K'), quality: 'high' }
  await expect.poll(() => savedSettings(page)).toEqual(expected)
  // Merely changing settings is not a dirty generation draft and does not call AI.
  await closeAi(page)
  ai = await openAi(page)
  await expect(ai.getByTestId('entity-ai-kind')).toHaveValue('location')
  await expect(ai.getByTestId('entity-ai-llm')).toHaveValue(llmId)
  await closeAi(page)
  await page.reload()
  ai = await openAi(page)
  await expect(ai.getByTestId('entity-ai-kind')).toHaveValue('location')
  await expect(ai.getByLabel('Số ứng viên (1–6)', { exact: true })).toHaveValue('4')
  await expect(ai.getByTestId('entity-ai-llm')).toHaveValue(llmId)
  await expect(ai.getByTestId('entity-ai-image-model')).toHaveValue(imageId)
  await expect(ai.getByLabel('Tạo thêm ảnh (phát sinh phí)', { exact: true })).toBeChecked()
  await expect(ai.getByLabel('Tự lưu ứng viên hoàn tất', { exact: true })).toBeChecked()
  await expect(ai.getByTestId('entity-image-ratio')).toHaveValue('16:9')
  await expect(ai.getByTestId('entity-image-resolution')).toHaveValue('2K')
  await expect(ai.getByTestId('entity-image-quality')).toHaveValue('high')
  await page.screenshot({ path: 'artifacts/entity-creation-update/ai-settings-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(ai.getByTestId('entity-image-quality')).toBeVisible()
  await page.screenshot({ path: 'artifacts/entity-creation-update/ai-settings-mobile.png', fullPage: true })
  expect(paidRequests).toEqual([])
})

test('description and local source are discarded, not persisted as preferences or uploaded on selection', async ({ page }) => {
  await signUpFresh(page)
  const llmId = await seedLlmModel(page)
  await openLibrary(page)
  let ai = await openAi(page)
  const patches: Array<{ version: number; settings: Record<string, unknown> }> = []
  let uploads = 0
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (request.method() === 'PATCH' && path === preferencesPath) patches.push(request.postDataJSON())
    if (request.method() === 'POST' && path === '/api/uploads') uploads++
  })
  await ai.getByTestId('entity-ai-llm').selectOption(llmId)
  await ai.getByLabel('Số ứng viên (1–6)', { exact: true }).fill('3')
  await ai.locator('textarea[name="description"]').fill('PRIVATE DESCRIPTION never remembered')
  await ai.getByTestId('entity-ai-source').setInputFiles(await referenceImage())
  await expect(ai.locator('.entity-creation-source-preview')).toHaveAttribute('src', /^blob:/)
  await expect(ai.getByLabel('Số ứng viên (1–6)', { exact: true })).toHaveValue('1')
  await expect.poll(() => savedSettings(page)).toMatchObject({ modelId: llmId, count: 3 })
  await closeAi(page, true)
  ai = await openAi(page)
  await expect(ai.locator('textarea[name="description"]')).toHaveValue('')
  await expect(ai.locator('.entity-creation-source-preview')).toHaveCount(0)
  await expect(ai.getByLabel('Số ứng viên (1–6)', { exact: true })).toHaveValue('3')
  await closeAi(page)
  await page.reload()
  ai = await openAi(page)
  await expect(ai.locator('textarea[name="description"]')).toHaveValue('')
  await expect(ai.locator('.entity-creation-source-preview')).toHaveCount(0)
  expect(uploads).toBe(0)
  expect(patches.length).toBeGreaterThan(0)
  for (const patch of patches) {
    expect(patch.version).toBe(1)
    expect(Object.keys(patch.settings).every(key => Object.hasOwn(entityLibraryPreferencesDefaults, key))).toBe(true)
    expect(JSON.stringify(patch)).not.toContain('PRIVATE DESCRIPTION')
    expect(JSON.stringify(patch)).not.toContain('private-reference.png')
  }
  expect(Object.keys(await savedSettings(page)).sort()).toEqual(Object.keys(entityLibraryPreferencesDefaults).sort())
})

test('switching AI kinds preserves description, local reference and original candidates without leave confirmation', async ({ page }) => {
  await signUpFresh(page)
  const llmId = await seedLlmModel(page)
  await mockCandidates(page)
  await openLibrary(page)
  const ai = await openAi(page)
  await ai.getByTestId('entity-ai-kind').selectOption('item')
  await ai.getByTestId('entity-ai-llm').selectOption(llmId)
  const description = 'Đạo cụ cần giữ mô tả khi đổi loại'
  await ai.locator('textarea[name="description"]').fill(description)
  await ai.getByTestId('entity-ai-source').setInputFiles(await referenceImage())
  const preview = await ai.locator('.entity-creation-source-preview').getAttribute('src')
  await ai.getByRole('button', { name: 'Tạo bằng AI', exact: true }).click()
  const card = ai.getByTestId('entity-card')
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('Ứng viên được giữ')
  await expect(ai.getByRole('button', { name: 'Tạo bằng AI', exact: true })).toBeEnabled()
  const candidatePreview = await card.locator('img').getAttribute('src')
  let confirmations = 0
  page.on('dialog', async dialog => { confirmations++; await dialog.dismiss() })
  for (const kind of ['character', 'logo', 'location', 'item']) {
    await ai.getByTestId('entity-ai-kind').selectOption(kind)
    await expect(ai.getByTestId('entity-ai-kind')).toHaveValue(kind)
    await expect(page.getByTestId('entity-ai-leave-dialog')).toHaveCount(0)
    await expect(ai.locator('textarea[name="description"]')).toHaveValue(description)
    await expect(ai.locator('.entity-creation-source-preview')).toHaveAttribute('src', preview!)
    await expect(card).toHaveCount(1)
    await expect(card).toHaveAttribute('data-entity-kind', 'item')
    await expect(card).toContainText('Ứng viên được giữ')
    await expect(card.locator('img')).toHaveAttribute('src', candidatePreview!)
  }
  expect(confirmations).toBe(0)
})

for (const kind of ['item', 'character'] as const) {
  test(`image ratio/resolution/quality are sent in ${kind} illustration payload`, async ({ page }) => {
    await signUpFresh(page)
    const llmId = await seedLlmModel(page)
    const imageId = await seedModel(page, await seedProvider(page))
    await mockCandidates(page)
    const endpoint = kind === 'character' ? '/api/shared-characters/illustrations' : '/api/entity-library/illustrations'
    let illustration: Record<string, unknown> | undefined
    const generation = { id: `settings-${kind}`, status: 'succeeded', progress: 100, assets: [{ id: 'image', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==' }] }
    await page.route(`**${endpoint}`, route => {
      illustration = route.request().postDataJSON()
      return route.fulfill({ json: { generation } })
    })
    await page.route(`**/api/generations/${generation.id}`, route => route.fulfill({ json: { generation } }))
    await openLibrary(page)
    const ai = await openAi(page)
    await ai.getByTestId('entity-ai-kind').selectOption(kind)
    await ai.getByTestId('entity-ai-llm').selectOption(llmId)
    await ai.locator('textarea[name="description"]').fill('Tạo ứng viên có ảnh theo cấu hình')
    await ai.getByLabel('Tạo thêm ảnh (phát sinh phí)', { exact: true }).check()
    await ai.getByTestId('entity-ai-image-model').selectOption(imageId)
    await ai.getByTestId('entity-image-ratio').selectOption('9:16')
    await ai.getByTestId('entity-image-resolution').selectOption('2K')
    await ai.getByTestId('entity-image-quality').selectOption('medium')
    await ai.getByRole('button', { name: 'Tạo bằng AI', exact: true }).click()
    await expect.poll(() => illustration).toMatchObject({ modelId: imageId, size: imageSizeFor('9:16', '2K'), quality: 'medium' })
    await expect(ai.getByTestId('entity-card').getByRole('button', { name: 'Lưu', exact: true })).toBeEnabled()
  })
}

test('new manual character analyzes only name/appearance, preserves every voice field and shares LLM selection', async ({ page }) => {
  await signUpFresh(page)
  const firstLlm = await seedLlmModel(page)
  const secondLlm = await seedLlmModel(page, { modelId: 'second-vision-model' })
  await openLibrary(page)
  const ai = await openAi(page)
  await ai.getByTestId('entity-ai-llm').selectOption(firstLlm)
  await closeAi(page)
  await page.getByTestId('entity-library-create').click()
  const editor = page.getByTestId('entity-editor-dialog')
  await expect(editor.getByTestId('entity-editor-kind')).toHaveValue('character')
  await expect(editor.getByTestId('entity-editor-ai-model')).toHaveValue(firstLlm)
  await editor.getByTestId('entity-editor-ai-model').selectOption(secondLlm)
  await editor.locator('[name="name"]').fill('Tên trước phân tích')
  await editor.locator('[name="appearance"]').fill('Ngoại hình nhập tay')
  for (const [key, value] of Object.entries(voice)) await editor.locator(`[name="voice.${key}"]`).fill(value)
  await editor.getByTestId('entity-editor-file').setInputFiles(await referenceImage())
  let analysisModel: string | null = null
  let creates = 0
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/shared-characters') creates++ })
  await page.route('**/api/shared-characters/analyze-reference?*', route => {
    analysisModel = new URL(route.request().url()).searchParams.get('modelId')
    return route.fulfill({ json: { suggestion: { ...suggestion, voice: { ...voice, accent: 'DO NOT APPLY' } } } })
  })
  page.on('dialog', dialog => dialog.accept())
  await editor.getByTestId('entity-editor-analyze').click()
  await expect(editor.locator('[name="name"]')).toHaveValue(suggestion.name)
  await expect(editor.locator('[name="appearance"]')).toHaveValue(suggestion.appearance)
  await expectVoice(editor)
  await page.screenshot({ path: 'artifacts/entity-creation-update/character-analyze-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: 'artifacts/entity-creation-update/character-analyze-mobile.png', fullPage: true })
  await page.setViewportSize({ width: 1280, height: 720 })
  expect(analysisModel).toBe(secondLlm)
  expect(creates).toBe(0)
  await editor.getByRole('button', { name: 'Lưu', exact: true }).click()
  await expect(editor).toHaveCount(0)
  const charactersResponse = await page.request.get(`${BASE}/api/shared-characters`)
  const characters = (await charactersResponse.json()).characters
  expect(characters).toHaveLength(1)
  expect(characters[0]).toMatchObject({ ...suggestion, voice })
  const reopenedAi = await openAi(page)
  await expect(reopenedAi.getByTestId('entity-ai-llm')).toHaveValue(secondLlm)
})

test('existing manual character analyzes saved reference without changing voice or saving metadata implicitly', async ({ page }) => {
  await signUpFresh(page)
  const llmId = await seedLlmModel(page)
  const create = await page.request.post(`${BASE}/api/shared-characters`, { data: { name: 'Nhân vật có ảnh', appearance: 'Ngoại hình cũ', voice } })
  expect(create.ok()).toBeTruthy()
  const character = (await create.json()).character
  const image = await referenceImage()
  const upload = await page.request.post(`${BASE}/api/shared-characters/${character.id}/reference`, { data: image.buffer, headers: { 'Content-Type': image.mimeType } })
  expect(upload.ok()).toBeTruthy()
  const referenceRevision = (await upload.json()).character.updatedAt
  expect((await page.request.patch(`${BASE}${preferencesPath}`, { data: { version: 1, settings: { modelId: llmId } } })).ok()).toBeTruthy()
  let analysisBody: Record<string, unknown> | undefined
  await page.route(`**/api/shared-characters/${character.id}/analyze-reference`, route => {
    analysisBody = route.request().postDataJSON()
    return route.fulfill({ json: { suggestion: { ...suggestion, voice: { ...voice, pitch: 'DO NOT APPLY' } }, revision: referenceRevision } })
  })
  let metadataWrites = 0
  page.on('request', request => {
    if (request.method() === 'PATCH' && new URL(request.url()).pathname === `/api/shared-characters/${character.id}`) metadataWrites++
  })
  await openLibrary(page)
  await page.getByRole('button', { name: `Sửa — ${character.name}`, exact: true }).click()
  const editor = page.getByTestId('entity-editor-dialog')
  await expect(editor.locator('[name="appearance"]')).toHaveValue('Ngoại hình cũ')
  await expect(editor.getByTestId('entity-editor-ai-model')).toHaveValue(llmId)
  await expect(editor.locator('img')).toBeVisible()
  page.on('dialog', dialog => dialog.accept())
  await editor.getByTestId('entity-editor-analyze').click()
  await expect(editor.locator('[name="name"]')).toHaveValue(suggestion.name)
  await expect(editor.locator('[name="appearance"]')).toHaveValue(suggestion.appearance)
  await expectVoice(editor)
  expect(analysisBody).toMatchObject({ modelId: llmId, language: 'vi' })
  expect(metadataWrites).toBe(0)
  const unchanged = await page.request.get(`${BASE}/api/shared-characters/${character.id}`)
  expect((await unchanged.json()).character).toMatchObject({ name: character.name, appearance: 'Ngoại hình cũ', voice })
  await editor.getByRole('button', { name: 'Lưu', exact: true }).click()
  await expect(editor).toHaveCount(0)
  const updated = await page.request.get(`${BASE}/api/shared-characters/${character.id}`)
  expect((await updated.json()).character).toMatchObject({ ...suggestion, voice })
})

test('failed preferences GET retains local draft and retry loads saved selections', async ({ page }) => {
  await signUpFresh(page)
  const llmId = await seedLlmModel(page)
  expect((await page.request.patch(`${BASE}${preferencesPath}`, {
    data: { version: 1, settings: { kind: 'logo', modelId: llmId, count: 3 } },
  })).ok()).toBeTruthy()
  let reads = 0
  await page.route(`**${preferencesPath}`, route => {
    if (route.request().method() !== 'GET') return route.continue()
    reads++
    if (reads === 1) return route.fulfill({ status: 503, json: { error: 'Settings temporarily unavailable' } })
    return route.continue()
  })
  await openLibrary(page)
  await page.getByTestId('entity-library-ai-create').click()
  const ai = page.getByTestId('entity-ai-dialog')
  await expect(ai.getByRole('alert')).toContainText('Không thể tải hoặc lưu lựa chọn')
  await ai.locator('textarea[name="description"]').fill('Giữ nội dung trong khi tải lại cài đặt')
  await ai.getByTestId('entity-ai-source').setInputFiles(await referenceImage())
  const preview = await ai.locator('.entity-creation-source-preview').getAttribute('src')
  await expect(ai.getByRole('button', { name: 'Tạo bằng AI', exact: true })).toBeDisabled()
  await ai.getByRole('button', { name: 'Thử lại cài đặt', exact: true }).click()
  await expect(ai.getByTestId('entity-ai-kind')).toBeEnabled()
  await expect(ai.getByTestId('entity-ai-kind')).toHaveValue('logo')
  await expect(ai.getByTestId('entity-ai-llm')).toHaveValue(llmId)
  await expect(ai.locator('textarea[name="description"]')).toHaveValue('Giữ nội dung trong khi tải lại cài đặt')
  await expect(ai.locator('.entity-creation-source-preview')).toHaveAttribute('src', preview!)
  await expect(ai.getByRole('alert')).toHaveCount(0)
  expect(reads).toBe(2)
})

test('failed preferences PATCH retains chosen settings and retry saves them', async ({ page }) => {
  await signUpFresh(page)
  const llmId = await seedLlmModel(page)
  let patches = 0
  await page.route(`**${preferencesPath}`, route => {
    if (route.request().method() !== 'PATCH') return route.continue()
    patches++
    if (patches === 1) return route.fulfill({ status: 503, json: { error: 'Settings temporarily unavailable' } })
    return route.continue()
  })
  await openLibrary(page)
  const ai = await openAi(page)
  await ai.locator('textarea[name="description"]').fill('Không mất bản nháp khi lưu lỗi')
  await ai.getByTestId('entity-ai-llm').selectOption(llmId)
  await expect(ai.getByRole('alert')).toContainText('Không thể tải hoặc lưu lựa chọn')
  await expect(ai.getByTestId('entity-ai-llm')).toHaveValue(llmId)
  await expect(ai.locator('textarea[name="description"]')).toHaveValue('Không mất bản nháp khi lưu lỗi')
  expect((await savedSettings(page)).modelId).toBe('')
  await ai.getByRole('button', { name: 'Thử lại cài đặt', exact: true }).click()
  await expect.poll(() => savedSettings(page)).toMatchObject({ modelId: llmId })
  await expect(ai.getByRole('alert')).toHaveCount(0)
  await expect(ai.getByTestId('entity-ai-llm')).toHaveValue(llmId)
  await expect(ai.locator('textarea[name="description"]')).toHaveValue('Không mất bản nháp khi lưu lỗi')
  expect(patches).toBe(2)
  await closeAi(page, true)
  const reopened = await openAi(page)
  await expect(reopened.getByTestId('entity-ai-llm')).toHaveValue(llmId)
})

test('saved disabled model remains unavailable and cannot generate until explicitly replaced', async ({ page }) => {
  await signUpFresh(page)
  const disabledId = await seedLlmModel(page)
  const replacementId = await seedLlmModel(page, { modelId: 'enabled-replacement' })
  expect((await page.request.patch(`${BASE}${preferencesPath}`, {
    data: { version: 1, settings: { modelId: disabledId } },
  })).ok()).toBeTruthy()
  expect((await page.request.patch(`${BASE}/api/models/${disabledId}`, { data: { enabled: false } })).ok()).toBeTruthy()
  let generated = 0
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/generate')) generated++
  })
  await openLibrary(page)
  let ai = await openAi(page)
  await ai.locator('textarea[name="description"]').fill('Mô tả cần model hợp lệ')
  await expect(ai.getByTestId('entity-ai-llm')).toHaveValue(disabledId)
  await expect(ai.getByTestId('entity-ai-llm').locator('option:checked')).toContainText('không khả dụng')
  await expect(ai.getByRole('button', { name: 'Tạo bằng AI', exact: true })).toBeDisabled()
  await ai.getByLabel('Số ứng viên (1–6)', { exact: true }).fill('2')
  await expect.poll(() => savedSettings(page)).toMatchObject({ modelId: disabledId, count: 2 })
  await closeAi(page, true)
  ai = await openAi(page)
  await expect(ai.getByTestId('entity-ai-llm')).toHaveValue(disabledId)
  await ai.locator('textarea[name="description"]').fill('Mô tả mới')
  await expect(ai.getByRole('button', { name: 'Tạo bằng AI', exact: true })).toBeDisabled()
  await ai.getByTestId('entity-ai-llm').selectOption(replacementId)
  await expect(ai.getByRole('button', { name: 'Tạo bằng AI', exact: true })).toBeEnabled()
  expect(generated).toBe(0)
})

test('AI image controls and character editor fit a mobile viewport without horizontal overflow', async ({ page }) => {
  await signUpFresh(page)
  await seedLlmModel(page)
  await seedModel(page, await seedProvider(page))
  await page.setViewportSize({ width: 390, height: 844 })
  await openLibrary(page)
  const ai = await openAi(page)
  await ai.getByLabel('Tạo thêm ảnh (phát sinh phí)', { exact: true }).check()
  await expect(ai.getByTestId('entity-image-ratio')).toBeVisible()
  async function expectFits(dialog: Locator) {
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
    const overflowing = await dialog.evaluate(root => {
      const viewport = window.innerWidth
      return [root, ...root.querySelectorAll('input,select,textarea,button,section')]
        .filter(element => {
          const rect = element.getBoundingClientRect()
          return rect.width > 0 && (rect.left < -1 || rect.right > viewport + 1)
        }).map(element => ({ tag: element.tagName, testId: element.getAttribute('data-testid'), rect: element.getBoundingClientRect().toJSON() }))
    })
    expect(overflowing).toEqual([])
    await expect.poll(() => dialog.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  }
  await expectFits(ai)
  await closeAi(page)
  await page.getByTestId('entity-library-create').click()
  const editor = page.getByTestId('entity-editor-dialog')
  await expect(editor.getByTestId('entity-editor-ai-model')).toBeVisible()
  await expectFits(editor)
})

test('preferences drain keeps the last in-flight edit before a reopened dialog reads settings', async ({ page }) => {
  await signUpFresh(page)
  await openLibrary(page)
  const ai = await openAi(page)
  let releaseFirst!: () => void
  const barrier = new Promise<void>(resolve => { releaseFirst = resolve })
  const patches: Array<{ expectedUserId: string; settings: Record<string, unknown> }> = []
  const events: string[] = []
  let firstCommitted = false
  let paidJobs = 0
  page.on('request', request => {
    if (request.method() === 'POST' && /\/(generate|illustrations)$/.test(new URL(request.url()).pathname)) paidJobs++
  })
  await page.route(`**${preferencesPath}`, async route => {
    if (route.request().method() === 'GET') {
      events.push('read')
      return route.continue()
    }
    if (route.request().method() !== 'PATCH') return route.continue()
    patches.push(route.request().postDataJSON())
    const index = patches.length
    events.push(`patch-${index}`)
    const response = await route.fetch()
    if (index === 1) {
      firstCommitted = true
      await barrier
    }
    events.push(`commit-${index}`)
    await route.fulfill({ response })
  })
  try {
    await ai.getByLabel('Số ứng viên (1–6)', { exact: true }).fill('2')
    await expect.poll(() => firstCommitted).toBe(true)
    await ai.getByLabel('Số ứng viên (1–6)', { exact: true }).fill('5')
    await closeAi(page)
    await page.getByTestId('entity-library-ai-create').click()
    const reopened = page.getByTestId('entity-ai-dialog')
    // The new form must not read the server's intermediate count of 2.
    await expect(reopened.getByTestId('entity-ai-kind')).toBeDisabled()
    expect(events).toEqual(['patch-1'])
    releaseFirst()
    await expect(reopened.getByTestId('entity-ai-kind')).toBeEnabled()
    await expect(reopened.getByLabel('Số ứng viên (1–6)', { exact: true })).toHaveValue('5')
    await expect.poll(() => savedSettings(page)).toMatchObject({ count: 5 })
    expect(patches.map(patch => patch.settings)).toEqual([{ count: 2 }, { count: 5 }])
    expect(patches[0]!.expectedUserId).toBeTruthy()
    expect(patches[1]!.expectedUserId).toBe(patches[0]!.expectedUserId)
    expect(events).toEqual(['patch-1', 'commit-1', 'patch-2', 'commit-2', 'read'])
    expect(paidJobs).toBe(0)
  } finally {
    releaseFirst()
  }
})

test('client queue retains account identity and rejects its next drain after an API account switch', async ({ page }) => {
  await signUpFresh(page)
  const initial = await page.request.get(`${BASE}${preferencesPath}`)
  const accountAId = (await initial.json()).userId as string
  const cookieA = (await page.context().cookies(BASE)).map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
  await openLibrary(page)
  const ai = await openAi(page)
  let releaseFirst!: () => void
  const barrier = new Promise<void>(resolve => { releaseFirst = resolve })
  const patches: Array<{ expectedUserId: string; settings: Record<string, unknown> }> = []
  const statuses: number[] = []
  let firstCommitted = false
  await page.route(`**${preferencesPath}`, async route => {
    if (route.request().method() !== 'PATCH') return route.continue()
    patches.push(route.request().postDataJSON())
    const index = patches.length
    const response = await route.fetch()
    statuses.push(response.status())
    if (index === 1) {
      firstCommitted = true
      await barrier
    }
    await route.fulfill({ response })
  })
  try {
    await ai.getByLabel('Số ứng viên (1–6)', { exact: true }).fill('2')
    await expect.poll(() => firstCommitted).toBe(true)
    await ai.getByLabel('Số ứng viên (1–6)', { exact: true }).fill('6')
    // Keep A's form mounted while auth cookies change to B via the real API.
    await signUpFresh(page)
    const readB = await page.request.get(`${BASE}${preferencesPath}`)
    const accountB = await readB.json()
    expect(accountB.userId).not.toBe(accountAId)
    expect(accountB.settings).toEqual(entityLibraryPreferencesDefaults)
    releaseFirst()
    await expect.poll(() => statuses).toEqual([200, 400])
    await expect(ai.getByRole('alert')).toContainText('Không thể tải hoặc lưu lựa chọn')
    await expect(ai.getByLabel('Số ứng viên (1–6)', { exact: true })).toHaveValue('6')
    expect(patches).toEqual([
      { version: 1, expectedUserId: accountAId, settings: { count: 2 } },
      { version: 1, expectedUserId: accountAId, settings: { count: 6 } },
    ])
    expect(await savedSettings(page)).toEqual(entityLibraryPreferencesDefaults)
    const readA = await page.request.get(`${BASE}${preferencesPath}`, { headers: { Cookie: cookieA } })
    expect((await readA.json()).settings).toEqual({ ...entityLibraryPreferencesDefaults, count: 2 })
  } finally {
    releaseFirst()
  }
})
