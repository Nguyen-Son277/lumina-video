/**
 * Catalog dùng chung toàn ứng dụng (namespace `common`).
 *
 * Quy ước: mỗi khoá ngữ nghĩa có đủ bản dịch `en` và `vi`.
 * `as const satisfies Catalog` giữ được kiểu khoá literal và kiểm tra đầy đủ ngôn ngữ ngay khi biên dịch.
 */

import type { Catalog } from '../types'

export const commonCatalog = {
  appName: { en: 'Lumina Studio', vi: 'Lumina Studio' },
  documentTitle: {
    en: 'Lumina Studio — AI creative workspace',
    vi: 'Lumina Studio — Không gian sáng tạo AI',
  },
  languageLabel: { en: 'Language', vi: 'Ngôn ngữ' },
  languageEnglish: { en: 'English', vi: 'English' },
  languageVietnamese: { en: 'Tiếng Việt', vi: 'Tiếng Việt' },
} as const satisfies Catalog

export type CommonCatalog = typeof commonCatalog
