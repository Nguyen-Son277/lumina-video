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

  test('drawer đóng inert và không đưa các nút ngoài màn hình vào vòng Tab', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(BASE)

    const sidebar = page.locator('.sidebar')
    const openMenu = page.getByRole('button', { name: 'Mở menu' })
    await expect(sidebar).toHaveAttribute('inert', '')
    await expect(sidebar).toHaveAttribute('aria-hidden', 'true')
    await expect(sidebar.getByRole('button')).toHaveCount(0)
    await openMenu.focus()

    // Cover backward entry from the first main control and a complete forward cycle.
    await page.keyboard.press('Shift+Tab')
    expect(await sidebar.evaluate(element => element.contains(document.activeElement))).toBe(false)
    const steps = await page.locator('button:visible:enabled, a[href]:visible, input:visible:enabled, select:visible:enabled, textarea:visible:enabled, [tabindex="0"]:visible').count() + 2
    for (let step = 0; step < steps; step += 1) {
      await page.keyboard.press('Tab')
      expect(await sidebar.evaluate(element => element.contains(document.activeElement))).toBe(false)
    }
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden')
  })

  test('drawer mở trap focus nhìn thấy, trả focus và khôi phục scroll khi đóng', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(BASE)
    await page.evaluate(() => { document.body.style.overflow = 'clip' })

    const sidebar = page.locator('.sidebar')
    const openMenu = page.getByRole('button', { name: 'Mở menu' })
    const closeMenu = sidebar.getByRole('button', { name: 'Đóng menu' })
    const last = sidebar.locator('.row-more')
    await openMenu.focus()
    await openMenu.press('Enter')
    await expect(sidebar).toHaveAttribute('role', 'dialog')
    await expect(sidebar).toHaveAttribute('aria-modal', 'true')
    await expect(sidebar).not.toHaveAttribute('inert', '')
    await expect(closeMenu).toBeFocused()
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('hidden')

    // The hidden desktop collapse button must never become the first trap target.
    await page.keyboard.press('Shift+Tab')
    await expect(last).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(closeMenu).toBeFocused()
    await page.locator('.lumina-language-switcher__select').focus()
    await expect(closeMenu).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(sidebar).toHaveAttribute('inert', '')
    await expect(openMenu).toBeFocused()
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('clip')

    // Pointer dismissal uses the same cleanup path and restores the opener as well.
    await openMenu.click()
    await closeMenu.click()
    await expect(openMenu).toBeFocused()
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('clip')
  })

  test('desktop thu gọn vẫn hiện nhãn mobile và giữ lựa chọn sau resize/reload', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(BASE)
    const sidebar = page.locator('.sidebar')
    const firstLabel = sidebar.locator('.nav-item span').first()
    await sidebar.locator('.sidebar-collapse-toggle').click()
    await expect(sidebar).toHaveClass(/is-collapsed/)
    await expect(firstLabel).toBeHidden()
    await expect.poll(() => page.evaluate(() => localStorage.getItem('lumina.sidebar'))).toBe('collapsed')

    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'Mở menu' }).click()
    await expect(sidebar).not.toHaveClass(/is-collapsed/)
    await expect(firstLabel).toBeVisible()
    await expect(sidebar.locator('.brand-copy')).toBeVisible()
    await expect(sidebar.locator('.workspace-copy')).toBeVisible()
    await expect(sidebar.locator('.user-info')).toBeVisible()

    await page.reload()
    await expect(sidebar).toHaveAttribute('inert', '')
    await page.getByRole('button', { name: 'Mở menu' }).click()
    await expect(firstLabel).toBeVisible()
    await expect(sidebar).not.toHaveClass(/is-collapsed/)

    await page.setViewportSize({ width: 1280, height: 900 })
    await expect(sidebar).toHaveClass(/is-collapsed/)
    await expect(sidebar).not.toHaveClass(/sidebar-open/)
    await expect(sidebar).not.toHaveAttribute('inert', '')
    await expect(firstLabel).toBeHidden()
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).not.toBe('hidden')
    expect(await page.evaluate(() => localStorage.getItem('lumina.sidebar'))).toBe('collapsed')
    await page.reload()
    await expect(sidebar).toHaveClass(/is-collapsed/)
  })

  test('drawer điện thoại đóng được bằng nút X, nền mờ và Escape', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(BASE)

    const sidebar = page.locator('.sidebar')
    const openMenu = page.getByRole('button', { name: 'Mở menu' })
    const closeMenu = page.getByRole('button', { name: 'Đóng menu' })
    const bodyOverflow = () => page.evaluate(() => getComputedStyle(document.body).overflow)

    // Mở drawer: nút X hiện ra và nền trang không cuộn.
    await openMenu.click()
    await expect(sidebar).toHaveClass(/sidebar-open/)
    await expect(closeMenu).toBeVisible()
    await expect.poll(bodyOverflow).toBe('hidden')

    // Đóng bằng nút X.
    await closeMenu.click()
    await expect(sidebar).not.toHaveClass(/sidebar-open/)
    await expect.poll(bodyOverflow).not.toBe('hidden')

    // Đóng bằng cách bấm nền mờ bên ngoài drawer (drawer rộng 248px).
    await openMenu.click()
    await expect(sidebar).toHaveClass(/sidebar-open/)
    await page.mouse.click(360, 300)
    await expect(sidebar).not.toHaveClass(/sidebar-open/)

    // Đóng bằng phím Escape.
    await openMenu.click()
    await expect(sidebar).toHaveClass(/sidebar-open/)
    await page.keyboard.press('Escape')
    await expect(sidebar).not.toHaveClass(/sidebar-open/)

    // Nền mờ không được chặn nút mở menu sau khi đóng.
    await openMenu.click()
    await expect(sidebar).toHaveClass(/sidebar-open/)
  })

  test('drawer tự đóng khi chuyển từ điện thoại sang desktop', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(BASE)

    await page.getByRole('button', { name: 'Mở menu' }).click()
    const sidebar = page.locator('.sidebar')
    await expect(sidebar).toHaveClass(/sidebar-open/)

    await page.setViewportSize({ width: 1280, height: 800 })
    await expect(sidebar).not.toHaveClass(/sidebar-open/)
    // Không còn khoá cuộn nền sau khi drawer tự đóng.
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe('hidden')
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
  // Quick create now opens its session browser before showing the composer.
  await expect(page).toHaveURL(/page=quick/)
  await expect(page.getByRole('button', { name: 'Phiên mới', exact: true }).first()).toBeVisible()
  await expect(items.nth(0)).toHaveClass(/active/)
  await expect(items.nth(1)).not.toHaveClass(/active/)
  await expect(page.locator('.studio-switch')).toHaveCount(0)

  // Quay lại Studio dự án bằng mục Studio.
  await items.nth(1).click()
  await expect(page.getByRole('heading', { name: 'Dự án sáng tạo' })).toBeVisible()
  await expect(items.nth(1)).toHaveClass(/active/)
})


