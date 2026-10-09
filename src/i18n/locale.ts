/**
 * Store ngôn ngữ tối giản, không phụ thuộc thư viện.
 *
 * - Mặc định `en`; chỉ chấp nhận `en` / `vi`.
 * - Lưu vào `localStorage` khoá `lumina.locale`; giá trị sai hoặc storage bị chặn đều quay về `en`.
 * - Đồng bộ giữa các tab qua sự kiện `storage`.
 * - Tự cập nhật `<html lang>` (và tiêu đề nếu có resolver) khi ngôn ngữ đổi.
 * - Đọc được bằng `useSyncExternalStore` qua `subscribeLocale` / `getLocale` / `getServerLocale`.
 */

import { SUPPORTED_LOCALES, type Locale, type LocaleListener } from './types'

/** Khoá localStorage lưu ngôn ngữ đang chọn. */
export const LOCALE_STORAGE_KEY = 'lumina.locale'

/** Ngôn ngữ mặc định khi chưa lưu gì hoặc dữ liệu không hợp lệ. */
export const DEFAULT_LOCALE: Locale = 'en'

/** Kiểm tra một giá trị bất kỳ có phải mã ngôn ngữ hợp lệ. */
export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

/** Chuẩn hoá giá trị bất kỳ về `Locale`; không hợp lệ trả về `en`. */
export function normalizeLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE
}

/** Lấy `localStorage` nếu truy cập được (có thể bị chặn bởi trình duyệt/chế độ riêng tư). */
function safeStorage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    return window.localStorage
  } catch {
    return null
  }
}

/** Đọc ngôn ngữ đã lưu; lỗi truy cập hoặc giá trị sai đều trả về `en`. */
export function readStoredLocale(): Locale {
  const storage = safeStorage()
  if (!storage) return DEFAULT_LOCALE
  try {
    return normalizeLocale(storage.getItem(LOCALE_STORAGE_KEY))
  } catch {
    return DEFAULT_LOCALE
  }
}

/** Ghi ngôn ngữ vào localStorage; trả về `false` nếu storage bị chặn/đầy. */
export function writeStoredLocale(locale: Locale): boolean {
  const storage = safeStorage()
  if (!storage) return false
  try {
    storage.setItem(LOCALE_STORAGE_KEY, locale)
    return true
  } catch {
    return false
  }
}

let currentLocale: Locale = readStoredLocale()
const listeners = new Set<LocaleListener>()

/** Ngôn ngữ hiện tại (đọc đồng bộ, dùng cho `useSyncExternalStore`). */
export function getLocale(): Locale {
  return currentLocale
}

/** Giá trị dùng khi render phía server (không có localStorage). */
export function getServerLocale(): Locale {
  return DEFAULT_LOCALE
}

/** Đăng ký lắng nghe thay đổi ngôn ngữ; trả về hàm huỷ đăng ký. */
export function subscribeLocale(listener: LocaleListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

let titleResolver: ((locale: Locale) => string) | null = null

/**
 * Đăng ký hàm tạo tiêu đề tài liệu theo ngôn ngữ.
 * `null` để tắt việc cập nhật tiêu đề tự động.
 */
export function registerLocaleTitleResolver(resolver: ((locale: Locale) => string) | null): void {
  titleResolver = resolver
  applyLocaleToDocument(currentLocale)
}

/** Cập nhật `<html lang>` và tiêu đề tài liệu theo ngôn ngữ đã cho. */
export function applyLocaleToDocument(locale: Locale = currentLocale): void {
  if (typeof document === 'undefined') return
  try {
    document.documentElement.lang = locale
    if (titleResolver) {
      const title = titleResolver(locale)
      if (title) document.title = title
    }
  } catch {
    // Bỏ qua nếu DOM không cho phép ghi.
  }
}

function commit(next: Locale, options: { persist: boolean; notify: boolean }): void {
  const changed = next !== currentLocale
  currentLocale = next
  applyLocaleToDocument(next)
  if (options.persist) writeStoredLocale(next)
  if (options.notify && changed) {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // Một listener lỗi không được chặn các listener còn lại.
      }
    }
  }
}

/**
 * Đổi ngôn ngữ: chuẩn hoá, ghi localStorage (nếu được), cập nhật DOM và thông báo cho React.
 * Trả về ngôn ngữ thực sự được áp dụng.
 */
export function setLocale(next: Locale | string): Locale {
  const locale = normalizeLocale(next)
  commit(locale, { persist: true, notify: true })
  return locale
}

/** Đồng bộ khi tab khác đổi `lumina.locale` (hoặc xoá toàn bộ storage). */
function handleStorageEvent(event: StorageEvent): void {
  if (event.key !== null && event.key !== LOCALE_STORAGE_KEY) return
  commit(normalizeLocale(event.newValue), { persist: false, notify: true })
}

let initialized = false

export interface InitLocaleOptions {
  /** Lắng nghe thay đổi từ tab khác. Mặc định `true`. */
  syncStorage?: boolean
}

/**
 * Khởi tạo store: đọc localStorage, đồng bộ DOM và (tuỳ chọn) lắng nghe sự kiện `storage`.
 * Gọi nhiều lần là an toàn (idempotent). Trả về ngôn ngữ hiện tại.
 */
export function initLocale(options: InitLocaleOptions = {}): Locale {
  const { syncStorage = true } = options
  if (initialized) {
    applyLocaleToDocument(currentLocale)
    return currentLocale
  }
  initialized = true
  if (syncStorage && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('storage', handleStorageEvent)
  }
  commit(readStoredLocale(), { persist: false, notify: false })
  return currentLocale
}

/** Gỡ listener và đưa store về trạng thái ban đầu (dùng cho test). */
export function teardownLocale(): void {
  if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
    window.removeEventListener('storage', handleStorageEvent)
  }
  initialized = false
  listeners.clear()
  titleResolver = null
}
