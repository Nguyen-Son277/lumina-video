import { expect, test } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh } from './helpers/auth'

test('chụp ảnh giao diện', async ({ page }) => {
  await signUpFresh(page)

  // Trang đăng nhập.
  await page.context().clearCookies()
  await page.goto(BASE)
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'shots/00-auth.png' })

  // Đăng nhập lại để chụp phần còn lại.
  await signUpFresh(page)
  await page.goto(BASE)
  await page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true }).click()
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'shots/01-studio-empty.png', fullPage: true })

  await page.getByRole('button', { name: 'API & Models', exact: true }).click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'shots/02-providers-empty.png', fullPage: true })

  await page.getByRole('button', { name: /Model catalog/ }).click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'shots/03-catalog-empty.png', fullPage: true })

  await page.getByRole('button', { name: 'Thêm provider' }).first().click()
  await page.getByPlaceholder('Ví dụ: Production gateway').fill('Gateway của tôi')
  await page.getByPlaceholder('https://api.example.com/v1').fill('https://api.example.com/v1')
  await page.getByPlaceholder('sk-••••••••••••••••').fill('sk-demo-key')
  await page.waitForTimeout(200)
  await page.screenshot({ path: 'shots/04-provider-modal.png' })
  await page.getByRole('button', { name: 'Lưu provider' }).click()
  await page.waitForTimeout(400)

  await page.getByRole('button', { name: /Thêm model/ }).first().click()
  await page.getByPlaceholder('Ví dụ: gpt-image-1').fill('mock-image-model')
  await page.getByPlaceholder('Ví dụ: GPT Image 1').fill('Model ảnh demo')
  await page.waitForTimeout(200)
  await page.screenshot({ path: 'shots/05-model-modal.png' })
  await page.getByRole('button', { name: 'Lưu model' }).click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: 'shots/06-catalog-filled.png', fullPage: true })

  await page.getByRole('button', { name: /^Providers/ }).click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'shots/07-providers-filled.png', fullPage: true })

  // Tạo một ảnh thật để chụp trạng thái có kết quả.
  await page.getByRole('button', { name: 'Studio', exact: true }).click()
  await page.getByPlaceholder('Mô tả điều bạn muốn tạo...').fill('Một buổi sáng yên bình ở Đà Lạt')
  await page.getByRole('button', { name: 'Tạo hình ảnh' }).click()
  await page.waitForTimeout(2500)
  await page.screenshot({ path: 'shots/08-studio-ready.png', fullPage: true })

  await page.getByRole('button', { name: /Thư viện/ }).click()
  await page.waitForTimeout(1200)
  await page.screenshot({ path: 'shots/11-library.png', fullPage: true })

  // Giao diện điện thoại: sidebar bị ẩn nên phải mở menu trước khi điều hướng.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'shots/09-mobile-library.png' })
  await page.getByRole('button', { name: 'Mở menu' }).click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: 'shots/10-mobile-nav.png' })
  await page.getByRole('button', { name: 'Studio', exact: true }).click()
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'shots/13-mobile-studio.png' })
})

