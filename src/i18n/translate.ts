/**
 * Dịch thuần (không hook) + các hàm định dạng theo ngôn ngữ.
 *
 * Mọi hàm đều nhận `locale` tuỳ chọn ở cuối; mặc định lấy ngôn ngữ hiện tại từ store.
 */

import { DEFAULT_LOCALE, getLocale } from './locale'
import { SUPPORTED_LOCALES, type Catalog, type CatalogKey, type Locale, type MessageParams, type Translate } from './types'

const PLACEHOLDER = /\{(\w+)\}/g

/**
 * Thay các placeholder `{name}` bằng giá trị trong `params`.
 * Placeholder không có trong `params` được giữ nguyên (an toàn với nội dung thô).
 */
export function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template
  return template.replace(PLACEHOLDER, (match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return match
    const value = params[name]
    return value === undefined || value === null ? match : String(value)
  })
}

/** Tra bản dịch thô; thiếu ngôn ngữ thì lùi về `en`, rồi tới bản dịch đầu tiên có sẵn. */
function lookup(catalog: Catalog, key: string, locale: Locale): string | undefined {
  const entry = catalog[key]
  if (!entry) return undefined
  return entry[locale] ?? entry[DEFAULT_LOCALE] ?? Object.values(entry)[0]
}

/**
 * Dịch không cần hook.
 *
 * @example
 * translate(commonCatalog, 'documentTitle', undefined, 'vi')
 * translate(studioCatalog, 'sceneCount', { count: 3 })
 */
export function translate<C extends Catalog>(
  catalog: C,
  key: CatalogKey<C>,
  params?: MessageParams,
  locale: Locale = getLocale(),
): string {
  const entry = catalog[key]
  const count = params?.count
  const singular = typeof count === 'number' && new Intl.PluralRules(locale).select(count) === 'one'
    ? entry?.[locale === 'en' ? 'enOne' : 'viOne']
    : undefined
  const template = singular ?? lookup(catalog, key, locale)
  if (template === undefined) {
    if (import.meta.env?.DEV) console.warn(`[i18n] Missing translation: ${key} (${locale})`)
    return key
  }
  return interpolate(template, params)
}

/** Tạo hàm dịch đã gắn catalog; ngôn ngữ được đọc lại mỗi lần gọi qua `resolveLocale`. */
export function createTranslate<C extends Catalog>(
  catalog: C,
  resolveLocale: () => Locale = getLocale,
): Translate<C> {
  return (key, params) => translate(catalog, key, params, resolveLocale())
}

/** Định dạng số theo ngôn ngữ (`1.234,5` với `vi`, `1,234.5` với `en`). */
export function formatNumber(
  value: number,
  options: Intl.NumberFormatOptions = {},
  locale: Locale = getLocale(),
): string {
  return new Intl.NumberFormat(locale, options).format(value)
}

/** Định dạng ngày/giờ theo ngôn ngữ. Ngày không hợp lệ trả về chuỗi rỗng. */
export function formatDate(
  value: Date | number | string,
  options: Intl.DateTimeFormatOptions = {},
  locale: Locale = getLocale(),
): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(locale, options).format(date)
}

/** Select a grammatical number form; Vietnamese always uses the other form. */
export function pluralForm(count: number, forms: { one: string; other: string }, locale: Locale = getLocale()): string {
  return new Intl.PluralRules(locale).select(count) === 'one' ? forms.one : forms.other
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

export interface FormatBytesOptions {
  /** Số chữ số thập phân; mặc định 0 cho byte, 1 cho các đơn vị lớn hơn. */
  decimals?: number
  /** Cơ số quy đổi; mặc định 1024 (nhị phân), dùng 1000 cho thập phân. */
  base?: 1000 | 1024
}

/** Định dạng dung lượng theo ngôn ngữ, ví dụ `1,5 MB` (vi) / `1.5 MB` (en). */
export function formatBytes(
  bytes: number,
  options: FormatBytesOptions = {},
  locale: Locale = getLocale(),
): string {
  const base = options.base ?? 1024
  const finite = Number.isFinite(bytes) ? bytes : 0
  const sign = finite < 0 ? '-' : ''
  let value = Math.abs(finite)
  let unitIndex = 0
  while (value >= base && unitIndex < BYTE_UNITS.length - 1) {
    value /= base
    unitIndex += 1
  }
  const decimals = options.decimals ?? (unitIndex === 0 ? 0 : 1)
  const formatted = formatNumber(value, { maximumFractionDigits: decimals, minimumFractionDigits: 0 }, locale)
  return `${sign}${formatted} ${BYTE_UNITS[unitIndex]}`
}

export interface FormatDurationOptions {
  /** `clock` → `1:05:03`; `short`/`long` → đơn vị bản địa hoá qua `Intl` (`5 hr`, `5 giờ`). */
  style?: 'clock' | 'short' | 'long'
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** Định dạng khoảng thời gian (giây) theo ngôn ngữ. */
export function formatDuration(
  seconds: number,
  options: FormatDurationOptions = {},
  locale: Locale = getLocale(),
): string {
  const style = options.style ?? 'clock'
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60

  if (style === 'clock') {
    return hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(secs)}` : `${minutes}:${pad2(secs)}`
  }

  const unitDisplay = style === 'long' ? 'long' : 'short'
  const unit = (value: number, name: Intl.NumberFormatOptions['unit']): string =>
    new Intl.NumberFormat(locale, { style: 'unit', unit: name, unitDisplay }).format(value)

  const parts: string[] = []
  if (hours > 0) parts.push(unit(hours, 'hour'))
  if (minutes > 0) parts.push(unit(minutes, 'minute'))
  if (secs > 0 || parts.length === 0) parts.push(unit(secs, 'second'))
  return parts.join(' ')
}

export interface MissingTranslation {
  key: string
  locale: Locale
}

/** Liệt kê khoá thiếu/rỗng bản dịch — tiện cho test tính đầy đủ của catalog. */
export function missingTranslations(catalog: Catalog): MissingTranslation[] {
  const missing: MissingTranslation[] = []
  for (const [key, entry] of Object.entries(catalog)) {
    const partial = entry as Partial<Record<Locale, string>>
    for (const locale of SUPPORTED_LOCALES) {
      const value = partial[locale]
      if (typeof value !== 'string' || value.trim() === '') missing.push({ key, locale })
    }
  }
  return missing
}
