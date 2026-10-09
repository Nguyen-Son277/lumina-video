/**
 * i18n — mặc định tiếng Anh (`en`) và chuyển sang tiếng Việt (`vi`).
 *
 * Bối cảnh:
 * - `playwright.config.ts` ghim localStorage `lumina.locale = vi` cho các luồng cũ.
 *   Spec này ghi đè bằng `storageState` rỗng để kiểm tra mặc định `en` sạch.
 * - Nền tảng i18n nằm ở `src/i18n/`: khoá lưu `lumina.locale`, giá trị hợp lệ `en | vi`,
 *   mặc định `en` khi thiếu/không hợp lệ/bị chặn, đồng bộ qua sự kiện `storage`.
 * - `LanguageSwitcher` là một `<select>` với `option[value="en"]` = `English`,
 *   `option[value="vi"]` = `Tiếng Việt`, tên truy cập được là "Language" / "Ngôn ngữ".
 *
 * Nguyên tắc chống giòn:
 * - Nhãn route lấy đúng từ catalog `shell` (`navQuick`, `navCharacters`, `navLibrary`,
 *   `navPlanner`, `navApiModels`, `navStudio`, `navTimeline`) thay vì đoán câu chữ;
 *   đồng thời xác nhận ở chế độ `en` không còn văn bản tĩnh tiếng Việt của ứng dụng
 *   và ở chế độ `vi` nhãn khớp đúng các nhãn tiếng Việt đã biết.
 * - Chỉ quét văn bản tĩnh do ứng dụng sở hữu (`.auth-card`, `.sidebar`, `.topbar`),
 *   bỏ qua `<select>`/`<option>` và phần tử chọn ngôn ngữ (nhãn bản địa luôn là
 *   "English"/"Tiếng Việt" ở mọi ngôn ngữ), không đụng tới dữ liệu người dùng/AI.
 */

import { expect, test, type Locator, type Page } from '@playwright/test'
import { BASE, signUpFresh } from './helpers/auth'

/** Khoá localStorage mà store ngôn ngữ sử dụng. */
const LOCALE_KEY = 'lumina.locale'

// Config hiện tại ghim locale `vi`; spec mới cần một trình duyệt sạch hoàn toàn.
test.use({ storageState: { cookies: [], origins: [] } })

/** Nhận diện ký tự riêng của tiếng Việt (có dấu) trong văn bản tĩnh. */
const VIETNAMESE_DIACRITICS =
  /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i

/** Nhãn bản địa của hai lựa chọn ngôn ngữ (không đổi theo ngôn ngữ hiện tại). */
const NATIVE_LABELS = { en: 'English', vi: 'Tiếng Việt' } as const

/**
 * Nhãn tiếng Việt đã biết của ứng dụng (`shellCatalog`) — mốc xác nhận bản dịch.
 * Tiếng Anh lấy nguyên văn từ cùng catalog để không đoán câu chữ.
 */
const VI = {
  quick: 'Tạo nội dung đơn lẻ',
  studio: 'Studio',
  characters: 'Nhân vật',
  library: 'Thư viện',
  planner: 'Tạo kịch bản AI',
  timeline: 'Timeline',
  settings: 'API & Models',
} as const

/** Nhãn tiếng Anh tương ứng trong `src/i18n/catalogs/shell.ts`. */
const EN = {
  quick: 'Quick create',
  studio: 'Studio',
  characters: 'Characters',
  library: 'Library',
  planner: 'AI script planner',
  timeline: 'Timeline',
  settings: 'API & Models',
} as const

/** Các trang hợp lệ trong URL kèm nhãn en/vi đã biết (xem `src/App.tsx`). */
const ROUTES = [
  { route: 'quick', en: EN.quick, vi: VI.quick },
  { route: 'studio', en: EN.studio, vi: VI.studio },
  { route: 'characters', en: EN.characters, vi: VI.characters },
  { route: 'library', en: EN.library, vi: VI.library },
  { route: 'planner', en: EN.planner, vi: VI.planner },
  { route: 'timeline', en: EN.timeline, vi: VI.timeline },
  { route: 'settings', en: EN.settings, vi: VI.settings },
] as const

/**
 * Select chọn ngôn ngữ: nhận diện bằng hai giá trị `en`/`vi` thay vì phụ thuộc
 * class hay nhãn hiển thị (nhãn đổi theo ngôn ngữ hiện tại).
 */
