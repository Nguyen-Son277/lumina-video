import { expect, test, type Page } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh, waitForGeneration } from './helpers/auth'

/**
 * Xuất video dự án ở Studio.
 *
 * Giới hạn của môi trường E2E: provider giả lập trả một "MP4" tối thiểu (chỉ có hộp
 * `ftyp`, không có `moov`/`mdat`) nên ffmpeg thật không ghép được, mà
 * `playwright.config.ts` cũng không cấu hình ffmpeg giả cho mockServer. Vì vậy luồng
 * "hoàn tất + nút Tải về" chạy thật không thể đạt tới ở đây:
 *   - bài 1 chạy thật phần mở/đóng hộp thoại và lỗi server khi cảnh chưa có video;
 *   - bài 2 chạy thật toàn bộ luồng tạo bản xuất → worker → trạng thái cuối → xoá;
 *   - bài 3 kiểm tra riêng phần hiển thị "Hoàn tất + Tải về" với danh sách API stub.
 */

async function seedProject(page: Page, name: string): Promise<string> {
  const response = await page.request.post(`${BASE}/api/projects`, {
    data: { name, description: 'Dự án xuất video', style: '', language: 'vi', archived: false },
  })
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { project: { id: string } }).project.id
}

async function seedScene(
  page: Page,
  projectId: string,
  title: string,
  modelId: string,
): Promise<string> {
  const response = await page.request.post(`${BASE}/api/projects/${projectId}/scenes`, {
    data: { title, prompt: 'An đi qua rừng thông buổi sớm', modelId },
  })
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { scene: { id: string } }).scene.id
}

/** Mở Studio và vào chi tiết một dự án đã seed. */
async function openProject(page: Page, name: string): Promise<void> {
  await page.goto(BASE)
  await page.getByRole('button', { name: new RegExp(name) }).first().click()
  await expect(page.locator('.project-detail-header')).toBeVisible()
}

const exportButton = (page: Page) =>
  page.getByRole('button', { name: 'Xuất video', exact: true })

const exportDialog = (page: Page) => page.getByRole('dialog', { name: 'Xuất video dự án' })

const isExportCreate = (url: string, method: string) =>
  method === 'POST' && /\/api\/projects\/[^/]+\/exports$/.test(url)

test('mở hộp thoại xuất video, không tự tạo bản xuất và báo lỗi khi cảnh chưa có video', async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  const modelId = await seedModel(page, provider, {
    modelId: 'mock-video-model',
    displayName: 'Model video',
    kind: 'video',
  })
  const projectId = await seedProject(page, 'Dự án thiếu video')
  await seedScene(page, projectId, 'Cảnh trống', modelId)

  await openProject(page, 'Dự án thiếu video')

  let creates = 0
  page.on('request', (request) => {
    if (isExportCreate(request.url(), request.method())) creates += 1
  })

  // Mở hộp thoại không được tự tạo bản xuất nào.
  await exportButton(page).click()
  const modal = exportDialog(page)
  await expect(modal).toBeVisible()
  await expect(modal).toContainText('Ghép video của từng cảnh')
  await expect(modal).toContainText('Chưa có bản xuất nào')
  await expect(modal.locator('.project-export-item')).toHaveCount(0)
  expect(creates).toBe(0)

  // Tiêu điểm phải nằm trong hộp thoại (bẫy tiêu điểm).
  await expect
    .poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))))
    .toBe(true)

  // Bắt đầu xuất: server từ chối vì cảnh chưa có video thành công.
  const refused = page.waitForResponse(
    (response) => isExportCreate(response.url(), response.request().method()),
  )
  await modal.getByRole('button', { name: 'Bắt đầu xuất' }).click()
  expect((await refused).status()).toBe(400)
  await expect(modal.locator('.form-error')).toContainText('chưa có video thành công')
  await expect(modal.locator('.form-error')).toContainText('Cảnh trống')
  expect(creates).toBe(1)

  // Đóng bằng Escape.
  await page.keyboard.press('Escape')
  await expect(modal).toHaveCount(0)

  // Mở lại và đóng bằng nút Đóng.
  await exportButton(page).click()
  await expect(exportDialog(page)).toBeVisible()
  await exportDialog(page).getByRole('button', { name: 'Đóng' }).click()
  await expect(exportDialog(page)).toHaveCount(0)
})

