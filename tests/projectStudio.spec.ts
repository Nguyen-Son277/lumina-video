import { expect, test, type Page } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh, waitForGeneration } from './helpers/auth'

async function createProject(page: Page) {
  await page.getByRole('button', { name: 'Tạo dự án', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Tạo dự án' })
  await dialog.getByLabel('Tên dự án').fill('Phim Đà Lạt')
  await dialog.getByLabel('Mô tả', { exact: true }).fill('Một câu chuyện ngắn')
  await dialog.getByLabel('Phong cách chung').fill('Điện ảnh màu nước')
  await dialog.getByRole('button', { name: 'Lưu dự án' }).click()
  await expect(page.getByRole('heading', { name: 'Phim Đà Lạt', exact: true })).toBeVisible()
  // Chờ nội dung dự án tải xong, tránh thao tác vào lúc tab còn đang dựng lại.
  await expect(page.locator('.project-tab-panel')).toBeVisible()
}

async function noOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
}

test('ProjectStudio mặc định: dự án, nhân vật / giọng nói, cảnh, preview, tạo và chọn phiên bản mock', async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  const model = await seedModel(page, provider, { modelId: 'mock-video-model', displayName: 'Mock Video Model', kind: 'video' })
  await page.goto(BASE)
  await expect(page.getByRole('heading', { name: 'Dự án sáng tạo' })).toBeVisible()
  await expect(page.getByPlaceholder('Mô tả điều bạn muốn tạo...')).toHaveCount(0)
  await createProject(page)
  await page.getByRole('tab', { name: 'Nhân vật', exact: true }).click()
  await page.getByRole('button', { name: 'Thêm nhân vật', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Thêm nhân vật' })
  await dialog.getByLabel('Tên', { exact: true }).fill('An')
  await dialog.getByLabel('Ngoại hình').fill('Áo xanh, tóc ngắn')
  const voice = { 'Ngôn ngữ': 'vi', 'Giọng vùng miền': 'Miền Nam', 'Cao độ': 'trầm', 'Âm sắc': 'ấm', 'Tốc độ': 'chậm', 'Phát âm': 'rõ', 'Thói quen nói': 'ngắt nghỉ nhẹ' }
  for (const [label, value] of Object.entries(voice)) await dialog.getByLabel(label, { exact: true }).fill(value)
  await dialog.getByRole('button', { name: 'Lưu nhân vật' }).click()
  await expect(page.locator('.project-character-card')).toContainText('Miền Nam')
  await page.getByRole('tab', { name: 'Cảnh video', exact: true }).click()
  await page.getByRole('button', { name: 'Thêm cảnh', exact: true }).click()
  const editor = page.locator('.project-scene-editor')
  await editor.getByLabel('Tên cảnh').fill('Buổi sáng')
  await editor.getByLabel('Mô tả / hành động').fill('An đi qua rừng thông')
  await editor.getByLabel('Một nhân vật nói').selectOption({ label: 'An' })
  await editor.getByLabel('Lời thoại').fill('Chào Đà Lạt')
  await editor.getByRole('combobox', { name: 'Model video', exact: true }).selectOption(model)
  const generate = editor.getByRole('button', { name: 'Tạo / thử lại phiên bản mới' })
  await expect(generate).toBeDisabled()
  await editor.getByRole('button', { name: 'Lưu & xem trước prompt' }).click()
  const preview = editor.locator('.project-prompt-preview')
  for (const value of ['An đi qua rừng thông', 'Chào Đà Lạt', 'Áo xanh, tóc ngắn', 'Miền Nam', 'Điện ảnh màu nước']) await expect(preview).toContainText(value)
  const responsePromise = page.waitForResponse(r => /\/api\/scenes\/[^/]+\/generate$/.test(r.url()) && r.request().method() === 'POST')
  await generate.click()
  const response = await responsePromise
  expect(response.status()).toBe(202)
  const { generation } = await response.json()
  expect((await waitForGeneration(page, generation.id)).status).toBe('succeeded')
  const choose = editor.getByRole('button', { name: 'Chọn phiên bản này' })
  await expect(choose).toBeEnabled({ timeout: 15_000 })
  await choose.click()
  await expect(editor.getByRole('button', { name: 'Đang chọn', exact: true })).toBeDisabled()
  await expect(page.locator('.project-scene-card')).toContainText('Đã chọn phiên bản')
  await page.reload()
  await page.getByRole('button', { name: /Phim Đà Lạt/ }).click()
  await page.getByRole('tab', { name: 'Cảnh video', exact: true }).click()
  await expect(page.locator('.project-scene-card')).toContainText('Đã chọn phiên bản')
})

for (const width of [320, 390]) {
  test(`ProjectStudio không tràn ngang trên điện thoại ${width}px`, async ({ page }) => {
    await signUpFresh(page)
    await page.setViewportSize({ width, height: 844 })
    await page.goto(BASE)
    await expect(page.getByRole('heading', { name: 'Dự án sáng tạo' })).toBeVisible()
    await noOverflow(page)
    await createProject(page)
    await noOverflow(page)
    await page.getByRole('tab', { name: 'Nhân vật', exact: true }).click()
    await page.getByRole('button', { name: 'Thêm nhân vật' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await noOverflow(page)
    await page.getByRole('button', { name: 'Hủy', exact: true }).click()
    await page.getByRole('tab', { name: 'Cảnh video', exact: true }).click()
    await page.getByRole('button', { name: 'Thêm cảnh' }).click()
    await expect(page.locator('.project-scene-editor')).toBeVisible()
    await noOverflow(page)
  })
}

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

test('tải, xem trước và xóa ảnh tham chiếu của nhân vật', async ({ page }) => {
  await signUpFresh(page)
  const providerId = await seedProvider(page, { name: 'Gateway' })
  await seedModel(page, providerId, { modelId: 'mock-video-model', displayName: 'Model video', kind: 'video' })

  await page.goto(BASE)
  await createProject(page)
  await page.getByRole('tab', { name: 'Nhân vật', exact: true }).click()
  await page.getByRole('button', { name: 'Thêm nhân vật', exact: true }).click()

  const dialog = page.getByRole('dialog', { name: 'Thêm nhân vật' })
  await dialog.getByLabel('Tên', { exact: true }).fill('An')
  await dialog.getByLabel('Giọng vùng miền', { exact: true }).fill('Miền Nam')

  // Chưa chọn ảnh thì chỉ có ô giữ chỗ.
  await expect(dialog.locator('.project-reference-preview img')).toHaveCount(0)

  await dialog.locator('input[type=file]').setInputFiles({
    name: 'an.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_BASE64, 'base64'),
  })
  // Xem trước cục bộ ngay khi chọn tệp.
  await expect(dialog.locator('.project-reference-preview img')).toBeVisible()

  const uploaded = page.waitForResponse(
    (response) => /\/characters\/[^/]+\/reference$/.test(response.url()) && response.request().method() === 'POST',
  )
  await dialog.getByRole('button', { name: 'Lưu nhân vật' }).click()
  expect((await uploaded).status()).toBe(201)

  // Thẻ nhân vật hiển thị ảnh thật từ API có xác thực.
  const avatar = page.locator('.project-character-card .project-character-avatar img')
  await expect(avatar).toBeVisible()
  const src = await avatar.getAttribute('src')
  expect(src).toContain('/api/characters/')
  await expect(page.locator('.project-character-card')).not.toContainText('Chưa có ảnh tham chiếu')

  // Ảnh phải tải được thật, không phải ảnh hỏng.
  expect(
    await avatar.evaluate((element) => (element as HTMLImageElement).naturalWidth > 0),
  ).toBe(true)

  // Cảnh có nhân vật này sẽ có tùy chọn gửi kèm ảnh tham chiếu.
  await page.getByRole('tab', { name: 'Cảnh video', exact: true }).click()
  await page.getByRole('button', { name: 'Thêm cảnh', exact: true }).click()
  const editor = page.locator('.project-scene-editor')
  await editor.getByLabel('Một nhân vật nói').selectOption({ label: 'An' })
  await expect(editor.locator('.project-checkbox')).toBeVisible()
  await expect(editor.locator('.project-checkbox input')).toBeChecked()

  // Mở lại nhân vật để xóa ảnh.
  await page.getByRole('tab', { name: 'Nhân vật', exact: true }).click()
  await page.locator('.project-character-card').getByRole('button', { name: 'Sửa' }).click()
  const editDialog = page.getByRole('dialog', { name: 'Sửa nhân vật / giọng nói' })
  await expect(editDialog.locator('.project-reference-preview img')).toBeVisible()
  await editDialog.getByRole('button', { name: 'Xóa ảnh' }).click()
  await editDialog.getByRole('button', { name: 'Lưu nhân vật' }).click()

  await expect(page.locator('.project-character-card')).toContainText('Chưa có ảnh tham chiếu')
  await expect(page.locator('.project-character-card .project-character-avatar img')).toHaveCount(0)
})

test('tạo ảnh từ ảnh nguồn tải lên', async ({ page }) => {
  await signUpFresh(page)
  const providerId = await seedProvider(page, { name: 'Gateway' })
  await seedModel(page, providerId, { modelId: 'mock-image-model', displayName: 'Model ảnh', kind: 'image' })

  await page.goto(BASE)
  await createProject(page)

  const composer = page.locator('.project-composer')
  const png = {
    name: 'nguon.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_BASE64, 'base64'),
  }

  // Tải ảnh nguồn lên ngay khi chọn.
  const uploaded = page.waitForResponse(
    (response) => /\/api\/uploads$/.test(response.url()) && response.request().method() === 'POST',
  )
  await composer.locator('.project-source-add input[type=file]').setInputFiles([png, png])
  expect((await uploaded).status()).toBe(201)

  const previews = composer.locator('.project-source-item img')
  await expect(previews).toHaveCount(2)
  for (const src of await previews.evaluateAll((items) => items.map((item) => (item as HTMLImageElement).src))) {
    expect(src).toContain('/api/uploads/')
  }

  // Tạo ảnh và kiểm tra ảnh nguồn được gửi kèm.
  await composer.getByLabel('Mô tả ảnh').fill('Chuyển thành tranh màu nước')
  const created = page.waitForRequest(
    (request) => /\/api\/generations$/.test(request.url()) && request.method() === 'POST',
  )
  await composer.getByRole('button', { name: 'Tạo ảnh', exact: true }).click()

  const payload = JSON.parse((await created).postData() ?? '{}') as {
    sourceUploadIds?: string[]
    prompt?: string
  }
  expect(payload.sourceUploadIds).toHaveLength(2)
  expect(payload.prompt).toContain('màu nước')

  // Xóa một ảnh nguồn khỏi danh sách.
  await composer.locator('.project-source-remove').first().click()
  await expect(previews).toHaveCount(1)
})

test('mặc định không gửi trường quality khi tạo ảnh', async ({ page }) => {
  await signUpFresh(page)
  const providerId = await seedProvider(page, { name: 'Gateway' })
  await seedModel(page, providerId, { modelId: 'mock-image-model', displayName: 'Model ảnh', kind: 'image' })

  await page.goto(BASE)
  await createProject(page)

  const composer = page.locator('.project-composer')
  // Mặc định là "Mặc định của model (không gửi)".
  await expect(composer.getByLabel('Chất lượng')).toHaveValue('')

  await composer.getByLabel('Mô tả ảnh').fill('Một khối thuỷ tinh trên nền trắng')
  const created = page.waitForRequest(
    (request) => /\/api\/generations$/.test(request.url()) && request.method() === 'POST',
  )
  await composer.getByRole('button', { name: 'Tạo ảnh', exact: true }).click()

  const payload = JSON.parse((await created).postData() ?? '{}') as {
    params?: Record<string, unknown>
  }
  // Provider không hỗ trợ quality sẽ trả lỗi 400 nếu nhận trường này.
  expect(payload.params ?? {}).not.toHaveProperty('quality')
  expect(payload.params?.size).toBeTruthy()
})