function localeSelect(scope: Page | Locator): Locator {
  return scope.locator('select:has(option[value="en"]):has(option[value="vi"])').first()
}

/** Văn bản tĩnh do ứng dụng sở hữu, đã loại bỏ khung chọn ngôn ngữ (nhãn bản địa). */
async function staticText(scope: Locator): Promise<string> {
  return scope.evaluate((root: HTMLElement) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const parts: string[] = []
    let node = walker.nextNode()
    while (node) {
      const parent = node.parentElement
      if (parent && !parent.closest('.lumina-language-switcher, [data-locale]')) {
        // Bỏ qua đúng select ngôn ngữ (option English/Tiếng Việt luôn hiển thị bản địa),
        // vẫn giữ các select khác để kiểm tra nhãn lựa chọn của ứng dụng.
        const select = parent.closest('select')
        const isLocaleSelect =
          select !== null &&
          select.querySelector('option[value="en"]') !== null &&
          select.querySelector('option[value="vi"]') !== null
        if (!isLocaleSelect) parts.push(node.textContent ?? '')
      }
      node = walker.nextNode()
    }
    return parts.join('\n')
  })
}

/** Xác nhận một vùng giao diện tĩnh không còn lộ tiếng Việt khi đang ở chế độ `en`. */
async function expectNoVietnameseStaticText(scope: Locator, message: string): Promise<void> {
  expect(await staticText(scope), message).not.toMatch(VIETNAMESE_DIACRITICS)
}

/** localStorage hiện tại của trang. */
async function storedLocale(page: Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), LOCALE_KEY)
}

/** Mở một route đã đăng nhập bằng URL để không phụ thuộc nhãn điều hướng. */
async function gotoRoute(page: Page, route: string): Promise<void> {
  await page.goto(`${BASE}/?page=${route}`)
  await expect(page.locator('.topbar')).toBeVisible()
}

/** Không được tràn ngang quá 1px (sai số làm tròn). */
async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(1)
}

test.describe('i18n — mặc định tiếng Anh', () => {
  test('trang đăng nhập sạch hiển thị tiếng Anh, không lộ văn bản tĩnh tiếng Việt', async ({ page }) => {
    await page.goto(BASE)

    const shell = page.locator('.auth-shell')
    await expect(shell).toBeVisible()

    // `<html lang>` và tiêu đề tài liệu theo ngôn ngữ mặc định.
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    expect(await page.title()).not.toMatch(VIETNAMESE_DIACRITICS)

    // Mặc định sạch: hoặc chưa ghi gì, hoặc đã ghi `en` — tuyệt đối không phải `vi`.
    expect([null, 'en']).toContain(await storedLocale(page))

    // Select chọn ngôn ngữ có mặt, đúng tên truy cập được và đúng hai lựa chọn.
    const select = localeSelect(shell)
    await expect(select).toBeVisible()
    await expect(select).toHaveRole('combobox')
    await expect(select).toHaveAccessibleName(/Language|Ngôn ngữ/)
    await expect(select).toHaveValue('en')
    await expect(select.locator('option[value="en"]')).toHaveText(NATIVE_LABELS.en)
    await expect(select.locator('option[value="vi"]')).toHaveText(NATIVE_LABELS.vi)

    // Tiêu đề form là tiếng Anh (không đoán chính xác câu chữ của bản dịch).
    await expect(page.locator('.auth-title')).toContainText(/(sign|log)\s?in|welcome/i)

    // Vùng tĩnh của form không còn câu tiếng Việt nào.
    await expectNoVietnameseStaticText(page.locator('.auth-card'), 'form đăng nhập ở chế độ en')
  })

  test('giá trị không hợp lệ trong lumina.locale quay về en', async ({ page }) => {
    await page.goto(BASE)
    await expect(page.locator('.auth-shell')).toBeVisible()

    // Ghi một mã không được hỗ trợ rồi tải lại: phải chuẩn hoá về `en`.
    await page.evaluate((key) => localStorage.setItem(key, 'fr'), LOCALE_KEY)
    await page.reload()

    await expect(page.locator('.auth-shell')).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(localeSelect(page)).toHaveValue('en')
    await expect(page.locator('.auth-title')).toContainText(/(sign|log)\s?in|welcome/i)
  })

  test('storage bị chặn cho lumina.locale vẫn mặc định en', async ({ page }) => {
    // Chỉ chặn đúng khoá ngôn ngữ để không phá các tính năng khác dùng localStorage.
    await page.addInitScript((key: string) => {
      const prototype = Storage.prototype
      const originalGet = prototype.getItem
      const originalSet = prototype.setItem
      prototype.getItem = function (this: Storage, name: string) {
        if (name === key) throw new Error('storage bị chặn cho test')
        return originalGet.call(this, name)
      }
      prototype.setItem = function (this: Storage, name: string, value: string) {
        if (name === key) throw new Error('storage bị chặn cho test')
        return originalSet.call(this, name, value)
      }
    }, LOCALE_KEY)

    await page.goto(BASE)

    // Ứng dụng vẫn render và lùi về `en` thay vì vỡ.
    await expect(page.locator('.auth-shell')).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(localeSelect(page)).toHaveValue('en')
  })
})

