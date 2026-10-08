import { expect, test, type Page } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh } from './helpers/auth'

/**
 * Kiểm tra bố cục Studio mới: ưu tiên media, hai cột khi soạn nội dung,
 * và các điều khiển nâng cao được ẩn gọn.
 */

async function createProject(page: Page, name = 'Phim ngắn Đà Lạt') {
  await page.getByRole('button', { name: 'Tạo dự án', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Tạo dự án' })
  await dialog.getByLabel('Tên dự án').fill(name)
  await dialog.getByRole('button', { name: 'Lưu dự án' }).click()
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
}

async function columns(page: Page, selector: string) {
  return page.locator(selector).evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)
}

test('bảng dự án hiển thị dạng lưới nhiều cột trên desktop', async ({ page }) => {
  await signUpFresh(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(BASE)
  await expect(page.getByRole('heading', { name: 'Dự án sáng tạo' })).toBeVisible()

  // Thẻ bắt đầu luôn có, kèm nút tạo dự án ở đầu trang.
  await expect(page.locator('.project-start-card')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Tạo dự án', exact: true })).toBeVisible()

  await createProject(page)
  await page.locator('.project-back').click()

  // Có dự án thì lưới phải từ hai cột trở lên.
  expect(await columns(page, '.project-dashboard-grid')).toBeGreaterThanOrEqual(2)
  await expect(page.locator('.project-dashboard-card')).toHaveCount(1)
  await expect(page.locator('.project-cover')).toBeVisible()
})

test('không gian soạn cảnh tách hai cột: soạn bên trái, phiên bản bên phải', async ({ page }) => {
  await signUpFresh(page)
  const providerId = await seedProvider(page, { name: 'Gateway' })
  const videoModel = await seedModel(page, providerId, {
    modelId: 'mock-video-model',
    displayName: 'Model video',
    kind: 'video',
  })

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(BASE)
  await createProject(page)
  await page.getByRole('tab', { name: 'Cảnh video', exact: true }).click()
  await page.getByRole('button', { name: 'Thêm cảnh', exact: true }).click()

  const editor = page.locator('.project-scene-editor')
  await expect(editor).toBeVisible()
  expect(await columns(page, '.project-scene-editor .project-workspace')).toBe(2)

  // Composer nằm bên trái, khu phiên bản bên phải.
  const composer = await editor.locator('.project-composer').boundingBox()
  const versions = await editor.locator('.project-results-panel').boundingBox()
  expect(composer!.x).toBeLessThan(versions!.x)

  // Các bước được chỉ rõ và nút tạo nổi bật.
  await expect(editor.locator('.project-step')).toHaveCount(3)
  await expect(editor.getByRole('button', { name: 'Tạo / thử lại phiên bản mới' })).toBeDisabled()
  await expect(editor.locator('.project-cost-warning')).toBeVisible()

  // Tham số JSON chỉ nằm trong phần nâng cao và mặc định đóng.
  const advanced = editor.locator('.project-advanced')
  await expect(advanced).toBeVisible()
  expect(await advanced.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false)

  // Chọn model rồi mới xem trước được prompt.
  await editor.getByLabel('Tên cảnh').fill('Buổi sáng')
  await editor.getByLabel('Mô tả / hành động').fill('An đi qua rừng thông')
  await editor.getByRole('combobox', { name: 'Model video', exact: true }).selectOption(videoModel)
  await editor.getByRole('button', { name: 'Lưu & xem trước prompt' }).click()
  await expect(editor.locator('.project-prompt-preview')).toBeVisible()
  await expect(editor.getByRole('button', { name: 'Tạo / thử lại phiên bản mới' })).toBeEnabled()

  // Trước khi tạo, khu phiên bản hiển thị trạng thái trống có hướng dẫn.
  await expect(editor.locator('.project-empty-media')).toBeVisible()
})

test('trên điện thoại, không gian soạn cảnh chuyển thành một cột', async ({ page }) => {
  await signUpFresh(page)
  const providerId = await seedProvider(page, { name: 'Gateway' })
  await seedModel(page, providerId, { modelId: 'mock-video-model', displayName: 'Model video', kind: 'video' })
  await seedModel(page, providerId, { modelId: 'mock-image-model', displayName: 'Model ảnh', kind: 'image' })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(BASE)
  await createProject(page)

  // Studio ảnh: một cột, không tràn ngang.
  expect(await columns(page, '.project-workspace')).toBe(1)
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(1)

  await page.getByRole('tab', { name: 'Cảnh video', exact: true }).click()
  await page.getByRole('button', { name: 'Thêm cảnh', exact: true }).click()
  expect(await columns(page, '.project-scene-editor .project-workspace')).toBe(1)
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(1)
})

test('bảng dự án có tìm kiếm và lọc lưu trữ', async ({ page }) => {
  await signUpFresh(page)
  await page.goto(BASE)
  await createProject(page, 'Dự án Alpha')
  await page.locator('.project-back').click()

  const search = page.getByPlaceholder('Tìm dự án…')
  await expect(search).toBeVisible()

  await search.fill('không tồn tại')
  await expect(page.locator('.project-dashboard-card')).toHaveCount(0)
  await expect(page.locator('.project-start-card')).toBeVisible()

  await search.fill('Alpha')
  await expect(page.locator('.project-dashboard-card')).toHaveCount(1)

  await expect(page.locator('.project-archive-toggle')).toBeVisible()
})
