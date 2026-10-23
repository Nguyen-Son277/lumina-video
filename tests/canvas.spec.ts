import { expect, test, type Page } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh } from './helpers/auth'
import { MOCK_PNG_BYTES } from '../server/generations/adapters/mock'

/**
 * Canvas dự án: dựng node, lưu/khôi phục, xem trước rồi chạy.
 *
 * Các bài test dùng provider giả lập nên không gọi model thật; phần "nối dây" được
 * kiểm tra ở backend còn ở đây kiểm tra giao diện thật sự tạo node, lưu và chạy.
 */

async function openCanvas(page: Page, projectName: string): Promise<void> {
  await page.goto(`${BASE}/?page=studio`)
  await page.getByRole('button', { name: new RegExp(projectName) }).click()
  await page.getByRole('tab', { name: 'Canvas' }).click()
  await expect(page.locator('.canvas-flow')).toBeVisible()
}

async function createProject(page: Page, name: string): Promise<string> {
  const response = await page.request.post(`${BASE}/api/projects`, { data: { name } })
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { project: { id: string } }).project.id
}

async function createCharacter(page: Page, name: string): Promise<string> {
  const response = await page.request.post(`${BASE}/api/shared-characters`, {
    data: { name, appearance: 'váy hồng, tóc dài' },
  })
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { character: { id: string } }).character.id
}

async function uploadCharacterReference(page: Page, characterId: string): Promise<void> {
  const response = await page.request.post(`${BASE}/api/shared-characters/${characterId}/reference`, {
    headers: { 'Content-Type': 'image/png' },
    data: MOCK_PNG_BYTES,
  })
  expect(response.ok()).toBe(true)
}

async function uploadItemReference(page: Page, projectId: string, itemId: string): Promise<void> {
  const response = await page.request.post(`${BASE}/api/projects/${projectId}/items/${itemId}/reference`, {
    headers: { 'Content-Type': 'image/png' },
    data: MOCK_PNG_BYTES,
  })
  expect(response.ok()).toBe(true)
}

async function createItem(page: Page, projectId: string, name: string): Promise<string> {
  const response = await page.request.post(`${BASE}/api/projects/${projectId}/items`, {
    data: { kind: 'product', name, description: 'chai thủy tinh nắp vàng' },
  })
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { item: { id: string } }).item.id
}

function graphOf(ids: { characterId: string; itemId: string; modelId: string }) {
  return {
    schemaVersion: 1,
    nodes: [
      { id: 'p1', kind: 'prompt', x: 40, y: 40, data: {
        text: '@lan đặt chai serum lên bàn gỗ',
        promptDocument: { version: 1, text: '@lan đặt chai serum lên bàn gỗ', mentions: [
          { id: 'mention-lan', start: 0, end: 4, label: 'lan', entity: { kind: 'character', id: ids.characterId } },
        ] },
      } },
      { id: 'c1', kind: 'character', x: 40, y: 220, data: { sourceId: ids.characterId } },
      { id: 'i1', kind: 'item', x: 40, y: 400, data: { sourceId: ids.itemId } },
      { id: 'g1', kind: 'image', x: 380, y: 220, data: { modelId: ids.modelId, layout: { aspectRatio: '16:9', instances: [] } } },
    ],
    edges: [
      { id: 'e1', source: 'p1', sourcePort: 'prompt', target: 'g1', targetPort: 'prompt' },
      { id: 'e2', source: 'c1', sourcePort: 'object', target: 'g1', targetPort: 'context' },
      { id: 'e3', source: 'i1', sourcePort: 'object', target: 'g1', targetPort: 'context' },
    ],
  }
}

test.beforeEach(async ({ page }) => {
  await signUpFresh(page)
})

