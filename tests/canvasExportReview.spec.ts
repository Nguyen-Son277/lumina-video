import { expect, test } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh } from './helpers/auth'

test('Canvas export requires a fresh reviewed media list after another tab changes the chain', async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  const modelId = await seedModel(page, provider, { kind: 'video', modelId: 'sora-review' })
  const response = await page.request.post(`${BASE}/api/quick-sessions`, { data: { title: 'Export review' } })
  const sessionId = (await response.json()).session.id
  const root = `${BASE}/api/quick-sessions/${sessionId}/canvas`
  const graph = { schemaVersion: 1, nodes: [
    { id: 'prompt', kind: 'prompt', x: 0, y: 0, data: { text: 'A quiet lake' } },
    { id: 'first', kind: 'video', x: 300, y: 0, data: { modelId } },
    { id: 'later', kind: 'video', x: 600, y: 0, data: { modelId } },
  ], edges: [{ id: 'prompt-video', source: 'prompt', sourcePort: 'prompt', target: 'first', targetPort: 'prompt' }] }
  expect((await page.request.put(root, { data: { baseRevision: 0, graph } })).ok()).toBe(true)
  const input = await (await page.request.post(`${root}/nodes/first/preview`, { data: { kind: 'video' } })).json()
  const run = await page.request.post(`${root}/nodes/first/run`, { data: { kind: 'video', stamp: input.preview.stamp } })
  expect(run.status()).toBe(202)
  const generationId = (await run.json()).generation.id
  await expect.poll(async () => (await (await page.request.get(`${BASE}/api/generations/${generationId}`)).json()).generation.status, { timeout: 30_000 }).toBe('succeeded')
  await page.goto(`${BASE}/?page=quick&session=${sessionId}&view=canvas`)
  await page.locator('.react-flow__node[data-id="first"]').getByRole('button', { name: 'Chi tiết', exact: true }).click()
  await page.locator('.canvas-toolbar').getByRole('button', { name: 'Xuất video', exact: true }).click()
  const modal = page.getByRole('dialog', { name: 'Xuất video', exact: true })
  const create = modal.getByRole('button', { name: 'Tạo bản xuất video', exact: true })
  await expect(create).toBeEnabled()
  await expect(modal.locator('.project-export-version')).toContainText(generationId.slice(0, 8))
  expect((await (await page.request.get(`${root}/exports`)).json()).exports).toHaveLength(0)
  const changed = { ...graph, edges: [...graph.edges, { id: 'first-later', source: 'first', sourcePort: 'video', target: 'later', targetPort: 'sequence' }] }
  expect((await page.request.put(root, { data: { baseRevision: 1, graph: changed } })).ok()).toBe(true)
  const rejected = page.waitForResponse(result => result.url() === `${root}/exports` && result.request().method() === 'POST')
  await create.click()
  expect((await rejected).status()).toBe(409)
  await expect(modal.getByRole('alert')).toBeVisible()
  await expect(create).toBeDisabled()
  await modal.getByRole('button', { name: 'Làm mới danh sách', exact: true }).click()
  await expect(modal.locator('.project-export-list strong')).toHaveText(['1. A quiet lake', '2. later'])
  await expect(modal.getByText('Chưa có video thành công', { exact: true })).toHaveCount(1)
  await expect(create).toBeDisabled()
  expect((await (await page.request.get(`${root}/exports`)).json()).exports).toHaveLength(0)
  await modal.press('Escape')
  await expect(modal).toHaveCount(0)
  await expect(page.locator('.canvas-sequence-edge')).toHaveCount(1)
})
