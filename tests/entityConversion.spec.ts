import { expect, test, type Locator, type Page } from '@playwright/test'
import sharp from 'sharp'
import type { EntityKind, EntityLibraryEntity } from '../src/api/entityLibrary'
import type { CharacterVoice } from '../src/api/projectTypes'
import { BASE, seedLlmModel, signUpFresh } from './helpers/auth'

const kinds: EntityKind[] = ['character', 'item', 'logo', 'location']
const voice: CharacterVoice = { language: 'vi', accent: 'Miền Nam', pitch: 'Trầm', timbre: 'Ấm', pace: 'Chậm', articulation: 'Rõ', habits: 'Ngắt nhịp nhẹ' }
const description = 'Mô tả đầy đủ được giữ nguyên khi chuyển loại.'
const notes = 'Ghi chú riêng cần giữ qua vòng chuyển đổi.'
async function image(color = '#3478ac') {
  return { name: 'reference.png', mimeType: 'image/png', buffer: await sharp({ create: { width: 32, height: 32, channels: 4, background: color } }).png().toBuffer() }
}
async function catalog(page: Page): Promise<EntityLibraryEntity[]> {
  const response = await page.request.get(`${BASE}/api/entity-library`)
  expect(response.ok()).toBeTruthy()
  return (await response.json()).entities
}
async function current(page: Page, id: string) {
  const entities = (await catalog(page)).filter(entity => entity.id === id)
  expect(entities).toHaveLength(1)
  return entities[0]!
}
async function create(page: Page, kind: EntityKind, options: { description?: string; withImage?: boolean } = {}) {
  const response = await page.request.post(`${BASE}${kind === 'character' ? '/api/shared-characters' : '/api/entity-library/assets'}`, {
    data: kind === 'character'
      ? { name: 'Tài nguyên chuyển loại', appearance: options.description ?? description, voice }
      : { kind, name: 'Tài nguyên chuyển loại', description: options.description ?? description, continuityNotes: notes },
  })
  expect(response.ok()).toBeTruthy()
  const body = await response.json()
  const id = (body.character ?? body.asset).id as string
  if (options.withImage) {
    const file = await image()
    const upload = await page.request.post(`${BASE}${kind === 'character' ? `/api/shared-characters/${id}/reference` : `/api/entity-library/assets/${id}/reference`}`, { data: file.buffer, headers: { 'Content-Type': file.mimeType } })
    expect(upload.ok()).toBeTruthy()
  }
  return current(page, id)
}
function card(page: Page, id: string) { return page.locator(`[data-testid="entity-library-card"][data-entity-id="${id}"]`) }
async function openEditor(page: Page, entity: EntityLibraryEntity, navigate = true) {
  if (navigate) await page.goto(`${BASE}/?page=entities`)
  await card(page, entity.id).getByRole('button', { name: `Sửa — ${entity.name}`, exact: true }).click()
  const editor = page.getByTestId('entity-editor-dialog')
  await expect(editor.getByTestId('entity-editor-kind')).toBeEnabled()
  return editor
}
async function save(editor: Locator) {
  await editor.getByRole('button', { name: 'Lưu', exact: true }).click()
  await expect(editor).toHaveCount(0)
}
async function discard(page: Page, editor: Locator) {
  await editor.getByRole('button', { name: 'Đóng', exact: true }).last().click()
  await page.getByTestId('entity-dirty-dialog').getByRole('button', { name: 'Bỏ thay đổi và rời đi', exact: true }).click()
  await expect(editor).toHaveCount(0)
}
async function referenceBytes(page: Page, entity: EntityLibraryEntity) {
  const response = await page.request.get(`${BASE}${entity.kind === 'character' ? `/api/characters/${entity.id}/reference` : `/api/entity-library/assets/${entity.id}/reference`}`)
  expect(response.ok()).toBeTruthy()
  return response.body()
}

test.beforeEach(async ({ page }) => { await signUpFresh(page) })

for (const from of kinds) for (const to of kinds.filter(kind => kind !== from)) {
  test(`editing converts standalone ${from} to ${to} only on Save, preserving identity and image`, async ({ page }) => {
    const source = await create(page, from, { withImage: true })
    const beforeImage = await referenceBytes(page, source)
    let conversions = 0
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/convert')) conversions++ })
    const editor = await openEditor(page, source)
    await editor.getByTestId('entity-editor-kind').selectOption(to)
    await expect(editor.locator(`[name="${to === 'character' ? 'appearance' : 'description'}"]`)).toHaveValue(description)
    await expect(editor.locator('[name="name"]')).toHaveValue(source.name)
    await expect(editor.locator('.entity-creation-reference img')).toBeVisible()
    expect((await current(page, source.id)).kind).toBe(from)
    expect(conversions).toBe(0)
    await save(editor)
    const target = await current(page, source.id)
    expect(target).toMatchObject({ id: source.id, kind: to, handle: source.handle, name: source.name, description })
    expect(await referenceBytes(page, target)).toEqual(beforeImage)
    expect(conversions).toBe(1)
    await expect(card(page, source.id)).toHaveAttribute('data-entity-kind', to)
    await expect(page.getByTestId(`entity-library-filter-${to}`)).toHaveAttribute('aria-pressed', 'true')
    await page.reload()
    await expect(card(page, source.id)).toHaveAttribute('data-entity-kind', to)
  })
}