test('unified library navigation canonicalizes legacy characters and preserves filter/detail URL', async ({ page }) => {
  await signUpFresh(page)
  const response = await page.request.post(`${BASE}/api/shared-characters`, { data: { name: 'URL character', appearance: 'Full description', voice: {} } })
  const character = (await response.json()).character
  await page.goto(`${BASE}/?page=characters`)
  await expect(page).toHaveURL(/page=entities/)
  await expect(page).toHaveURL(/type=character/)
  await expect(page.getByTestId('entity-library-filter-character')).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('entity-library-card').getByTestId('entity-card-details').click()
  await expect(page).toHaveURL(new RegExp(character.id))
  await page.reload()
  await expect(page.getByTestId('entity-details-dialog')).toContainText('Full description')
  await page.getByTestId('entity-details-dialog').getByRole('button', { name: 'Đóng', exact: true }).click()
  await page.getByTestId('entity-library-filter-logo').click()
  await expect(page).toHaveURL(/type=logo/)
  await page.goBack()
  await expect(page.getByTestId('entity-library-filter-character')).toHaveAttribute('aria-pressed', 'true')
  const nav = page.locator('.primary-nav').first()
  await expect(nav.getByRole('button', { name: 'Nhân vật & tài nguyên', exact: true })).toHaveCount(1)
  await expect(nav.getByRole('button', { name: 'Nhân vật', exact: true })).toHaveCount(0)
})
