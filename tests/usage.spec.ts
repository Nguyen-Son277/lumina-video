import { expect, test, type Page } from '@playwright/test'
import { BASE, ensureAdminSession, seedModel, seedProvider, signUpFresh, waitForGeneration } from './helpers/auth'

/** Prompt ảnh và nội dung chat dùng để nhận diện sự kiện trong nhật ký. */
const IMAGE_PROMPT = 'Boi canh nhat ky su dung'
const CHAT_TEXT = 'Xin chao nhat ky su dung'
const SESSION_TITLE = 'Phien nhat ky su dung'

/**
 * Dựng dữ liệu tối thiểu cho Nhật ký sử dụng: một ảnh đã tạo xong, một tin nhắn
 * chat có gọi LLM, và đơn giá token của model chat (để chi phí ước tính > 0).
 */
async function seedUsage(page: Page): Promise<{ imageModelId: string; llmModelId: string }> {
  const providerId = await seedProvider(page)
  const imageModelId = await seedModel(page, providerId, {
    modelId: 'mock-image-model',
    displayName: 'Mock Image',
    kind: 'image',
  })
  const llmModelId = await seedModel(page, providerId, {
    modelId: 'mock-chat-model',
    displayName: 'Mock Chat',
    kind: 'llm',
  })

  // 1 ảnh qua API và chờ worker hoàn tất.
  const created = await page.request.post(`${BASE}/api/generations`, {
    data: { modelId: imageModelId, prompt: IMAGE_PROMPT },
  })
  expect(created.status()).toBe(202)
  const image = (await created.json()) as { generation: { id: string } }
  expect((await waitForGeneration(page, image.generation.id)).status).toBe('succeeded')

  // 1 tin nhắn chat qua API: ghi một dòng `llm_usage` gắn với tin nhắn.
  const sessionResponse = await page.request.post(`${BASE}/api/plans`, {
    data: { kind: 'planner', chatModelId: llmModelId, title: SESSION_TITLE },
  })
  expect(sessionResponse.status()).toBe(201)
  const session = (await sessionResponse.json()) as { session: { id: string } }
  const sent = await page.request.post(`${BASE}/api/plans/${session.session.id}/messages`, {
    data: { content: CHAT_TEXT, target: 'script' },
  })
  expect(sent.ok()).toBe(true)

  // Đơn giá token LLM: mock trả token nên chi phí ước tính có ngay.
  const llmPatch = await page.request.patch(`${BASE}/api/models/${llmModelId}`, {
    data: { priceInput1k: 0.01, priceOutput1k: 0.02, priceCurrency: 'USD' },
  })
  expect(llmPatch.ok()).toBe(true)

  return { imageModelId, llmModelId }
}

/** Đọc số từ chuỗi đã định dạng theo ngôn ngữ (`1.234,5` hoặc `1,234.5`). */
function parseLocalizedNumber(text: string | null): number {
  if (!text) return 0
  const digits = text.replace(/[^\d.,-]/g, '')
  // Bỏ dấu phân cách nghìn: dấu xuất hiện ở giữa và theo sau là đúng 3 chữ số.
  const normalized = digits.replace(/[.,](?=\d{3}\b)/g, '')
  return Number(normalized.replace(',', '.'))
}

