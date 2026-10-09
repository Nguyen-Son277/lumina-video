import { expect, test, type Locator, type Page } from '@playwright/test'
import { BASE, seedProvider, signUpFresh } from './helpers/auth'
import { providerKeysCatalog as K } from '../src/i18n/catalogs/providerKeys'
import { shellCatalog } from '../src/i18n/catalogs/shell'

/**
 * Quản lý nhiều API key cho provider qua giao diện.
 *
 * Mỗi bài test dùng một tài khoản mới nên workspace luôn trống; provider được tạo
 * qua API (không tốn phí gọi provider thật) rồi toàn bộ thao tác key được thực hiện
 * bằng UI. Nhãn lấy thẳng từ catalog `providerKeys` để không lệch câu chữ.
 */

const SETTINGS_NAV = shellCatalog.navApiModels.vi
const REMOVE_PROVIDER = shellCatalog.removeProvider.vi

/** Nội suy tham số đúng như `translate` để nhãn test luôn khớp UI. */
function fill(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  )
}

async function openSettings(page: Page): Promise<void> {
  await page.goto(BASE)
  await page.getByRole('button', { name: SETTINGS_NAV, exact: true }).click()
  await expect(page.locator('.settings-page')).toBeVisible()
}

/** Hàng provider theo tên hiển thị. */
function providerItem(page: Page, name: string): Locator {
  return page.locator('.provider-item').filter({ hasText: name })
}

interface KeysPanel {
  item: Locator
  panel: Locator
}

/** Mở bảng key của provider rồi trả về hàng + bảng để thao tác tiếp. */
async function openKeys(page: Page, name: string, locale: 'vi' | 'en' = 'vi'): Promise<KeysPanel> {
  const item = providerItem(page, name)
  await item.getByRole('button', { name: fill(K.keysAria[locale], { name }) }).click()
  const panel = item.locator('.provider-credentials-panel')
  await expect(panel).toBeVisible()
  await expect(panel.locator('.credential-row, .credentials-empty').first()).toBeVisible()
  return { item, panel }
}

async function addKeyViaUi(page: Page, panel: Locator, label: string, secret: string): Promise<void> {
  await panel.getByRole('button', { name: K.addKey.vi }).click()
  const dialog = page.getByRole('dialog', { name: K.addKeyTitle.vi })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel(K.labelField.vi).fill(label)
  await dialog.getByLabel(K.secretField.vi).fill(secret)
  await dialog.getByRole('button', { name: K.saveKey.vi }).click()
  await expect(dialog).toHaveCount(0)
}

async function deleteKeyViaUi(page: Page, panel: Locator, label: string): Promise<void> {
  await panel.getByRole('button', { name: fill(K.deleteKeyAria.vi, { label }) }).click()
  const dialog = page.getByRole('dialog', { name: K.deleteConfirmTitle.vi })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: K.confirmDelete.vi }).click()
  await expect(dialog).toHaveCount(0)
}

/** Seed thêm key qua API để test không phụ thuộc thao tác thêm thủ công. */
async function seedCredential(
  page: Page,
  providerId: string,
  apiKey: string,
  label: string,
): Promise<void> {
  const response = await page.request.post(`${BASE}/api/providers/${providerId}/credentials`, {
    data: { apiKey, label },
  })
  expect(response.ok(), await response.text()).toBe(true)
}

/** Trang không được tràn ngang quá 1px (sai số làm tròn). */
async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(1)
}

test.beforeEach(async ({ page }) => {
  await signUpFresh(page)
})