test('thêm node trên bảng, tự lưu và khôi phục sau khi tải lại', async ({ page }) => {
  const projectId = await createProject(page, 'Canvas luu tru')
  await openCanvas(page, 'Canvas luu tru')

  await page.locator('.canvas-tool').first().click()
  await page.getByRole('menuitem', { name: 'Prompt', exact: true }).click()
  await page.locator('.canvas-tool').first().click()
  await page.getByRole('menuitem', { name: 'Tạo ảnh', exact: true }).click()
  await expect(page.locator('.canvas-node')).toHaveCount(2)

  await page.locator('.canvas-node.kind-prompt header').click()
  await page.locator('.canvas-inspector textarea').fill('Một góc bàn gỗ buổi sáng')
  await expect(page.locator('.canvas-save-state')).toHaveText('Đã lưu', { timeout: 20_000 })

  const saved = await page.request.get(`${BASE}/api/projects/${projectId}/canvas`)
  const canvas = ((await saved.json()) as { canvas: { graph: { nodes: unknown[] }; revision: number } }).canvas
  expect(canvas.graph.nodes).toHaveLength(2)
  expect(canvas.revision).toBeGreaterThan(0)

  await openCanvas(page, 'Canvas luu tru')
  await expect(page.locator('.canvas-node')).toHaveCount(2)
  await expect(page.locator('.canvas-node.kind-prompt .canvas-node-summary')).toHaveText('Một góc bàn gỗ buổi sáng')
})

test('xem trước rồi xác nhận chạy node ảnh và nhận kết quả', async ({ page }) => {
  const projectId = await createProject(page, 'Canvas chay anh')
  const provider = await seedProvider(page)
  const modelId = await seedModel(page, provider, { modelId: 'canvas-image', kind: 'image' })
  const characterId = await createCharacter(page, 'Lan')
  const itemId = await createItem(page, projectId, 'Chai serum')
  await uploadCharacterReference(page, characterId)
  await uploadItemReference(page, projectId, itemId)
  const saved = await page.request.put(`${BASE}/api/projects/${projectId}/canvas`, {
    data: { graph: graphOf({ characterId, itemId, modelId }), baseRevision: 0 },
  })
  expect(saved.ok()).toBe(true)

  await openCanvas(page, 'Canvas chay anh')
  await expect(page.locator('.canvas-node')).toHaveCount(4)
  // Cạnh nối được dựng lại từ graph đã lưu.
  await expect(page.locator('.react-flow__edge')).toHaveCount(3)

  // Ảnh bằng chứng cho giao diện bảng (thư mục test-results đã gitignore).
  await page.screenshot({ path: 'test-results/canvas-board.png', fullPage: false })
  await page.locator('.canvas-node.kind-image .canvas-run-button').click()
  const inspector = page.locator('.canvas-inspector')
  await expect(inspector).toContainText('Nội dung sẽ gửi')
  // Prompt gửi đi có mô tả đối tượng thật, không chỉ alias.
  await expect(inspector.locator('pre')).toContainText('chai thủy tinh nắp vàng')
  await expect(inspector).toContainText('Ảnh đầu vào')
  await expect(inspector.locator('.canvas-input-row')).toHaveCount(2)

  await page.getByRole('button', { name: 'Xác nhận và chạy' }).click()
  await expect(page.locator('.canvas-node.kind-image .canvas-output-media')).toBeVisible({ timeout: 45_000 })

  const runs = await page.request.get(`${BASE}/api/projects/${projectId}/canvas/runs`)
  const runList = ((await runs.json()) as { runs: Array<{ nodeId: string; generationId: string }> }).runs
  expect(runList).toHaveLength(1)
  expect(runList[0]!.nodeId).toBe('g1')
})

