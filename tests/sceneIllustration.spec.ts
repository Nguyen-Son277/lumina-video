import { expect, test, type Page } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh, waitForGeneration } from './helpers/auth'

/**
 * Ảnh minh hoạ storyboard + thao tác hàng loạt trên cảnh ở Studio.
 *
 * Seeding: E2E không chạy được "Tạo kịch bản AI" đầy đủ với ảnh storyboard thật
 * (cần model ảnh + batch), nên ảnh minh hoạ được seed qua API đúng như applyPlan
 * làm: tải ảnh lên `/api/uploads` rồi PATCH cảnh với `backgroundUploadId`. Nhờ vậy
 * kiểm thử vẫn đi qua đường dữ liệu thật của server, không mock phía UI.
 */

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

async function seedProject(page: Page, name: string): Promise<string> {
  const response = await page.request.post(`${BASE}/api/projects`, {
    data: { name, description: 'Dự án kiểm thử minh hoạ', style: '', language: 'vi', archived: false },
  })
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { project: { id: string } }).project.id
}

async function seedUpload(page: Page): Promise<string> {
  const response = await page.request.post(`${BASE}/api/uploads`, {
    headers: { 'Content-Type': 'image/png' },
    data: Buffer.from(PNG_BASE64, 'base64'),
  })
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { upload: { id: string } }).upload.id
}

async function seedScene(
  page: Page,
  projectId: string,
  input: { title: string; modelId?: string | null; backgroundUploadId?: string | null },
): Promise<string> {
  const response = await page.request.post(`${BASE}/api/projects/${projectId}/scenes`, {
    data: {
      title: input.title,
      prompt: 'An đi qua rừng thông buổi sớm',
      background: 'Rừng thông, sương sớm',
      modelId: input.modelId ?? null,
      ...(input.backgroundUploadId ? { backgroundUploadId: input.backgroundUploadId } : {}),
    },
  })
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { scene: { id: string } }).scene.id
}

/** Mở Studio và vào thẳng tab Cảnh video của dự án đã seed. */
async function openScenesTab(page: Page, projectName: string): Promise<void> {
  await page.goto(BASE)
  await page.getByRole('button', { name: new RegExp(projectName) }).first().click()
  await expect(page.locator('.project-tab-panel')).toBeVisible()
  await page.getByRole('tab', { name: 'Cảnh video', exact: true }).click()
  await expect(page.locator('.project-scene-list')).toBeVisible()
}

async function noOverflow(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(1)
}

test('ảnh minh hoạ từ timeline hiện trên thẻ cảnh và trong trình sửa cảnh', async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  await seedModel(page, provider, { modelId: 'mock-video-model', displayName: 'Model video', kind: 'video' })
  const projectId = await seedProject(page, 'Dự án minh hoạ')
  const uploadId = await seedUpload(page)
  await seedScene(page, projectId, { title: 'Sương sớm', backgroundUploadId: uploadId })

  await openScenesTab(page, 'Dự án minh hoạ')

  const thumb = page.locator('.project-scene-thumb img').first()
  await expect(thumb).toBeVisible()
  await expect(thumb).toHaveAttribute('src', new RegExp(`/api/uploads/${uploadId}`))
  // Nhãn nói rõ đây là ảnh minh hoạ timeline, không phải video đã tạo.
  await expect(page.locator('.project-scene-thumb')).toContainText('Ảnh minh hoạ timeline')

  // Trình sửa cảnh xem trước đúng ảnh đó và mở được lightbox.
  await page.getByRole('button', { name: 'Sửa cảnh Sương sớm' }).click()
  const editor = page.locator('.project-scene-editor')
  await expect(editor).toBeVisible()
  const previewButton = editor.getByRole('button', { name: 'Phóng to ảnh minh hoạ của cảnh Sương sớm' })
  await expect(previewButton.locator('img')).toBeVisible()
  await previewButton.click()
  await expect(page.locator('.lightbox-backdrop')).toBeVisible()
  await page.locator('.lightbox-backdrop').getByRole('button', { name: 'Đóng' }).click()
  await expect(page.locator('.lightbox-backdrop')).toHaveCount(0)
})