test.describe('i18n — chuyển ngôn ngữ', () => {
  test('chọn Tiếng Việt được lưu và giữ nguyên sau khi tải lại', async ({ page }) => {
    await page.goto(BASE)
    const select = localeSelect(page)
    await expect(select).toHaveValue('en')

    await select.selectOption('vi')

    await expect(page.locator('html')).toHaveAttribute('lang', 'vi')
    expect(await storedLocale(page)).toBe('vi')
    await expect(select).toHaveValue('vi')
    await expect(page.locator('.auth-title')).toContainText(/Đăng nhập|tài khoản/i)
    // Tiêu đề tài liệu cũng đổi theo ngôn ngữ.
    expect(await page.title()).toMatch(VIETNAMESE_DIACRITICS)

    await page.reload()
    await expect(page.locator('.auth-shell')).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'vi')
    await expect(localeSelect(page)).toHaveValue('vi')
    expect(await storedLocale(page)).toBe('vi')
  })

  test('giá trị form đăng nhập được giữ khi đổi ngôn ngữ', async ({ page }) => {
    await page.goto(BASE)
    await expect(page.locator('.auth-shell')).toBeVisible()

    const email = page.locator('.auth-form input[type="email"]')
    const password = page.locator('.auth-form input[type="password"]')
    const title = page.locator('.auth-title')

    await email.fill('giao.dich@gigone.com')
    await password.fill('matkhau-rat-dai-123')
    const titleEn = await title.innerText()

    // en → vi: state React của form phải được giữ, chỉ câu chữ đổi.
    await localeSelect(page).selectOption('vi')
    await expect(page.locator('html')).toHaveAttribute('lang', 'vi')
    await expect(email).toHaveValue('giao.dich@gigone.com')
    await expect(password).toHaveValue('matkhau-rat-dai-123')
    await expect(title).not.toHaveText(titleEn)

    // vi → en: vẫn giữ nguyên giá trị.
    await localeSelect(page).selectOption('en')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(email).toHaveValue('giao.dich@gigone.com')
    await expect(password).toHaveValue('matkhau-rat-dai-123')
    await expect(title).toHaveText(titleEn)
  })

  test('đồng bộ ngôn ngữ giữa hai tab qua sự kiện storage', async ({ page, context }) => {
    await page.goto(BASE)
    const other = await context.newPage()

    try {
      await other.goto(BASE)
      await expect(localeSelect(page)).toHaveValue('en')
      await expect(localeSelect(other)).toHaveValue('en')

      // Tab A đổi sang vi → tab B nhận sự kiện `storage` và cập nhật theo.
      await localeSelect(page).selectOption('vi')
      await expect(localeSelect(other)).toHaveValue('vi')
      await expect(other.locator('html')).toHaveAttribute('lang', 'vi')

      // Chiều ngược lại: tab B đổi sang en → tab A cập nhật theo.
      await localeSelect(other).selectOption('en')
      await expect(localeSelect(page)).toHaveValue('en')
      await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    } finally {
      await other.close()
    }
  })
})

