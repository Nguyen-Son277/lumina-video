import { expect, test } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh, waitForGeneration } from './helpers/auth'

test.beforeEach(async ({ page }) => {
  await signUpFresh(page)
})

test('model video chỉ xuất hiện ở chế độ video', async ({ page }) => {
  const providerId = await seedProvider(page, { name: 'Gateway video' })
  await seedModel(page, providerId, { modelId: 'video-1', displayName: 'Model video', kind: 'video' })

  await page.goto(BASE)
  await page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true }).click()

  // Chế độ ảnh vẫn trống vì chưa có model ảnh.
  await expect(page.getByText('Chưa có model ảnh')).toBeVisible()

  await page.getByRole('button', { name: /Tạo video/ }).first().click()
  await expect(page.getByText('Chưa có model video')).toHaveCount(0)
  // Bám theo nhãn "Model" thay vì chỉ số select, vì Topbar có thêm select ngôn ngữ.
  await expect(page.getByRole('combobox', { name: 'Model', exact: true }).locator('option:checked')).toHaveText('Model video')
})

test('model chưa phân loại không xuất hiện trong Studio', async ({ page }) => {
  const providerId = await seedProvider(page, { name: 'Gateway lạ' })
  await seedModel(page, providerId, { modelId: 'mystery', displayName: 'Model chưa rõ', kind: 'unclassified' })

  await page.goto(BASE)
  await page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true }).click()
  await expect(page.getByText('Chưa có model ảnh')).toBeVisible()

  await page.getByRole('button', { name: 'API & Models', exact: true }).click()
  await page.getByRole('button', { name: /Model catalog/ }).click()
  await expect(page.getByText('Model chưa rõ')).toBeVisible()
})

test('đổi phân loại model trong catalog sẽ đưa model vào Studio', async ({ page }) => {
  const providerId = await seedProvider(page)
  await seedModel(page, providerId, { modelId: 'later', displayName: 'Model sau', kind: 'unclassified' })

  await page.goto(BASE)
  await page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true }).click()
  await page.getByRole('button', { name: 'API & Models', exact: true }).click()
  await page.getByRole('button', { name: /Model catalog/ }).click()

  await page.getByLabel('Phân loại Model sau').selectOption('image')
  await expect(page.getByText('Đã cập nhật phân loại model.')).toBeVisible()

  await page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true }).click()
  // Bám theo nhãn "Model" thay vì chỉ số select, vì Topbar có thêm select ngôn ngữ.
  await expect(page.getByRole('combobox', { name: 'Model', exact: true }).locator('option:checked')).toHaveText('Model sau')
})

test('xóa provider sẽ xóa model liên quan', async ({ page }) => {
  const providerId = await seedProvider(page, { name: 'Gateway tạm' })
  await seedModel(page, providerId, { modelId: 'temp', displayName: 'Model tạm', kind: 'image' })

  await page.goto(BASE)
  await page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true }).click()
  await page.getByRole('button', { name: 'API & Models', exact: true }).click()
  await expect(page.getByText('Gateway tạm')).toBeVisible()

  await page.getByRole('button', { name: 'Xóa provider' }).click()
  await expect(page.getByText('Danh sách provider đang trống')).toBeVisible()

  await page.getByRole('button', { name: /Model catalog/ }).click()
  await expect(page.getByText('Chưa có model nào')).toBeVisible()
})

test('tạo ảnh thật rồi thấy kết quả trong thư viện', async ({ page }) => {
  const providerId = await seedProvider(page)
  await seedModel(page, providerId, { modelId: 'img-1', displayName: 'Model ảnh', kind: 'image' })

  await page.goto(BASE)
  await page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true }).click()
  await page.getByPlaceholder('Mô tả điều bạn muốn tạo...').fill('Một khung cảnh yên bình ở Đà Lạt')
  await page.getByRole('button', { name: 'Tạo hình ảnh' }).click()

  await expect(page.getByText('Đã gửi yêu cầu')).toBeVisible()

  // Thư viện phải hiển thị kết quả với media thật từ API.
  await page.getByRole('button', { name: /Thư viện/ }).click()
  await expect(page.locator('.creation-card')).toHaveCount(1, { timeout: 30_000 })

  const image = page.locator('.creation-card img').first()
  await expect(image).toBeVisible({ timeout: 30_000 })
  const src = await image.getAttribute('src')
  expect(src).toContain('/api/assets/')

  // Ảnh phải tải được thật, không phải ảnh hỏng.
  const loaded = await image.evaluate((element) => (element as HTMLImageElement).naturalWidth > 0)
  expect(loaded).toBe(true)
})

