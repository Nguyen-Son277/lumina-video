import { expect, test } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh } from './helpers/auth'
import { MOCK_PNG_BYTES } from '../server/generations/adapters/mock'

for (const mobile of [false, true]) {
  test(`typed Studio inspector shares prompt/note/entity data ${mobile ? 'mobile' : 'desktop'}`, async ({ page }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 })
    await signUpFresh(page)
    const projectResponse = await page.request.post(`${BASE}/api/projects`, { data: { name: 'Typed Inspector' } })
    const project = (await projectResponse.json()).project
    const assetResponse = await page.request.post(`${BASE}/api/entity-library/assets`, { data: { kind: 'item', name: 'Inspector Cup', handle: 'inspector-cup', description: 'Blue ceramic cup' } })
    const asset = (await assetResponse.json()).asset
    const graph = { schemaVersion: 1, nodes: [
      { id: 'prompt', kind: 'prompt', x: 10, y: 10, data: { text: 'Initial prompt' } },
      { id: 'note', kind: 'note', x: 300, y: 10, data: { text: 'Initial note' } },
      { id: 'library', kind: 'library', x: 600, y: 10, data: { sourceId: asset.id, entityKind: 'item' } },
    ], edges: [] }
    const save = await page.request.put(`${BASE}/api/projects/${project.id}/canvas`, { data: { baseRevision: 0, graph } })
    expect(save.ok()).toBe(true)
    await page.goto(`${BASE}/?page=studio`)
    await page.getByRole('button', { name: /Typed Inspector/ }).click()
    await page.getByRole('tab', { name: 'Canvas' }).click()
    await page.locator('.canvas-node.kind-prompt header strong').click()
    const inspector = page.locator('.canvas-inspector')
    await expect(inspector.locator('select')).toHaveCount(0)
    await expect(inspector).toContainText('14/8000')
    await inspector.locator('textarea').fill('Inspector updated')
    await expect(page.locator('.canvas-node.kind-prompt .canvas-node-summary')).toHaveText('Inspector updated')
    await inspector.getByRole('button', { name: 'Đóng', exact: true }).click()
    await page.locator('.canvas-node.kind-note header strong').click()
    await inspector.locator('textarea').fill('Shared note')
    await expect(page.locator('.canvas-node.kind-note .canvas-node-summary')).toHaveText('Shared note')
    await expect(inspector.getByRole('combobox')).toHaveCount(0)
    await inspector.getByRole('button', { name: 'Đóng', exact: true }).click()
    await page.locator('.canvas-node.kind-library header strong').click()
    const picker = inspector.getByRole('combobox', { name: 'Nhân vật & tài nguyên', exact: true })
    await expect(picker).toHaveValue(/#inspector-cup · Inspector Cup/)
    await picker.fill('ceramic')
    await expect(inspector.getByRole('listbox').getByRole('option')).toHaveCount(1)
    await inspector.getByRole('listbox').getByRole('option').click()
    await expect(inspector).toContainText('Blue ceramic cup')
    await expect(inspector.getByRole('combobox')).toHaveCount(2)
    await inspector.getByRole('combobox', { name: 'Loại đối tượng', exact: true }).selectOption('logo')
    await expect(inspector.getByRole('listbox').getByRole('option')).toHaveCount(0)
    await expect(inspector).toContainText('Không tìm thấy đối tượng')
  })
}