test('Nhật ký sử dụng: tổng quan, đơn giá, lọc theo loại và tab Tin nhắn', async ({ page }) => {
  await signUpFresh(page)
  await seedUsage(page)

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${BASE}/?page=usage`)
  await expect(page.getByRole('heading', { name: /Nhật ký/ })).toBeVisible()

  // Sự kiện ảnh và LLM đều hiện trong bảng.
  await expect(page.locator('.usage-table')).toContainText(IMAGE_PROMPT)
  await expect(page.locator('.usage-table')).toContainText(CHAT_TEXT)

  // Tổng lượt > 0.
  const totalText = await page.locator('.usage-card').first().locator('strong').textContent()
  expect(parseLocalizedNumber(totalText)).toBeGreaterThan(0)

  // Ảnh chưa có đơn giá nên có lượt chưa ước tính được.
  const costCard = page.locator('.usage-card').filter({ hasText: 'Chi phí ước tính' })
  await expect(costCard).toContainText('chưa ước tính được')

  // Chi phí ước tính > 0 nhờ đơn giá token của model chat.
  expect(parseLocalizedNumber(await costCard.locator('strong').textContent())).toBeGreaterThan(0)

  // Trang Sử dụng không nhập đơn giá nữa: chỉ nhắc và mở sang Model catalog.
  const pricingHint = page.locator('.usage-pricing-hint')
  await expect(pricingHint).toContainText('Đơn giá model đã chuyển')
  await expect(page.locator('.usage-pricing-row')).toHaveCount(0)

  // Nhập đơn giá ảnh ở đúng nơi khai báo model: API & Models → Model catalog.
  await pricingHint.getByRole('button', { name: 'Mở API & Models' }).click()
  await expect(page.getByRole('button', { name: /Model catalog/ })).toHaveClass(/active/)
  const imageRow = page.locator('.model-row').filter({ hasText: 'Mock Image' })
  await imageRow.getByRole('button', { name: 'Đơn giá của Mock Image' }).click()
  await imageRow.getByLabel('Giá mỗi lượt Mock Image').fill('0.5')
  await imageRow.getByRole('button', { name: 'Lưu đơn giá' }).click()
  await expect(imageRow).toContainText('Đã lưu')
  await expect(imageRow.locator('.model-price-summary')).toContainText('0,5 USD')

  // Quay lại Nhật ký sử dụng, tổng hợp phải tính theo đơn giá vừa nhập.
  await page.getByRole('button', { name: 'Sử dụng', exact: true }).click()
  await expect(page.getByRole('heading', { name: /Nhật ký/ })).toBeVisible()
  await page.getByRole('button', { name: 'Tải lại' }).click()
  await expect(costCard).not.toContainText('chưa ước tính được')
  expect(parseLocalizedNumber(await costCard.locator('strong').textContent())).toBeGreaterThan(0)

  // Lọc theo loại LLM: chỉ còn sự kiện chat.
  await page.getByLabel('Loại', { exact: true }).selectOption('llm')
  await expect(page.locator('.usage-table')).toContainText(CHAT_TEXT)
  await expect(page.locator('.usage-table')).not.toContainText(IMAGE_PROMPT)

  // Tab Tin nhắn: hiện vai trò, phiên, preview và số lần gọi LLM.
  await page.getByRole('tab', { name: 'Tin nhắn' }).click()
  const messageList = page.locator('.usage-messages')
  await expect(messageList).toContainText(CHAT_TEXT)
  await expect(messageList).toContainText(SESSION_TITLE)
  await expect(messageList).toContainText('lần gọi LLM')
})

test('Panel quản trị: log toàn hệ thống kèm email người dùng', async ({ page }) => {
  const account = await signUpFresh(page)
  await seedUsage(page)

  // Đổi cookie sang super admin: vỏ quản trị render ở chính URL gốc.
  await ensureAdminSession(page)
  await page.goto(BASE)
  const usageTab = page.locator('.admin-tabs [role="tab"]').nth(1)
  await expect(usageTab).toBeVisible()
  await usageTab.click()

  const panel = page.locator('.usage-admin')
  await expect(panel).toBeVisible()
  const table = panel.locator('.usage-table')
  await expect(table).toContainText(IMAGE_PROMPT)
  await expect(table).toContainText(CHAT_TEXT)
  // Cột người dùng hiện email thật của tài khoản đã tạo sự kiện.
  await expect(table).toContainText(account.email)
})

test('Nhật ký sử dụng không tràn ngang ở 390px', async ({ page }) => {
  await signUpFresh(page)
  await seedUsage(page)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${BASE}/?page=usage`)
  await expect(page.locator('.usage-table')).toBeVisible()
  // Trang chỉ còn lối sang API & Models, không còn ô nhập đơn giá.
  await expect(page.locator('.usage-pricing-hint')).toBeVisible()

  const overflow = await page.evaluate(() => {
    const doc = document.documentElement
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth }
  })
  expect(overflow.scrollWidth, 'trang không được tràn ngang').toBeLessThanOrEqual(overflow.clientWidth + 1)
})