test('bố trí đối tượng trong khung hình và giữ sau khi tải lại', async ({ page }) => {
  const projectId = await createProject(page, 'Canvas bo tri')
  const provider = await seedProvider(page)
  const modelId = await seedModel(page, provider, { modelId: 'canvas-image', kind: 'image' })
  const characterId = await createCharacter(page, 'Lan')
  const itemId = await createItem(page, projectId, 'Chai serum')
  await uploadCharacterReference(page, characterId)
  await uploadItemReference(page, projectId, itemId)
  await page.request.put(`${BASE}/api/projects/${projectId}/canvas`, {
    data: { graph: graphOf({ characterId, itemId, modelId }), baseRevision: 0 },
  })

  await openCanvas(page, 'Canvas bo tri')
  await page.locator('.canvas-node.kind-image .text-button', { hasText: 'Bố trí cảnh' }).click()
  await expect(page.getByRole('dialog', { name: 'Bố trí khung hình' })).toBeVisible()
  await page.locator('.canvas-layout-objects button').first().click()
  await page.locator('.canvas-layout-objects button').nth(1).click()
  await expect(page.locator('.canvas-layout-instance')).toHaveCount(2)
  await page.screenshot({ path: 'test-results/canvas-layout.png', fullPage: false })

  // Fixture raster hợp lệ được ghép thành ảnh nguồn riêng, không chỉ magic bytes.
  const compositeResponse = page.waitForResponse(response => response.url().includes('/composite') && response.request().method() === 'POST')
  await page.getByRole('dialog', { name: 'Bố trí khung hình' }).getByRole('button', { name: 'Dùng bản bố trí làm ảnh nguồn' }).click()
  const composite = await compositeResponse
  expect(composite.status()).toBe(201)
  expect((await composite.json()).upload.id).toBeTruthy()
  await expect(page.getByRole('dialog', { name: 'Bố trí khung hình' })).toBeHidden()
  await expect(page.locator('.canvas-save-state')).toHaveText('Đã lưu', { timeout: 20_000 })

  await openCanvas(page, 'Canvas bo tri')
  await page.locator('.canvas-node.kind-image .text-button', { hasText: 'Bố trí cảnh' }).click()
  await expect(page.locator('.canvas-layout-instance')).toHaveCount(2)
})

test('tạo sản phẩm mới ngay trong Canvas và gắn vào node', async ({ page }) => {
  const projectId = await createProject(page, 'Canvas san pham')
  const provider = await seedProvider(page)
  await seedModel(page, provider, { modelId: 'canvas-image', kind: 'image' })

  await openCanvas(page, 'Canvas san pham')
  await page.locator('.canvas-tool').first().click()
  await page.getByRole('menuitem', { name: 'Sản phẩm / đạo cụ', exact: true }).click()
  await expect(page.locator('.canvas-node.kind-item')).toHaveCount(1)

  await page.locator('.canvas-node.kind-item').getByRole('button', { name: 'Thêm sản phẩm / đạo cụ' }).click()
  const dialog = page.getByRole('dialog', { name: 'Thêm sản phẩm / đạo cụ' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Tên').fill('Ly sứ trắng')
  await dialog.getByLabel('Ngoại hình').fill('ly sứ trắng viền vàng, thân cao')
  await dialog.getByLabel('Bắt buộc giữ nhất quán').fill('giữ nguyên viền vàng')
  await dialog.getByRole('button', { name: 'Tạo', exact: true }).click()
  await expect(dialog).toHaveCount(0)

  // Vật phẩm vừa tạo được chọn sẵn trên node và đã lưu vào dự án.
  const listed = await page.request.get(`${BASE}/api/projects/${projectId}/items`)
  const items = ((await listed.json()) as { items: Array<{ id: string; name: string; continuityNotes: string }> }).items
  expect(items).toHaveLength(1)
  expect(items[0]!.name).toBe('Ly sứ trắng')
  expect(items[0]!.continuityNotes).toBe('giữ nguyên viền vàng')
  await expect(page.locator('.canvas-node.kind-item .canvas-summary-name')).toHaveText(items[0]!.name)
  await expect(page.locator('.canvas-save-state')).toHaveText('Đã lưu', { timeout: 20_000 })

  await openCanvas(page, 'Canvas san pham')
  await expect(page.locator('.canvas-node.kind-item .canvas-summary-name')).toHaveText(items[0]!.name)
})