test('character voice and asset notes survive multiple real conversion round trips', async ({ page }) => {
  let entity = await create(page, 'character', { withImage: true })
  const originalId = entity.id
  for (const target of ['item', 'logo', 'location', 'character'] as const) {
    const editor = await openEditor(page, entity)
    await editor.getByTestId('entity-editor-kind').selectOption(target)
    if (target === 'item') await editor.locator('[name="continuityNotes"]').fill(notes)
    if (target === 'character') for (const [key, value] of Object.entries(voice)) await expect(editor.locator(`[name="voice.${key}"]`)).toHaveValue(value)
    await save(editor)
    entity = await current(page, originalId)
    const hydration = await page.request.get(`${BASE}/api/entity-library/${target}/${originalId}/conversion-data`)
    expect(hydration.ok()).toBeTruthy()
    expect(await hydration.json()).toMatchObject({ voice, continuityNotes: notes })
  }
  const response = await page.request.get(`${BASE}/api/shared-characters/${originalId}`)
  expect((await response.json()).character).toMatchObject({ name: entity.name, appearance: description, voice })
})

test('changing draft kind retains typed fields and local image; discard leaves the original untouched', async ({ page }) => {
  const source = await create(page, 'character', { withImage: true })
  const beforeImage = await referenceBytes(page, source)
  const editor = await openEditor(page, source)
  await editor.locator('[name="name"]').fill('Tên chỉ trong bản nháp')
  await editor.locator('[name="appearance"]').fill('Ngoại hình chỉ trong bản nháp')
  await editor.locator('[name="voice.accent"]').fill('Giọng bản nháp')
  await editor.getByTestId('entity-editor-file').setInputFiles(await image('#ff1133'))
  const localPreview = await editor.locator('.entity-creation-reference img').getAttribute('src')
  let confirms = 0
  page.on('dialog', dialog => { confirms++; return dialog.dismiss() })
  for (const kind of ['item', 'logo', 'location', 'character'] as const) {
    await editor.getByTestId('entity-editor-kind').selectOption(kind)
    await expect(page.getByTestId('entity-dirty-dialog')).toHaveCount(0)
    await expect(editor.locator('[name="name"]')).toHaveValue('Tên chỉ trong bản nháp')
    await expect(editor.locator(`[name="${kind === 'character' ? 'appearance' : 'description'}"]`)).toHaveValue('Ngoại hình chỉ trong bản nháp')
    await expect(editor.locator('.entity-creation-reference img')).toHaveAttribute('src', localPreview!)
  }
  await expect(editor.locator('[name="voice.accent"]')).toHaveValue('Giọng bản nháp')
  expect(confirms).toBe(0)
  await editor.getByTestId('entity-editor-kind').selectOption('item')
  await discard(page, editor)
  expect(await current(page, source.id)).toEqual(source)
  expect(await referenceBytes(page, source)).toEqual(beforeImage)
})

test('conversion committed before an image upload failure is not performed twice on Save retry', async ({ page }) => {
  const source = await create(page, 'item', { withImage: true })
  const replacement = await image('#ecaf55')
  let conversions = 0
  let uploads = 0
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/convert')) conversions++ })
  await page.route(`**/api/shared-characters/${source.id}/reference`, route => {
    if (route.request().method() !== 'POST') return route.continue()
    uploads++
    if (uploads === 1) return route.fulfill({ status: 503, json: { error: 'Controlled image upload failure' } })
    return route.continue()
  })
  const editor = await openEditor(page, source)
  await editor.getByTestId('entity-editor-kind').selectOption('character')
  await editor.getByTestId('entity-editor-file').setInputFiles(replacement)
  await editor.getByRole('button', { name: 'Lưu', exact: true }).click()
  await expect(editor.getByRole('alert')).toContainText('Đã lưu thông tin')
  expect((await current(page, source.id)).kind).toBe('character')
  expect(conversions).toBe(1)
  await save(editor)
  expect(conversions).toBe(1)
  expect(uploads).toBe(2)
  expect(await referenceBytes(page, await current(page, source.id))).toEqual(replacement.buffer)
  await expect(card(page, source.id)).toHaveAttribute('data-entity-kind', 'character')
})

