import { expect, test } from '@playwright/test'
import { BASE, seedLlmModel, seedModel, seedProvider, signUpFresh } from './helpers/auth'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

const referenceFile = {
  name: 'an.png',
  mimeType: 'image/png',
  buffer: Buffer.from(PNG_BASE64, 'base64'),
}

test('AI tạo nhân vật mẫu rồi thêm một nhân vật vào thư viện', async ({ page }) => {
  await signUpFresh(page)
  await seedLlmModel(page)
  await page.goto(BASE)
  await page.getByRole('button', { name: 'Nhân vật', exact: true }).click()

  await page.getByRole('button', { name: 'AI tạo nhân vật', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'AI tạo nhân vật' })
  await expect(dialog).toBeVisible()

  // Nút tạo bị khóa khi chưa có mô tả. Chưa có model ảnh thì chỉ sinh hồ sơ.
  const generate = dialog.getByRole('button', { name: /Tạo \d+ nhân vật/ })
  await expect(generate).toBeDisabled()

  await dialog
    .getByLabel('Mô tả nhân vật')
    .fill('một phi hành gia trẻ, điềm tĩnh, người Việt, mặc đồ bay màu xanh')
  await dialog.getByLabel('Số lượng').selectOption('4')

  const requested = page.waitForRequest(
    (request) =>
      /\/api\/shared-characters\/generate$/.test(request.url()) &&
      request.method() === 'POST',
  )
  await generate.click()
  const payload = JSON.parse((await requested).postData() ?? '{}') as {
    description?: string
    count?: number
  }
  expect(payload.description).toContain('phi hành gia')
  expect(payload.count).toBe(4)

  // Chưa có model ảnh nên ứng viên chưa được lưu: thư viện vẫn trống.
  const cards = dialog.locator('.character-ai-card')
  await expect(cards).toHaveCount(4)
  await expect(page.locator('.character-library-card')).toHaveCount(0)
  await expect(dialog.getByText(/Chưa có model tạo ảnh/)).toBeVisible()

  // Chọn một ứng viên và thêm vào thư viện.
  const first = cards.first()
  const name = (await first.locator('h3').innerText()).trim()
  await first.getByRole('button', { name: 'Thêm vào danh sách' }).click()
  await expect(first.getByRole('button', { name: 'Đã thêm' })).toBeDisabled()

  await expect(page.locator('.character-library-card')).toHaveCount(1)
  await expect(page.locator('.character-library-card')).toContainText(name)

  await dialog.locator('.modal-actions').getByRole('button', { name: 'Đóng' }).click()
  await expect(dialog).toHaveCount(0)

  // Nhân vật đã lưu thật sự: tải lại trang vẫn còn.
  await page.reload()
  await page.getByRole('button', { name: 'Nhân vật', exact: true }).click()
  await expect(page.locator('.character-library-card')).toContainText(name)
})

test('chưa có model LLM & Chat thì AI tạo nhân vật hướng dẫn mở API & Models', async ({ page }) => {
  await signUpFresh(page)
  await page.goto(BASE)
  await page.getByRole('button', { name: 'Nhân vật', exact: true }).click()

  await page.getByRole('button', { name: 'AI tạo nhân vật', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'AI tạo nhân vật' })
  await expect(dialog).toContainText('Chưa có model LLM & Chat')
  await expect(dialog.getByRole('button', { name: /Tạo bằng AI/ })).toHaveCount(0)

  await dialog.getByRole('button', { name: 'Mở API & Models' }).click()
  await expect(page.getByRole('heading', { name: /API/ })).toBeVisible()
})

