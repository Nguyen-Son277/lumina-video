import { expect, test } from '@playwright/test'
import {
  approveAccountViaApi,
  BASE,
  ensureAdminSession,
  registerAccountViaApi,
  rejectAccountViaApi,
  signInViaUi,
} from './helpers/auth'

/**
 * Duyệt tài khoản ở tầng giao diện.
 *
 * Bối cảnh: tài khoản đăng ký mới ở trạng thái chờ duyệt, không có phiên đăng nhập.
 * Super admin (email trong SUPER_ADMIN_EMAILS của server test) duyệt hoặc từ chối
 * trên trang quản trị; trang này chỉ có tính năng duyệt tài khoản.
 *
 * Server test đặt locale mặc định là `vi` (xem playwright.config.ts) nên nhãn nút
 * và thông báo dùng tiếng Việt.
 */

const PASSWORD = 'matkhau-e2e-rat-dai-123'

async function noHorizontalOverflow(page: import('@playwright/test').Page): Promise<void> {
  const widths = await page.evaluate(() => {
    const doc = document.documentElement
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth }
  })
  expect(widths.scrollWidth, 'trang quản trị không được tràn ngang').toBeLessThanOrEqual(widths.clientWidth + 1)
}

test('đăng ký mới hiện thông báo chờ duyệt và chưa đăng nhập được', async ({ page }) => {
  const email = `ui-pending-${Date.now()}@gigone.com`

  await page.goto(BASE)
  await page.getByRole('button', { name: 'Đăng ký ngay' }).click()
  await page.getByPlaceholder('ban@example.com').fill(email)
  await page.getByPlaceholder('Ít nhất 10 ký tự').fill(PASSWORD)
  await page.getByRole('button', { name: 'Tạo tài khoản' }).click()

  // Không vào ứng dụng: màn hình xác nhận tài khoản đang chờ duyệt.
  await expect(page.getByRole('heading', { name: 'Đã tạo tài khoản' })).toBeVisible()
  await expect(page.getByText(email)).toBeVisible()

  // Đăng nhập trước khi được duyệt vẫn bị chặn kèm lý do rõ ràng.
  await page.getByRole('button', { name: 'Quay lại đăng nhập' }).click()
  await page.getByPlaceholder('ban@example.com').fill(email)
  await page.getByPlaceholder('Nhập mật khẩu').fill(PASSWORD)
  await page.getByRole('button', { name: 'Đăng nhập' }).click()
  await expect(page.locator('.auth-error')).toContainText('đang chờ quản trị viên duyệt')
})

test('super admin duyệt tài khoản trên trang quản trị rồi tài khoản đó đăng nhập được', async ({ page }) => {
  const email = `ui-approve-${Date.now()}@gigone.com`

  const created = await registerAccountViaApi(page, email, PASSWORD)
  expect(created.approvalRequired).toBe(true)

  await ensureAdminSession(page)
  await page.goto(BASE)

  await expect(page.getByRole('heading', { name: 'Duyệt tài khoản' })).toBeVisible()
  // Trang quản trị không có mục nào dẫn tới tính năng tạo nội dung.
  await expect(page.getByRole('button', { name: 'Studio', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Thư viện', exact: true })).toHaveCount(0)

  // Xem toàn bộ tài khoản để hàng vẫn còn sau khi trạng thái đổi khỏi "chờ duyệt".
  await page.getByRole('button', { name: 'Tất cả', exact: true }).click()
  const row = page.locator('.admin-row').filter({ hasText: email })
  await expect(row.locator('.admin-status')).toHaveText('Chờ duyệt')

  await row.getByRole('button', { name: 'Duyệt' }).click()
  await expect(row.locator('.admin-status')).toHaveText('Đã duyệt')

  // Tài khoản đã duyệt đăng nhập được và thấy workspace thường.
  await page.request.post(`${BASE}/api/auth/logout`)
  await signInViaUi(page, { email, password: PASSWORD })
})

test('super admin từ chối tài khoản thì tài khoản đó không đăng nhập được', async ({ page }) => {
  const email = `ui-reject-${Date.now()}@gigone.com`

  const created = await registerAccountViaApi(page, email, PASSWORD)
  await ensureAdminSession(page)
  await rejectAccountViaApi(page, created.userId)
  await page.request.post(`${BASE}/api/auth/logout`)

  await page.goto(BASE)
  await page.getByPlaceholder('ban@example.com').fill(email)
  await page.getByPlaceholder('Nhập mật khẩu').fill(PASSWORD)
  await page.getByRole('button', { name: 'Đăng nhập' }).click()
  await expect(page.locator('.auth-error')).toContainText('đã bị quản trị viên từ chối')
})

test('trang quản trị không tràn ngang trên điện thoại nhỏ', async ({ page }) => {
  await ensureAdminSession(page)
  await page.setViewportSize({ width: 320, height: 640 })
  await page.goto(BASE)

  await expect(page.getByRole('heading', { name: 'Duyệt tài khoản' })).toBeVisible()
  await noHorizontalOverflow(page)
})

test('admin đăng nhập thẳng vào trang quản trị, không thấy Studio dù URL yêu cầu', async ({ page }) => {
  await ensureAdminSession(page)
  await page.goto(`${BASE}/?page=studio`)

  await expect(page.getByRole('heading', { name: 'Duyệt tài khoản' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true })).toHaveCount(0)

  // Đăng xuất khỏi vỏ quản trị quay về trang đăng nhập.
  await page.getByRole('button', { name: 'Đăng xuất' }).click()
  await expect(page.getByRole('button', { name: 'Đăng nhập' })).toBeVisible()
})