test('discard after committed conversion and failed image upload shows target card and retains original image', async ({ page }) => {
  const source = await create(page, 'item', { withImage: true })
  const originalImage = await referenceBytes(page, source)
  await page.route(`**/api/shared-characters/${source.id}/reference`, route => {
    if (route.request().method() !== 'POST') return route.continue()
    return route.fulfill({ status: 503, json: { error: 'Controlled image upload failure' } })
  })
  const editor = await openEditor(page, source)
  await editor.getByTestId('entity-editor-kind').selectOption('character')
  await editor.getByTestId('entity-editor-file').setInputFiles(await image('#1188ff'))
  await editor.getByRole('button', { name: 'Lưu', exact: true }).click()
  await expect(editor.getByRole('alert')).toContainText('Đã lưu thông tin')
  await discard(page, editor)
  await expect(card(page, source.id)).toHaveAttribute('data-entity-kind', 'character')
  await expect(page.getByTestId('entity-library-filter-character')).toHaveAttribute('aria-pressed', 'true')
  const target = await current(page, source.id)
  expect(target.kind).toBe('character')
  expect(await referenceBytes(page, target)).toEqual(originalImage)
})

test('in-use character conversion returns usage details and keeps the original and unsaved draft intact', async ({ page }) => {
  const source = await create(page, 'character', { withImage: true })
  const projectResponse = await page.request.post(`${BASE}/api/projects`, { data: { name: 'Dự án đang dùng nhân vật' } })
  expect(projectResponse.ok()).toBeTruthy()
  const project = (await projectResponse.json()).project
  const scene = await page.request.post(`${BASE}/api/projects/${project.id}/scenes`, { data: { title: 'Cảnh giữ liên kết', prompt: 'Nhân vật đi dạo', characterId: source.id, characterIds: [source.id] } })
  expect(scene.ok()).toBeTruthy()
  const editor = await openEditor(page, source)
  await editor.getByTestId('entity-editor-kind').selectOption('logo')
  await editor.locator('[name="name"]').fill('Tên nháp không được mất')
  const conversion = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/convert') && response.request().method() === 'POST')
  await editor.getByRole('button', { name: 'Lưu', exact: true }).click()
  const blocked = await conversion
  expect(blocked.status()).toBe(409)
  await expect(editor.locator('.entity-conversion-usage li')).not.toHaveCount(0)
  await expect(editor.locator('.entity-conversion-usage')).toContainText('Cảnh giữ liên kết')
  await expect(editor.getByRole('link', { name: 'Mở nơi sử dụng', exact: true }).first()).toHaveAttribute('href', new RegExp(project.id))
  await expect(editor.locator('[name="name"]')).toHaveValue('Tên nháp không được mất')
  await expect(editor.getByTestId('entity-editor-kind')).toHaveValue('logo')
  expect(await current(page, source.id)).toEqual(source)
  await discard(page, editor)
})

test('long asset description cannot save as character and is never silently truncated', async ({ page }) => {
  const longDescription = `${'a'.repeat(4100)} Đuôi mô tả phải giữ`
  const source = await create(page, 'item', { description: longDescription })
  const editor = await openEditor(page, source)
  let conversions = 0
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/convert')) conversions++ })
  await editor.getByTestId('entity-editor-kind').selectOption('character')
  await expect(editor.locator('[name="appearance"]')).toHaveValue(longDescription)
  await expect(editor.getByRole('alert')).toContainText('nội dung chưa bị cắt bỏ')
  await expect(editor.getByRole('button', { name: 'Lưu', exact: true })).toBeDisabled()
  await editor.getByTestId('entity-editor-kind').selectOption('location')
  await expect(editor.locator('[name="description"]')).toHaveValue(longDescription)
  await expect(editor.getByRole('button', { name: 'Lưu', exact: true })).toBeEnabled()
  expect(conversions).toBe(0)
  await discard(page, editor)
  expect((await current(page, source.id)).description).toBe(longDescription)
})

