import { expect, test } from '@playwright/test'
import { BASE } from './helpers/auth'

test('admin cấu hình ngoài tên miền đăng ký lần đầu tự duyệt và không thể đăng ký lại', async ({ page }) => {
  const email = 'bootstrap-admin@example.com'
  const password = 'bootstrap-admin-password-123'
  await page.goto(BASE)
  await page.getByRole('button', { name: 'Đăng ký ngay' }).click()
  await page.getByLabel('Tên', { exact: true }).fill('Initial Admin')
  await page.getByPlaceholder('ban@example.com').fill('  BOOTSTRAP-ADMIN@example.com  ')
  await page.getByPlaceholder('Ít nhất 10 ký tự').fill(password)
  await page.getByRole('button', { name: 'Tạo tài khoản', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Duyệt tài khoản' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Đã tạo tài khoản' })).toHaveCount(0)
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Studio', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click()
  await page.getByRole('button', { name: 'Đăng ký ngay' }).click()
  await page.getByLabel('Tên', { exact: true }).fill('Duplicate Admin')
  await page.getByPlaceholder('ban@example.com').fill(email)
  await page.getByPlaceholder('Ít nhất 10 ký tự').fill('replacement-password-123')
  await page.getByRole('button', { name: 'Tạo tài khoản', exact: true }).click()
  await expect(page.locator('.auth-error')).toContainText('Email này đã được đăng ký')
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click()
  await page.getByPlaceholder('Nhập mật khẩu').fill(password)
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Duyệt tài khoản' })).toBeVisible()
})
