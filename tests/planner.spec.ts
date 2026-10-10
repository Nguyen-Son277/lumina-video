import { expect, test } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh } from './helpers/auth'

for (const width of [1440, 1024, 390]) {
  test(`kịch bản nháp rộng và không chồng chéo ở ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await signUpFresh(page)
    const providerId = await seedProvider(page)
    await seedModel(page, providerId, { modelId: 'mock-chat-model', displayName: 'Chat Model', kind: 'llm' })
    await page.goto(BASE)
    if (width <= 760) await page.getByRole('button', { name: 'Mở menu', exact: true }).click()
    await page.getByRole('button', { name: 'Tạo kịch bản AI', exact: true }).click()
    await page.getByRole('button', { name: 'Phiên mới' }).first().click()
    await page.locator('.plan-chat-chips').getByRole('button', { name: 'Viết kịch bản' }).click()
    const drawer = page.locator('.plan-drawer--script')
    const scene = drawer.locator('.plan-scene').first()
    await expect(scene).toBeVisible()
    await drawer.getByLabel('Tiêu đề cảnh 1', { exact: true }).fill('Một tiêu đề rất dài '.repeat(20))
    await scene.locator('textarea').first().fill('Bối cảnh rất dài với nhiều chi tiết '.repeat(100))
    const metrics = await drawer.evaluate((el) => {
      const rect = el.getBoundingClientRect()
      const badge = el.querySelector('.plan-scene-index')! as HTMLElement
      const head = el.querySelector('.plan-scene-head')!
      const children = [...head.children].map((child) => child.getBoundingClientRect())
      const overlaps = children.some((a, i) => children.slice(i + 1).some((b) =>
        a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top))
      const body = el.querySelector('.plan-drawer-body')!
      return { width: rect.width, badgeOverflow: badge.scrollWidth - badge.clientWidth,
        overflow: body.scrollWidth - body.clientWidth, overlaps,
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
        columns: getComputedStyle(el.querySelector('.plan-row')!).gridTemplateColumns.split(' ').length }
    })
    expect(metrics.width).toBeCloseTo(width <= 760 ? width : Math.min(1100, width * 0.9), 0)
    expect(metrics.badgeOverflow).toBeLessThanOrEqual(1)
    expect(metrics.overflow).toBeLessThanOrEqual(1)
    expect(metrics.pageOverflow).toBeLessThanOrEqual(1)
    expect(metrics.overlaps).toBe(false)
    expect(metrics.columns).toBe(width <= 760 ? 1 : 2)
    await expect(drawer.getByRole('button', { name: 'Lưu nháp', exact: true })).toBeVisible()
    await drawer.getByRole('button', { name: 'Đóng panel', exact: true }).click()
    await expect(page.locator('.plan-drawer.is-open')).toHaveCount(0)
  })
}

/**
 * Luồng Tạo kịch bản AI: chat là bề mặt mặc định, panel artifact mở bằng icon,
 * phiên và cấu hình model nằm sau icon, và chat hoạt động như một agent.
 *
 * Bài test dùng model mock nên không gọi provider thật, nhưng vẫn đi qua đúng
 * pipeline tạo nội dung (worker + hàng đợi).
 */
test('Tạo kịch bản AI: chat mặc định, panel mở bằng icon, agent tự chạy bước', async ({ page }) => {
  await signUpFresh(page)
  const providerId = await seedProvider(page)
  await seedModel(page, providerId, {
    modelId: 'mock-chat-model',
    displayName: 'Chat Model',
    kind: 'llm',
  })
  await seedModel(page, providerId, {
    modelId: 'mock-image-model',
    displayName: 'Image Model',
    kind: 'image',
  })
  await seedModel(page, providerId, {
    modelId: 'mock-video-model',
    displayName: 'Video Model',
    kind: 'video',
  })

  await page.goto(BASE)
  await page.getByRole('button', { name: 'Tạo kịch bản AI', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Tạo kịch bản AI' })).toBeVisible()

  await page.getByRole('button', { name: 'Phiên mới' }).first().click()

  // Chat là bề mặt mặc định và lớn; panel artifact đóng cho tới khi được mở.
  await expect(page.locator('.plan-chat')).toBeVisible()
  await expect(page.locator('.plan-drawer.is-open')).toHaveCount(0)
  // Chat phải thực sự lớn (không còn bị cột phiên/thanh setup thu hẹp) và nằm gọn
  // trong màn hình: người dùng không phải cuộn xuống mới thấy khung chat.
  const geometry = await page.evaluate(() => {
    const chat = document.querySelector('.plan-chat')!.getBoundingClientRect()
    const doc = document.documentElement
    return { chatHeight: chat.height, chatBottom: chat.bottom, viewport: window.innerHeight, scrollHeight: doc.scrollHeight, clientHeight: doc.clientHeight }
  })
  expect(geometry.chatHeight).toBeGreaterThan(340)
  expect(geometry.chatBottom).toBeLessThanOrEqual(geometry.viewport + 1)
  expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight + 1)

  // Cấu hình model nằm sau một icon, không chiếm chỗ.
  await expect(page.getByRole('combobox', { name: 'Model chat AI', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Cấu hình model' }).click()
  await expect(page.getByRole('combobox', { name: 'Model chat AI', exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Model AI hình ảnh', exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Model video', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Đóng cấu hình model' }).click()

  // Danh sách phiên cũng nằm sau icon.
  await page.getByRole('button', { name: 'Danh sách phiên' }).click()
  await expect(page.getByRole('dialog', { name: 'Danh sách phiên' })).toBeVisible()
  await page.getByRole('button', { name: 'Đóng danh sách phiên' }).click()

  // Chip hành động nhanh: viết kịch bản rồi mở đúng panel.
  await page.locator('.plan-chat-chips').getByRole('button', { name: 'Viết kịch bản' }).click()
  await expect(page.locator('.plan-drawer.is-open')).toHaveCount(1)
  const drawerBox = (await page.locator('.plan-drawer').boundingBox())!
  expect(drawerBox.width).toBeGreaterThan(360)
  await expect(page.locator('.plan-scene').first()).toBeVisible({ timeout: 20000 })
  await page.getByRole('button', { name: 'Đóng panel' }).click()
  await expect(page.locator('.plan-drawer.is-open')).toHaveCount(0)

  // Chat kiểu agent: yêu cầu timeline thì AI chạy bước đó và mở luôn trang Timeline.
  await page.locator('.plan-chat textarea').fill('Lên timeline cho tôi')
  await page.locator('.plan-chat .generate-button').click()
  await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible({ timeout: 25000 })

  // Storyboard ngang: mỗi frame một thẻ có thời gian, số người, hành động riêng.
  const cards = page.locator('.board-card:not(.board-card-add)')
  await expect(cards.first()).toBeVisible({ timeout: 20000 })
  await expect(cards.first().locator('.board-time')).toContainText('0:00')
  await expect(cards.first().locator('.board-chips span').first()).toBeVisible()

  // Chốt vào Studio: tạo dự án với cảnh chưa duyệt.
  const applied = page.waitForResponse((response) => /\/api\/plans\/[^/]+\/apply$/.test(response.url()))
  await page.locator('.board-heading-actions').getByRole('button', { name: 'Chốt & tạo dự án' }).click()
  const projectDialog = page.getByRole('dialog', { name: 'Chốt & tạo dự án', exact: true })
  await expect(projectDialog).toBeVisible()
  await projectDialog.getByRole('button', { name: 'Xác nhận tạo dự án' }).click()
  expect((await applied).status()).toBe(201)
})

test('chat vẫn nằm gọn trong màn hình ở cửa sổ thấp', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 })
  await signUpFresh(page)
  const providerId = await seedProvider(page)
  await seedModel(page, providerId, {
    modelId: 'mock-chat-model',
    displayName: 'Chat Model',
    kind: 'llm',
  })

  await page.goto(BASE)
  await page.getByRole('button', { name: 'Tạo kịch bản AI', exact: true }).click()
  await page.getByRole('button', { name: 'Phiên mới' }).first().click()
  await expect(page.locator('.plan-chat')).toBeVisible()

  const geometry = await page.evaluate(() => {
    const chat = document.querySelector('.plan-chat')!.getBoundingClientRect()
    const doc = document.documentElement
    return { chatBottom: chat.bottom, viewport: window.innerHeight, scrollHeight: doc.scrollHeight, clientHeight: doc.clientHeight }
  })
  expect(geometry.chatBottom).toBeLessThanOrEqual(geometry.viewport + 1)
  expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight + 1)
})

test('panel artifact nhớ trạng thái mở sau khi tải lại trang', async ({ page }) => {
  await signUpFresh(page)
  const providerId = await seedProvider(page)
  await seedModel(page, providerId, {
    modelId: 'mock-chat-model',
    displayName: 'Chat Model',
    kind: 'llm',
  })

  await page.goto(BASE)
  await page.getByRole('button', { name: 'Tạo kịch bản AI', exact: true }).click()
  await page.getByRole('button', { name: 'Phiên mới' }).first().click()

  await page.locator('.planner-bar').getByRole('button', { name: 'Timeline' }).click()
  await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible()

  // Tải lại trang vẫn ở đúng trang Timeline và đúng phiên (lưu trong URL).
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible()
  await expect(page.getByRole('button', { name: /AI lên timeline/ }).first()).toBeVisible()
})

test('Timeline node: dây nối thể hiện thứ tự và kéo node để nối lại chuỗi', async ({ page }) => {
  await signUpFresh(page)
  const providerId = await seedProvider(page)
  await seedModel(page, providerId, {
    modelId: 'mock-chat-model',
    displayName: 'Chat Model',
    kind: 'llm',
  })
  await page.goto(BASE)
  await page.getByRole('button', { name: 'Tạo kịch bản AI', exact: true }).click()
  await page.getByRole('button', { name: 'Phiên mới' }).first().click()
  await page.locator('.plan-chat-chips').getByRole('button', { name: 'Viết kịch bản' }).click()
  await expect(page.locator('.plan-scene').first()).toBeVisible({ timeout: 20000 })
  await page.getByRole('button', { name: 'Đóng panel' }).click()
  await page.locator('.plan-chat-chips').getByRole('button', { name: 'Lên timeline' }).click()
  await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible({ timeout: 25000 })

  const nodes = page.locator('.board-node')
  await expect(nodes).toHaveCount(2)
  // Hai node thì có đúng một dây nối giữa chúng.
  await expect(page.locator('.board-link')).toHaveCount(1)

  const firstTitle = await nodes.first().locator('.board-card-title strong').textContent()
  const secondTitle = await nodes.nth(1).locator('.board-card-title strong').textContent()
  expect(firstTitle).not.toBe(secondTitle)

  // Kéo node thứ hai lên trước node thứ nhất để nối lại chuỗi.
  await nodes.nth(1).dragTo(nodes.nth(0))
  await expect(nodes.first().locator('.board-card-title strong')).toHaveText(secondTitle!)

  // Lưu rồi tải lại: thứ tự mới vẫn còn.
  await page.locator('.board-legend').getByRole('button', { name: 'Lưu thay đổi' }).click()
  await expect(page.getByRole('button', { name: 'Lưu thay đổi' }).first()).toBeDisabled({ timeout: 15000 })
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible()
  await expect(page.locator('.board-node').first().locator('.board-card-title strong')).toHaveText(
    secondTitle!,
    { timeout: 20000 },
  )
  await expect(page.locator('.board-link')).toHaveCount(1)
})

test('Timeline: sửa người/hành động, đổi thứ tự frame và AI sắp xếp lại', async ({ page }) => {
  await signUpFresh(page)
  const providerId = await seedProvider(page)
  await seedModel(page, providerId, {
    modelId: 'mock-chat-model',
    displayName: 'Chat Model',
    kind: 'llm',
  })
  await page.goto(BASE)
  await page.getByRole('button', { name: 'Tạo kịch bản AI', exact: true }).click()
  await page.getByRole('button', { name: 'Phiên mới' }).first().click()

  // Kịch bản nháp rồi lên timeline (mở thẳng trang Timeline).
  await page.locator('.plan-chat-chips').getByRole('button', { name: 'Viết kịch bản' }).click()
  await expect(page.locator('.plan-scene').first()).toBeVisible({ timeout: 20000 })
  await page.getByRole('button', { name: 'Đóng panel' }).click()
  await page.locator('.plan-chat-chips').getByRole('button', { name: 'Lên timeline' }).click()
  await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible({ timeout: 25000 })

  const cards = page.locator('.board-card:not(.board-card-add)')
  await expect(cards).toHaveCount(2)
  // Thời gian cộng dồn từ thời lượng từng frame.
  await expect(page.locator('.board-time').first()).toHaveText('0:00–0:08')
  await expect(cards.nth(1).locator('.board-chips span')).toHaveCount(2)

  // Chọn frame 2 và sửa hành động riêng của người đầu tiên.
  await cards.nth(1).click()
  const editor = page.locator('.board-editor')
  await expect(editor).toBeVisible()
  await expect(editor.getByText('Nhân vật trong frame (2)')).toBeVisible()
  await editor.getByLabel('Hành động của nhân vật 1').fill('vẫy tay chào')
  await editor.getByLabel('Biểu cảm của nhân vật 1').fill('mắt mở to, khoé miệng nhếch')
  await editor.getByLabel('Nhịp hành động của frame đang chọn').fill('0–3s đứng yên, 3–8s vẫy tay')
  await expect(cards.nth(1).locator('.board-chips')).toContainText('vẫy tay chào')

  // Đổi hướng cuộn của dải storyboard chứ không phải cuộn trang.
  const pageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )
  expect(pageOverflow).toBeLessThanOrEqual(1)

  // AI sắp xếp lại đúng frame đang chọn.
  await editor.getByRole('button', { name: /AI sắp xếp frame/ }).click()
  await expect(editor.getByLabel('Hành động của nhân vật 1')).toHaveValue(
    /hoạt động nhịp nhàng/,
    { timeout: 25000 },
  )

  await page.getByRole('button', { name: 'Chat với AI', exact: true }).click()
  const chatDrawer = page.getByRole('dialog', { name: 'Chat với AI về Timeline' })
  await expect(chatDrawer).toBeVisible()
  const longDraft = 'Nội dung chưa gửi\n'.repeat(20)
  await chatDrawer.getByLabel('Nội dung tin nhắn timeline').fill(longDraft)
  const inputHeight = (await chatDrawer.getByLabel('Nội dung tin nhắn timeline').boundingBox())!.height
  expect(inputHeight).toBeGreaterThan(64)
  expect(inputHeight).toBeLessThanOrEqual(page.viewportSize()!.height * 0.3 + 2)
  await page.keyboard.press('Escape')
  await expect(chatDrawer).toHaveCount(0)
  await page.getByRole('button', { name: 'Chat với AI', exact: true }).click()
  await expect(chatDrawer.getByLabel('Nội dung tin nhắn timeline')).toHaveValue(longDraft)
  await chatDrawer.getByRole('button', { name: 'Đóng chat' }).click()

  let applies = 0
  page.on('request', (request) => { if (/\/apply$/.test(request.url())) applies += 1 })
  await page.locator('.board-heading-actions').getByRole('button', { name: 'Chốt & tạo dự án' }).click()
  const projectDialog = page.getByRole('dialog', { name: 'Chốt & tạo dự án', exact: true })
  await expect(projectDialog.getByLabel('Tên dự án mới')).toBeVisible()
  expect(applies).toBe(0)
  await projectDialog.getByRole('checkbox').check()
  await expect(projectDialog.getByRole('button', { name: 'Xác nhận tạo dự án' })).toBeDisabled()
  await projectDialog.getByRole('button', { name: 'Huỷ', exact: true }).click()

  // AI sắp xếp đã tự lưu (nút Lưu thay đổi hết bật): tải lại vẫn còn dữ liệu.
  await expect(page.getByRole('button', { name: 'Lưu thay đổi' }).first()).toBeDisabled()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible()
  await expect(page.locator('.board-chips').nth(1)).toContainText('hoạt động nhịp nhàng', {
    timeout: 20000,
  })
  // Biểu cảm và nhịp hành động vẫn còn sau khi tải lại.
  await page.locator('.board-card:not(.board-card-add)').nth(1).click()
  await expect(page.locator('.board-editor').getByLabel('Biểu cảm của nhân vật 1')).toHaveValue(/mắt/)
  await expect(page.locator('.board-editor').getByLabel('Nhịp hành động của frame đang chọn')).toHaveValue(/0–3s/)
})

test('ảnh tham chiếu nhân vật sinh từ trang thiết kế và mở lớn được', async ({ page }) => {
  await signUpFresh(page)
  const providerId = await seedProvider(page)
  await seedModel(page, providerId, {
    modelId: 'mock-chat-model',
    displayName: 'Chat Model',
    kind: 'llm',
  })
  await seedModel(page, providerId, {
    modelId: 'mock-image-model',
    displayName: 'Image Model',
    kind: 'image',
  })

  await page.goto(BASE)
  await page.getByRole('button', { name: 'Tạo kịch bản AI', exact: true }).click()
  await page.getByRole('button', { name: 'Phiên mới' }).first().click()

  // Chọn model ảnh cho phiên (ảnh chân dung dùng model này).
  await page.getByRole('button', { name: 'Cấu hình model' }).click()
  await page.getByRole('combobox', { name: 'Model AI hình ảnh', exact: true }).selectOption({ index: 1 })
  await page.getByRole('button', { name: 'Đóng cấu hình model' }).click()

  // Cần kịch bản nháp trước khi đề xuất nhân vật.
  await page.locator('.plan-chat-chips').getByRole('button', { name: 'Viết kịch bản' }).click()
  await expect(page.locator('.plan-scene').first()).toBeVisible({ timeout: 20000 })
  await page.getByRole('button', { name: 'Đóng panel' }).click()

  // Chip "Đề xuất nhân vật" mở panel Nhân vật và sinh danh sách.
  await page.locator('.plan-chat-chips').getByRole('button', { name: 'Đề xuất nhân vật' }).click()
  await expect(page.getByRole('heading', { name: 'Thiết kế nhân vật', exact: true })).toBeVisible({ timeout: 20000 })
  await expect(page.getByRole('textbox',{name:'Màu da',exact:true})).toHaveValue('Da nâu sáng')
  await expect(page.getByRole('textbox',{name:'Chiều cao (cm)',exact:true})).toHaveValue('172')
  await page.getByRole('button', { name: 'Tạo ảnh nhân vật', exact: true }).click()
  await expect(page.locator('.pc-portrait-image img')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.pc-portrait-image a')).toHaveAttribute('target', '_blank')
})

test('ô nhập tin nhắn tự giãn, tối đa 30% chiều cao màn hình', async ({ page }) => {
  await signUpFresh(page)
  const providerId = await seedProvider(page)
  await seedModel(page, providerId, {
    modelId: 'mock-chat-model',
    displayName: 'Chat Model',
    kind: 'llm',
  })

  await page.goto(BASE)
  await page.getByRole('button', { name: 'Tạo kịch bản AI', exact: true }).click()
  await page.getByRole('button', { name: 'Phiên mới' }).first().click()

  const box = page.getByLabel('Nội dung tin nhắn')
  await expect(box).toBeVisible()
  const heightOf = async () => (await box.boundingBox())!.height
  const base = await heightOf()
  expect(base).toBeLessThan(120)

  // Gõ đoạn dài: ô cao lên để đọc lại được toàn bộ nội dung.
  const long = Array.from(
    { length: 16 },
    (_, index) => `Dòng ${index + 1}: mô tả cảnh quay buổi sáng ở thành phố ven biển.`,
  ).join('\n')
  await box.fill(long)
  await expect.poll(heightOf).toBeGreaterThan(base)

  // Nhưng không vượt quá 30% chiều cao màn hình.
  const viewport = await page.evaluate(() => window.innerHeight)
  expect(await heightOf()).toBeLessThanOrEqual(viewport * 0.3 + 2)

  // Chạm trần thì cuộn bên trong ô và không cao thêm nữa.
  const metrics = await box.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }))
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight)
  const atMax = await heightOf()
  await box.fill(`${long}\nThêm một dòng nữa để chắc chắn ô không vượt trần.`)
  expect(await heightOf()).toBeLessThanOrEqual(atMax + 2)

  // Bố cục vẫn gọn trong màn hình, không sinh cuộn trang.
  const layout = await page.evaluate(() => {
    const chat = document.querySelector('.plan-chat')!.getBoundingClientRect()
    const doc = document.documentElement
    return {
      bottom: chat.bottom,
      viewport: window.innerHeight,
      scrollHeight: doc.scrollHeight,
      clientHeight: doc.clientHeight,
    }
  })
  expect(layout.bottom).toBeLessThanOrEqual(layout.viewport + 1)
  expect(layout.scrollHeight).toBeLessThanOrEqual(layout.clientHeight + 1)

  // Xoá nội dung: ô co lại như ban đầu.
  await box.fill('')
  await expect.poll(heightOf).toBeLessThanOrEqual(base + 4)
})

test('Timeline: sinh tất cả ảnh storyboard và theo dõi tiến trình từng frame', async ({ page }) => {
  await signUpFresh(page)
  const providerId = await seedProvider(page)
  await seedModel(page, providerId, {
    modelId: 'mock-chat-model',
    displayName: 'Chat Model',
    kind: 'llm',
  })
  await seedModel(page, providerId, {
    modelId: 'mock-image-model',
    displayName: 'Image Model',
    kind: 'image',
  })

  await page.goto(BASE)
  await page.getByRole('button', { name: 'Tạo kịch bản AI', exact: true }).click()
  await page.getByRole('button', { name: 'Phiên mới' }).first().click()
  await page.locator('.plan-chat-chips').getByRole('button', { name: 'Viết kịch bản' }).click()
  await expect(page.locator('.plan-scene').first()).toBeVisible({ timeout: 20000 })
  await page.getByRole('button', { name: 'Đóng panel' }).click()
  await page.locator('.plan-chat-chips').getByRole('button', { name: 'Lên timeline' }).click()
  await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible({ timeout: 25000 })

  // Chọn model ảnh cho phiên ngay trên trang Timeline.
  await page.getByLabel('Model ảnh').selectOption({ index: 1 })

  // Xác nhận chi phí trước khi chạy batch.
  await page.getByRole('button', { name: 'Sinh tất cả ảnh' }).click()
  await expect(page.locator('.board-batch-panel')).toContainText('2 frame')
  const started = page.getByRole('button', { name: /Bắt đầu sinh 2 ảnh/ })
  await started.click()

  // Tiến trình hiển thị và cả hai frame đều có ảnh storyboard.
  await expect(page.locator('.board-batch-count')).toContainText('2/2 ảnh xong', { timeout: 40000 })
  await expect(page.locator('.board-batch-count')).toContainText('hoàn tất')
  const cards = page.locator('.board-card:not(.board-card-add)')
  await expect(cards.nth(0).locator('.board-image img')).toBeVisible({ timeout: 20000 })
  await expect(cards.nth(1).locator('.board-image img')).toBeVisible({ timeout: 20000 })

  // Ảnh storyboard phóng to được.
  await cards.nth(0).locator('.illustration-zoom').click()
  await expect(page.locator('.lightbox-backdrop')).toBeVisible()
  await expect(page.locator('.lightbox-percent')).toHaveText('100%')
  await page.locator('.lightbox-toolbar').getByRole('button', { name: 'Đóng', exact: true }).click()

  // Tải lại trang vẫn thấy batch đã xong (trạng thái nằm ở server).
  await page.reload()
  await expect(page.locator('.board-batch-count')).toContainText('hoàn tất', { timeout: 20000 })
})

/**
 * Trang Timeline khi chưa gắn phiên nào là danh sách timeline dạng thẻ giống
 * dashboard dự án ở Studio: ảnh bìa storyboard, trạng thái phiên và quy mô.
 */
test('Timeline: danh sách phiên hiển thị dạng thẻ và mở được storyboard', async ({ page }) => {
  await signUpFresh(page)

  // Tạo một phiên rỗng qua API để danh sách có dữ liệu (không cần model).
  const created = await page.request.post(`${BASE}/api/plans`, { data: { kind: 'planner' } })
  expect(created.ok()).toBe(true)

  // Mở trang Timeline không kèm phiên: thấy lưới thẻ thay vì danh sách nút chữ.
  await page.goto(`${BASE}/?page=timeline`)
  await expect(page.getByRole('heading', { name: 'Danh sách timeline' })).toBeVisible()
  const cards = page.locator('.board-session-card')
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText('Phiên chưa đặt tên')
  await expect(cards.first().locator('.board-session-status')).toHaveText('Chưa chọn model')
  await expect(cards.first()).toContainText('0 frame')
  await expect(cards.first()).toContainText('0 nhân vật')
  await expect(cards.first()).toContainText('Chưa có ảnh storyboard')

  // Bấm thẻ để mở storyboard của đúng phiên đó.
  await cards.first().getByRole('button').click()
  await expect(page.getByRole('heading', { name: 'Timeline', exact: true })).toBeVisible()
  await expect(page).toHaveURL(/session=/)

  // Quay lại danh sách thẻ từ trang storyboard.
  await page.locator('.board-heading-links').getByRole('button', { name: 'Danh sách timeline' }).click()
  await expect(page.getByRole('heading', { name: 'Danh sách timeline' })).toBeVisible()
  await expect(page).not.toHaveURL(/session=/)
})
