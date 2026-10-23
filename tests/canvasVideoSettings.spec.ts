import { expect, test, type Page } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh } from './helpers/auth'

async function openCanvas(page: Page, name: string) {
  await page.goto(`${BASE}/?page=studio`)
  await page.getByRole('button', { name: new RegExp(name) }).click()
  await page.getByRole('tab', { name: 'Canvas' }).click()
  await expect(page.locator('.canvas-flow')).toBeVisible()
}

// Uses the existing Playwright harness/mock backend; do not start a separate server.
test('video node settings synchronize with inspector, persist local model IDs, and never edit the scene', async ({ page }) => {
  await signUpFresh(page)
  const name = 'Canvas video settings'
  const projectResponse = await page.request.post(`${BASE}/api/projects`, { data: { name } })
  expect(projectResponse.ok()).toBe(true)
  const projectId = (await projectResponse.json()).project.id as string
  const provider = await seedProvider(page, { name: 'Canvas video provider' })
  const modelId = await seedModel(page, provider, { modelId: 'sora-canvas', displayName: 'Canvas Sora', kind: 'video' })
  const secondModelId = await seedModel(page, provider, { modelId: 'sora-canvas-two', displayName: 'Canvas Sora Two', kind: 'video' })
  await seedModel(page, provider, { modelId: 'canvas-image-only', displayName: 'Image must not appear', kind: 'image' })
  const secondProvider = await seedProvider(page, { name: 'Other video provider' })
  const otherModelId = await seedModel(page, secondProvider, { modelId: 'sora-other', displayName: 'Other Sora', kind: 'video' })
  const sceneResponse = await page.request.post(`${BASE}/api/projects/${projectId}/scenes`, {
    data: { title: 'Inherited scene', prompt: 'Camera pan', modelId, params: { size: '1280x720', seconds: '8' } },
  })
  expect(sceneResponse.ok()).toBe(true)
  const scene = (await sceneResponse.json()).scene
  const saved = await page.request.put(`${BASE}/api/projects/${projectId}/canvas`, {
    data: { baseRevision: 0, graph: {
      schemaVersion: 1,
      nodes: [
        { id: 'p', kind: 'prompt', x: 20, y: 20, data: { text: 'Camera pan' } },
        { id: 'v', kind: 'video', x: 360, y: 20, data: { modelId, sceneId: scene.id } },
      ],
      edges: [{ id: 'pv', source: 'p', sourcePort: 'prompt', target: 'v', targetPort: 'prompt' }],
    } },
  })
  expect(saved.ok()).toBe(true)

  await openCanvas(page, name)
  const node = page.locator('.canvas-node.kind-video')
  // Cards stay compact; the full editor is available in the right inspector.
  await expect(node.locator('.canvas-video-settings')).toHaveCount(0)
  await node.locator('header').click()
  const inspector = page.locator('.canvas-inspector .canvas-video-settings')
  await expect(inspector).toBeVisible()
  await expect(inspector.getByRole('combobox', { name: 'Nhà cung cấp', exact: true })).toHaveValue(provider)
  await expect(inspector.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue(modelId)
  await expect(inspector.getByRole('option', { name: 'Image must not appear' })).toHaveCount(0)
  await expect(inspector).toContainText('8')
  await inspector.getByRole('button', { name: 'Dùng bản sao riêng' }).click()
  await inspector.getByRole('spinbutton', { name: 'Thời lượng', exact: true }).fill('12')
  await inspector.getByRole('combobox', { name: 'Tỷ lệ khung hình', exact: true }).selectOption('9:16')
  await inspector.getByRole('combobox', { name: 'Độ phân giải', exact: true }).selectOption('1080')
  await expect(inspector.getByRole('spinbutton', { name: 'Thời lượng', exact: true })).toHaveValue('12')
  await expect(inspector.getByRole('combobox', { name: 'Tỷ lệ khung hình', exact: true })).toHaveValue('9:16')
  await expect(inspector.getByRole('combobox', { name: 'Độ phân giải', exact: true })).toHaveValue('1080')
  await inspector.getByRole('spinbutton', { name: 'Thời lượng', exact: true }).fill('16')
  await inspector.getByRole('combobox', { name: 'Model', exact: true }).selectOption(secondModelId)
  await expect(inspector.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue(secondModelId)
  await expect(inspector.getByRole('spinbutton', { name: 'Thời lượng', exact: true })).toHaveValue('16')
  await inspector.getByRole('combobox', { name: 'Nhà cung cấp', exact: true }).selectOption(secondProvider)
  await expect(inspector.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue(otherModelId)
  // Provider changes reset controls; edits persist in the inspector.
  await inspector.getByRole('spinbutton', { name: 'Thời lượng', exact: true }).fill('12')
  await inspector.getByRole('combobox', { name: 'Tỷ lệ khung hình', exact: true }).selectOption('9:16')
  await inspector.getByRole('combobox', { name: 'Độ phân giải', exact: true }).selectOption('1080')
  await expect(inspector.getByRole('spinbutton', { name: 'Thời lượng', exact: true })).toHaveValue('12')
  await expect(page.locator('.canvas-save-state')).toHaveText('Đã lưu', { timeout: 20_000 })
  const persisted = await page.request.get(`${BASE}/api/projects/${projectId}/canvas`)
  const graph = (await persisted.json()).canvas.graph
  expect(graph.nodes.find((entry: { id: string }) => entry.id === 'v').data).toMatchObject({
    modelId: otherModelId, videoSettings: { modelId: otherModelId, params: { size: '1080x1920', seconds: '12' } },
  })
  const scenes = await page.request.get(`${BASE}/api/projects/${projectId}/scenes`)
  expect((await scenes.json()).scenes.find((entry: { id: string }) => entry.id === scene.id).params).toEqual(scene.params)

  await openCanvas(page, name)
  const persistedNode = page.locator('.canvas-node.kind-video')
  await persistedNode.locator('header').click()
  const persistedInspector = page.locator('.canvas-inspector .canvas-video-settings')
  await expect(persistedInspector.getByRole('combobox', { name: 'Nhà cung cấp', exact: true })).toHaveValue(secondProvider)
  await expect(persistedInspector.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue(otherModelId)
  await expect(persistedInspector.getByRole('spinbutton', { name: 'Thời lượng', exact: true })).toHaveValue('12')
  await expect(persistedInspector.getByRole('combobox', { name: 'Tỷ lệ khung hình', exact: true })).toHaveValue('9:16')
  await expect(persistedInspector.getByRole('combobox', { name: 'Độ phân giải', exact: true })).toHaveValue('1080')
  await persistedInspector.getByRole('button', { name: 'Trở về thiết lập của cảnh' }).click()
  await expect(persistedInspector.getByRole('button', { name: 'Dùng bản sao riêng' })).toBeVisible()
  await expect(page.locator('.canvas-save-state')).toHaveText('Đã lưu', { timeout: 20_000 })
  const inherited = await page.request.get(`${BASE}/api/projects/${projectId}/canvas`)
  expect((await inherited.json()).canvas.graph.nodes.find((entry: { id: string }) => entry.id === 'v').data).not.toHaveProperty('videoSettings')
})
