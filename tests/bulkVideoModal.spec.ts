import { test, expect } from '@playwright/test'
import { BASE, seedProvider, seedModel, signUpFresh } from './helpers/auth'

async function setup(page: import('@playwright/test').Page) {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  const model = await seedModel(page, provider, { modelId: 'bulk-modal-video', displayName: 'Bulk modal video', kind: 'video' })
  const project = (await (await page.request.post(`${BASE}/api/projects`, { data: { name: 'Bulk modal project' } })).json()).project
  for (const title of ['First scene', 'Second scene']) {
    await page.request.post(`${BASE}/api/projects/${project.id}/scenes`, { data: { title, prompt: 'A scene', modelId: model, params: { size: '1280x720', seconds: '5' } } })
  }
  await page.goto(`${BASE}/?page=studio&project=${project.id}`)
  await page.getByText('Bulk modal project', { exact: true }).click()
  await page.getByRole('tab', { name: 'Cảnh video', exact: true }).click()
  return { projectId: project.id, providerId: provider, modelId: model }
}

function opener(page: import('@playwright/test').Page) {
  return page.getByRole('button', { name: 'Cấu hình video hàng loạt', exact: true })
}
function modal(page: import('@playwright/test').Page) {
  return page.getByRole('dialog', { name: 'Cấu hình video hàng loạt', exact: true }).and(page.locator('.project-scene-modal'))
}

test('bulk modal accessible, responsive, restores opener focus and never generates on open or apply', async ({ page }) => {
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 740 })
    const projectId = await setup(page)
    const first = page.getByRole('checkbox', { name: 'Chọn cảnh First scene', exact: true })
    await first.check()
    const trigger = opener(page)
    let generates = 0
    page.on('request', request => { if (request.method() === 'POST' && /\/api\/scenes\/[^/]+\/generate$/.test(request.url())) generates++ })
    await trigger.click()
    const dialog = modal(page)
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('.project-bulk-video-modal')).toBeVisible()
    await expect(dialog.locator('fieldset.project-bulk-video-settings')).toBeVisible()
    await expect(dialog.locator('.project-bulk-video-settings').getByLabel('Nhà cung cấp video')).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    expect(generates).toBe(0)
    if (width === 390) break
    // Return to project via fresh setup for the second viewport.
    await page.goto('about:blank')
  }
})

test('bulk modal keeps local draft on failed apply, locks close while applying, and reopens with draft', async ({ page }) => {
  const { projectId, providerId, modelId } = await setup(page)
  await page.getByRole('checkbox', { name: 'Chọn cảnh First scene', exact: true }).check()
  const trigger = opener(page)
  await trigger.click()
  const dialog = modal(page)
  const settings = dialog.locator('.project-bulk-video-settings')
  // Select provider and model first: duration constraints are model-specific.
  const provider = settings.getByLabel('Nhà cung cấp video')
  const models = settings.getByRole('combobox', { name: 'Model video', exact: true })
  await provider.selectOption(providerId)
  await models.selectOption(modelId)
  const duration = settings.getByRole('spinbutton', { name: 'Thời lượng' })
  await duration.fill('9')
  let generationRequests = 0
  page.on('request', request => { if (request.method() === 'POST' && /\/api\/scenes\/[^/]+\/generate$/.test(request.url())) generationRequests++ })

  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let started!: () => void
  const applying = new Promise<void>(resolve => { started = resolve })
  await page.route(`**/api/projects/${projectId}/scenes/bulk`, async route => {
    started()
    await gate
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Apply failed' }) })
  })
  const apply = dialog.getByRole('button', { name: 'Áp dụng model và cấu hình', exact: true })
  const applyPromise = apply.click()
  await applying
  await expect(dialog.locator('.project-scene-modal-close')).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  release()
  await applyPromise
  await expect(dialog.getByRole('alert')).toBeVisible()
  await expect(duration).toHaveValue('9')
  await expect(dialog.locator('.project-scene-modal-close')).toBeEnabled()
  await expect.poll(() => generationRequests).toBe(0)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await trigger.click()
  await expect(modal(page).locator('.project-bulk-video-settings').getByRole('spinbutton', { name: 'Thời lượng' })).toHaveValue('9')
})

for (const width of [320, 390]) {
  test(`bulk modal fits ${width}px mobile viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 740 })
    await setup(page)
    await page.getByRole('checkbox', { name: 'Chọn cảnh First scene', exact: true }).check()
    await opener(page).click()
    const dialog = modal(page)
    const bounds = await dialog.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1)
  })
}
