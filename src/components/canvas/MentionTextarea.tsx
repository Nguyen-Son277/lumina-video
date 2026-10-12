import { useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasAlias } from '../../api/canvas'
import { useTranslation } from '../../i18n'
import { canvasCatalog } from '../../i18n/catalogs/canvas'

/**
 * Ô nhập prompt có gợi ý `@đối tượng`.
 *
 * Danh sách alias do server trả về (đã gắn với node trên bảng), nên gợi ý luôn khớp
 * với thứ server phân giải lúc chạy. Chèn alias chỉ sửa văn bản: việc nối node vào
 * cảnh do người dùng quyết định, không tự thay đổi cấu trúc bảng.
 */
export function MentionTextarea({ value, aliases, onChange, onPick, placeholder, disabled, rows = 4 }: {
  value: string
  aliases: CanvasAlias[]
  onChange: (next: string) => void
  /** Gọi khi người dùng chèn một alias, để nối node tương ứng vào cảnh. */
  onPick?: (alias: CanvasAlias) => void
  placeholder?: string
  disabled?: boolean
  rows?: number
}) {
  const { t } = useTranslation(canvasCatalog)
  const ref = useRef<HTMLTextAreaElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  const matches = useMemo(() => {
    const needle = query.toLowerCase()
    return aliases
      .filter((alias) => !needle || alias.alias.toLowerCase().includes(needle) || alias.name.toLowerCase().includes(needle))
      .slice(0, 8)
  }, [aliases, query])

  useEffect(() => { setActive(0) }, [query, open])

  /** Vị trí `@` đang gõ, hoặc null khi con trỏ không nằm trong một mention. */
  function mentionAtCursor(text: string, caret: number): { start: number; query: string } | null {
    const before = text.slice(0, caret)
    const at = before.lastIndexOf('@')
    if (at < 0) return null
    // `\@` là ký tự thường, không mở gợi ý.
    if (at > 0 && before[at - 1] === '\\') return null
    const typed = before.slice(at + 1)
    if (/[\s@]/.test(typed)) return null
    return { start: at, query: typed }
  }

  function sync(text: string, caret: number): void {
    const found = mentionAtCursor(text, caret)
    setOpen(Boolean(found))
    setQuery(found?.query ?? '')
  }

  function insert(alias: CanvasAlias): void {
    const element = ref.current
    const caret = element?.selectionStart ?? value.length
    const found = mentionAtCursor(value, caret)
    const start = found?.start ?? caret
    const next = `${value.slice(0, start)}@${alias.alias} ${value.slice(caret)}`
    onChange(next)
    onPick?.(alias)
    setOpen(false)
    // Đặt lại con trỏ ngay sau alias vừa chèn.
    const position = start + alias.alias.length + 2
    requestAnimationFrame(() => {
      element?.focus()
      element?.setSelectionRange(position, position)
    })
  }

  return <div className="canvas-mention">
    <textarea
      ref={ref}
      className="canvas-mention-input"
      value={value}
      rows={rows}
      disabled={disabled}
      placeholder={placeholder ?? t('promptPlaceholder')}
      onChange={(event) => { onChange(event.target.value); sync(event.target.value, event.target.selectionStart ?? 0) }}
      onClick={(event) => sync(value, (event.target as HTMLTextAreaElement).selectionStart ?? 0)}
      onKeyDown={(event) => {
        if (!open) return
        if (event.key === 'ArrowDown') { event.preventDefault(); setActive((current) => Math.min(current + 1, matches.length - 1)) }
        else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((current) => Math.max(current - 1, 0)) }
        else if (event.key === 'Enter' && matches[active]) { event.preventDefault(); insert(matches[active]) }
        else if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
      }}
      onBlur={() => window.setTimeout(() => setOpen(false), 120)}
    />
    {open && (
      <div className="canvas-mention-menu" role="listbox" aria-label={t('mentionHint')}>
        {matches.length ? matches.map((alias, index) => (
          <button
            key={alias.nodeId}
            type="button"
            role="option"
            aria-selected={index === active}
            className={index === active ? 'is-active' : ''}
            onMouseDown={(event) => { event.preventDefault(); insert(alias) }}
          >
            <strong>@{alias.alias}</strong>
            <span>{alias.name}</span>
            {!alias.hasReference && <em>{t('mentionNoReference')}</em>}
          </button>
        )) : <span className="canvas-mention-empty">{t('mentionEmpty')}</span>}
      </div>
    )}
  </div>
}