test('nút Tạo video trên thẻ cảnh tạo một phiên bản với model đã gán', async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  const modelId = await seedModel(page, provider, {
    modelId: 'mock-video-model',
    displayName: 'Model video',
    kind: 'video',
  })
  const projectId = await seedProject(page, 'Dự án tạo cảnh')
  await seedScene(page, projectId, { title: 'Cảnh một', modelId })

  await openScenesTab(page, 'Dự án tạo cảnh')
  const card = page.locator('.project-scene-card').first()
  await expect(card).toContainText('0 phiên bản')

  const responsePromise = page.waitForResponse(
    (response) => /\/api\/scenes\/[^/]+\/generate$/.test(response.url()) && response.request().method() === 'POST',
  )
  await card.getByRole('button', { name: 'Tạo video' }).click()
  const response = await responsePromise
  expect(response.status()).toBe(202)
  const { generation } = (await response.json()) as { generation: { id: string } }
  expect((await waitForGeneration(page, generation.id)).status).toBe('succeeded')

  // Thẻ cập nhật số phiên bản và không còn ở trạng thái chờ duyệt.
  await expect(card).toContainText('1 phiên bản', { timeout: 15_000 })
  await expect(card).toContainText('Đang chờ duyệt')
})

test('duyệt hàng loạt rồi tạo cho cảnh đã duyệt hiện trạng thái đang chờ / đang chạy', async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  const modelId = await seedModel(page, provider, {
    modelId: 'mock-video-model',
    displayName: 'Model video',
    kind: 'video',
  })
  const projectId = await seedProject(page, 'Dự án hàng loạt')
  await seedScene(page, projectId, { title: 'Cảnh A', modelId })
  await seedScene(page, projectId, { title: 'Cảnh B', modelId })

  await openScenesTab(page, 'Dự án hàng loạt')
  const cards = page.locator('.project-scene-card')
  await expect(cards).toHaveCount(2)

  await cards.nth(0).getByRole('checkbox', { name: 'Chọn cảnh Cảnh A' }).check()
  await cards.nth(1).getByRole('checkbox', { name: 'Chọn cảnh Cảnh B' }).check()
  await expect(page.locator('.project-section-header').filter({ hasText: 'Thao tác hàng loạt' })).toContainText('Đã chọn 2 cảnh')

  // Cảnh chưa duyệt thì chưa có video nào được tạo.
  await expect(cards.nth(0)).toContainText('Đang chờ duyệt — chưa tạo video nào.')

  const approveResponse = page.waitForResponse(
    (response) => /\/api\/projects\/[^/]+\/scenes\/bulk$/.test(response.url()) && response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: 'Duyệt cảnh đã chọn', exact: true }).click()
  expect((await approveResponse).status()).toBe(200)
  await expect(page.locator('.project-scene-card').first().getByRole('checkbox', { name: 'Duyệt cảnh Cảnh A' })).toBeChecked()

  const bulkResponse = page.waitForResponse(
    (response) => /\/api\/projects\/[^/]+\/scenes\/bulk$/.test(response.url()) && response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: 'Tạo cho các cảnh đã duyệt' }).click()
  expect((await bulkResponse).status()).toBe(200)

  // Worker xếp hàng lần lượt: giao diện có thể bắt được trạng thái chờ/đang chạy,
  // nhưng mock hoàn tất rất nhanh nên chấp nhận cả trường hợp đã có phiên bản.
  await expect
    .poll(
      async () => {
        const text = (await page.locator('.project-scene-card').first().innerText()).replace(/\s+/g, ' ')
        return /Đang chờ|Đang chạy/.test(text) || /\d+ phiên bản/.test(text)
      },
      { timeout: 30_000 },
    )
    .toBe(true)
  await expect(page.locator('.project-scene-card').first()).toContainText('1 phiên bản', { timeout: 30_000 })
})