test('chụp ảnh Studio dự án đã thiết kế lại', async ({ page }) => {
  await signUpFresh(page)
  const providerId = await seedProvider(page, { name: 'OpenAI-compatible', baseUrl: 'https://api.example.com/v1' })
  const imageModel = await seedModel(page, providerId, {
    modelId: 'mock-image-model',
    displayName: 'Model ảnh',
    kind: 'image',
  })
  const videoModel = await seedModel(page, providerId, {
    modelId: 'mock-video-model',
    displayName: 'Model video',
    kind: 'video',
  })

  await page.goto(BASE)
  await page.waitForTimeout(600)
  await page.screenshot({ path: 'shots/20-studio-dashboard-empty.png', fullPage: true })

  // Tạo dự án để chụp không gian làm việc.
  await page.getByRole('button', { name: 'Tạo dự án', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Tạo dự án' })
  await dialog.getByLabel('Tên dự án').fill('Phim ngắn Đà Lạt')
  await dialog.getByLabel('Mô tả').fill('Câu chuyện một ngày ở cao nguyên')
  await dialog.getByLabel('Phong cách chung').fill('Điện ảnh màu nước, ánh sáng ấm')
  await dialog.getByRole('button', { name: 'Lưu dự án' }).click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: 'shots/21-project-images.png', fullPage: true })

  // Ảnh nguồn để tạo ảnh từ ảnh.
  await page.locator('.project-source-add input[type=file]').setInputFiles({
    name: 'nguon.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64',
    ),
  })
  await page.locator('.project-composer').getByLabel('Mô tả ảnh').fill('Chuyển thành tranh màu nước')
  await page.waitForTimeout(700)
  await page.screenshot({ path: 'shots/26-source-images.png', fullPage: true })

  // Nhân vật và hồ sơ giọng nói.
  await page.getByRole('tab', { name: 'Nhân vật', exact: true }).click()
  await page.getByRole('button', { name: 'Thêm nhân vật', exact: true }).click()
  const characterDialog = page.getByRole('dialog', { name: 'Thêm nhân vật' })
  await characterDialog.getByLabel('Tên', { exact: true }).fill('An')
  await characterDialog.getByLabel('Ngoại hình').fill('Áo xanh, tóc ngắn')
  await characterDialog.getByLabel('Giọng vùng miền', { exact: true }).fill('Miền Nam')
  await characterDialog.getByLabel('Âm sắc', { exact: true }).fill('Ấm, hơi trầm')
  // Đính kèm ảnh tham chiếu để chụp đúng trạng thái có ảnh.
  await characterDialog.locator('input[type=file]').setInputFiles({
    name: 'an.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64',
    ),
  })
  await page.waitForTimeout(400)
  await page.screenshot({ path: 'shots/22-character-form.png' })
  await characterDialog.getByRole('button', { name: 'Lưu nhân vật' }).click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: 'shots/23-character-list.png', fullPage: true })

  // Cảnh video kèm xem trước prompt.
  await page.getByRole('tab', { name: 'Cảnh video', exact: true }).click()
  await page.getByRole('button', { name: 'Thêm cảnh', exact: true }).click()
  const editor = page.locator('.project-scene-editor')
  await editor.getByLabel('Tên cảnh').fill('Buổi sáng')
  await editor.getByLabel('Mô tả / hành động').fill('An đi qua rừng thông, sương sớm')
  await editor.getByLabel('Một nhân vật nói').selectOption({ label: 'An' })
  await editor.getByLabel('Lời thoại').fill('Chào Đà Lạt.')
  await editor.getByRole('combobox', { name: 'Model video', exact: true }).selectOption(videoModel)
  await editor.getByRole('button', { name: 'Lưu & xem trước prompt' }).click()
  await page.waitForTimeout(700)
  await page.screenshot({ path: 'shots/24-scene-preview.png', fullPage: true })

  // Điện thoại.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(400)
  await page.screenshot({ path: 'shots/25-mobile-scene.png', fullPage: true })

  void imageModel
})

test('chụp ảnh có sẵn provider và model', async ({ page }) => {
  await signUpFresh(page)
  const providerId = await seedProvider(page, { name: 'OpenAI-compatible', baseUrl: 'https://api.example.com/v1' })
  await seedModel(page, providerId, { modelId: 'img-model', displayName: 'Model ảnh', kind: 'image' })
  await seedModel(page, providerId, { modelId: 'vid-model', displayName: 'Model video', kind: 'video' })

  await page.goto(BASE)
  await page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true }).click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: 'shots/12-studio-configured.png', fullPage: true })
})

test('chụp ảnh xem chi tiết ảnh trong Studio', async ({ page }) => {
  await signUpFresh(page)
  const providerId = await seedProvider(page, { name: 'Gateway' })
  await seedModel(page, providerId, { modelId: 'mock-image-model', displayName: 'Model ảnh', kind: 'image' })

  await page.goto(BASE)
  await page.getByRole('button', { name: 'Tạo dự án', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Tạo dự án' })
  await dialog.getByLabel('Tên dự án').fill('Phim ngắn Đà Lạt')
  await dialog.getByLabel('Phong cách chung').fill('Điện ảnh màu nước, ánh sáng ấm')
  await dialog.getByRole('button', { name: 'Lưu dự án' }).click()
  await expect(page.locator('.project-tab-panel')).toBeVisible()

  const composer = page.locator('.project-composer')
  await composer.getByLabel('Mô tả ảnh').fill('Một buổi sáng yên bình ở Đà Lạt, sương sớm')
  await composer.getByRole('button', { name: 'Tạo ảnh', exact: true }).click()

  const card = page.locator('.project-results .creation-card').first()
  await expect(card.locator('.creation-zoom img')).toBeVisible({ timeout: 20000 })
  await page.screenshot({ path: 'shots/27-studio-results.png', fullPage: true })

  await card.locator('.creation-zoom').click()
  await expect(page.locator('.lightbox-backdrop')).toBeVisible()
  await page.locator('.lightbox-backdrop').getByRole('button', { name: 'Phóng to' }).click()
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'shots/28-lightbox.png' })

  await page.keyboard.press('Escape')
  await expect(page.locator('.lightbox-backdrop')).toHaveCount(0)
  await card.hover()
  await page.screenshot({ path: 'shots/29-card-actions.png' })
})
