import { expect, test } from '@playwright/test'
import { BASE, signUpFresh } from './helpers/auth'

async function noHorizontalOverflow(page: import('@playwright/test').Page) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth }
  })
  // Cho phép sai số 1px do làm tròn.
  expect(overflow.scrollWidth, 'trang không được tràn ngang').toBeLessThanOrEqual(overflow.clientWidth + 1)
}

test.describe('Layout', () => {
  test.beforeEach(async ({ page }) => {
    await signUpFresh(page)
  })

  for (const viewport of [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'tablet', width: 1024, height: 768 },
    { name: 'mobile', width: 390, height: 844 },
    { name: 'mobile nhỏ', width: 320, height: 640 },
  ]) {
    test(`không tràn ngang ở ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.goto(BASE)
      await page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true }).click()
      await noHorizontalOverflow(page)

      // API & Models
      if (viewport.width < 760) {
        await page.getByRole('button', { name: 'Mở menu' }).click()
      }
      await page.getByRole('button', { name: 'API & Models', exact: true }).click()
      await noHorizontalOverflow(page)
      await expect(page.getByText('Danh sách provider đang trống')).toBeVisible()

      await page.getByRole('button', { name: /Model catalog/ }).click()
      await noHorizontalOverflow(page)
      await expect(page.getByText('Chưa có model nào')).toBeVisible()
    })
  }

  test('modal vừa màn hình điện thoại nhỏ', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 })
    await page.goto(BASE)
      await page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true }).click()
    await page.getByRole('button', { name: 'Mở menu' }).click()
    await page.getByRole('button', { name: 'API & Models', exact: true }).click()
    await page.getByRole('button', { name: 'Thêm provider' }).first().click()

    const modal = page.locator('.modal-card')
    await expect(modal).toBeVisible()
    const box = await modal.boundingBox()
    expect(box!.width).toBeLessThanOrEqual(320)
    await noHorizontalOverflow(page)
  })

  test('sidebar ẩn mặc định trên điện thoại và hiện khi mở menu', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(BASE)
      await page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true }).click()

    const sidebar = page.locator('.sidebar')
    await expect(sidebar).not.toHaveClass(/sidebar-open/)

    await page.getByRole('button', { name: 'Mở menu' }).click()
    await expect(sidebar).toHaveClass(/sidebar-open/)

    await page.getByRole('button', { name: /Thư viện/ }).click()
    await expect(sidebar).not.toHaveClass(/sidebar-open/)
  })

  test('không còn phần tử trang trí giả và bộ đếm đúng', async ({ page }) => {
    await page.goto(BASE)
      await page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true }).click()

    // Nút generate bị khóa khi chưa có model.
    await expect(page.getByRole('button', { name: 'Tạo hình ảnh' })).toBeDisabled()
    await expect(page.getByText('Chưa cấu hình API')).toBeVisible()

    // Không có provider/model nào trong catalog.
    await page.getByRole('button', { name: 'API & Models', exact: true }).click()
    await expect(page.locator('.tab-count').first()).toHaveText('0')
    await expect(page.locator('.tab-count').nth(1)).toHaveText('0')
    await expect(page.locator('.provider-row')).toHaveCount(0)
    await expect(page.locator('.model-row')).toHaveCount(0)
  })
})
