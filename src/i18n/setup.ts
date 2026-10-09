/**
 * Cài đặt i18n một lần lúc khởi động: tiêu đề tài liệu + đồng bộ localStorage/DOM.
 * Gọi trong `src/main.tsx` trước khi render.
 */

import { commonCatalog } from './catalogs/common'
import { initLocale, registerLocaleTitleResolver } from './locale'
import { translate } from './translate'
import type { Catalog, Locale } from './types'

export interface InstallI18nOptions {
  /** Lắng nghe thay đổi ngôn ngữ từ tab khác. Mặc định `true`. */
  syncStorage?: boolean
  /** Catalog chứa khoá `documentTitle`; mặc định `commonCatalog`. */
  titleCatalog?: Catalog
}

/**
 * Khởi tạo ngôn ngữ, `<html lang>` và tiêu đề tài liệu theo ngôn ngữ đã lưu.
 * Trả về ngôn ngữ đang dùng.
 */
export function installI18n(options: InstallI18nOptions = {}): Locale {
  const titleCatalog = options.titleCatalog ?? commonCatalog
  registerLocaleTitleResolver(locale => translate(titleCatalog, 'documentTitle', undefined, locale))
  return initLocale({ syncStorage: options.syncStorage })
}
