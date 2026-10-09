/**
 * Nền tảng i18n của Lumina Studio — không phụ thuộc thư viện ngoài, không import backend.
 *
 * Bắt đầu nhanh:
 *   import { installI18n } from './i18n'          // trong main.tsx, trước khi render
 *   import { useTranslation, LanguageSwitcher } from './i18n'
 */

export * from './types'
export * from './locale'
export * from './translate'
export * from './useTranslation'
export * from './setup'
export * from './messages'

export { LanguageSwitcher } from './LanguageSwitcher'
export type { LanguageSwitcherProps } from './LanguageSwitcher'

export { catalogs, commonCatalog } from './catalogs'
export type { CatalogNamespace, CommonCatalog } from './catalogs'