test('Studio inspector binds hash item/scenery with thumbnails, persists and removes managed edges', async ({ page }) => {
  await signUpFresh(page)
  const projectResponse = await page.request.post(`${BASE}/api/projects`, { data: { name: 'Inspector Gallery' } })
  const project = (await projectResponse.json()).project
  const actorResponse = await page.request.post(`${BASE}/api/shared-characters`, { data: { name: 'Gallery Actor', appearance: 'Dark hair' } })
  const actor = (await actorResponse.json()).character
  expect((await page.request.patch(`${BASE}/api/entity-library/character/${actor.id}/handle`, { data: { handle: 'gallery-actor' } })).ok()).toBe(true)
  const assets = []
  for (const kind of ['item', 'location'] as const) {
    const response = await page.request.post(`${BASE}/api/entity-library/assets`, { data: { kind, name: `Gallery ${kind}`, handle: `gallery-${kind}`, description: `Reference for ${kind}` } })
    expect(response.ok()).toBe(true)
    const asset = (await response.json()).asset
    expect((await page.request.post(`${BASE}/api/entity-library/assets/${asset.id}/reference`, { headers: { 'Content-Type': 'image/png' }, data: MOCK_PNG_BYTES })).ok()).toBe(true)
    assets.push(asset)
  }
  const boardUrl = `${BASE}/api/projects/${project.id}/canvas`
  expect((await page.request.put(boardUrl, { data: { baseRevision: 0, graph: { schemaVersion: 1, nodes: [
    { id: 'gallery-prompt', kind: 'prompt', x: 350, y: 50, data: { text: '' } },
    { id: 'gallery-output', kind: 'image', x: 700, y: 50, data: {} },
  ], edges: [{ id: 'gallery-prompt-edge', source: 'gallery-prompt', sourcePort: 'prompt', target: 'gallery-output', targetPort: 'prompt' }] } } })).ok()).toBe(true)
  const open = async () => {
    await page.goto(`${BASE}/?page=studio`)
    await page.getByRole('button', { name: /Inspector Gallery/ }).click()
    await page.getByRole('tab', { name: 'Canvas' }).click()
  }
  await open()
  await page.locator('.canvas-node.kind-prompt header strong').click()
  const inspector = page.locator('.canvas-inspector')
  const prompt = inspector.getByRole('textbox', { name: 'Nội dung prompt' })
  await prompt.fill('@gallery-')
  await expect(inspector.getByRole('option')).toHaveCount(1)
  await expect(inspector.getByRole('option')).toContainText('@gallery-actor')
  await prompt.fill('#gallery-')
  await expect(inspector.getByRole('option')).toHaveCount(2)
  await expect(inspector.getByRole('option').filter({ hasText: 'gallery-actor' })).toHaveCount(0)
  for (const kind of ['item', 'location']) {
    if (kind === 'location') { await prompt.press('End'); await prompt.pressSequentially(' #gallery-') }
    const option = inspector.getByRole('option').filter({ hasText: `#gallery-${kind}` })
    await expect(option.locator('img')).toBeVisible()
    await expect.poll(() => option.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
    await option.click()
  }
  const read = async () => (await (await page.request.get(boardUrl)).json()).canvas.graph
  await expect.poll(async () => (await read()).edges.filter((edge: { autoMention?: boolean }) => edge.autoMention).length).toBe(2)
  await expect(page.locator('.canvas-node.kind-library')).toHaveCount(2)
  await expect(page.locator('.canvas-node.kind-library .canvas-thumb')).toHaveCount(2)
  await inspector.getByRole('button', { name: 'Đóng', exact: true }).click()
  // Mention nodes appear left of the prompt, outside the initial fit viewport.
  await page.getByRole('button', { name: 'Vừa khung', exact: true }).click()
  await page.locator('.canvas-node.kind-library').filter({ hasText: 'Gallery item' }).getByRole('button', { name: 'Chi tiết', exact: true }).click()
  await expect(inspector.locator('img.canvas-thumb')).toBeVisible()
  await expect.poll(() => inspector.locator('img.canvas-thumb').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
  await expect(inspector).toContainText('Reference for item')
  await expect(page.locator('.canvas-save-state')).toHaveText('Đã lưu')
  await page.reload()
  await page.getByRole('button', { name: /Inspector Gallery/ }).click()
  await page.getByRole('tab', { name: 'Canvas' }).click()
  await page.locator('.canvas-node.kind-prompt header strong').click()
  await expect(prompt).toHaveValue('#gallery-item #gallery-location')
  const persisted = await read()
  expect(persisted.nodes.filter((node: { kind: string; data: { sourceId?: string } }) => node.kind === 'library').map((node: { data: { sourceId: string } }) => node.data.sourceId).sort()).toEqual(assets.map(asset => asset.id).sort())
  await prompt.fill('No references now')
  await expect.poll(async () => (await read()).edges.filter((edge: { autoMention?: boolean }) => edge.autoMention).length).toBe(0)
})

test('quick inspector @/# mentions reconcile and preview returns to typed editor', async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  await seedModel(page, provider, { modelId: 'typed-inspector-image', displayName: 'Inspector Image', kind: 'image' })
  const character = await page.request.post(`${BASE}/api/shared-characters`, { data: { name: 'Inspector Actor', appearance: 'Short dark hair' } })
  expect(character.ok()).toBe(true)
  const actor = (await character.json()).character
  const handle = await page.request.patch(`${BASE}/api/entity-library/character/${actor.id}/handle`, { data: { handle: 'inspector-actor' } })
  expect(handle.ok()).toBe(true)
  await page.request.post(`${BASE}/api/entity-library/assets`, { data: { kind: 'logo', name: 'Inspector Logo', handle: 'inspector-logo' } })
  const sessionResponse = await page.request.post(`${BASE}/api/quick-sessions`, { data: { title: 'Inspector regression' } })
  expect(sessionResponse.status()).toBe(201)
  const { session } = await sessionResponse.json()
  await page.goto(`${BASE}/?page=quick&session=${session.id}`)
  await page.locator('#prompt').fill('Initial quick prompt')
  await page.getByTestId('quick-canvas-toggle').filter({ visible: true }).click()
  await page.locator('.canvas-node.kind-prompt header strong').first().click()
  const inspector = page.locator('.canvas-inspector')
  const prompt = inspector.locator('textarea')
  await prompt.fill('@inspector-actor')
  await inspector.getByRole('option').filter({ hasText: '@inspector-actor' }).click()
  await prompt.press('End')
  await prompt.pressSequentially(' #inspector-logo')
  await inspector.getByRole('option').filter({ hasText: '#inspector-logo' }).click()
  await expect(page.locator('.canvas-node.kind-character')).toHaveCount(1)
  await expect(page.locator('.canvas-node.kind-library')).toHaveCount(1)
  await expect(page.locator('.canvas-node.kind-prompt .canvas-node-summary').first()).toHaveText(await prompt.inputValue())
  await inspector.getByRole('button', { name: 'Đóng', exact: true }).click()
  await page.locator('.canvas-node.kind-image').first().getByRole('button', { name: 'Xem trước', exact: true }).click()
  await inspector.getByRole('button', { name: 'Quay lại chỉnh sửa', exact: true }).click()
  await expect(inspector.locator('[data-node-kind="image"]')).toBeVisible()
  await expect(inspector.getByRole('combobox', { name: 'Model' })).toBeVisible()
})
