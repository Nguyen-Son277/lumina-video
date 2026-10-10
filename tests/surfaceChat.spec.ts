import { expect, test, type Page } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh } from './helpers/auth'

/**
 * Luồng mới của Tạo kịch bản AI:
 *  - cổng chọn model chat trước khi nhắn,
 *  - nút Kịch bản nháp nổi bật,
 *  - chat bối cảnh/timeline chỉ ĐỀ XUẤT, người dùng xác nhận mới ghi.
 */

async function seedPlanner(page: Page): Promise<void> {
  const provider = await seedProvider(page)
  await seedModel(page, provider, { modelId: 'mock-chat-model', displayName: 'Chat', kind: 'llm' })
  await seedModel(page, provider, { modelId: 'mock-image-model', displayName: 'Image', kind: 'image' })
  await seedModel(page, provider, { modelId: 'mock-video-model', displayName: 'Video', kind: 'video' })
}

async function newSession(page: Page): Promise<void> {
  await page.goto(`${BASE}/?page=planner`)
  await page.getByRole('button', { name: 'Phiên mới', exact: true }).first().click()
}

async function pickChatModel(page: Page): Promise<void> {
  const gate = page.locator('.model-gate')
  await expect(gate).toBeVisible()
  await gate.getByRole('combobox', { name: 'Model chat (bắt buộc)' }).selectOption({ index: 1 })
  await expect(gate).toHaveCount(0)
  // Tạo phiên mới mở sẵn popover cấu hình; đóng lại để không che phần còn lại.
  const closeSetup = page.getByRole('button', { name: 'Đóng cấu hình model' })
  if (await closeSetup.count()) await closeSetup.click()
}

test('phiên mới bắt buộc chọn model chat trước khi nhắn', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await signUpFresh(page)
  await seedPlanner(page)
  await newSession(page)

  // Cổng chặn: chưa có model chat thì không nhắn được.
  const gate = page.locator('.model-gate')
  await expect(gate).toBeVisible()
  await expect(gate).toContainText('Chọn model chat để bắt đầu')
  await expect(page.locator('.plan-chat textarea')).toBeDisabled()
  await expect(page.locator('.plan-chat-chips').getByRole('button', { name: 'Viết kịch bản' })).toBeDisabled()

  await pickChatModel(page)

  // Chọn xong mới nhắn được.
  await expect(page.locator('.plan-chat textarea')).toBeEnabled()
  await expect(page.locator('.plan-chat-chips').getByRole('button', { name: 'Viết kịch bản' })).toBeEnabled()
})

test('nút Kịch bản nháp nổi bật mở panel kịch bản', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await signUpFresh(page)
  await seedPlanner(page)
  await newSession(page)
  await pickChatModel(page)

  // Chưa có kịch bản: thẻ CTA nổi bật gợi ý viết.
  const cta = page.locator('.script-cta')
  await expect(cta).toBeVisible()
  await expect(cta).toContainText('Chưa có kịch bản nháp')
  await cta.getByRole('button', { name: 'Mở panel kịch bản nháp' }).click()
  await expect(page.locator('.plan-scene').first()).toBeVisible({ timeout: 20000 })
  await page.getByRole('button', { name: 'Đóng panel' }).click()

  // Có kịch bản: CTA chuyển sang "Xem kịch bản nháp" kèm số cảnh và mở lại panel.
  await expect(cta).toContainText('Xem kịch bản nháp')
  await expect(cta).toContainText('cảnh')
  await cta.getByRole('button', { name: 'Mở panel kịch bản nháp' }).click()
  await expect(page.locator('.plan-drawer.is-open')).toHaveCount(1)
})

