import { expect, test } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh } from './helpers/auth'

test('standalone quick video previews and runs without any project scene', async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  const modelId = await seedModel(page, provider, { modelId: 'sora-quick-canvas', displayName: 'Quick Canvas Video', kind: 'video' })
  const requests: string[] = []
  page.on('request', request => requests.push(request.url()))
  await page.goto(`${BASE}/?page=quick`)
  await page.getByRole('button', { name: 'Phiên mới', exact: true }).first().click()
  await page.locator('.mode-tabs button').nth(1).click()
  await page.getByPlaceholder('Mô tả điều bạn muốn tạo...').fill('A cinematic slow pan across a mountain lake')
  await page.getByTestId('quick-canvas-toggle').click()
  const video = page.locator('.canvas-node.kind-video').first()
  await expect(video).toBeVisible()
  await expect(video.getByRole('combobox', { name: 'Chọn cảnh', exact: true })).toHaveCount(0)
  await expect(video.locator('.canvas-video-settings')).not.toContainText('Chưa chọn cảnh')
  await expect(video.locator('.canvas-video-settings').getByRole('combobox', { name: 'Model', exact: true })).toHaveValue(modelId)
  const previewResponse = page.waitForResponse(response => /\/quick-sessions\/[^/]+\/canvas\/nodes\/[^/]+\/preview$/.test(response.url()))
  await video.getByRole('button', { name: 'Xem trước', exact: true }).click()
  const preview = await previewResponse
  expect(preview.ok()).toBe(true)
  expect((await preview.json()).preview.kind).toBe('video')
  const inspector = page.locator('.canvas-inspector')
  await expect(inspector).toContainText('A cinematic slow pan across a mountain lake')
  const runResponse = page.waitForResponse(response => /\/quick-sessions\/[^/]+\/canvas\/nodes\/[^/]+\/run$/.test(response.url()))
  await inspector.getByRole('button', { name: 'Xác nhận và chạy', exact: true }).click()
  const run = await runResponse
  expect(run.ok()).toBe(true)
  const generation = (await run.json()).generation
  expect(generation.kind).toBe('video')
  expect(generation.projectId ?? null).toBeNull()
  await expect(video.locator('video.canvas-output-media')).toBeVisible({ timeout: 30_000 })
  expect(requests.some(url => /\/projects\/.*\/(items|scenes)/.test(url))).toBe(false)
})

test('quick canvas @ selection creates reusable logo context and preserves manual placement after mention removal', async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  await seedModel(page, provider, { modelId: 'canvas-mentions-image', displayName: 'Canvas mentions image', kind: 'image' })
  const response = await page.request.post(`${BASE}/api/entity-library/assets`, { data: { kind: 'logo', name: 'Canvas Brand', handle: 'canvas-brand' } })
  expect(response.ok()).toBe(true)
  const entity = (await response.json()).asset
  const requests: string[] = []
  page.on('request', request => requests.push(request.url()))
  await page.goto(`${BASE}/?page=quick`)
  await page.getByRole('button', { name: 'Phiên mới', exact: true }).first().click()
  await page.getByPlaceholder('Mô tả điều bạn muốn tạo...').fill('Canvas scene')
  await page.getByTestId('quick-canvas-toggle').click()
  await expect(page.locator('.canvas-flow')).toBeVisible()
  const prompt = page.locator('.canvas-node.kind-prompt textarea').first()
  await prompt.fill('@canvas-brand')
  await page.getByRole('option').filter({ hasText: '@canvas-brand' }).click()
  const logo = page.locator('.canvas-node.kind-library').filter({ hasText: 'Canvas Brand' })
  await expect(logo).toHaveCount(1)
  const position = logo.getByRole('combobox', { name: 'Vị trí logo' })
  await expect(position).toHaveValue('top-right')
  await position.selectOption('bottom-center')
  await expect(page.locator('.canvas-save-state')).toHaveText('Đã lưu')
  // Use the board GET request to avoid coupling the test to URL parameter spelling.
  const boardUrl = requests.find(url => /\/quick-sessions\/[^/]+\/canvas$/.test(url))!
  expect(boardUrl).toBeTruthy()
  const read = async () => (await (await page.request.get(boardUrl)).json()).canvas.graph
  await expect.poll(async () => (await read()).nodes.find((node: { data: { sourceId?: string } }) => node.data.sourceId === entity.id)?.data.logoPosition).toBe('bottom-center')
  const graph = await read()
  expect(graph.edges.some((edge: { autoMention?: boolean }) => edge.autoMention)).toBe(true)
  await prompt.fill('No bound mentions')
  await expect.poll(async () => (await read()).edges.filter((edge: { autoMention?: boolean }) => edge.autoMention).length).toBe(0)
  await expect(logo).toHaveCount(1)
  await expect(position).toHaveValue('bottom-center')
  expect(requests.some(url => /\/projects\/.*\/items/.test(url))).toBe(false)
})