test('tạo video thật và xem được trong thư viện', async ({ page }) => {
  const providerId = await seedProvider(page)
  await seedModel(page, providerId, { modelId: 'vid-1', displayName: 'Model video', kind: 'video' })

  await page.goto(BASE)
  await page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true }).click()
  await page.getByRole('button', { name: /Tạo video/ }).first().click()
  await page.getByPlaceholder('Mô tả điều bạn muốn tạo...').fill('Sóng biển buổi sáng')
  // Nút gửi nằm trong .generate-button để không nhầm với tab chế độ.
  await page.locator('.generate-button', { hasText: 'Tạo video' }).click()

  await page.getByRole('button', { name: /Thư viện/ }).click()
  await expect(page.locator('.creation-card')).toHaveCount(1, { timeout: 30_000 })
  await expect(page.locator('.creation-card video')).toBeVisible({ timeout: 40_000 })
})

test('tài khoản khác không thấy dữ liệu của nhau', async ({ page, browser }) => {
  const providerId = await seedProvider(page, { name: 'Riêng tư' })
  await seedModel(page, providerId, { modelId: 'private', displayName: 'Riêng tư', kind: 'image' })

  await page.goto(BASE)
  await page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true }).click()
  await page.getByRole('button', { name: 'API & Models', exact: true }).click()
  await expect(page.getByText('Riêng tư')).toBeVisible()

  // Mở một context hoàn toàn mới với tài khoản khác.
  const otherContext = await browser.newContext()
  const otherPage = await otherContext.newPage()

  const email = `other-${Date.now()}@gigone.com`
  const response = await otherPage.request.post(`${BASE}/api/auth/register`, {
    data: { email, password: 'matkhau-khac-rat-dai-123' },
  })
  expect(response.ok()).toBe(true)

  await otherPage.goto(BASE)
  await otherPage.getByRole('button', { name: 'API & Models', exact: true }).click()
  await expect(otherPage.getByText('Danh sách provider đang trống')).toBeVisible()
  await expect(otherPage.getByText('Riêng tư')).toHaveCount(0)

  await otherContext.close()
})

test('lịch sử tạo nội dung được giữ sau khi tải lại trang', async ({ page }) => {
  const providerId = await seedProvider(page)
  await seedModel(page, providerId, { modelId: 'persist', displayName: 'Lưu trữ', kind: 'image' })

  const created = await page.request.post(`${BASE}/api/generations`, {
    data: { modelId: (await (await page.request.get(`${BASE}/api/models`)).json()).models[0].id, prompt: 'Lưu qua tải lại' },
  })
  expect(created.status()).toBe(202)

  await page.goto(BASE)
  await page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true }).click()
  await page.getByRole('button', { name: /Thư viện/ }).click()
  await expect(page.locator('.creation-card')).toHaveCount(1, { timeout: 30_000 })
  await expect(page.locator('.creation-card').first()).toContainText('Lưu qua tải lại')
})

test('tác vụ đang chạy vẫn tiếp tục sau khi tải lại trang', async ({ page }) => {
  const providerId = await seedProvider(page)
  const modelId = await seedModel(page, providerId, { modelId: 'reload', displayName: 'Tải lại', kind: 'video' })

  const response = await page.request.post(`${BASE}/api/generations`, {
    data: { modelId, prompt: 'Chạy nền' },
  })
  const body = (await response.json()) as { generation: { id: string } }

  await page.goto(BASE)
  await page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true }).click()
  await page.getByRole('button', { name: /Thư viện/ }).click()
  await expect(page.locator('.creation-card')).toHaveCount(1)

  // Worker ở backend vẫn xử lý dù tab đã tải lại.
  const done = await waitForGeneration(page, body.generation.id)
  expect(done.status).toBe('succeeded')
})

test('đăng xuất đưa về trang đăng nhập', async ({ page }) => {
  await page.goto(BASE)
  await page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true }).click()
  await expect(page.getByRole('heading', { name: /Tạo nội dung/ })).toBeVisible()

  await page.getByRole('button', { name: 'Đăng xuất' }).click()
  await expect(page.getByRole('heading', { name: 'Đăng nhập để tiếp tục' })).toBeVisible()
})

test('giao diện điện thoại mở được menu và API & Models', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(BASE)

  // Sidebar ẩn trên điện thoại nên mở menu rồi mới điều hướng được.
  await page.getByRole('button', { name: 'Mở menu' }).click()
  await page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true }).click()

  await page.getByRole('button', { name: 'Mở menu' }).click()
  await expect(page.getByRole('button', { name: 'API & Models', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'API & Models', exact: true }).click()

  await expect(page.getByText('Danh sách provider đang trống')).toBeVisible()
})