test('thay và xoá ảnh minh hoạ trong trình sửa cảnh cập nhật giao diện', async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  await seedModel(page, provider, { modelId: 'mock-video-model', displayName: 'Model video', kind: 'video' })
  const projectId = await seedProject(page, 'Dự án thay ảnh')
  const firstUpload = await seedUpload(page)
  await seedScene(page, projectId, { title: 'Cảnh thay ảnh', backgroundUploadId: firstUpload })

  await openScenesTab(page, 'Dự án thay ảnh')
  await page.getByRole('button', { name: 'Sửa cảnh Cảnh thay ảnh' }).click()
  const editor = page.locator('.project-scene-editor')
  await expect(editor).toBeVisible()

  const preview = editor.getByRole('button', { name: 'Phóng to ảnh minh hoạ của cảnh Cảnh thay ảnh' })
  await expect(preview.locator('img')).toHaveAttribute('src', new RegExp(`/api/uploads/${firstUpload}`))

  // Tải ảnh mới: upload trước rồi PATCH cảnh với backgroundUploadId mới.
  const patch = page.waitForResponse(
    (response) => /\/api\/projects\/[^/]+\/scenes\/[^/]+$/.test(response.url()) && response.request().method() === 'PATCH',
  )
  await editor.getByLabel('Thay ảnh', { exact: true }).setInputFiles({
    name: 'khac.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_BASE64, 'base64'),
  })
  await patch
  await expect(preview.locator('img')).not.toHaveAttribute('src', new RegExp(`/api/uploads/${firstUpload}`), {
    timeout: 15_000,
  })

  await editor.getByRole('button', { name: 'Xoá ảnh' }).click()
  await expect(editor).toContainText('Chưa có ảnh minh hoạ')
  await expect(preview).toHaveCount(0)
})

for (const width of [320, 390]) {
  test(`cảnh có ảnh minh hoạ không tràn ngang trên điện thoại ${width}px`, async ({ page }) => {
    await signUpFresh(page)
    const provider = await seedProvider(page)
    await seedModel(page, provider, { modelId: 'mock-video-model', displayName: 'Model video', kind: 'video' })
    const projectId = await seedProject(page, `Dự án mobile ${width}`)
    const uploadId = await seedUpload(page)
    await seedScene(page, projectId, { title: 'Cảnh mobile', backgroundUploadId: uploadId })

    await page.setViewportSize({ width, height: 844 })
    await openScenesTab(page, `Dự án mobile ${width}`)
    await noOverflow(page)
    await page.getByRole('button', { name: 'Sửa cảnh Cảnh mobile' }).click()
    await expect(page.locator('.project-scene-editor')).toBeVisible()
    await noOverflow(page)
  })
}

test('nhãn mới đổi theo ngôn ngữ Anh / Việt', async ({ page }) => {
  await signUpFresh(page)
  const projectId = await seedProject(page, 'Dự án ngôn ngữ')
  const uploadId = await seedUpload(page)
  await seedScene(page, projectId, { title: 'Cảnh ngôn ngữ', backgroundUploadId: uploadId })

  await openScenesTab(page, 'Dự án ngôn ngữ')
  await expect(page.locator('.project-scene-thumb')).toContainText('Ảnh minh hoạ timeline')

  await page.locator('.lumina-language-switcher__select').selectOption('en')
  await expect(page.locator('.breadcrumb strong')).toHaveText('Studio')
  await expect(page.getByRole('button', { name: 'Create image', exact: true })).toBeVisible()
  await expect(page.locator('.project-scene-thumb')).toContainText('Timeline illustration')

  await page.locator('.lumina-language-switcher__select').selectOption('vi')
  await expect(page.getByRole('button', { name: 'Tạo ảnh', exact: true })).toBeVisible()
  await expect(page.locator('.project-scene-thumb')).toContainText('Ảnh minh hoạ timeline')
})
