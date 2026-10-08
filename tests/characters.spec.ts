import { expect, test } from '@playwright/test'
import { BASE, signUpFresh } from './helpers/auth'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

const referenceFile = {
  name: 'an.png',
  mimeType: 'image/png',
  buffer: Buffer.from(PNG_BASE64, 'base64'),
}

test('thư viện nhân vật dùng chung: tạo, xem ảnh tham chiếu và xóa', async ({ page }) => {
  await signUpFresh(page)
  await page.goto(BASE)

  // Mục Nhân vật nằm trên sidebar cùng nhóm với Studio.
  await page.getByRole('button', { name: 'Nhân vật', exact: true }).click()
  await expect(page.getByRole('heading', { name: /Nhân vật/ })).toBeVisible()
  await expect(page.getByText('Thư viện nhân vật đang trống')).toBeVisible()

  await page.getByRole('button', { name: 'Tạo nhân vật' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Thêm nhân vật' })
  await dialog.getByLabel('Tên', { exact: true }).fill('An')
  await dialog.getByLabel('Ngoại hình').fill('Áo xanh, tóc ngắn')
  await dialog.getByLabel('Giọng vùng miền', { exact: true }).fill('Miền Nam')

  // Xem trước cục bộ ngay khi chọn ảnh, trước cả khi lưu.
  await expect(dialog.locator('.project-reference-preview img')).toHaveCount(0)
  await dialog.locator('input[type=file]').setInputFiles(referenceFile)
  await expect(dialog.locator('.project-reference-preview img')).toBeVisible()

  const uploaded = page.waitForResponse(
    (response) =>
      /\/api\/shared-characters\/[^/]+\/reference$/.test(response.url()) &&
      response.request().method() === 'POST',
  )
  await dialog.getByRole('button', { name: 'Lưu nhân vật' }).click()
  expect((await uploaded).status()).toBe(201)

  // Thẻ nhân vật hiển thị ảnh thật từ API có xác thực.
  const card = page.locator('.character-library-card')
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('An')
  await expect(card).toContainText('Áo xanh, tóc ngắn')
  await expect(card).toContainText('Giọng: Miền Nam')

  const avatar = card.locator('.character-library-media img')
  await expect(avatar).toBeVisible()
  await expect
    .poll(async () => avatar.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0)

  // Bấm ảnh mở trình xem phóng to.
  await card.locator('.creation-zoom').click()
  const lightbox = page.getByRole('dialog', { name: /Xem ảnh/ })
  await expect(lightbox).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(lightbox).toHaveCount(0)

  // Dữ liệu vẫn còn sau khi tải lại trang; mở lại mục Nhân vật để kiểm tra.
  await page.reload()
  await page.getByRole('button', { name: 'Nhân vật', exact: true }).click()
  await expect(page.locator('.character-library-card')).toContainText('An')
  await expect(page.locator('.character-library-media img')).toBeVisible()
})

test('nhân vật dùng chung gửi kèm khi tạo nội dung đơn lẻ', async ({ page }) => {
  await signUpFresh(page)
  await page.goto(BASE)

  // Tạo nhân vật có ảnh tham chiếu trong thư viện.
  await page.getByRole('button', { name: 'Nhân vật', exact: true }).click()
  await page.getByRole('button', { name: 'Tạo nhân vật' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Thêm nhân vật' })
  await dialog.getByLabel('Tên', { exact: true }).fill('Lan')
  await dialog.getByLabel('Ngoại hình').fill('Váy hồng')
  await dialog.locator('input[type=file]').setInputFiles(referenceFile)
  await dialog.getByRole('button', { name: 'Lưu nhân vật' }).click()
  await expect(page.locator('.character-library-card')).toContainText('Lan')

  // Sang trang tạo nội dung đơn lẻ: chọn nhân vật và xác nhận tùy chọn gửi ảnh.
  await page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true }).click()
  const characterSelect = page.locator('.quick-character .select-wrap select')
  await characterSelect.selectOption({ label: 'Lan · có ảnh tham chiếu' })
  await expect(page.locator('.quick-character-preview')).toContainText('Váy hồng')
  const sendReference = page.locator('.quick-character .project-checkbox input')
  await expect(sendReference).toBeChecked()

  // Model ảnh để có thể tạo nội dung.
  const providerResponse = await page.request.post(`${BASE}/api/providers`, {
    data: { name: 'Gateway', baseUrl: 'https://e2e.mock.test/v1', apiKey: 'sk-e2e-test-key' },
  })
  const providerId = ((await providerResponse.json()) as { provider: { id: string } }).provider.id
  await page.request.post(`${BASE}/api/models`, {
    data: { providerId, modelId: 'mock-image-model', displayName: 'Model ảnh', kind: 'image' },
  })
  await page.reload()
  await page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true }).click()
  await page.locator('.quick-character .select-wrap select').selectOption({ label: 'Lan · có ảnh tham chiếu' })
  await page.getByPlaceholder('Mô tả điều bạn muốn tạo...').fill('Lan đi dạo')

  // Request tạo nội dung phải mang characterId và tùy chọn gửi ảnh tham chiếu.
  const created = page.waitForRequest(
    (request) => /\/api\/generations$/.test(request.url()) && request.method() === 'POST',
  )
  await page.getByRole('button', { name: 'Tạo hình ảnh' }).click()
  const payload = JSON.parse((await created).postData() ?? '{}') as {
    characterId?: string
    params?: Record<string, unknown>
  }
  expect(payload.characterId).toBeTruthy()
  expect(payload.params?.useCharacterReference).toBe(true)
})

