import { expect, test, type Page } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh } from './helpers/auth'

// Playwright's dedicated mock server uses PROVIDER_MODE=mock. These tests only
// persist scenes / compile prompts: they never submit a paid generation.
const projectName = 'Scene popup regression'
const sceneTitle = 'Forest opening'
const scenePrompt = 'A slow camera move through a misty forest'
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

function sceneModal(page: Page) {
  // The accessible title can include the scene name after saving. Scope by the
  // approved shell as well as role instead of depending on exact translated copy.
  return page.getByRole('dialog').and(page.locator('.project-scene-modal'))
}

async function seedStudio(page: Page, options: { empty?: boolean; illustration?: boolean } = {}) {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  const modelId = await seedModel(page, provider, { modelId: 'mock-video-model', displayName: 'Popup mock video', kind: 'video' })
  const projectResponse = await page.request.post(`${BASE}/api/projects`, { data: { name: projectName } })
  expect(projectResponse.ok()).toBe(true)
  const { project } = await projectResponse.json() as { project: { id: string } }
  let sceneId = ''
  if (!options.empty) {
    let backgroundUploadId: string | undefined
    if (options.illustration) {
      const uploadResponse = await page.request.post(`${BASE}/api/uploads`, {
        headers: { 'Content-Type': 'image/png' }, data: Buffer.from(png, 'base64'),
      })
      expect(uploadResponse.ok()).toBe(true)
      backgroundUploadId = (await uploadResponse.json()).upload.id
    }
    const response = await page.request.post(`${BASE}/api/projects/${project.id}/scenes`, {
      data: { title: sceneTitle, prompt: scenePrompt, modelId, params: { size: '1280x720', seconds: '5' }, ...(backgroundUploadId ? { backgroundUploadId } : {}) },
    })
    expect(response.ok()).toBe(true)
    sceneId = (await response.json()).scene.id
  }
  await page.goto(`${BASE}/?page=studio&project=${project.id}`)
  await page.getByText(projectName, { exact: true }).click()
  await page.getByRole('tab', { name: 'Cảnh video', exact: true }).click()
  return { projectId: project.id, sceneId, modelId }
}

async function openEdit(page: Page) {
  await page.getByRole('button', { name: `Sửa cảnh ${sceneTitle}`, exact: true }).click()
  const modal = sceneModal(page)
  await expect(modal).toBeVisible()
  await expect(modal).toHaveAttribute('aria-modal', 'true')
  await expect(modal).toHaveAccessibleName(/Cảnh đang sửa|Editing scene/)
  return modal
}

async function scenes(page: Page, projectId: string) {
  const response = await page.request.get(`${BASE}/api/projects/${projectId}/scenes`)
  expect(response.ok()).toBe(true)
  return (await response.json()).scenes as Array<{ id: string; title: string; prompt: string }>
}

test('edit uses a named modal, traps focus, locks background and restores opener on clean Escape', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 })
  await seedStudio(page)
  const opener = page.getByRole('button', { name: `Sửa cảnh ${sceneTitle}`, exact: true })
  await opener.scrollIntoViewIfNeeded()
  const backgroundScroll = await page.evaluate(() => window.scrollY)
  expect(backgroundScroll).toBeGreaterThan(0)
  const beforeOverflow = await page.evaluate(() => document.body.style.overflow)
  const modal = await openEdit(page)
  await expect(page.locator('.project-scene-editor')).toHaveCount(1)
  await expect(modal.locator('.project-scene-editor')).toHaveCount(1)
  await page.screenshot({ path: 'shots/scene-popup-desktop.png', fullPage: true })
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('hidden')
  await expect.poll(() => modal.evaluate(element => element.contains(document.activeElement))).toBe(true)

  // Tab forward from the last enabled control and back from the first must stay
  // in the popup, rather than reach the project controls underneath it.
  const focusable = modal.locator('button:visible:enabled, input:visible:enabled, textarea:visible:enabled, select:visible:enabled, summary:visible, [tabindex="0"]:visible')
  await focusable.last().focus()
  await page.keyboard.press('Tab')
  await expect.poll(() => modal.evaluate(element => element.contains(document.activeElement))).toBe(true)
  await focusable.first().focus()
  await page.keyboard.press('Shift+Tab')
  await expect.poll(() => modal.evaluate(element => element.contains(document.activeElement))).toBe(true)

  await page.locator('.project-scene-modal-backdrop').click({ position: { x: 2, y: 2 } })
  await expect(modal).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(modal).toHaveCount(0)
  await expect(opener).toBeFocused()
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe(beforeOverflow)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(backgroundScroll)
  await expect(page.locator('.project-scene-editor')).toHaveCount(0)
})

