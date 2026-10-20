import { expect, test } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh, waitForGeneration } from './helpers/auth'

/** Mở composer mới từ danh sách phiên. */
async function openQuick(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`${BASE}/?page=quick`)
  await page.getByRole('button', { name: 'Phiên mới', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: /Tạo nội dung/ })).toBeVisible()
}

async function generateQuick(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('.generate-button').click()
  await page.getByRole('dialog', { name: 'Xác nhận yêu cầu tạo nội dung' })
    .getByRole('button', { name: 'Xác nhận & tạo nội dung', exact: true }).click()
}

async function openOptionGroup(page: import('@playwright/test').Page, index: number): Promise<void> {
  const group = page.locator('.quick-option-group').nth(index)
  if (await group.getAttribute('open') === null) await group.locator('summary').click()
  await expect(group).toHaveAttribute('open', '')
}

/** Tạo nhân vật thư viện dùng chung qua API (không cần ảnh tham chiếu). */
async function createCharacter(page: import('@playwright/test').Page, name: string): Promise<string> {
  const response = await page.request.post(`${BASE}/api/shared-characters`, {
    data: { name, appearance: `Ngoại hình ${name}` },
  })
  expect(response.ok()).toBe(true)
  const body = (await response.json()) as { character: { id: string } }
  return body.character.id
}

test.beforeEach(async ({ page }) => {
  await signUpFresh(page)
})

test('phiên tạo nhiều nội dung, sửa lại từ nội dung cũ và giữ sau khi tải lại', async ({ page }) => {
  const providerId = await seedProvider(page)
  await seedModel(page, providerId, { modelId: 'img-1', displayName: 'Model ảnh', kind: 'image' })

  await openQuick(page)
  await page.getByPlaceholder('Mô tả điều bạn muốn tạo...').fill('Ngôi nhà gỗ buổi sáng')
  await generateQuick(page)

  // Phiên được tạo ở lần tạo đầu tiên và ghi lên URL.
  await expect(page.locator('.creation-strip .creation-card')).toHaveCount(1, { timeout: 30_000 })
  await expect.poll(() => new URL(page.url()).searchParams.get('session')).toBeTruthy()

  // "Sửa mô tả" nạp lại nội dung cũ nhưng KHÔNG xoá kết quả cũ.
  await page.getByRole('button', { name: 'Sửa mô tả' }).first().click()
  await expect(page.locator('.quick-edit-banner')).toContainText('Đang sửa từ')
  await expect(page.getByPlaceholder('Mô tả điều bạn muốn tạo...')).toHaveValue('Ngôi nhà gỗ buổi sáng')

  await page.getByPlaceholder('Mô tả điều bạn muốn tạo...').fill('Ngôi nhà gỗ buổi sáng, trời mưa')
  await generateQuick(page)
  await expect(page.locator('.creation-strip .creation-card')).toHaveCount(2, { timeout: 30_000 })

  // Tải lại trang vẫn mở đúng phiên với đủ hai nội dung.
  await page.reload()
  await expect(page.locator('.creation-strip .creation-card')).toHaveCount(2, { timeout: 30_000 })
})

test('dùng ảnh đã tạo trong phiên làm ảnh nguồn', async ({ page }) => {
  const providerId = await seedProvider(page)
  await seedModel(page, providerId, { modelId: 'img-1', displayName: 'Model ảnh', kind: 'image' })

  await openQuick(page)
  await page.getByPlaceholder('Mô tả điều bạn muốn tạo...').fill('Ngôi nhà gỗ')
  await generateQuick(page)
  await expect(page.locator('.creation-strip .creation-card img').first()).toBeVisible({ timeout: 30_000 })

  await page.getByRole('button', { name: 'Dùng làm ảnh nguồn' }).first().click()
  await openOptionGroup(page, 0)
  await expect(page.locator('.quick-source .project-source-item')).toHaveCount(1)

  const created = page.waitForRequest(
    (request) => /\/api\/generations$/.test(request.url()) && request.method() === 'POST',
  )
  await page.getByPlaceholder('Mô tả điều bạn muốn tạo...').fill('Ngôi nhà gỗ, trời mưa')
  await generateQuick(page)

  const payload = JSON.parse((await created).postData() ?? '{}') as { sourceAssetIds?: string[] }
  expect(payload.sourceAssetIds).toHaveLength(1)
  await expect(page.locator('.creation-strip .creation-card')).toHaveCount(2, { timeout: 30_000 })
})

test('phiên giữ nhiều nhân vật cho mọi lần tạo', async ({ page }) => {
  const providerId = await seedProvider(page)
  await seedModel(page, providerId, { modelId: 'img-1', displayName: 'Model ảnh', kind: 'image' })
  const lan = await createCharacter(page, 'Lan')
  const minh = await createCharacter(page, 'Minh')

  await openQuick(page)
  await openOptionGroup(page, 1)
  const characterSelect = page.locator('.quick-character .select-wrap select')
  await characterSelect.selectOption({ label: 'Lan · chỉ mô tả' })
  await characterSelect.selectOption({ label: 'Minh · chỉ mô tả' })
  await expect(page.locator('.quick-cast-chip')).toHaveCount(2)
  await expect(page.locator('.quick-character-preview')).toContainText('Lan')

  const created = page.waitForRequest(
    (request) => /\/api\/generations$/.test(request.url()) && request.method() === 'POST',
  )
  await page.getByPlaceholder('Mô tả điều bạn muốn tạo...').fill('Hai người đi dạo')
  await generateQuick(page)

  const payload = JSON.parse((await created).postData() ?? '{}') as {
    characterId?: string
    characterIds?: string[]
    quickSessionId?: string
  }
  expect(payload.characterId).toBe(lan)
  expect(payload.characterIds).toEqual([lan, minh])
  expect(payload.quickSessionId).toBeTruthy()

  // Wait for the accepted generation/session transition before reloading.
  await expect.poll(() => new URL(page.url()).searchParams.get('session')).toBe(payload.quickSessionId)
  await expect(page.locator('.creation-strip .creation-card')).toHaveCount(1)
  // Tải lại: phiên vẫn giữ đúng hai nhân vật.
  await page.reload()
  await expect(page.locator('.quick-cast-chip')).toHaveCount(2, { timeout: 30_000 })
})