test('thư viện nhân vật dùng chung: tạo, xem ảnh tham chiếu và xóa', async ({ page }) => {
  await signUpFresh(page)
  await page.goto(BASE)

  // Mục Nhân vật nằm trên sidebar cùng nhóm với Studio.
  await page.getByRole('button', { name: 'Nhân vật', exact: true }).click()
  await expect(page.getByRole('heading', { name: /Nhân vật/ })).toBeVisible()
  await expect(page.getByText('Thư viện nhân vật đang trống')).toBeVisible()

  await page.getByRole('button', { name: 'Tạo nhân vật', exact: true }).click()
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
  await page.getByRole('button', { name: 'Tạo nhân vật', exact: true }).click()
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
  await page.getByRole('button', { name: 'Tạo nhân vật', exact: true }).click()
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

test('phân loại model thành LLM & Chat trong Model catalog', async ({ page }) => {
  await signUpFresh(page)
  const providerId = await seedProvider(page)
  await seedModel(page, providerId, { modelId: 'mock-chat-model', displayName: 'Chat model', kind: 'unclassified' })

  await page.goto(BASE)
  await page.getByRole('button', { name: 'API & Models', exact: true }).click()

  // Không còn tab LLM riêng: chỉ Providers và Model catalog.
  await expect(page.getByRole('button', { name: /LLM & Chat/ })).toHaveCount(0)

  await page.getByRole('button', { name: /Model catalog/ }).click()
  const row = page.locator('.model-row')
  await expect(row).toContainText('Chat model')

  const patched = page.waitForResponse(
    (response) => /\/api\/models\/[^/]+$/.test(response.url()) && response.request().method() === 'PATCH',
  )
  await row.getByLabel('Phân loại Chat model').selectOption('llm')
  await patched
  await expect(row.getByLabel('Phân loại Chat model')).toHaveValue('llm')
  await expect(row.locator('.llm-kind')).toHaveCount(1)

  // Tạo kịch bản AI dùng ngay model vừa phân loại.
  await page.getByRole('button', { name: 'Tạo kịch bản AI', exact: true }).click()
  await expect(page.getByText('Chưa có model LLM & Chat')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Phiên mới' }).first()).toBeVisible()
})

test('chưa có model LLM & Chat thì không tạo được nhân vật bằng AI', async ({ page }) => {
  await signUpFresh(page)
  // Có provider nhưng chưa phân loại model nào thành LLM & Chat.
  const providerId = await seedProvider(page, { baseUrl: 'https://llm.mock.test/v1' })
  await seedModel(page, providerId, { modelId: 'mock-image-model', kind: 'image' })

  await page.goto(BASE)
  await page.getByRole('button', { name: 'Nhân vật', exact: true }).click()
  await page.getByRole('button', { name: 'AI tạo nhân vật', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'AI tạo nhân vật' })

  await expect(dialog.getByText('Chưa có model LLM & Chat')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Tạo bằng AI' })).toHaveCount(0)
})

test('trang Nhân vật và Model catalog không tràn ngang trên điện thoại', async ({ page }) => {
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
    await page.getByRole('button', { name: /Model catalog/ }).click()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1)
  }
})

test('AI tạo nhân vật: một nút tạo cả loạt ảnh sheet, tự lưu, và phóng to được', async ({ page }) => {
  await signUpFresh(page)
  const providerId = await seedProvider(page)
  await seedModel(page, providerId, {
    modelId: 'mock-image-model',
    displayName: 'Model ảnh',
    kind: 'image',
  })
  await seedLlmModel(page)
  await page.goto(BASE)
  await page.getByRole('button', { name: 'Nhân vật', exact: true }).click()

  await page.getByRole('button', { name: 'AI tạo nhân vật', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'AI tạo nhân vật' })
  await dialog.getByLabel('Mô tả nhân vật').fill('một phi hành gia trẻ, điềm tĩnh')
  await dialog.getByLabel('Số lượng').selectOption('2')

  // Cảnh báo chi phí theo số nhân vật, và nằm cùng hàng với tick tự lưu cho gọn.
  await expect(dialog.getByText(/Tối đa/)).toContainText('2')
  const autosaveBox = (await dialog.locator('.character-ai-autosave').boundingBox())!
  const costBox = (await dialog.locator('.character-ai-cost').boundingBox())!
  const centerOf = (box: { y: number; height: number }) => box.y + box.height / 2
  expect(Math.abs(centerOf(autosaveBox) - centerOf(costBox))).toBeLessThan(24)

  // Một nút duy nhất: sinh hồ sơ + ảnh sheet + lưu ngay (mặc định bật).
  await dialog.getByRole('button', { name: /Tạo 2 nhân vật \+ ảnh/ }).click()

  const cards = dialog.locator('.character-ai-card')
  await expect(cards).toHaveCount(2)
  await expect(cards.first().locator('.illustration-image')).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(async () => dialog.locator('.character-ai-status.is-ok').count(), { timeout: 40_000 })
    .toBe(2)

  // Zoom ảnh sheet ngay trong modal.
  await cards.first().locator('.illustration-zoom').click()
  await expect(page.locator('.lightbox-backdrop')).toBeVisible()
  // Đo qua chỉ số phóng của trình xem (ảnh mock rất nhỏ nên bề rộng không đổi).
  await expect(page.locator('.lightbox-percent')).toHaveText('100%')
  await page.locator('.lightbox-toolbar').getByRole('button', { name: 'Phóng to', exact: true }).click()
  await expect(page.locator('.lightbox-percent')).toHaveText('125%')
  await page.keyboard.press('Escape')
  await expect(page.locator('.lightbox-backdrop')).toHaveCount(0)

  await dialog.locator('.modal-actions').getByRole('button', { name: 'Đóng' }).click()

  // Hai nhân vật đã vào thư viện kèm ảnh tham chiếu, không phải bấm từng thẻ.
  const libraryCards = page.locator('.character-library-card')
  await expect(libraryCards).toHaveCount(2)
  await expect(libraryCards.first().locator('.character-library-media img')).toBeVisible({ timeout: 20_000 })

  // Phóng to ảnh tham chiếu đã lưu.
  await libraryCards.first().locator('.character-library-media').click()
  await expect(page.locator('.lightbox-backdrop')).toBeVisible()
  await page.locator('.lightbox-toolbar').getByRole('button', { name: 'Đóng', exact: true }).click()
  await expect(page.locator('.lightbox-backdrop')).toHaveCount(0)
})

test('minh hoạ nhân vật đã lưu sẽ tạo và gắn ảnh tham chiếu', async ({ page }) => {
  await signUpFresh(page)
  const providerId = await seedProvider(page)
  await seedModel(page, providerId, {
    modelId: 'mock-image-model',
    displayName: 'Model ảnh',
    kind: 'image',
  })
  await page.goto(BASE)
  await page.getByRole('button', { name: 'Nhân vật', exact: true }).click()

  await page.getByRole('button', { name: 'Tạo nhân vật', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Thêm nhân vật' })
  await dialog.getByLabel('Tên', { exact: true }).fill('An')
  await dialog.getByLabel('Ngoại hình').fill('Áo xanh, tóc ngắn')
  await dialog.getByRole('button', { name: 'Lưu nhân vật' }).click()

  const card = page.locator('.character-library-card')
  await expect(card).toContainText('Chưa có ảnh tham chiếu')

  await card.getByRole('button', { name: 'Minh hoạ' }).click()
  const illustrate = page.getByRole('dialog', { name: /Minh hoạ nhân vật/ })
  await illustrate.getByRole('button', { name: 'Tạo ảnh minh hoạ' }).click()

  // Ảnh xong thì tự gắn làm ảnh tham chiếu và modal đóng lại.
  await expect(card).not.toContainText('Chưa có ảnh tham chiếu', { timeout: 30_000 })
  await expect(card.locator('.character-library-media img')).toBeVisible({ timeout: 20_000 })
  await expect(illustrate).toHaveCount(0)
})

test('xuất prompt nhân vật để dùng ở công cụ khác', async ({ page }) => {
  await signUpFresh(page)
  await page.goto(BASE)
  await page.getByRole('button', { name: 'Nhân vật', exact: true }).click()

  await page.getByRole('button', { name: 'Tạo nhân vật', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Thêm nhân vật' })
  await dialog.getByLabel('Tên', { exact: true }).fill('An')
  await dialog.getByLabel('Ngoại hình').fill('Áo xanh, tóc ngắn')
  await dialog.getByLabel('Giọng vùng miền', { exact: true }).fill('Miền Nam')
  await dialog.getByLabel('Âm sắc', { exact: true }).fill('Ấm')
  await dialog.getByRole('button', { name: 'Lưu nhân vật' }).click()

  await page.locator('.character-library-card').getByRole('button', { name: 'Prompt' }).click()
  const promptDialog = page.getByRole('dialog', { name: /Prompt nhân vật/ })
  const text = promptDialog.getByLabel('Prompt nhân vật')

  // Prompt phải gồm cả mô tả lẫn giọng nói để dùng được ở nơi khác.
  await expect(text).toHaveValue(/An/, { timeout: 15_000 })
  await expect(text).toHaveValue(/Áo xanh, tóc ngắn/)
  await expect(text).toHaveValue(/Miền Nam/)
  await expect(text).toHaveValue(/Ấm/)
  await expect(text).toHaveValue(/Giữ nguyên ngoại hình và danh tính nhân vật/)
  await expect(promptDialog.getByRole('button', { name: /Sao chép prompt/ })).toBeEnabled()
})

test('chưa có model ảnh thì vùng minh hoạ hướng dẫn thêm model', async ({ page }) => {
  await signUpFresh(page)
  await page.goto(BASE)
  await page.getByRole('button', { name: 'Nhân vật', exact: true }).click()

  await page.getByRole('button', { name: 'Tạo nhân vật', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Thêm nhân vật' })
  await dialog.getByLabel('Tên', { exact: true }).fill('An')
  await dialog.getByRole('button', { name: 'Lưu nhân vật' }).click()

  await page.locator('.character-library-card').getByRole('button', { name: 'Minh hoạ' }).click()
  const illustrate = page.getByRole('dialog', { name: /Minh hoạ nhân vật/ })
  await expect(illustrate.locator('.illustration-empty')).toContainText('Chưa có model tạo ảnh')
  await expect(illustrate.getByRole('button', { name: 'Tạo ảnh minh hoạ' })).toHaveCount(0)
})