test('dirty close confirms: dismiss preserves draft, accept discards without persisting', async ({ page }) => {
  const { projectId } = await seedStudio(page)
  const modal = await openEdit(page)
  await modal.getByLabel('Tên cảnh', { exact: true }).fill('Unsaved scene title')
  const dismissed = page.waitForEvent('dialog')
  const escape = page.keyboard.press('Escape')
  const firstConfirm = await dismissed
  expect(firstConfirm.type()).toBe('confirm')
  await firstConfirm.dismiss()
  await escape
  await expect(modal).toBeVisible()
  await expect(modal.getByLabel('Tên cảnh', { exact: true })).toHaveValue('Unsaved scene title')

  const accepted = page.waitForEvent('dialog')
  const close = modal.locator('.project-scene-modal-close').click()
  const secondConfirm = await accepted
  expect(secondConfirm.type()).toBe('confirm')
  await secondConfirm.accept()
  await close
  await expect(modal).toHaveCount(0)
  expect((await scenes(page, projectId))[0].title).toBe(sceneTitle)
  await openEdit(page)
  await expect(sceneModal(page).getByLabel('Tên cảnh', { exact: true })).toHaveValue(sceneTitle)
})

test('save persists edits, keeps popup open and resets clean-close baseline', async ({ page }) => {
  const { projectId, sceneId } = await seedStudio(page)
  const modal = await openEdit(page)
  await modal.getByLabel('Mô tả / hành động').fill('The camera rises above the canopy')
  const saved = page.waitForResponse(response => response.url().endsWith(`/scenes/${sceneId}`) && response.request().method() === 'PATCH')
  await modal.getByRole('button', { name: 'Lưu cảnh', exact: true }).click()
  expect((await saved).ok()).toBe(true)
  await expect(modal.getByRole('button', { name: 'Lưu cảnh', exact: true })).toBeEnabled()
  await expect(modal).toBeVisible()
  expect((await scenes(page, projectId))[0].prompt).toBe('The camera rises above the canopy')
  // An unexpected dirty confirmation is auto-dismissed by Playwright and would
  // leave the modal open, causing this clean-close assertion to fail.
  await page.keyboard.press('Escape')
  await expect(modal).toHaveCount(0)
  await openEdit(page)
  await expect(sceneModal(page).getByLabel('Mô tả / hành động')).toHaveValue('The camera rises above the canopy')
})

test('add save-and-preview preserves editor state and repeated saves never duplicate the scene', async ({ page }) => {
  const { projectId, modelId } = await seedStudio(page, { empty: true })
  const opener = page.getByRole('button', { name: 'Thêm cảnh', exact: true })
  await opener.click()
  const modal = sceneModal(page)
  await expect(modal).toHaveAccessibleName(/Cảnh mới|New scene/)
  await modal.getByLabel('Tên cảnh', { exact: true }).fill('New popup scene')
  await modal.getByLabel('Mô tả / hành động').fill(scenePrompt)
  await modal.getByRole('combobox', { name: 'Model video', exact: true }).selectOption(modelId)
  const preview = modal.getByRole('button', { name: 'Lưu & xem trước prompt', exact: true })
  await preview.click()
  await expect(modal.locator('.project-prompt-preview')).toBeVisible()
  await expect(modal.getByLabel('Tên cảnh', { exact: true })).toHaveValue('New popup scene')
  const firstScenes = await scenes(page, projectId)
  expect(firstScenes).toHaveLength(1)
  await preview.click()
  await expect(modal.locator('.project-prompt-preview')).toBeVisible()
  expect((await scenes(page, projectId)).map(scene => scene.id)).toEqual([firstScenes[0].id])
  await page.keyboard.press('Escape')
  await expect(modal).toHaveCount(0)
  await expect(opener).toBeFocused()
  await page.getByRole('button', { name: 'Sửa cảnh New popup scene', exact: true }).click()
  await expect(sceneModal(page).getByLabel('Tên cảnh', { exact: true })).toHaveValue('New popup scene')
})

