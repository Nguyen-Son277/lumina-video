import { expect, test, type Page } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh } from './helpers/auth'

const actionNames = ['Lưu cảnh', 'Lưu & xem trước prompt', 'Tạo / thử lại phiên bản mới'] as const
const title = 'Header actions scene'
const prompt = 'A slow camera move through a misty forest'

async function openScene(page: Page) {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  const modelId = await seedModel(page, provider, { modelId: 'mock-video-model', kind: 'video' })
  const projectResponse = await page.request.post(`${BASE}/api/projects`, { data: { name: 'Scene header regression' } })
  expect(projectResponse.ok()).toBe(true)
  const { project } = await projectResponse.json() as { project: { id: string } }
  const sceneResponse = await page.request.post(`${BASE}/api/projects/${project.id}/scenes`, {
    data: { title, prompt, modelId, params: { size: '1280x720', seconds: '5' } },
  })
  expect(sceneResponse.ok()).toBe(true)
  const { scene } = await sceneResponse.json() as { scene: { id: string } }
  await page.goto(`${BASE}/?page=studio&project=${project.id}`)
  await page.getByText('Scene header regression', { exact: true }).click()
  await page.getByRole('tab', { name: 'Cảnh video', exact: true }).click()
  const opener = page.getByRole('button', { name: `Sửa cảnh ${title}`, exact: true })
  await opener.click()
  const modal = page.getByRole('dialog').and(page.locator('.project-scene-modal'))
  await expect(modal).toBeVisible()
  const header = modal.locator('.project-scene-modal-header')
  const actions = header.locator('.project-scene-header-actions')
  return { modal, header, actions, opener, projectId: project.id, sceneId: scene.id }
}

for (const width of [1440, 390, 320]) {
  test(`scene header has three unique actions before close and stays visible while scrolling at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 740 })
    const { modal, header, actions } = await openScene(page)
    const close = header.locator('.project-scene-modal-close')
    await expect(actions).toHaveCount(1)
    await expect(actions.getByRole('button')).toHaveCount(3)
    await expect(header.getByRole('button')).toHaveCount(4)
    for (const name of actionNames) {
      await expect(modal.getByRole('button', { name, exact: true })).toHaveCount(1)
      await expect(actions.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 })
    }
    await expect(actions.getByRole('button')).toHaveText([...actionNames])
    await expect(modal.locator('.project-scene-editor').getByRole('button', { name: /^(Lưu cảnh|Lưu & xem trước prompt|Tạo \/ thử lại phiên bản mới)$/ })).toHaveCount(0)
    expect(await header.evaluate(element => {
      const actions = element.querySelector('.project-scene-header-actions')!
      const close = element.querySelector('.project-scene-modal-close')!
      return Boolean(actions.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING)
    })).toBe(true)
    await expect(close).toBeInViewport({ ratio: 1 })
    await page.screenshot({ path: `shots/scene-header-${width}.png`, fullPage: true })
    const body = modal.locator('.project-scene-modal-body')
    for (const region of [modal, header, actions, body]) {
      await expect.poll(() => region.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    }
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    const bounds = await modal.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1)
    const beforeScroll = await header.boundingBox()
    // Expand optional controls to guarantee meaningful internal scrolling on desktop too.
    await modal.getByRole('button', { name: 'Cấu hình video', exact: true }).click()
    await modal.locator('.studio-disclosure > summary').click()
    await body.evaluate(element => { element.scrollTop = element.scrollHeight })
    await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    await expect.poll(() => header.boundingBox()).toEqual(beforeScroll)
    for (const name of actionNames) {
      await expect(actions.getByRole('button', { name, exact: true })).toBeVisible()
      await expect(actions.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 })
    }
    await expect(close).toBeInViewport({ ratio: 1 })
  })
}

test('header save and optional preview preserve state, dirty edits block generation, and retain focus / clean Escape baseline', async ({ page }) => {
  const { modal, header, actions, opener, projectId, sceneId } = await openScene(page)
  const save = actions.getByRole('button', { name: actionNames[0], exact: true })
  const preview = actions.getByRole('button', { name: actionNames[1], exact: true })
  const generate = actions.getByRole('button', { name: actionNames[2], exact: true })
  const close = header.locator('.project-scene-modal-close')
  await expect(modal.getByLabel('Tên cảnh', { exact: true })).toBeFocused()
  await expect(generate).toBeEnabled()
  await expect(modal.locator('.project-prompt-preview')).toHaveCount(0)
  await expect(save).toBeEnabled()
  await expect(preview).toBeEnabled()
  await modal.getByLabel('Mô tả / hành động').fill('Saved from the modal header')
  await expect(generate).toBeDisabled()

  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let signalStarted!: () => void
  const started = new Promise<void>(resolve => { signalStarted = resolve })
  const sceneUrl = `${BASE}/api/projects/${projectId}/scenes/${sceneId}`
  await page.route(sceneUrl, async route => {
    if (route.request().method() !== 'PATCH') return route.continue()
    signalStarted()
    await gate
    await route.continue()
  })
  const saved = page.waitForResponse(response => response.url() === sceneUrl && response.request().method() === 'PATCH')
  try {
    await save.click()
    await started
    for (const button of [save, preview, generate, close]) await expect(button).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(modal).toBeVisible()
  } finally {
    release()
  }
  expect((await saved).ok()).toBe(true)
  await page.unroute(sceneUrl)
  await expect(save).toBeEnabled()
  await expect(preview).toBeEnabled()
  await expect(close).toBeEnabled()
  await expect(generate).toBeEnabled()
  await expect(modal.getByLabel('Mô tả / hành động')).toHaveValue('Saved from the modal header')
  await expect(modal.locator('.project-prompt-preview')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(modal).toHaveCount(0)
  await expect(opener).toBeFocused()

  await opener.click()
  await expect(modal.getByLabel('Mô tả / hành động')).toHaveValue('Saved from the modal header')
  await preview.click()
  await expect(modal.locator('.project-prompt-preview')).toContainText('Saved from the modal header')
  await expect(generate).toBeEnabled()
  await expect(modal.getByLabel('Tên cảnh', { exact: true })).toHaveValue(title)
  await modal.getByLabel('Mô tả / hành động').fill('Preview invalidates after edits')
  await expect(modal.locator('.project-prompt-preview')).toHaveCount(0)
  await expect(generate).toBeDisabled()
  await preview.click()
  await expect(modal.locator('.project-prompt-preview')).toContainText('Preview invalidates after edits')
  await expect(generate).toBeEnabled()

  // Header actions participate in the same trap as the body, rather than losing
  // keyboard focus to the project behind the popup after moving out of the editor.
  const focusable = modal.locator('button:visible:enabled, input:visible:enabled, textarea:visible:enabled, select:visible:enabled, summary:visible, [tabindex="0"]:visible')
  await focusable.last().focus()
  await page.keyboard.press('Tab')
  await expect(save).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(preview).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(generate).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(close).toBeFocused()
  await save.focus()
  await page.keyboard.press('Shift+Tab')
  await expect(focusable.last()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(modal).toHaveCount(0)
  await expect(opener).toBeFocused()
  const response = await page.request.get(`${BASE}/api/projects/${projectId}/scenes`)
  expect(response.ok()).toBe(true)
  expect((await response.json()).scenes).toEqual([expect.objectContaining({ id: sceneId, prompt: 'Preview invalidates after edits' })])
})
