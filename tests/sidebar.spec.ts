import { expect, test } from '@playwright/test'
import { BASE, signUpFresh } from './helpers/auth'

test.describe('Sidebar', () => {
  test.beforeEach(async ({ page }) => {
    await signUpFresh(page)
  })

  for (const viewport of [
    { name: 'cao', width: 1440, height: 900 },
    { name: 'thấp', width: 1280, height: 600 },
    { name: 'rất thấp', width: 1280, height: 480 },
  ]) {
    test(`profile và plan card nằm trong khung nhìn khi cửa sổ ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.goto(BASE)

      const userRow = page.locator('.user-row')
      const planCard = page.locator('.plan-card')
      const sidebar = page.locator('.sidebar')

      await expect(userRow).toBeVisible()

      const sidebarBox = (await sidebar.boundingBox())!
      const userBox = (await userRow.boundingBox())!

      // Toàn bộ profile phải nằm trong chiều cao khung nhìn, không cần cuộn.
      expect(userBox.y + userBox.height).toBeLessThanOrEqual(viewport.height + 1)

      // Sidebar không được cao hơn khung nhìn.
      expect(sidebarBox.height).toBeLessThanOrEqual(viewport.height + 1)

      // Vẫn nằm trong bề ngang sidebar.
      expect(userBox.x + userBox.width).toBeLessThanOrEqual(sidebarBox.x + sidebarBox.width + 1)

      // Plan card chỉ hiển thị khi cửa sổ đủ cao; nếu hiện thì cũng phải trong tầm nhìn.
      if (viewport.height >= 620) {
        await expect(planCard).toBeVisible()
        const planBox = (await planCard.boundingBox())!
        expect(planBox.y + planBox.height).toBeLessThanOrEqual(viewport.height + 1)
      }
    })
  }

  test('sidebar không cuộn theo trang khi nội dung chính dài', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 700 })
    await page.goto(BASE)

    const userRow = page.locator('.user-row')
    const before = (await userRow.boundingBox())!

    // Cuộn trang xuống đáy.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await page.waitForTimeout(250)

    const after = (await userRow.boundingBox())!
    // Profile phải đứng yên so với khung nhìn.
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1)
    expect(after.y + after.height).toBeLessThanOrEqual(700 + 1)
  })

  test('sidebar vẫn đúng trên điện thoại', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(BASE)

    const sidebar = page.locator('.sidebar')
    await expect(sidebar).not.toHaveClass(/sidebar-open/)

    await page.getByRole('button', { name: 'Mở menu' }).click()
    await expect(sidebar).toHaveClass(/sidebar-open/)

    const userRow = page.locator('.user-row')
    await expect(userRow).toBeVisible()
    const box = (await userRow.boundingBox())!
    expect(box.y + box.height).toBeLessThanOrEqual(844 + 1)
  })

  test('sidebar ngắn vẫn cuộn được tới profile nếu cần', async ({ page }) => {
    // Cửa sổ cực thấp: nội dung sidebar cao hơn khung nhìn.
    await page.setViewportSize({ width: 1280, height: 360 })
    await page.goto(BASE)

    const sidebar = page.locator('.sidebar')
    const metrics = await sidebar.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }))

    // Sidebar phải tự cuộn bên trong, không đẩy trang dài ra.
    expect(metrics.clientHeight).toBeLessThanOrEqual(360 + 1)

    await sidebar.evaluate((el) => { el.scrollTop = el.scrollHeight })
    await expect(page.locator('.user-row')).toBeVisible()
  })
})

test('sidebar tách riêng Tạo nội dung đơn lẻ và Studio', async ({ page }) => {
  await signUpFresh(page)
  await page.goto(BASE)

  const nav = page.locator('.primary-nav').first()
  const items = nav.locator('.nav-item')
  // Mục đơn lẻ phải nằm ngay trên Studio.
  await expect(items.nth(0)).toContainText('Tạo nội dung đơn lẻ')
  await expect(items.nth(1)).toContainText('Studio')

  // Mặc định mở Studio dự án.
  await expect(items.nth(1)).toHaveClass(/active/)
  await expect(items.nth(0)).not.toHaveClass(/active/)

  // Bấm mục đơn lẻ thì chuyển sang trang riêng, không còn nút gạt cũ.
  await items.nth(0).click()
  await expect(page.getByRole('button', { name: 'Tạo hình ảnh' })).toBeVisible()
  await expect(items.nth(0)).toHaveClass(/active/)
  await expect(items.nth(1)).not.toHaveClass(/active/)
  await expect(page.locator('.studio-switch')).toHaveCount(0)

  // Quay lại Studio dự án bằng mục Studio.
  await items.nth(1).click()
  await expect(page.getByRole('heading', { name: 'Dự án sáng tạo' })).toBeVisible()
  await expect(items.nth(1)).toHaveClass(/active/)
})