for (const width of [320, 390]) {
  test(`scene modal fits ${width}px mobile and scrolls internally`, async ({ page }) => {
    await page.setViewportSize({ width, height: 740 })
    await seedStudio(page)
    const modal = await openEdit(page)
    if (width === 390) await page.screenshot({ path: 'shots/scene-popup-mobile.png', fullPage: true })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    const bounds = await modal.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(741)
    const body = modal.locator('.project-scene-modal-body')
    await expect.poll(() => body.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    expect(await body.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    await modal.getByRole('button', { name: 'Lưu cảnh', exact: true }).scrollIntoViewIfNeeded()
    await expect(modal.getByRole('button', { name: 'Lưu cảnh', exact: true })).toBeInViewport()
    await expect(modal.locator('.project-scene-modal-close')).toBeInViewport()
    await page.keyboard.press('Escape')
    await expect(modal).toHaveCount(0)
  })
}

test('pending scene save disables close and ignores Escape / backdrop until complete', async ({ page }) => {
  const { projectId, sceneId } = await seedStudio(page)
  const modal = await openEdit(page)
  await modal.getByLabel('Mô tả / hành động').fill('Delayed save still persists')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let signalStarted!: () => void
  const started = new Promise<void>(resolve => { signalStarted = resolve })
  await page.route(`**/api/projects/${projectId}/scenes/${sceneId}`, async route => {
    if (route.request().method() !== 'PATCH') return route.continue()
    signalStarted()
    await gate
    await route.continue()
  })
  try {
    await modal.getByRole('button', { name: 'Lưu cảnh', exact: true }).click()
    await started
    await expect(modal.locator('.project-scene-modal-close')).toBeDisabled()
    await page.keyboard.press('Escape')
    await page.locator('.project-scene-modal-backdrop').click({ position: { x: 2, y: 2 } })
    await expect(modal).toBeVisible()
  } finally {
    release()
  }
  await expect(modal.locator('.project-scene-modal-close')).toBeEnabled()
  expect((await scenes(page, projectId))[0].prompt).toBe('Delayed save still persists')
  await page.keyboard.press('Escape')
  await expect(modal).toHaveCount(0)
})

test('Escape closes only native generation confirmation and never enqueues a generation', async ({ page }) => {
  const { projectId, sceneId } = await seedStudio(page)
  const assetResponse = await page.request.post(`${BASE}/api/entity-library/assets`, {
    data: { kind: 'logo', name: 'Popup logo', handle: 'popup_logo', description: 'A simple green logo' },
  })
  expect(assetResponse.ok()).toBe(true)
  const { asset } = await assetResponse.json()
  const prompt = `@${asset.handle} appears over the forest`
  const updated = await page.request.patch(`${BASE}/api/projects/${projectId}/scenes/${sceneId}`, {
    data: { prompt, promptDocument: { version: 1, text: prompt, mentions: [
      { id: 'popup-logo-mention', start: 0, end: asset.handle.length + 1, label: asset.handle, entity: { kind: 'logo', id: asset.id } },
    ] } },
  })
  expect(updated.ok()).toBe(true)
  // Reload scene data after the API seed; all subsequent actions use the real UI.
  await page.reload()
  await page.getByRole('tab', { name: 'Cảnh video', exact: true }).click()
  const modal = await openEdit(page)
  await modal.getByRole('button', { name: 'Lưu & xem trước prompt', exact: true }).click()
  await expect(modal.locator('.project-prompt-preview')).toBeVisible()
  const generate = modal.getByRole('button', { name: 'Tạo / thử lại phiên bản mới', exact: true })
  let generateRequests = 0
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/scenes\/[^/]+\/generate$/.test(request.url())) generateRequests += 1
  })
  await generate.click()
  const confirmation = page.getByRole('dialog', { name: 'Xác nhận yêu cầu tạo nội dung', exact: true })
  await expect(confirmation).toBeVisible()
  await expect(confirmation).toHaveJSProperty('open', true)
  await expect(confirmation).toContainText('Popup logo')
  await page.keyboard.press('Escape')
  await expect(confirmation).toHaveCount(0)
  await expect(modal).toBeVisible()
  await expect(generate).toBeFocused()
  expect(generateRequests).toBe(0)
  const versionsResponse = await page.request.get(`${BASE}/api/generations?sceneId=${sceneId}`)
  expect(versionsResponse.ok()).toBe(true)
  expect((await versionsResponse.json()).generations).toHaveLength(0)
  await page.keyboard.press('Escape')
  await expect(modal).toHaveCount(0)
})

test('archived scene popup retains illustration preview but disables illustration changes', async ({ page }) => {
  await seedStudio(page, { illustration: true })
  await page.getByRole('button', { name: 'Lưu trữ', exact: true }).click()
  const modal = await openEdit(page)
  await expect(modal.getByText('Dự án đã lưu trữ không đổi được ảnh minh hoạ.', { exact: true })).toBeVisible()
  await expect(modal.getByLabel('Thay ảnh', { exact: true })).toBeDisabled()
  await expect(modal.getByRole('button', { name: 'Xoá ảnh', exact: true })).toBeDisabled()
  await modal.getByRole('button', { name: `Phóng to ảnh minh hoạ của cảnh ${sceneTitle}`, exact: true }).click()
  await expect(page.locator('.lightbox-backdrop')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.lightbox-backdrop')).toHaveCount(0)
  await expect(modal).toBeVisible()
})

test('Escape closes only nested illustration lightbox before closing clean scene popup', async ({ page }) => {
  await seedStudio(page, { illustration: true })
  const modal = await openEdit(page)
  await modal.getByRole('button', { name: `Phóng to ảnh minh hoạ của cảnh ${sceneTitle}`, exact: true }).click()
  await expect(page.locator('.lightbox-backdrop')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.lightbox-backdrop')).toHaveCount(0)
  await expect(modal).toBeVisible()
  await expect.poll(() => modal.evaluate(element => element.contains(document.activeElement))).toBe(true)
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('hidden')
  await page.keyboard.press('Escape')
  await expect(modal).toHaveCount(0)
})
