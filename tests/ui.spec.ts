import { expect, test } from '@playwright/test'
import { BASE, signUpFresh } from './helpers/auth'

test.describe('Workspace / API & Models', () => {
  test.beforeEach(async ({ page }) => {
    await signUpFresh(page)
  })

  test('workspace mới không có provider hoặc model nào', async ({ page }) => {
    await page.goto(BASE)
    await page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true }).click()

    await expect(page.getByRole('heading', { name: /Tạo nội dung/ })).toBeVisible()
    await expect(page.getByText('Chưa có model ảnh')).toBeVisible()

    const body = await page.locator('body').innerText()
    for (const sample of ['Together AI', 'Krea gateway', 'GPT Image 1', 'FLUX 1.1 Pro', 'Veo 3']) {
      expect(body).not.toContain(sample)
    }
    expect(body).not.toContain('krea.example.com')
  })

  test('tab Providers và Model catalog đều trống', async ({ page }) => {
    await page.goto(BASE)
    await page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true }).click()
    await page.getByRole('button', { name: 'API & Models', exact: true }).click()

    await expect(page.getByText('Danh sách provider đang trống')).toBeVisible()
    await expect(page.getByText('Thêm kết nối đầu tiên bằng Base URL và API key để bắt đầu.')).toBeVisible()

    await page.getByRole('button', { name: /Model catalog/ }).click()
    await expect(page.getByText('Chưa có model nào')).toBeVisible()
    await expect(page.getByRole('button', { name: /Thêm model/ }).first()).toBeVisible()
  })

  test('thêm provider qua giao diện rồi thêm model', async ({ page }) => {
    await page.goto(BASE)
    await page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true }).click()
    await page.getByRole('button', { name: 'API & Models', exact: true }).click()

    await page.getByRole('button', { name: 'Thêm provider' }).first().click()
    await page.getByPlaceholder('Ví dụ: Production gateway').fill('Gateway của tôi')
    await page.getByPlaceholder('https://api.example.com/v1').fill('https://api.example.com/v1')
    await page.getByPlaceholder('sk-••••••••••••••••').fill('sk-test-key-abcd')
    await page.getByRole('button', { name: 'Lưu provider' }).click()

    await expect(page.getByText('Chưa kiểm tra')).toBeVisible()
    await expect(page.getByText('Gateway của tôi')).toBeVisible()
    await expect(page.getByText('api.example.com/v1')).toBeVisible()
    // Chỉ hiển thị 4 ký tự cuối, không bao giờ hiện key đầy đủ.
    await expect(page.getByText('••••abcd')).toBeVisible()

    await page.getByRole('button', { name: /Thêm model/ }).first().click()
    await page.getByPlaceholder('Ví dụ: gpt-image-1').fill('my-image-model')
    await page.getByPlaceholder('Ví dụ: GPT Image 1').fill('Model ảnh của tôi')
    await page.locator('.kind-picker button', { hasText: 'Tạo ảnh' }).click()
    await page.getByRole('button', { name: 'Lưu model' }).click()

    await page.getByRole('button', { name: /Model catalog/ }).click()
    await expect(page.getByText('Model ảnh của tôi')).toBeVisible()

    // Model đã phân loại phải xuất hiện trong Studio.
    await page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true }).click()
    // Bám theo nhãn "Model" thay vì chỉ số select, vì Topbar có thêm select ngôn ngữ.
    const modelSelect = page.getByRole('combobox', { name: 'Model', exact: true })
    await expect(modelSelect.locator('option:checked')).toHaveText('Model ảnh của tôi')
    await expect(page.getByText('Chưa có model ảnh')).toHaveCount(0)
  })

  test('chưa có model thì không thể tạo nội dung', async ({ page }) => {
    await page.goto(BASE)
    await page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true }).click()
    await page.getByPlaceholder('Mô tả điều bạn muốn tạo...').fill('Một khung cảnh thử nghiệm')
    await expect(page.getByRole('button', { name: 'Tạo hình ảnh' })).toBeDisabled()
    await expect(page.getByText('Chưa cấu hình API')).toBeVisible()
  })

  test('thêm model khi chưa có provider sẽ được hướng dẫn thêm provider', async ({ page }) => {
    await page.goto(BASE)
    await page.getByRole('button', { name: 'Tạo nội dung đơn lẻ', exact: true }).click()
    await page.getByRole('button', { name: 'API & Models', exact: true }).click()
    await page.getByRole('button', { name: /Model catalog/ }).click()
    await page.getByRole('button', { name: /Thêm model/ }).first().click()

    await expect(page.getByRole('heading', { name: 'Chưa có provider' })).toBeVisible()
    await page.getByRole('button', { name: 'Thêm provider' }).last().click()
    await expect(page.getByRole('heading', { name: 'Thêm provider' })).toBeVisible()
  })
})
