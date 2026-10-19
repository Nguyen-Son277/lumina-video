import { expect, test } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh } from './helpers/auth'

/** Integration contract: lead mounts LocationReferences in the planner's locations panel.
 * Uses the isolated mock-provider backend configured by Playwright; no external AI call.
 */
test.beforeEach(async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  await seedModel(page, provider, { modelId: 'mock-chat-model', displayName: 'Chat', kind: 'llm' })
  await seedModel(page, provider, { modelId: 'mock-image-model', displayName: 'Image', kind: 'image' })
})

async function openLocations(page: import('@playwright/test').Page) {
  await page.goto(`${BASE}/?page=planner`)
  await page.getByRole('button', { name: 'Phiên mới', exact: true }).first().click()
  // The owner may expose a tab/button or keep the reusable panel directly on the page.
  // The planner bar renders after the session loads, so wait for the opener first.
  const opener = page.getByRole('button', { name: /Bối cảnh|Locations/ }).first()
  if (await opener.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false)) {
    await opener.click()
  }
  await expect(page.getByTestId('location-references')).toBeVisible()
  return page.getByTestId('location-references')
}

test('tạo ảnh bối cảnh và giữ tham chiếu sau reload, không gửi lại POST', async ({ page }) => {
  const panel = await openLocations(page)
  await panel.getByRole('button', { name: 'Thêm bối cảnh', exact: true }).click()
  await page.getByLabel('Tên bối cảnh', { exact: true }).fill('Rừng thông')
  await page.getByRole('button', { name: 'Lưu bối cảnh', exact: true }).click()
  await panel.locator('select').first().selectOption({ index: 1 })
  let submits = 0
  page.on('request', request => { if (request.method() === 'POST' && /\/reference\/generate$/.test(request.url())) submits++ })
  await panel.getByRole('button', { name: 'Tạo ảnh tham chiếu', exact: true }).click()
  // Ảnh tham chiếu là bộ nhiều góc, không còn một ảnh bìa duy nhất.
  await expect(panel.locator('.location-view-image img')).toBeVisible({ timeout: 20000 })
  await expect(panel.locator('.location-view')).toHaveCount(1)
  expect(submits).toBe(1)
  await page.reload()
  await page.getByRole('button', { name: /Bối cảnh/ }).first().click()
  await expect(page.locator('.location-view-image img')).toBeVisible()
  expect(submits).toBe(1)
})

test('thêm từng góc tham chiếu riêng cho cùng một bối cảnh', async ({ page }) => {
  const panel = await openLocations(page)
  await panel.getByRole('button', { name: 'Thêm bối cảnh', exact: true }).click()
  await page.getByLabel('Tên bối cảnh', { exact: true }).fill('Sân ga')
  await page.getByRole('button', { name: 'Lưu bối cảnh', exact: true }).click()
  await panel.locator('select').first().selectOption({ index: 1 })

  // Góc thứ nhất.
  await panel.getByRole('button', { name: 'Thêm góc', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Tạo thêm một góc tham chiếu' })
  await dialog.getByLabel('Góc nhìn').selectOption('left')
  const firstSubmit = page.waitForResponse(response => response.request().method() === 'POST' && /\/reference\/generate$/.test(response.url()))
  await dialog.getByRole('button', { name: 'Tạo ảnh tham chiếu', exact: true }).click()
  expect((await firstSubmit).status()).toBe(202)
  await expect(panel.locator('.location-view')).toHaveCount(1)
  await expect(panel.locator('.location-view figcaption')).toHaveText('Bên trái')

  // Góc thứ hai: phải được THÊM, không thay thế góc cũ.
  await panel.getByRole('button', { name: 'Thêm góc', exact: true }).click()
  await dialog.getByLabel('Góc nhìn').selectOption('behind')
  const secondSubmit = page.waitForResponse(response => response.request().method() === 'POST' && /\/reference\/generate$/.test(response.url()))
  await dialog.getByRole('button', { name: 'Tạo ảnh tham chiếu', exact: true }).click()
  expect((await secondSubmit).status()).toBe(202)
  await expect(panel.locator('.location-view')).toHaveCount(2)

  const stored = await (await page.request.get(`${BASE}/api/plans`)).json()
  const location = stored.sessions[0].locations[0]
  expect(location.referenceViews.map((view: { label: string }) => view.label).sort()).toEqual(['behind', 'left'])

  // Xoá một góc thì góc còn lại vẫn giữ.
  await panel.getByRole('button', { name: 'Xoá góc: Bên trái' }).click()
  await expect(panel.locator('.location-view')).toHaveCount(1)
  await expect(panel.locator('.location-view figcaption')).toHaveText('Phía sau')
})

for (const width of [1440, 390, 320]) {
  test(`location metadata CRUD and locale-preserved draft at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const panel = await openLocations(page)
    await panel.getByRole('button', { name: 'Thêm bối cảnh', exact: true }).click()
    const dialog = page.locator('.locations-dialog')
    await dialog.getByLabel('Tên bối cảnh', { exact: true }).fill('Sân ga trung tâm')
    await dialog.locator('summary').click()
    await dialog.getByLabel('Giai đoạn / biến thể', { exact: true }).fill('Buổi sáng')
    await dialog.getByLabel('Mô tả bối cảnh', { exact: true }).fill('Sân ga có đồng hồ tròn và ghế gỗ.')
    await dialog.getByLabel('Ghi chú liên tục', { exact: true }).fill('Đồng hồ luôn ở bên trái khung hình.')
    await dialog.getByLabel('Prompt ảnh nền không có người', { exact: true }).fill('Empty railway station, wooden benches.')
    // Locale switching must not replace/reinitialize editor state.
    await page.evaluate(() => localStorage.setItem('lumina.locale', 'en'))
    await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'lumina.locale', newValue: 'en' })))
    await expect(dialog.getByLabel('Location name', { exact: true })).toHaveValue('Sân ga trung tâm')
    await dialog.getByRole('button', { name: 'Save location', exact: true }).click()
    await expect(panel.getByRole('heading', { name: 'Sân ga trung tâm', exact: true })).toBeVisible()
    await expect(panel).toContainText('No reference image yet')
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
    await panel.getByRole('button', { name: 'Edit location', exact: true }).first().click()
    const edit = page.getByRole('dialog', { name: 'Edit location', exact: true })
    await edit.locator('summary').click()
    await edit.getByLabel('Stage / variation', { exact: true }).fill('Sau cơn bão')
    await edit.getByRole('button', { name: 'Save location', exact: true }).click()
    await panel.getByRole('button', { name: 'Edit location', exact: true }).first().click()
    await page.locator('.locations-dialog summary').click()
    await expect(page.getByLabel('Stage / variation', { exact: true })).toHaveValue('Sau cơn bão')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await panel.getByRole('button', { name: 'Delete location', exact: true }).first().click()
    const confirmation = page.getByRole('dialog', { name: 'Delete this location?', exact: true })
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(panel).toContainText('Sân ga trung tâm')
    await panel.getByRole('button', { name: 'Delete location', exact: true }).first().click()
    await page.getByRole('dialog', { name: 'Delete this location?', exact: true }).getByRole('button', { name: 'Delete location', exact: true }).click()
    await expect(panel.getByRole('heading', { name: 'No locations yet' })).toBeVisible()
  })
}
