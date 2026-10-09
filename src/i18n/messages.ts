/**
 * Ranh giới thông báo (toast) của ứng dụng.
 *
 * Nội dung toast chỉ có đúng hai dạng:
 * - `LocalizedTextDescriptor`: câu do ứng dụng sở hữu, lưu namespace + khoá + tham số
 *   nên dịch lại được ở mọi ngôn ngữ. Component con tạo descriptor bằng `notification()`.
 * - `string`: nội dung thô (AI/người dùng/provider) — LUÔN giữ nguyên văn, kể cả khi
 *   trùng khít một câu trong catalog.
 *
 * KHÔNG có cơ chế "đoán ngược" chuỗi đã dịch thành khoá catalog: việc suy luận đó biến
 * nội dung thô thành câu dịch máy nên đã bị loại bỏ. Muốn toast dịch lại theo ngôn ngữ,
 * nơi phát phải gửi descriptor tường minh.
 */

import { catalogs, type CatalogNamespace } from './catalogs'
import { getLocale } from './locale'
import { translate } from './translate'
import type { Catalog, Locale, MessageParams } from './types'

/** Khoá hợp lệ của một namespace catalog đã đăng ký. */
export type CatalogKeyOf<N extends CatalogNamespace> = keyof (typeof catalogs)[N] & string

/** Khoá catalog + tham số nội suy, đủ để dịch lại ở bất kỳ ngôn ngữ nào. */
export interface LocalizedTextDescriptor {
  /** Namespace catalog, ví dụ `shell`, `studio`, `planner`. */
  namespace: CatalogNamespace
  /** Khoá trong namespace đó. */
  key: string
  /** Tham số nội suy (đã giữ nguyên, kể cả giá trị là nội dung thô). */
  params?: MessageParams
}

/**
 * Nội dung toast ở ranh giới ứng dụng.
 *
 * - `LocalizedTextDescriptor`: câu do ứng dụng sở hữu, dịch theo ngôn ngữ hiện tại.
 * - `string`: văn bản thô từ AI/người dùng/provider — không bao giờ bị dịch.
 */
export type Notification = string | LocalizedTextDescriptor

/**
 * Tạo descriptor tường minh cho một câu do ứng dụng sở hữu.
 *
 * @example
 * notification('planner', 'aiRanStep', { step: label })
 * notification('characters', 'aiNotifyBatchSaved', { count: saved.length })
 */
export function notification<N extends CatalogNamespace>(
  namespace: N,
  key: CatalogKeyOf<N>,
  params?: MessageParams,
): LocalizedTextDescriptor {
  return params ? { namespace, key, params } : { namespace, key }
}

/** Dịch lại một descriptor theo ngôn ngữ hiện tại (hoặc ngôn ngữ chỉ định). */
export function translateLocalizedText(
  descriptor: LocalizedTextDescriptor,
  locale: Locale = getLocale(),
): string {
  const catalog = catalogs[descriptor.namespace] as Catalog | undefined
  if (!catalog) return descriptor.key
  return translate(catalog, descriptor.key, descriptor.params, locale)
}

/** Dịch nội dung toast: chuỗi thô giữ nguyên, descriptor tra catalog. */
export function notificationText(
  message: Notification,
  locale?: Locale,
): string {
  return typeof message === 'string' ? message : translateLocalizedText(message, locale)
}

/** Kiểm tra giá trị bất kỳ có phải descriptor hợp lệ (namespace đã đăng ký + key chuỗi). */
export function isLocalizedTextDescriptor(value: unknown): value is LocalizedTextDescriptor {
  if (!value || typeof value !== 'object') return false
  const namespace = (value as { namespace?: unknown }).namespace
  const key = (value as { key?: unknown }).key
  return (
    typeof namespace === 'string' &&
    Object.prototype.hasOwnProperty.call(catalogs, namespace) &&
    typeof key === 'string'
  )
}
