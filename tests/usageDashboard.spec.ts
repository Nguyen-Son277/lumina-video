import { expect, test, type Page } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh, waitForGeneration } from './helpers/auth'

/** Real API events: unequal image / AI-text counts make the chart meaningful. */
async function seedDashboard(page: Page) {
  const provider = await seedProvider(page, { name: 'Dashboard provider' })
  const imageModel = await seedModel(page, provider, { modelId: 'mock-image-model', displayName: 'Ảnh phong cảnh', kind: 'image' })
  const chatModel = await seedModel(page, provider, { modelId: 'mock-chat-model', displayName: 'Trợ lý nội dung', kind: 'llm' })
  for (const prompt of ['Bình minh trên núi', 'Khu vườn mùa xuân', 'Thành phố về đêm']) {
    const response = await page.request.post(`${BASE}/api/generations`, { data: { modelId: imageModel, prompt } })
    expect(response.status()).toBe(202)
    const body = await response.json() as { generation: { id: string } }
    expect((await waitForGeneration(page, body.generation.id)).status).toBe('succeeded')
  }
  const response = await page.request.post(`${BASE}/api/plans`, { data: { kind: 'planner', chatModelId: chatModel, title: 'Kế hoạch sáng tạo' } })
  expect(response.status()).toBe(201)
  const body = await response.json() as { session: { id: string } }
  for (const content of ['Viết ý tưởng cho bộ ảnh', 'Gợi ý tiêu đề ngắn gọn']) {
    const sent = await page.request.post(`${BASE}/api/plans/${body.session.id}/messages`, { data: { content, target: 'script' } })
    expect(sent.ok()).toBe(true)
  }
}

async function expectNoOverflow(page: Page) {
  const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
  expect(size.scroll, 'dashboard must not overflow horizontally').toBeLessThanOrEqual(size.client + 1)
}

for (const width of [1440, 1024, 390, 320]) {
  test(`dashboard usage: biểu đồ và ảnh chụp ở ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 })
    await signUpFresh(page)
    await seedDashboard(page)
    await page.goto(`${BASE}/?page=usage`)
    await expect(page.getByRole('heading', { name: /Nhật ký/ })).toBeVisible()
    await expect(page.locator('.usage-primary-cards > .usage-card')).toHaveCount(3)
    await expect(page.locator('.usage-primary-cards > .usage-card').first().locator('strong')).toHaveText('5')
    const charts = page.locator('.usage-charts')
    await expect(charts).toBeVisible()
    const images = charts.getByRole('img')
    expect(await images.count()).toBeGreaterThanOrEqual(2)
    for (const image of await images.all()) await expect(image).toHaveAccessibleName(/.+/)
    await expect(page.getByRole('combobox', { name: 'Khoảng thời gian', exact: true })).toHaveValue('7d')
    // Default screenshots deliberately retain progressive disclosure in its closed state.
    await expect(page.locator('details').filter({ has: page.locator('summary', { hasText: 'Chi phí, chi tiết kỹ thuật và cài đặt' }) })).not.toHaveAttribute('open', '')
    await expectNoOverflow(page)
    await page.screenshot({ path: `shots/usage-dashboard-${width}.png`, fullPage: true, animations: 'disabled' })
    const chartDetails = charts.locator('details')
    await chartDetails.locator('summary').click()
    await expect(chartDetails.getByRole('table')).toHaveCount(2)
    for (const table of await chartDetails.getByRole('table').all()) {
      await expect(table).toBeVisible()
      await expect(table).toContainText('Ảnh')
      await expect(table).toContainText('AI văn bản')
    }
    await expectNoOverflow(page)
  })
}

test('dashboard usage: trạng thái rỗng, loại và khoảng thời gian tự chọn', async ({ page }) => {
  await signUpFresh(page)
  await page.goto(`${BASE}/?page=usage`)
  await expect(page.getByRole('heading', { name: 'Không có sự kiện trong khoảng này' })).toBeVisible()
  await expect(page.locator('.usage-primary-cards > .usage-card').first().locator('strong')).toHaveText('0')
  await expectNoOverflow(page)

  await seedDashboard(page)
  await page.getByRole('button', { name: 'Tải lại', exact: true }).click()
  await expect(page.locator('.usage-table')).toContainText('Bình minh trên núi')
  await page.getByLabel('Loại', { exact: true }).selectOption({ label: 'AI văn bản' })
  await expect(page.locator('.usage-table')).toContainText('Viết ý tưởng cho bộ ảnh')
  await expect(page.locator('.usage-table')).not.toContainText('Bình minh trên núi')
  await expect(page.locator('.usage-primary-cards > .usage-card').first().locator('strong')).toHaveText('2')
  await page.getByRole('combobox', { name: 'Khoảng thời gian', exact: true }).selectOption('custom')
  await page.getByLabel('Từ ngày', { exact: true }).fill('2025-03-05')
  await page.getByLabel('Đến ngày', { exact: true }).fill('2025-03-01')
  await expect(page.getByRole('button', { name: 'Xuất CSV', exact: true })).toBeDisabled()
  await page.getByLabel('Đến ngày', { exact: true }).fill('2025-03-06')
  await expect(page.getByRole('button', { name: 'Xuất CSV', exact: true })).toBeEnabled()
  await expect(page.getByRole('heading', { name: 'Không có sự kiện trong khoảng này' })).toBeVisible()
  await page.getByRole('combobox', { name: 'Khoảng thời gian', exact: true }).selectOption('all')
  await expect(page.locator('.usage-table')).toContainText('Viết ý tưởng cho bộ ảnh')
})
