import { expect, test, type Page } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh } from './helpers/auth'

/**
 * Planner chat requires a chat model, while artifact access stays compact in the toolbar.
 * Surface chat changes are proposals that only persist after user confirmation.
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

test('chat has no script CTA and artifact toolbar stays compact', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await signUpFresh(page)
  await seedPlanner(page)
  await newSession(page)
  await pickChatModel(page)

  await expect(page.locator('.script-cta')).toHaveCount(0)
  const scriptButton = page.locator('.planner-bar-group').getByRole('button', { name: /Draft script|Kịch bản nháp/ })
  await expect(scriptButton).toBeVisible()
  await expect(scriptButton).toHaveClass(/planner-bar-button/)
  await expect(scriptButton).not.toHaveClass(/script-cta/)
  await scriptButton.click()
  await expect(page.locator('.plan-drawer.is-open')).toHaveCount(1)
  await page.getByRole('button', { name: 'Đóng panel' }).click()

  await page.locator('.plan-chat-chips').getByRole('button', { name: 'Viết kịch bản' }).click()
  await expect(page.locator('.plan-scene').first()).toBeVisible({ timeout: 20000 })
  await page.getByRole('button', { name: 'Đóng panel' }).click()
  await scriptButton.click()
  await expect(page.locator('.plan-drawer.is-open')).toHaveCount(1)
  await expect(page.locator('.plan-scene').first()).toBeVisible()
})

test('chat tổng hợp dễ đọc và giữ nguyên sau khi tải lại trên mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await signUpFresh(page)
  await seedPlanner(page)
  await newSession(page)
  await pickChatModel(page)
  await page.locator('.plan-chat textarea').fill('Tổng hợp ý tưởng video tình bạn, 60 giây, tông ấm áp.')
  await page.locator('.planner-composer').getByRole('button', { name: 'Gửi', exact: true }).click()
  const assistant = page.locator('.plan-chat-log .is-assistant .planner-bubble-body')
  await expect(assistant.first()).toBeVisible({ timeout: 20000 })
  await expect(page.locator('.planner-thinking')).toHaveCount(0, { timeout: 20000 })
  const answer = await assistant.first().innerText()
  expect(answer.trim().length).toBeGreaterThan(0)
  expect(answer).not.toMatch(/```|"(?:reply|scenes|characters|run)"\s*:/)
  await page.reload()
  await expect(assistant.first()).toHaveText(answer)
  await expect(page.locator('.script-cta')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
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

test('xóa ảnh frame rồi tạo lại và reload không hồi sinh ảnh cũ', async ({ page }) => {
  await signUpFresh(page)
  await seedPlanner(page)
  await newSession(page)
  await pickChatModel(page)
  await page.locator('.plan-chat-chips').getByRole('button', { name: 'Viết kịch bản' }).click()
  await expect(page.locator('.plan-scene').first()).toBeVisible({ timeout: 20000 })
  await page.getByRole('button', { name: 'Đóng panel' }).click()
  await page.locator('.plan-chat-chips').getByRole('button', { name: 'Lên timeline' }).click()
  await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible({ timeout: 25000 })
  const sessions = await (await page.request.get(`${BASE}/api/plans`)).json()
  const session = sessions.sessions[0]
  const frameId = session.timeline.frames[0].id
  const models = await (await page.request.get(`${BASE}/api/models`)).json()
  await page.request.patch(`${BASE}/api/plans/${session.id}/setup`, { data: { imageModelId: models.models.find((model: any) => model.kind === 'image').id } })
  const root = `${BASE}/api/plans/${session.id}/timeline/${frameId}/background`
  const generate = async (key: string) => {
    const response = await page.request.post(root, { data: { requestKey: key } })
    expect(response.status()).toBe(202)
    const { generation } = await response.json()
    await expect.poll(async () => (await (await page.request.get(`${BASE}/api/generations/${generation.id}`)).json()).generation.status, { timeout: 20000 }).toBe('succeeded')
    expect((await page.request.post(`${root}/attach`, { data: { generationId: generation.id } })).ok()).toBe(true)
    return generation.id
  }
  const original = await generate('original')
  expect((await page.request.delete(root)).ok()).toBe(true)
  await page.reload()
  const removed = await (await page.request.get(`${BASE}/api/plans/${session.id}`)).json()
  expect(removed.session.timeline.frames[0].background).toBeNull()
  expect((await (await page.request.get(`${root}/task`)).json()).task.detachedAt).toBeTruthy()
  expect((await page.request.post(`${root}/attach`, { data: { generationId: original } })).status()).toBe(409)
  expect(await generate('replacement')).not.toBe(original)
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
