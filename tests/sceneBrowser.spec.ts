import { expect, test, type Page } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh, waitForGeneration } from './helpers/auth'

async function seedBrowser(page: Page, count = 5) {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  const modelId = await seedModel(page, provider, { modelId: 'mock-video-model', kind: 'video' })
  const created = await page.request.post(`${BASE}/api/projects`, { data: { name: 'Scene browser regression' } })
  expect(created.ok()).toBe(true)
  const { project } = await created.json()
  const sceneIds: string[] = []
  for (let index = 0; index < count; index++) {
    const response = await page.request.post(`${BASE}/api/projects/${project.id}/scenes`, {
      data: { title: `Browser scene ${index + 1}`, prompt: `A forest panorama ${index + 1}`, position: index, modelId, params: { size: '1280x720', seconds: '5' } },
    })
    expect(response.ok()).toBe(true)
    sceneIds.push((await response.json()).scene.id)
  }
  let generateRequests = 0
  page.on('request', request => {
    if (request.method() === 'POST' && (/\/api\/scenes\/[^/]+\/generate$/.test(request.url()) || /\/api\/generations$/.test(request.url()))) generateRequests++
    if (request.method() === 'POST' && /\/scenes\/bulk$/.test(request.url()) && request.postDataJSON()?.action === 'generate') generateRequests++
  })
  await page.goto(`${BASE}/?page=studio&project=${project.id}`)
  await page.getByText('Scene browser regression', { exact: true }).click()
  await page.getByRole('tab', { name: 'Cảnh video', exact: true }).click()
  await expect(page.locator('.project-scene-card')).toHaveCount(count)
  return { projectId: project.id as string, sceneIds, generateRequests: () => generateRequests }
}

async function noGenerations(page: Page, projectId: string) {
  const response = await page.request.get(`${BASE}/api/generations?projectId=${projectId}`)
  expect(response.ok()).toBe(true)
  expect((await response.json()).generations).toHaveLength(0)
}

test('1440px browser has four columns with the first row visible and ordered scene tags', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const seeded = await seedBrowser(page)
  const list = page.locator('.project-scene-list')
  await expect.poll(() => list.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(4)
  const cards = list.locator('.project-scene-card')
  const boxes = await Promise.all([0, 1, 2, 3, 4].map(index => cards.nth(index).boundingBox()))
  for (let index = 0; index < 4; index++) {
    await expect(cards.nth(index)).toBeInViewport({ ratio: 1 })
    expect(boxes[index]!.y).toBeCloseTo(boxes[0]!.y, 0)
    if (index) expect(boxes[index]!.x).toBeGreaterThan(boxes[index - 1]!.x)
  }
  expect(boxes[4]!.y).toBeGreaterThan(boxes[0]!.y)
  await page.screenshot({ path: 'shots/scene-browser-1440.png', fullPage: true })
  await expect(list.locator('.scene-order-tag')).toHaveText(['Cảnh 01', 'Cảnh 02', 'Cảnh 03', 'Cảnh 04', 'Cảnh 05'])
  for (let index = 0; index < 5; index++) {
    await expect(cards.nth(index).getByRole('checkbox', { name: `Chọn cảnh Browser scene ${index + 1}`, exact: true })).toBeVisible()
    await expect(cards.nth(index).locator('.scene-order-tag')).toBeVisible()
  }
  await expect(page.locator('.project-steps, .studio-tab-help, .studio-bulk-tools')).toHaveCount(0)
  expect(seeded.generateRequests()).toBe(0)
  await noGenerations(page, seeded.projectId)
})