test('thêm key: nhãn hiển thị, bí mật bị che và không lộ trong DOM', async ({ page }) => {
  const providerId = await seedProvider(page, {
    name: 'Gateway key',
    apiKey: 'sk-secret-alpha-1111',
  })
  await seedCredential(page, providerId, 'sk-secret-beta-2222', 'Key phụ')

  await openSettings(page)
  const { item, panel } = await openKeys(page, 'Gateway key')

  // Provider có sẵn một key backfill từ API key cũ.
  await expect(panel.locator('.credential-row')).toHaveCount(2)
  await expect(panel.getByText('Key phụ')).toBeVisible()
  await expect(item.getByRole('button', { name: REMOVE_PROVIDER })).toBeVisible()

  // Gợi ý chỉ là 4 ký tự cuối; bí mật đầy đủ không bao giờ có trong DOM.
  await expect(panel.locator('.credential-hint').first()).toHaveText('••••1111')
  expect(await page.content()).not.toContain('sk-secret-alpha-1111')
  expect(await page.content()).not.toContain('sk-secret-beta-2222')

  // Thêm key mới ngay trong giao diện.
  await addKeyViaUi(page, panel, 'Key thứ ba', 'sk-secret-gamma-3333')
  await expect(panel.locator('.credential-row')).toHaveCount(3)
  await expect(panel.getByText('Key thứ ba')).toBeVisible()
  expect(await page.content()).not.toContain('sk-secret-gamma-3333')
})

test('sửa key để trống bí mật thì giữ nguyên key cũ', async ({ page }) => {
  await seedProvider(page, { name: 'Gateway sửa key', apiKey: 'sk-keep-9999' })

  await openSettings(page)
  const { panel } = await openKeys(page, 'Gateway sửa key')
  const hintBefore = await panel.locator('.credential-hint').first().innerText()

  await panel.getByRole('button', { name: fill(K.editKeyAria.vi, { label: 'Key mặc định' }) }).click()
  const dialog = page.getByRole('dialog', { name: K.editKeyTitle.vi })
  await expect(dialog).toBeVisible()

  // Ô bí mật luôn trống khi sửa: key đã lưu không bao giờ được hiển thị lại.
  await expect(dialog.getByLabel(K.secretField.vi)).toHaveValue('')
  await expect(dialog.getByLabel(K.secretField.vi)).toHaveAttribute(
    'placeholder',
    K.secretPlaceholderKeep.vi,
  )

  await dialog.getByLabel(K.labelField.vi).fill('Key đổi tên')
  await dialog.getByRole('button', { name: K.saveChanges.vi }).click()
  await expect(dialog).toHaveCount(0)

  await expect(panel.getByText('Key đổi tên')).toBeVisible()
  await expect(panel.locator('.credential-hint').first()).toHaveText(hintBefore)
  expect(await page.content()).not.toContain('sk-keep-9999')
})

test('xoá key phải qua xác nhận; xoá hết key thì hiện hướng dẫn', async ({ page }) => {
  await seedProvider(page, { name: 'Gateway xoá key', apiKey: 'sk-delete-7777' })

  await openSettings(page)
  const { panel } = await openKeys(page, 'Gateway xoá key')

  // Mở hộp xác nhận rồi huỷ: key vẫn còn.
  await panel.getByRole('button', { name: fill(K.deleteKeyAria.vi, { label: 'Key mặc định' }) }).click()
  const dialog = page.getByRole('dialog', { name: K.deleteConfirmTitle.vi })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Key mặc định')
  await dialog.getByRole('button', { name: K.cancel.vi }).click()
  await expect(dialog).toHaveCount(0)
  await expect(panel.locator('.credential-row')).toHaveCount(1)

  // Xác nhận xoá: hết key thì bảng hiện trạng thái rỗng kèm hướng dẫn.
  await deleteKeyViaUi(page, panel, 'Key mặc định')
  await expect(panel.locator('.credential-row')).toHaveCount(0)
  await expect(panel.getByText(K.emptyTitle.vi)).toBeVisible()
  await expect(panel.getByText(K.emptyCaption.vi)).toBeVisible()
})

test('đổi thứ tự key bằng nút lên/xuống và giữ sau khi tải lại', async ({ page }) => {
  const providerId = await seedProvider(page, { name: 'Gateway thứ tự', apiKey: 'sk-order-1111' })
  await seedCredential(page, providerId, 'sk-order-2222', 'Key 2')

  await openSettings(page)
  const first = await openKeys(page, 'Gateway thứ tự')
  await expect(first.panel.locator('.credential-row').first()).toContainText('Key mặc định')

  await first.panel
    .getByRole('button', { name: fill(K.moveUpAria.vi, { label: 'Key 2' }) })
    .click()
  await expect(first.panel.locator('.credential-row').first()).toContainText('Key 2')
  // Nút lên của key đầu tiên bị vô hiệu hoá.
  await expect(
    first.panel.getByRole('button', { name: fill(K.moveUpAria.vi, { label: 'Key 2' }) }),
  ).toBeDisabled()

  await page.reload()
  await page.getByRole('button', { name: SETTINGS_NAV, exact: true }).click()
  const reloaded = await openKeys(page, 'Gateway thứ tự')
  await expect(reloaded.panel.locator('.credential-row').first()).toContainText('Key 2')
})