test('sửa nhân vật thư viện ngay trong Studio phải dùng endpoint dùng chung', async ({ page }) => {
  await signUpFresh(page)
  await page.goto(BASE)

  // Tạo nhân vật thư viện có ảnh tham chiếu.
  await page.getByRole('button', { name: 'Nhân vật', exact: true }).click()
  await page.getByRole('button', { name: 'Tạo nhân vật' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Thêm nhân vật' })
  await dialog.getByLabel('Tên', { exact: true }).fill('Lan')
  await dialog.locator('input[type=file]').setInputFiles(referenceFile)
  await dialog.getByRole('button', { name: 'Lưu nhân vật' }).click()
  await expect(page.locator('.character-library-card')).toContainText('Lan')

  // Vào Studio, tạo dự án rồi mở tab Nhân vật: nhân vật thư viện phải xuất hiện.
  await page.getByRole('button', { name: 'Studio', exact: true }).click()
  await page.getByRole('button', { name: 'Tạo dự án', exact: true }).click()
  const projectDialog = page.getByRole('dialog', { name: 'Tạo dự án' })
  await projectDialog.getByLabel('Tên dự án').fill('Phim')
  await projectDialog.getByRole('button', { name: 'Lưu dự án' }).click()
  await page.getByRole('tab', { name: 'Nhân vật', exact: true }).click()

  const card = page.locator('.project-character-card')
  await expect(card).toContainText('Lan')
  await expect(card).toContainText('Thư viện dùng chung')

  // Sửa và lưu phải gọi endpoint /api/shared-characters, không phải endpoint dự án.
  await card.getByRole('button', { name: 'Sửa' }).click()
  const editDialog = page.getByRole('dialog', { name: 'Sửa nhân vật / giọng nói' })
  await editDialog.getByLabel('Ngoại hình').fill('Áo đỏ')
  const patched = page.waitForRequest(
    (request) =>
      /\/api\/shared-characters\/[^/]+$/.test(request.url()) && request.method() === 'PATCH',
  )
  await editDialog.getByRole('button', { name: 'Lưu nhân vật' }).click()
  expect((await patched).method()).toBe('PATCH')
  await expect(card).toContainText('Áo đỏ')

  // Xóa cũng phải dùng endpoint dùng chung.
  const removed = page.waitForRequest(
    (request) =>
      /\/api\/shared-characters\/[^/]+$/.test(request.url()) && request.method() === 'DELETE',
  )
  await card.getByRole('button', { name: 'Xóa', exact: true }).click()
  await removed
  await expect(page.locator('.project-character-card')).toHaveCount(0)
})

test('tạo nhân vật trong Studio với phạm vi dùng chung', async ({ page }) => {
  await signUpFresh(page)
  await page.goto(BASE)

  await page.getByRole('button', { name: 'Studio', exact: true }).click()
  await page.getByRole('button', { name: 'Tạo dự án', exact: true }).click()
  const projectDialog = page.getByRole('dialog', { name: 'Tạo dự án' })
  await projectDialog.getByLabel('Tên dự án').fill('Phim')
  await projectDialog.getByRole('button', { name: 'Lưu dự án' }).click()
  await page.getByRole('tab', { name: 'Nhân vật', exact: true }).click()
  await page.getByRole('button', { name: 'Thêm nhân vật', exact: true }).click()

  const dialog = page.getByRole('dialog', { name: 'Thêm nhân vật' })
  // Mặc định là dùng chung để nhân vật không bị gắn chết vào dự án.
  await expect(dialog.getByLabel('Phạm vi sử dụng')).toHaveValue('library')
  await dialog.getByLabel('Tên', { exact: true }).fill('Bình')
  await dialog.locator('input[type=file]').setInputFiles(referenceFile)

  // Phải gọi endpoint dùng chung, không phải endpoint của dự án.
  const created = page.waitForRequest(
    (request) =>
      /\/api\/shared-characters$/.test(request.url()) && request.method() === 'POST',
  )
  await dialog.getByRole('button', { name: 'Lưu nhân vật' }).click()
  await created

  const card = page.locator('.project-character-card')
  await expect(card).toContainText('Bình')
  await expect(card).toContainText('Thư viện dùng chung')

  // Nhân vật cũng phải xuất hiện trong thư viện nhân vật.
  await page.getByRole('button', { name: 'Nhân vật', exact: true }).click()
  await expect(page.locator('.character-library-card')).toContainText('Bình')
  await expect(page.locator('.character-library-media img')).toBeVisible()
})

test('quản lý kết nối LLM: chỉ nhập URL + key, model chọn từ dropdown', async ({ page }) => {
  await signUpFresh(page)
  await page.goto(BASE)
  await page.getByRole('button', { name: 'API & Models', exact: true }).click()

  await page.getByRole('button', { name: /LLM & Chat/ }).click()
  await expect(page.getByText('Chưa có kết nối LLM')).toBeVisible()

  await page.getByRole('button', { name: 'Thêm kết nối LLM' }).click()
  const dialog = page.getByRole('dialog', { name: 'Thêm kết nối LLM' })

  // Chỉ cần Base URL và API key. Không có ô nhập model thủ công nào lộ ra.
  await dialog.getByPlaceholder('https://api.openai.com/v1').fill('https://api.openai.com/v1')
  await dialog.locator('input[type=password]').fill('sk-llm-abcd1234')
  await expect(dialog.locator('input[placeholder="Ví dụ: gpt-4o-mini"]')).toHaveCount(0)

  // Bấm tải danh sách model: dropdown phải có model lấy từ /models.
  await dialog.getByRole('button', { name: 'Tải danh sách model' }).click()
  const modelSelect = dialog.getByLabel('Model chat')
  await expect(modelSelect.locator('option')).toContainText(['mock-chat-model', 'mock-script-model'])
  // Model đầu tiên được chọn sẵn để chỉ cần bấm Lưu.
  await expect(modelSelect).toHaveValue('mock-chat-model')

  const saved = page.waitForResponse(
    (response) => /\/api\/llm$/.test(response.url()) && response.request().method() === 'POST',
  )
  await dialog.getByRole('button', { name: 'Lưu kết nối' }).click()
  const payload = JSON.parse((await saved).request().postData() ?? '{}') as {
    name?: string
    modelId?: string
  }
  // Không nhập tên hiển thị: backend tự suy ra từ tên miền.
  expect(payload.name).toBeUndefined()
  expect(payload.modelId).toBe('mock-chat-model')

  // Key không bao giờ hiển thị lại, chỉ 4 ký tự cuối.
  const row = page.locator('.provider-row')
  await expect(row).toContainText('api.openai.com')
  await expect(row).toContainText('••••1234')

  // Đổi model bằng dropdown, không nhập tay.
  await row.getByRole('button', { name: 'Tải model' }).click()
  const rowSelect = row.getByLabel(/Model chat của/)
  await expect(rowSelect.locator('option')).toContainText(['mock-chat-model', 'mock-script-model'])
  const patched = page.waitForResponse(
    (response) => /\/api\/llm\/[^/]+$/.test(response.url()) && response.request().method() === 'PATCH',
  )
  await rowSelect.selectOption('mock-script-model')
  await patched
  await expect(rowSelect).toHaveValue('mock-script-model')

  // Kiểm tra kết nối ở chế độ mock (không gọi mạng ngoài).
  await row.getByRole('button', { name: 'Kiểm tra' }).click()
  await expect(row).toContainText('Đã kết nối')

  await row.getByRole('button', { name: /Xóa kết nối/ }).click()
  await expect(page.getByText('Chưa có kết nối LLM')).toBeVisible()
})

test('trang Nhân vật và tab LLM không tràn ngang trên điện thoại', async ({ page }) => {
  await signUpFresh(page)
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await page.goto(BASE)
    await page.getByRole('button', { name: 'Mở menu' }).click()
    await page.getByRole('button', { name: 'Nhân vật', exact: true }).click()
    await expect(page.getByRole('heading', { name: /Nhân vật/ })).toBeVisible()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1)

    await page.getByRole('button', { name: 'Mở menu' }).click()
    await page.getByRole('button', { name: 'API & Models', exact: true }).click()
    await page.getByRole('button', { name: /LLM & Chat/ }).click()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1)
  }
})