test.describe('i18n — route đã đăng nhập', () => {
  test('lỗi đăng nhập API đang hiển thị đổi ngôn ngữ ngay', async ({ page }) => {
    await page.goto(BASE)
    await page.getByLabel('Email', { exact: true }).fill('missing@gigone.com')
    await page.locator('input[type="password"]').fill('invalid-password-123')
    await page.locator('.auth-card button[type="submit"]').click()
    const error = page.locator('.auth-error')
    await expect(error).toBeVisible()
    await expect(error).toContainText(/email|password/i)
    await localeSelect(page).selectOption('vi')
    await expect(error).toContainText(/Email|mật khẩu/)
    await localeSelect(page).selectOption('en')
    await expect(error).toContainText(/email|password/i)
    await expectNoVietnameseStaticText(error, 'lỗi API tiếng Anh')
  })

  test('mọi nhãn điều hướng dịch được: en không lộ tiếng Việt, vi đúng nhãn đã biết', async ({ page }) => {
    await signUpFresh(page)

    // ---- Chế độ en (mặc định sạch) ----
    await gotoRoute(page, 'studio')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')

    for (const { route, en, vi } of ROUTES) {
      await gotoRoute(page, route)
      const breadcrumb = page.locator('.breadcrumb strong')
      await expect(breadcrumb).toBeVisible()
      // Nhãn tiếng Anh đúng như catalog `shell`.
      await expect(breadcrumb).toHaveText(en)
      // Và không được trùng nhãn tiếng Việt khi hai bản dịch khác nhau.
      if (VIETNAMESE_DIACRITICS.test(vi)) await expect(breadcrumb).not.toHaveText(vi)

      await expectNoVietnameseStaticText(
        page.locator('.sidebar'),
        `sidebar ở chế độ en cho route ${route}`,
      )
      await expectNoVietnameseStaticText(
        page.locator('.topbar'),
        `topbar ở chế độ en cho route ${route}`,
      )
      // Nội dung trang (tài khoản mới nên chỉ có văn bản tĩnh của ứng dụng).
      await expectNoVietnameseStaticText(
        page.locator('.main-area'),
        `nội dung trang ở chế độ en cho route ${route}`,
      )
    }

    const sidebarEn = page.locator('.sidebar')
    for (const label of [EN.quick, EN.characters, EN.library, EN.planner, EN.settings]) {
      await expect(sidebarEn.getByRole('button', { name: label, exact: true })).toBeVisible()
    }

    // ---- Chế độ vi ----
    await localeSelect(page.locator('.topbar')).selectOption('vi')
    await expect(page.locator('html')).toHaveAttribute('lang', 'vi')

    for (const { route, vi } of ROUTES) {
      await gotoRoute(page, route)
      await expect(page.locator('.breadcrumb strong')).toHaveText(vi)
    }

    const sidebar = page.locator('.sidebar')
    for (const label of [VI.quick, VI.characters, VI.library, VI.planner, VI.settings]) {
      await expect(sidebar.getByRole('button', { name: label, exact: true })).toBeVisible()
    }
  })
})

test.describe('i18n — responsive', () => {
  for (const width of [320, 390]) {
    test(`không tràn ngang và chọn được ngôn ngữ ở ${width}px (auth + topbar)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 })
      await page.goto(BASE)

      // --- Auth ---
      await expect(page.locator('.auth-shell')).toBeVisible()
      const authSelect = localeSelect(page.locator('.auth-shell'))
      await expect(authSelect).toBeVisible()
      await expect(authSelect).toHaveRole('combobox')
      await expect(authSelect).toHaveAccessibleName(/Language|Ngôn ngữ/)
      await expect(authSelect).toHaveValue('en')
      await expectNoHorizontalOverflow(page)

      // Đổi ngôn ngữ ngay trên màn hình nhỏ vẫn thao tác được.
      await authSelect.selectOption('vi')
      await expect(page.locator('html')).toHaveAttribute('lang', 'vi')
      await expectNoHorizontalOverflow(page)

      // --- Topbar (đã đăng nhập) ---
      await signUpFresh(page)
      await page.goto(BASE)
      await expect(page.locator('.topbar')).toBeVisible()

      const topSelect = localeSelect(page.locator('.topbar'))
      await expect(topSelect).toBeVisible()
      await expect(topSelect).toHaveRole('combobox')
      await expect(topSelect).toHaveAccessibleName(/Language|Ngôn ngữ/)
      // Ngôn ngữ đã chọn trước khi đăng ký vẫn được giữ.
      await expect(topSelect).toHaveValue('vi')
      await expectNoHorizontalOverflow(page)
    })
  }
})
