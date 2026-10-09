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
      // Trên điện thoại sidebar bị ẩn nên phải mở menu trước khi điều hướng.
      if (viewport.width < 760) await page.getByRole('button', { name: 'Mở menu' }).click()
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

  test('breadcrumb Timeline đúng khi mở URL trực tiếp và tải lại', async ({ page }) => {
    await page.goto(`${BASE}/?page=timeline`)
    await expect(page.locator('.breadcrumb strong')).toHaveText('Timeline')
    await page.reload()
    await expect(page.locator('.breadcrumb strong')).toHaveText('Timeline')

    await page.getByRole('button', { name: 'API & Models', exact: true }).click()
    await expect(page.locator('.breadcrumb strong')).toHaveText('API & Models')
    await page.getByRole('button', { name: 'Timeline', exact: true }).click()
    await expect(page.locator('.breadcrumb strong')).toHaveText('Timeline')
  })

  test('nội dung trang dùng hết chiều ngang còn lại trên màn hình rộng', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto(BASE)
    await page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true }).click()

    const sizes = await page.evaluate(() => {
      const main = document.querySelector('.main-area') as HTMLElement
      const content = document.querySelector('.page-content') as HTMLElement
      const style = getComputedStyle(content)
      return {
        main: main.getBoundingClientRect().width,
        content: content.getBoundingClientRect().width,
        paddingLeft: Number.parseFloat(style.paddingLeft),
        paddingRight: Number.parseFloat(style.paddingRight),
        marginLeft: style.marginLeft,
      }
    })

    // `.page-content` phải trải hết chiều ngang còn lại: chỉ chừa padding hai bên,
    // không có max-width thu nhỏ nội dung và không căn giữa bằng margin auto.
    expect(sizes.marginLeft).toBe('0px')
    expect(sizes.content).toBeGreaterThan(sizes.main - sizes.paddingLeft - sizes.paddingRight - 2)
    // Sidebar 248px trên desktop: còn lại hơn 1600px thì nội dung không bị chật.
    expect(sizes.content).toBeGreaterThan(1600)
  })

  test('sidebar thu gọn thành rail icon, nhớ trạng thái và trả lại chỗ cho nội dung', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(BASE)

    const sidebar = page.locator('.sidebar')
    const widthOf = async () => (await sidebar.boundingBox())!.width
    const mainWidthOf = async () => (await page.locator('.main-area').boundingBox())!.width

    expect(await widthOf()).toBeGreaterThan(200)
    const mainBefore = await mainWidthOf()

    await page.getByRole('button', { name: 'Thu gọn menu' }).click()
    await expect.poll(widthOf).toBeLessThanOrEqual(80)
    await expect.poll(mainWidthOf).toBeGreaterThan(mainBefore)
    // Nhãn chữ bị ẩn nhưng mục điều hướng vẫn còn (có tên truy cập riêng).
    await expect(page.locator('.sidebar .nav-item span').first()).toBeHidden()
    await expect(page.getByRole('button', { name: 'Nhân vật', exact: true })).toBeVisible()

    // Tải lại trang vẫn giữ trạng thái đã chọn.
    await page.reload()
    await expect.poll(widthOf).toBeLessThanOrEqual(80)

    await page.getByRole('button', { name: 'Mở rộng menu' }).click()
    await expect.poll(widthOf).toBeGreaterThan(200)
    await expect(page.locator('.sidebar .nav-item span').first()).toBeVisible()
  })

  test('trên điện thoại sidebar vẫn là drawer có nhãn chữ', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(BASE)

    // Thu gọn là hành vi của desktop; điện thoại dùng nút mở menu sẵn có.
    await expect(page.getByRole('button', { name: 'Thu gọn menu' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Mở menu' }).click()
    await expect(page.locator('.sidebar')).toHaveClass(/sidebar-open/)
    await expect(page.locator('.sidebar .nav-item span').first()).toBeVisible()
  })

  test('modal vừa màn hình điện thoại nhỏ', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 })
    await page.goto(BASE)
    await page.getByRole('button', { name: 'Mở menu' }).click()
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
