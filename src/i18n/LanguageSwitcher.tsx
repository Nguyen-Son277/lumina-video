/**
 * Nút chọn ngôn ngữ dùng chung: select có nhãn truy cập được, hiển thị tên bản địa
 * "English" / "Tiếng Việt". Không kèm CSS — lớp cha truyền `className`/`style`.
 */

import { useId, type CSSProperties } from 'react'
import { commonCatalog } from './catalogs/common'
import { translate } from './translate'
import { useLocale } from './useTranslation'
import type { Locale } from './types'

export interface LanguageSwitcherProps {
  /** Class cho khung bao; mặc định `lumina-language-switcher`. */
  className?: string
  /** Style nội tuyến cho khung bao (do lớp cha quyết định). */
  style?: CSSProperties
  /** Id của select; mặc định sinh tự động. */
  id?: string
  /** Nhãn truy cập được; mặc định lấy từ catalog `common`. */
  label?: string
  /** Hiện nhãn trực quan cạnh select. Mặc định `false` (chỉ dùng `aria-label`). */
  showLabel?: boolean
  /** Class cho select; mặc định `lumina-language-switcher__select`. */
  selectClassName?: string
  /** Gọi sau khi ngôn ngữ đổi, kèm mã ngôn ngữ mới. */
  onLocaleChange?: (locale: Locale) => void
}

/** Tên bản địa của từng ngôn ngữ — luôn hiển thị nguyên bản để người dùng nhận ra. */
const NATIVE_LABELS: Record<Locale, string> = {
  en: 'English',
  vi: 'Tiếng Việt',
}

const LOCALE_ORDER: Locale[] = ['en', 'vi']

export function LanguageSwitcher({
  className = 'lumina-language-switcher',
  style,
  id,
  label,
  showLabel = false,
  selectClassName = 'lumina-language-switcher__select',
  onLocaleChange,
}: LanguageSwitcherProps = {}) {
  const { locale, setLocale } = useLocale()
  const generatedId = useId()
  const selectId = id ?? `lumina-locale-${generatedId.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const labelText = label ?? translate(commonCatalog, 'languageLabel', undefined, locale)

  return (
    <div className={className} style={style} data-locale={locale}>
      {showLabel ? (
        <label className="lumina-language-switcher__label" htmlFor={selectId}>
          {labelText}
        </label>
      ) : null}
      <select
        id={selectId}
        className={selectClassName}
        aria-label={showLabel ? undefined : labelText}
        title={labelText}
        value={locale}
        onChange={event => {
          const next = setLocale(event.target.value)
          onLocaleChange?.(next)
        }}
      >
        {LOCALE_ORDER.map(code => (
          <option key={code} value={code} lang={code}>
            {NATIVE_LABELS[code]}
          </option>
        ))}
      </select>
    </div>
  )
}

export default LanguageSwitcher