test('kết quả cạnh composer lọc theo ảnh/video và mới nhất trước', async ({ page }) => {
  const provider = await seedProvider(page)
  const image = await seedModel(page, provider, { modelId: 'image', kind: 'image' })
  const video = await seedModel(page, provider, { modelId: 'video', kind: 'video' })
  const sessionResponse = await page.request.post(`${BASE}/api/quick-sessions`, { data: { title: 'Mixed session' } })
  const { session } = await sessionResponse.json()
  for (const [modelId, prompt] of [[image, 'Ảnh cũ'], [video, 'Video riêng'], [image, 'Ảnh mới']]) {
    const response = await page.request.post(`${BASE}/api/generations`, { data: { modelId, prompt, quickSessionId: session.id } })
    expect(response.status()).toBe(202)
    await waitForGeneration(page, (await response.json()).generation.id)
  }
  await page.goto(`${BASE}/?page=quick&session=${session.id}`)
  const results = page.locator('.quick-session-results')
  const cards = results.locator('.creation-card')
  await expect(cards).toHaveCount(2)
  await expect(cards.first()).toContainText('Ảnh mới')
  await expect(results).not.toContainText('Video riêng')
  await expect(page.locator('.creation-strip')).toHaveCount(1)
  await expect(page.locator('.studio-grid > .quick-session-results')).toBeVisible()
  await page.locator('.mode-tabs button').nth(1).click()
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText('Video riêng')
  await expect(results).not.toContainText('Ảnh mới')
  await page.locator('.mode-tabs button').first().click()
  await expect(cards.first()).toContainText('Ảnh mới')
  await page.getByPlaceholder('Mô tả điều bạn muốn tạo...').fill('Ảnh vừa tạo')
  await generateQuick(page)
  await expect(cards).toHaveCount(3)
  await expect(cards.first()).toContainText('Ảnh vừa tạo')
  await page.reload()
  await expect(cards.first()).toContainText('Ảnh vừa tạo')
  await expect(cards).toHaveCount(3)
})

test('mobile xem thêm nhiều ảnh và tab video có trạng thái rỗng riêng', async ({ page }) => {
  const provider = await seedProvider(page)
  const image = await seedModel(page, provider, { modelId: 'image', kind: 'image' })
  await seedModel(page, provider, { modelId: 'video', kind: 'video' })
  const response = await page.request.post(`${BASE}/api/quick-sessions`, { data: { title: 'Nhiều ảnh' } })
  const { session } = await response.json()
  for (let i = 0; i < 7; i++) {
    const created = await page.request.post(`${BASE}/api/generations`, { data: { modelId: image, prompt: `Ảnh số ${i}`, quickSessionId: session.id } })
    expect(created.status()).toBe(202)
    await waitForGeneration(page, (await created.json()).generation.id)
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${BASE}/?page=quick&session=${session.id}`)
  const cards = page.locator('.quick-results-list .creation-card')
  await expect(cards).toHaveCount(6)
  await expect(cards.nth(1)).toBeVisible()
  await expect(cards.first()).toContainText('Ảnh số 6')
  await page.getByRole('button', { name: 'Xem kết quả (7)', exact: true }).click()
  await page.getByRole('button', { name: 'Xem thêm', exact: true }).click()
  await expect(cards).toHaveCount(7)
  await expect(cards.last()).toBeVisible()
  await page.locator('.mode-tabs button').nth(1).click()
  await expect(cards).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Phiên này chưa có video', exact: true })).toBeVisible()
  await page.locator('.mode-tabs button').first().click()
  await expect(cards).toHaveCount(6)
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
  }
  // Evidence goes to gitignored test-results so a normal E2E run never dirties shots/.
  await page.screenshot({ path: 'test-results/quick-results-mobile.png', fullPage: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: 'test-results/quick-results-desktop.png', fullPage: true })
})

test('xoá phiên vẫn giữ kết quả trong Thư viện', async ({ page }) => {
  const providerId = await seedProvider(page)
  await seedModel(page, providerId, { modelId: 'img-1', displayName: 'Model ảnh', kind: 'image' })

  await openQuick(page)
  await page.getByPlaceholder('Mô tả điều bạn muốn tạo...').fill('Kết quả giữ lại')
  await generateQuick(page)
  await expect(page.locator('.creation-strip .creation-card')).toHaveCount(1, { timeout: 30_000 })

  await page.getByRole('button', { name: 'Xóa phiên' }).click()
  await expect(page.getByText('Đã xóa phiên. Kết quả vẫn còn trong Thư viện.')).toBeVisible()

  await page.getByRole('button', { name: /Thư viện/ }).click()
  await expect(page.locator('.creation-card')).toHaveCount(1, { timeout: 30_000 })
})