test('chat bối cảnh: AI chỉ đề xuất, bỏ thì không đổi, xác nhận mới ghi', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await signUpFresh(page)
  await seedPlanner(page)
  await newSession(page)
  await pickChatModel(page)

  // Mở khu bối cảnh và thêm một bối cảnh.
  await page.getByRole('button', { name: /Bối cảnh & tính liên tục/ }).first().click()
  const panel = page.getByTestId('location-references')
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: 'Thêm bối cảnh', exact: true }).click()
  await page.locator('.locations-dialog').getByLabel('Tên bối cảnh', { exact: true }).fill('Sân ga')
  await page.locator('.locations-dialog').getByRole('button', { name: 'Lưu bối cảnh', exact: true }).click()
  await expect(panel).toContainText('Sân ga')

  // Nút Chat với AI mở cửa sổ chat bên phải.
  await panel.getByRole('button', { name: 'Chat với AI', exact: true }).click()
  const drawer = page.getByRole('dialog', { name: 'Bối cảnh & liên tục' })
  await expect(drawer).toBeVisible()
  const drawerBox = (await drawer.boundingBox())!
  expect(drawerBox.x).toBeGreaterThan(1440 / 2 - 50)

  // Gửi yêu cầu sửa: AI trả thẻ đề xuất, chưa ghi gì.
  await drawer.getByLabel('Tin nhắn cho bề mặt này').fill('Thêm bối cảnh cho cảnh đêm')
  await drawer.getByRole('button', { name: 'Gửi', exact: true }).click()
  const proposal = drawer.locator('.surface-proposal')
  await expect(proposal).toBeVisible({ timeout: 20000 })
  await expect(proposal).toContainText('Đề xuất thay đổi')
  await expect(proposal).toContainText('Thêm')
  await expect(proposal).toContainText('Bối cảnh mới')

  // Bỏ đề xuất: danh sách bối cảnh không đổi.
  await proposal.getByRole('button', { name: 'Bỏ đề xuất', exact: true }).click()
  await expect(drawer.locator('.surface-proposal')).toHaveCount(0)
  await drawer.getByRole('button', { name: 'Đóng chat' }).click()
  await expect(panel.locator('.location-card')).toHaveCount(1)

  // Gửi lại và xác nhận: lúc này mới ghi.
  await panel.getByRole('button', { name: 'Chat với AI', exact: true }).click()
  await drawer.getByLabel('Tin nhắn cho bề mặt này').fill('Thêm bối cảnh cho cảnh đêm')
  await drawer.getByRole('button', { name: 'Gửi', exact: true }).click()
  await expect(drawer.locator('.surface-proposal')).toBeVisible({ timeout: 20000 })
  const applied = page.waitForResponse((response) => /\/propose\/apply$/.test(response.url()))
  await drawer.getByRole('button', { name: 'Áp dụng thay đổi', exact: true }).click()
  const applyResponse = await applied
  expect(applyResponse.status()).toBe(200)
  await expect(drawer.locator('.surface-proposal')).toHaveCount(0)
  await drawer.getByRole('button', { name: 'Đóng chat' }).click()
  await expect(panel.locator('.location-card')).toHaveCount(2)

  // Bền sau khi tải lại.
  await page.reload()
  await page.getByRole('button', { name: /Bối cảnh & tính liên tục/ }).first().click()
  await expect(page.getByTestId('location-references').locator('.location-card')).toHaveCount(2)
})

test('chat timeline: đề xuất rồi xác nhận mới đổi khung', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await signUpFresh(page)
  await seedPlanner(page)
  await newSession(page)
  await pickChatModel(page)

  // Viết kịch bản rồi lên timeline (mở trang Timeline).
  await page.locator('.plan-chat-chips').getByRole('button', { name: 'Viết kịch bản' }).click()
  await expect(page.locator('.plan-scene').first()).toBeVisible({ timeout: 20000 })
  await page.getByRole('button', { name: 'Đóng panel' }).click()
  await page.locator('.plan-chat-chips').getByRole('button', { name: 'Lên timeline' }).click()
  await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible({ timeout: 25000 })

  // Chat trong Timeline: chỉ đề xuất.
  await page.getByRole('button', { name: 'Chat với AI', exact: true }).click()
  const drawer = page.getByRole('dialog', { name: 'Chat với AI về Timeline' })
  await expect(drawer).toBeVisible()
  await drawer.getByLabel('Tin nhắn cho bề mặt này').fill('Khung đầu quay cận cảnh')
  await drawer.getByRole('button', { name: 'Gửi', exact: true }).click()
  const proposal = drawer.locator('.surface-proposal')
  await expect(proposal).toBeVisible({ timeout: 20000 })
  await expect(proposal).toContainText('Góc máy / ghi chú hình')

  // Chưa xác nhận thì timeline chưa đổi (kiểm tra trực tiếp dữ liệu server).
  const framesBefore = await page.request.get(`${BASE}/api/plans`)
  const firstSession = (await framesBefore.json()).sessions[0]
  expect(firstSession.timeline.frames[0].shotNotes).toContain('Toàn cảnh')

  // Bỏ đề xuất rồi gửi lại để xác nhận.
  await proposal.getByRole('button', { name: 'Bỏ đề xuất', exact: true }).click()
  await expect(drawer.locator('.surface-proposal')).toHaveCount(0)
  await drawer.getByLabel('Tin nhắn cho bề mặt này').fill('Khung đầu quay cận cảnh')
  await drawer.getByRole('button', { name: 'Gửi', exact: true }).click()
  await expect(drawer.locator('.surface-proposal')).toBeVisible({ timeout: 20000 })
  const appliedTl = page.waitForResponse((response) => /\/propose\/apply$/.test(response.url()))
  await drawer.getByRole('button', { name: 'Áp dụng thay đổi', exact: true }).click()
  const applyTl = await appliedTl
  expect(applyTl.status()).toBe(200)
  await expect(drawer.locator('.surface-proposal')).toHaveCount(0)
  await drawer.getByRole('button', { name: 'Đóng chat' }).click()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible()
  const framesAfter = await page.request.get(`${BASE}/api/plans`)
  expect((await framesAfter.json()).sessions[0].timeline.frames[0].shotNotes).toContain('Cận cảnh, máy đẩy chậm')
})
