/**
 * Hook React cho i18n, dùng `useSyncExternalStore` để đọc store ngôn ngữ.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { getLocale, getServerLocale, setLocale, subscribeLocale } from './locale'
import { createTranslate } from './translate'
import type { Catalog, CatalogKey, Locale, MessageParams, Translate } from './types'

export interface LocaleState {
  locale: Locale
  setLocale: (next: Locale | string) => Locale
}

/** Chỉ đọc/đổi ngôn ngữ hiện tại. */
export function useLocale(): LocaleState {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getServerLocale)
  return { locale, setLocale }
}

export interface Translation<C extends Catalog> extends LocaleState {
  /** Dịch một khoá trong catalog đã truyền; `t` chỉ nhận khoá hợp lệ của catalog đó. */
  t: Translate<C>
}

/**
 * Dịch trong component.
 *
 * @example
 * const { t, locale, setLocale } = useTranslation(commonCatalog)
 * t('documentTitle')
 * t('sceneCount', { count: 3 }) // 'Cảnh {count}' → 'Cảnh 3'
 */
export function useTranslation<C extends Catalog>(catalog: C): Translation<C> {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getServerLocale)
  const t = useMemo(() => createTranslate(catalog, () => locale), [catalog, locale])
  return { t, locale, setLocale }
}

/**
 * Giữ nguyên nội dung do AI sinh ra (không dịch, không biến đổi) và chỉ dùng bản dịch
 * của `fallbackKey` khi nội dung rỗng.
 *
 * @example
 * const message = useLocalizedMessage(plannerCatalog, 'emptyResult')
 * message(scene.summary)            // nguyên văn nếu có nội dung
 * message('', { topic: 'Mưa' })     // bản dịch dự phòng + nội suy
 */
export function useLocalizedMessage<C extends Catalog>(
  catalog: C,
  fallbackKey: CatalogKey<C>,
): (raw: string | null | undefined, params?: MessageParams) => string {
  const { t } = useTranslation(catalog)
  return useCallback(
    (raw: string | null | undefined, params?: MessageParams): string => {
      // Nội dung AI là văn bản thô: trả nguyên văn, kể cả khi chứa placeholder.
      if (typeof raw === 'string' && raw.trim() !== '') return raw
      return t(fallbackKey, params)
    },
    [t, fallbackKey],
  )
}