test('bản xuất chạy nền cập nhật trạng thái cuối rồi xoá được', async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  const modelId = await seedModel(page, provider, {
    modelId: 'mock-video-model',
    displayName: 'Model video',
    kind: 'video',
  })
  const projectId = await seedProject(page, 'Dự án xuất thật')
  const sceneId = await seedScene(page, projectId, 'Cảnh một', modelId)

  // Tạo video thành công cho cảnh qua đúng đường dữ liệu thật của server.
  const enqueued = await page.request.post(`${BASE}/api/scenes/${sceneId}/generate`, {
    data: { idempotencyKey: `export-e2e-${Date.now()}` },
  })
  expect(enqueued.status()).toBe(202)
  const { generation } = (await enqueued.json()) as { generation: { id: string } }
  expect((await waitForGeneration(page, generation.id)).status).toBe('succeeded')

  await openProject(page, 'Dự án xuất thật')
  await exportButton(page).click()
  const modal = exportDialog(page)
  await expect(modal).toBeVisible()

  const created = page.waitForResponse(
    (response) => isExportCreate(response.url(), response.request().method()),
  )
  await modal.getByRole('button', { name: 'Bắt đầu xuất' }).click()
  expect((await created).status()).toBe(202)

  // Danh sách tự làm mới khi bản xuất còn chờ/chạy. Ở môi trường test, ffmpeg thật
  // không đọc được "MP4" giả lập nên trạng thái cuối là Thất bại (hoặc thiếu ffmpeg);
  // cả hai đều là trạng thái kết thúc, không còn thanh tiến trình.
  const item = modal.locator('.project-export-item').first()
  await expect(item).toBeVisible()
  await expect(item).toContainText(/Hoàn tất|Thất bại/, { timeout: 30_000 })
  await expect(item.locator('.project-export-progress')).toHaveCount(0)

  // Bản xuất đã dừng thì xoá được và biến mất khỏi danh sách.
  const removed = page.waitForResponse(
    (response) =>
      /\/api\/exports\/[^/]+$/.test(response.url()) && response.request().method() === 'DELETE',
  )
  await item.getByRole('button', { name: 'Xóa', exact: true }).click()
  expect((await removed).status()).toBe(204)
  await expect(modal.locator('.project-export-item')).toHaveCount(0)
})

test('bản xuất hoàn tất hiển thị nút Tải về theo downloadUrl', async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  await seedModel(page, provider, {
    modelId: 'mock-video-model',
    displayName: 'Model video',
    kind: 'video',
  })
  const projectId = await seedProject(page, 'Dự án tải về')

  // Luồng thật không thể đạt 'succeeded' trong E2E (xem ghi chú đầu file), nên ở đây
  // stub đúng hợp đồng của GET /api/projects/:id/exports để kiểm tra phần hiển thị.
  await page.route(`**/api/projects/${projectId}/exports`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        exports: [
          {
            id: 'export-stub',
            projectId,
            status: 'succeeded',
            progress: 100,
            itemCount: 2,
            url: '/api/exports/export-stub/file',
            downloadUrl: '/api/exports/export-stub/file?download=1',
            mimeType: 'video/mp4',
            byteSize: 2048,
            errorCode: null,
            errorMessage: null,
            errorMessageKey: null,
            errorMessageParams: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            completedAt: Date.now(),
          },
        ],
      }),
    })
  })

  await openProject(page, 'Dự án tải về')
  await exportButton(page).click()
  const modal = exportDialog(page)
  await expect(modal.locator('.project-export-item')).toHaveCount(1)
  await expect(modal).toContainText('Hoàn tất')
  await expect(modal).toContainText('2 cảnh')

  const download = modal.getByRole('link', { name: 'Tải về' })
  await expect(download).toHaveAttribute('href', '/api/exports/export-stub/file?download=1')
  await expect(download).toHaveAttribute('download', '')

  // Không còn bản chạy thì đóng hộp thoại là dừng làm mới.
  await modal.getByRole('button', { name: 'Đóng' }).click()
  await expect(exportDialog(page)).toHaveCount(0)
})