test('đổi chế độ chọn key failover/round robin và giữ sau khi tải lại', async ({ page }) => {
  await seedProvider(page, { name: 'Gateway chế độ', apiKey: 'sk-mode-1111' })

  await openSettings(page)
  const { panel } = await openKeys(page, 'Gateway chế độ')
  const select = panel.getByRole('combobox', { name: fill(K.modeAria.vi, { name: 'Gateway chế độ' }) })

  await expect(select).toHaveValue('failover')
  await expect(panel.getByText(K.modeFailoverHint.vi)).toBeVisible()

  await select.selectOption('round_robin')
  await expect(select).toHaveValue('round_robin')
  await expect(panel.getByText(K.modeRoundRobinHint.vi)).toBeVisible()

  await page.reload()
  await page.getByRole('button', { name: SETTINGS_NAV, exact: true }).click()
  const reloaded = await openKeys(page, 'Gateway chế độ')
  await expect(
    reloaded.panel.getByRole('combobox', { name: fill(K.modeAria.vi, { name: 'Gateway chế độ' }) }),
  ).toHaveValue('round_robin')
})

test('chặn thêm quá 10 key và báo giới hạn', async ({ page }) => {
  const providerId = await seedProvider(page, { name: 'Gateway giới hạn', apiKey: 'sk-limit-0000' })
  for (let index = 1; index < 10; index += 1) {
    await seedCredential(page, providerId, `sk-limit-${String(index).padStart(4, '0')}`, `Key ${index}`)
  }

  await openSettings(page)
  const { panel } = await openKeys(page, 'Gateway giới hạn')

  await expect(panel.locator('.credential-row')).toHaveCount(10)
  await expect(panel.getByRole('button', { name: K.addKey.vi })).toBeDisabled()
  await expect(panel.getByText(fill(K.limitReached.vi, { max: 10 }))).toBeVisible()
})

test('kiểm tra đúng một key rồi cập nhật trạng thái', async ({ page }) => {
  await seedProvider(page, { name: 'Gateway test key', apiKey: 'sk-test-1111' })

  await openSettings(page)
  const { panel } = await openKeys(page, 'Gateway test key')
  await expect(panel.locator('.credential-status')).toHaveText(K.statusUnknown.vi)

  await panel.getByRole('button', { name: fill(K.testKeyAria.vi, { label: 'Key mặc định' }) }).click()
  await expect(panel.locator('.credential-status')).toHaveText(K.statusOk.vi)
})

test('bật/tắt key và giữ trạng thái sau khi tải lại', async ({ page }) => {
  await seedProvider(page, { name: 'Gateway bật tắt', apiKey: 'sk-toggle-1111' })

  await openSettings(page)
  const { panel } = await openKeys(page, 'Gateway bật tắt')
  await expect(panel.getByRole('checkbox', { name: fill(K.disableKeyAria.vi, { label: 'Key mặc định' }) })).toBeChecked()

  await panel.getByRole('checkbox', { name: fill(K.disableKeyAria.vi, { label: 'Key mặc định' }) }).click()
  await expect(panel.getByRole('checkbox', { name: fill(K.enableKeyAria.vi, { label: 'Key mặc định' }) })).not.toBeChecked()
  await expect(panel.getByText(K.disabledBadge.vi)).toBeVisible()

  await page.reload()
  await page.getByRole('button', { name: SETTINGS_NAV, exact: true }).click()
  const reloaded = await openKeys(page, 'Gateway bật tắt')
  await expect(
    reloaded.panel.getByRole('checkbox', { name: fill(K.enableKeyAria.vi, { label: 'Key mặc định' }) }),
  ).not.toBeChecked()
})