for (const [from, target] of [['item', 'character'], ['character', 'logo']] as const) {
  test(`AI analyzes an unsaved ${from} → ${target} change through original image and target raw endpoint`, async ({ page }) => {
    await seedLlmModel(page)
    const source = await create(page, from, { withImage: true })
    const editor = await openEditor(page, source)
    await editor.getByTestId('entity-editor-kind').selectOption(target)
    await editor.getByTestId('entity-editor-ai-model').selectOption({ index: 1 })
    const requests: Array<{ path: string; method: string }> = []
    page.on('request', request => { requests.push({ path: new URL(request.url()).pathname, method: request.method() }) })
    const rawPath = target === 'character' ? '/api/shared-characters/analyze-reference' : '/api/entity-library/analyze-reference'
    const analysisResponse = page.waitForResponse(response => new URL(response.url()).pathname === rawPath && response.request().method() === 'POST')
    page.once('dialog', dialog => dialog.accept())
    await editor.getByTestId('entity-editor-analyze').click()
    const response = await analysisResponse
    expect(response.ok()).toBeTruthy()
    const request = response.request()
    expect(request.headers()['content-type']).toBe('image/png')
    // The real raw endpoint rejects empty/non-image bodies; its 200 above proves
    // upload validity. Chromium reports File-backed fetch bodies as null/0 in CDP.
    if (target !== 'character') expect(new URL(request.url()).searchParams.get('kind')).toBe(target)
    const result = await response.json()
    await expect(editor.locator('[name="name"]')).toHaveValue(result.suggestion.name)
    await expect(editor.locator(`[name="${target === 'character' ? 'appearance' : 'description'}"]`)).toHaveValue(target === 'character' ? result.suggestion.appearance : result.suggestion.description)
    expect(requests).toContainEqual({ path: from === 'character' ? `/api/characters/${source.id}/reference` : `/api/entity-library/assets/${source.id}/reference`, method: 'GET' })
    expect(requests.some(entry => entry.path.endsWith('/convert'))).toBe(false)
    expect(requests.some(entry => entry.path.includes(`/${source.id}/analyze-reference`))).toBe(false)
    expect((await current(page, source.id)).kind).toBe(from)
    await discard(page, editor)
  })
}

test('concurrent hydration revision mismatch fails closed and disables Save without changing the source', async ({ page }) => {
  const source = await create(page, 'item', { withImage: true })
  await page.route(`**/api/entity-library/item/${source.id}/conversion-data`, async route => {
    const response = await route.fetch()
    expect(response.ok()).toBeTruthy()
    const body = await response.json()
    // Simulate an edit between the two parallel hydration reads, without faking writes.
    await route.fulfill({ response, json: { ...body, revision: source.revision + 1 } })
  })
  await page.goto(`${BASE}/?page=entities`)
  await card(page, source.id).getByRole('button', { name: `Sửa — ${source.name}`, exact: true }).click()
  const editor = page.getByTestId('entity-editor-dialog')
  await expect(editor.getByRole('alert')).toContainText('Ảnh tham chiếu đã thay đổi')
  await expect(editor.getByRole('button', { name: 'Lưu', exact: true })).toBeDisabled()
  await expect(editor.getByTestId('entity-editor-kind')).toBeDisabled()
  expect(await current(page, source.id)).toEqual(source)
})

for (const [from, target] of [['item', 'character'], ['character', 'logo']] as const) {
  test(`late raw AI suggestion is rejected after the original ${from} revision changes during unsaved conversion`, async ({ page }) => {
    await seedLlmModel(page)
    const source = await create(page, from, { withImage: true })
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    let analyzed = false
    const rawPath = target === 'character' ? '/api/shared-characters/analyze-reference' : '/api/entity-library/analyze-reference'
    await page.route(`**${rawPath}?*`, async route => {
      const response = await route.fetch()
      expect(response.ok()).toBeTruthy()
      analyzed = true
      await barrier
      await route.fulfill({ response })
    })
    const editor = await openEditor(page, source)
    await editor.getByTestId('entity-editor-kind').selectOption(target)
    await editor.getByTestId('entity-editor-ai-model').selectOption({ index: 1 })
    page.once('dialog', dialog => dialog.accept())
    try {
      await editor.getByTestId('entity-editor-analyze').click()
      await expect.poll(() => analyzed).toBe(true)
      const update = await page.request.patch(`${BASE}${from === 'character' ? `/api/shared-characters/${source.id}` : `/api/entity-library/assets/${source.id}`}`, {
        data: from === 'character' ? { name: 'Nguồn được sửa đồng thời', appearance: description, voice } : { name: 'Nguồn được sửa đồng thời', revision: source.revision },
      })
      expect(update.ok()).toBeTruthy()
      release()
      await expect(editor.getByRole('alert')).toContainText('Ảnh tham chiếu đã thay đổi')
      await expect(editor.locator('[name="name"]')).toHaveValue(source.name)
      await expect(editor.locator(`[name="${target === 'character' ? 'appearance' : 'description'}"]`)).toHaveValue(description)
      expect(await current(page, source.id)).toMatchObject({ kind: from, name: 'Nguồn được sửa đồng thời' })
      await discard(page, editor)
    } finally {
      release()
    }
  })
}
