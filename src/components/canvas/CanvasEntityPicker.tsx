import { useId, useState } from 'react'
import { Image as ImageIcon } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { canvasCatalog } from '../../i18n/catalogs/canvas'

export type CanvasEntityOption = { value: string; label: string; description?: string; thumbnail?: string | null; type?: string }

/** Shared by node cards and the inspector; values retain their original source namespace. */
export function CanvasEntityPicker({ label, value, options, disabled, onChange, types }: {
  label: string
  value: string
  options: CanvasEntityOption[]
  disabled: boolean
  onChange: (value: string) => void
  types?: Array<{ value: string; label: string }>
}) {
  const id = useId()
  const { t } = useTranslation(canvasCatalog)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [type, setType] = useState('')
  const selected = options.find(option => option.value === value)
  const filtered = options.filter(option => (!type || option.type === type) && `${option.label} ${option.description ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  const choose = (next: string) => { onChange(next); setOpen(false); setQuery('') }
  return <div className="canvas-entity-picker nodrag nowheel" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
  }}>
    <label htmlFor={id}>{label}</label>
    {types && <label>{t('entityType')}<select className="canvas-select" aria-label={t('entityType')} value={type} disabled={disabled} onChange={event => { setType(event.target.value); setOpen(true); setQuery(''); setActive(0) }}>
      <option value="">{t('entityAllTypes')}</option>{types.map(entry => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
    </select></label>}
    <div className="canvas-entity-picker-control">
      {selected?.thumbnail && <img src={selected.thumbnail} alt="" />}
      <input id={id} role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={open ? `${id}-list` : undefined} aria-activedescendant={open && filtered[active] ? `${id}-option-${active}` : undefined}
        disabled={disabled} placeholder={label} value={open ? query : selected?.label ?? ''}
        onFocus={() => { setOpen(true); setQuery(''); setActive(0) }}
        onClick={() => { if (!open) { setOpen(true); setQuery(''); setActive(0) } }}
        onChange={event => { setQuery(event.target.value); setOpen(true); setActive(0) }}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); setOpen(true)
            setActive(index => Math.max(0, Math.min(filtered.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))))
          }
          if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229 && open && filtered[active]) { event.preventDefault(); choose(filtered[active].value) }
        }} />
      {value && !disabled && <button type="button" aria-label={t('entityClear')} onClick={() => choose('')}>×</button>}
    </div>
    {selected && !open && <strong className="canvas-entity-selected">{selected.label}</strong>}
    {open && <div id={`${id}-list`} role="listbox" aria-label={label} className="canvas-entity-options">
      {filtered.map((option, index) => <button type="button" role="option" aria-selected={value === option.value} id={`${id}-option-${index}`} key={option.value}
        className={active === index ? 'is-active' : ''} onMouseEnter={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(option.value)}>
        {option.thumbnail ? <img src={option.thumbnail} alt="" loading="lazy" /> : <ImageIcon size={24} />}
        <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
      </button>)}
      {!filtered.length && <p>{t('entityNoResults')}</p>}
    </div>}
  </div>
}