test('trùng key bị từ chối kèm lỗi đã bản địa hoá', async ({ page }) => {
  await seedProvider(page, { name: 'Gateway trùng', apiKey: 'sk-duplicate-1234' })

  await openSettings(page)
  const { panel } = await openKeys(page, 'Gateway trùng')

  await panel.getByRole('button', { name: K.addKey.vi }).click()
  const dialog = page.getByRole('dialog', { name: K.addKeyTitle.vi })
  await dialog.getByLabel(K.labelField.vi).fill('Key trùng')
  await dialog.getByLabel(K.secretField.vi).fill('sk-duplicate-1234')
  await dialog.getByRole('button', { name: K.saveKey.vi }).click()

  // Hộp thoại giữ nguyên và hiện câu lỗi tiếng Việt từ catalog lỗi dùng chung.
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('alert')).toContainText('đã được lưu cho provider')
  await expect(panel.locator('.credential-row')).toHaveCount(1)
})

test('sửa tên và Base URL provider ngay trong bảng key', async ({ page }) => {
  await seedProvider(page, { name: 'Gateway sửa', apiKey: 'sk-edit-1111' })

  await openSettings(page)
  const item = providerItem(page, 'Gateway sửa')
  await item.getByRole('button', { name: fill(K.editProviderAria.vi, { name: 'Gateway sửa' }) }).click()

  const dialog = page.getByRole('dialog', { name: K.editProviderTitle.vi })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel(K.providerNameField.vi).fill('Gateway đổi tên')
  await dialog.getByLabel(K.baseUrlField.vi).fill('https://changed.mock.test/v1')
  await dialog.getByRole('button', { name: K.saveChanges.vi }).click()
  await expect(dialog).toHaveCount(0)

  const renamed = providerItem(page, 'Gateway đổi tên')
  await expect(renamed.locator('.provider-url')).toHaveText('https://changed.mock.test/v1')

  // Thay đổi được lưu thật ở backend, không chỉ là trạng thái cục bộ.
  await page.reload()
  await page.getByRole('button', { name: SETTINGS_NAV, exact: true }).click()
  await expect(providerItem(page, 'Gateway đổi tên').locator('.provider-url')).toHaveText(
    'https://changed.mock.test/v1',
  )
})

test.describe('bảng key trên màn hình nhỏ', () => {
  for (const viewport of [
    { name: 'mobile', width: 390, height: 844 },
    { name: 'mobile nhỏ', width: 320, height: 640 },
  ]) {
    test(`không tràn ngang ở ${viewport.name}`, async ({ page }) => {
      const providerId = await seedProvider(page, { name: 'Gateway nhỏ', apiKey: 'sk-small-1111' })
      await seedCredential(page, providerId, 'sk-small-2222', 'Key phụ')

      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.goto(BASE)
      await page.getByRole('button', { name: shellCatalog.openMenu.vi }).click()
      await page.getByRole('button', { name: SETTINGS_NAV, exact: true }).click()

      const item = providerItem(page, 'Gateway nhỏ')
      const toggle = item.getByRole('button', { name: fill(K.keysAria.vi, { name: 'Gateway nhỏ' }) })
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      await expect(item.locator('.credential-row')).toHaveCount(2)

      await expectNoHorizontalOverflow(page)
    })
  }
})

test.describe('bảng key hiển thị tiếng Anh', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('đổi ngôn ngữ sang en là nhãn key đổi theo', async ({ page }) => {
    await seedProvider(page, { name: 'English gateway', apiKey: 'sk-english-1111' })
    await page.addInitScript(() => localStorage.setItem('lumina.locale', 'en'))

    await page.goto(BASE)
    await page.getByRole('button', { name: shellCatalog.navApiModels.en, exact: true }).click()
    const { panel } = await openKeys(page, 'English gateway', 'en')

    await expect(panel.getByText(K.panelTitle.en)).toBeVisible()
    await expect(panel.getByRole('button', { name: K.addKey.en })).toBeVisible()
    await expect(panel.getByText(K.statusUnknown.en)).toBeVisible()
    await expect(panel.getByText(K.enabledBadge.en)).toBeVisible()
    await expect(
      panel.getByRole('combobox', { name: fill(K.modeAria.en, { name: 'English gateway' }) }),
    ).toBeVisible()
    await expect(panel.getByText(K.modeFailoverHint.en)).toBeVisible()
  })
})