for (const width of [320, 390]) {
  test(`scene browser fits ${width}px without horizontal overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    const seeded = await seedBrowser(page, 2)
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    await expect.poll(() => page.locator('.project-scene-list').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(1)
    for (const card of await page.locator('.project-scene-card').all()) {
      const box = await card.boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1)
    }
    expect(seeded.generateRequests()).toBe(0)
  })
}

test('thumbnail opens results, not editing; opening either view never generates', async ({ page }) => {
  const seeded = await seedBrowser(page, 1)
  const thumbnail = page.locator('.scene-results-open')
  await thumbnail.click()
  const modal = page.getByRole('dialog').and(page.locator('.project-scene-modal'))
  await expect(modal.locator('.scene-results')).toBeVisible()
  await expect(modal.locator('.scene-results-empty')).toBeVisible()
  await expect(page.locator('.project-scene-editor')).toHaveCount(0)
  expect(seeded.generateRequests()).toBe(0)
  await page.keyboard.press('Escape')
  await expect(modal).toHaveCount(0)
  await expect(thumbnail).toBeFocused()
  await page.getByRole('button', { name: 'Sửa cảnh Browser scene 1', exact: true }).click()
  await expect(modal.locator('.project-scene-editor')).toBeVisible()
  await expect(modal.locator('.scene-results')).toHaveCount(0)
  await expect(modal.getByRole('button', { name: 'Tạo / thử lại phiên bản mới', exact: true })).toBeEnabled()
  expect(seeded.generateRequests()).toBe(0)
  await noGenerations(page, seeded.projectId)
})

test('advanced popup contains approval and config but main generate-approved stays outside', async ({ page }) => {
  const seeded = await seedBrowser(page, 1)
  await page.getByRole('checkbox', { name: 'Chọn cảnh Browser scene 1', exact: true }).check()
  const trigger = page.getByRole('button', { name: 'Tạo nhiều cảnh — nâng cao', exact: true })
  const generateApproved = page.getByRole('button', { name: 'Tạo cho các cảnh đã duyệt', exact: true })
  await expect(generateApproved).toBeVisible()
  await trigger.click()
  const modal = page.getByRole('dialog').and(page.locator('.project-scene-modal'))
  await expect(modal).toHaveAccessibleName('Tạo nhiều cảnh — nâng cao')
  await expect(modal.getByRole('button', { name: 'Duyệt cảnh đã chọn', exact: true })).toBeEnabled()
  await expect(modal.getByRole('button', { name: 'Bỏ duyệt cảnh đã chọn', exact: true })).toBeEnabled()
  await expect(modal.getByRole('button', { name: 'Cấu hình video hàng loạt', exact: true })).toBeVisible()
  await expect(modal.getByRole('button', { name: 'Tạo cho các cảnh đã duyệt', exact: true })).toHaveCount(0)
  await expect(page.locator('.scene-main-actions').getByRole('button', { name: 'Tạo cho các cảnh đã duyệt', exact: true })).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(modal).toHaveCount(0)
  await expect(trigger).toBeFocused()
  expect(seeded.generateRequests()).toBe(0)
  await noGenerations(page, seeded.projectId)
})

test('dirty draft blocks generation until save, then generates without manual prompt preview', async ({ page }) => {
  const seeded = await seedBrowser(page, 1)
  await page.getByRole('button', { name: 'Sửa cảnh Browser scene 1', exact: true }).click()
  const modal = page.getByRole('dialog').and(page.locator('.project-scene-modal'))
  const config = modal.getByRole('button', { name: 'Cấu hình video', exact: true })
  const generate = modal.getByRole('button', { name: 'Tạo / thử lại phiên bản mới', exact: true })
  await expect(config).toHaveAttribute('aria-expanded', 'false')
  await expect(modal.getByLabel('Nhà cung cấp video')).toBeHidden()
  await expect(generate).toBeEnabled()
  await modal.getByLabel('Mô tả / hành động').fill('Saved clean forest panorama')
  await expect(generate).toBeDisabled()
  expect(seeded.generateRequests()).toBe(0)
  let previewRequests = 0
  page.on('request', request => {
    if (request.method() === 'POST' && /\/preview-prompt$/.test(request.url())) previewRequests++
  })
  const saved = page.waitForResponse(response => response.url().endsWith(`/scenes/${seeded.sceneIds[0]}`) && response.request().method() === 'PATCH')
  await modal.getByRole('button', { name: 'Lưu cảnh', exact: true }).click()
  expect((await saved).ok()).toBe(true)
  await expect(generate).toBeEnabled()
  await expect(modal.locator('.project-prompt-preview')).toHaveCount(0)
  expect(previewRequests).toBe(0)
  expect(seeded.generateRequests()).toBe(0)
  const generated = page.waitForResponse(response => response.url().endsWith(`/scenes/${seeded.sceneIds[0]}/generate`) && response.request().method() === 'POST')
  await generate.click()
  const response = await generated
  expect(response.status()).toBe(202)
  const { generation } = await response.json()
  expect(generation.sceneId).toBe(seeded.sceneIds[0])
  expect((await waitForGeneration(page, generation.id)).status).toBe('succeeded')
  await expect(modal.locator('.project-version-card')).toHaveCount(1)
  await expect.poll(() => modal.locator('.project-versions').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(1)
  expect(previewRequests).toBe(0)
  expect(seeded.generateRequests()).toBe(1)
  await page.keyboard.press('Escape')
  await page.locator('.scene-results-open').click()
  const history = page.getByRole('dialog').and(page.locator('.project-scene-modal'))
  await expect(history.locator('.scene-results-card')).toHaveCount(1)
  await history.getByRole('button', { name: /Dùng phiên bản/ }).click()
  await expect(history.locator('.scene-results-selected')).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await expect(page.locator('.project-scene-editor')).toHaveCount(0)
})
