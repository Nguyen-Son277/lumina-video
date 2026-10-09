import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { plannerCatalog } from '../../i18n/catalogs/planner'
import { useTranslation } from '../../i18n/useTranslation'

/** Focus-trapped overlay shared by Timeline chat and project confirmation. */
export function TimelineOverlay({ title, drawer = false, locked = false, onClose, children }: {
  title: string
  drawer?: boolean
  locked?: boolean
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const { t } = useTranslation(plannerCatalog)
  const closeRef = useRef(onClose)
  const lockedRef = useRef(locked)
  closeRef.current = onClose
  lockedRef.current = locked
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusable = () => Array.from(ref.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
    ) ?? [])
    focusable()[0]?.focus()
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (!lockedRef.current) closeRef.current()
      }
      if (event.key === 'Tab') {
        const items = focusable()
        const first = items[0]
        const last = items[items.length - 1]
        if (!first) { event.preventDefault(); ref.current?.focus(); return }
        if (event.shiftKey && (document.activeElement === first || !ref.current?.contains(document.activeElement))) {
          event.preventDefault(); last?.focus()
        } else if (!event.shiftKey && (document.activeElement === last || !ref.current?.contains(document.activeElement))) {
          event.preventDefault(); first.focus()
        }
      }
    }
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('keydown', key)
      document.body.style.overflow = overflow
      previous?.focus()
    }
  }, [])
  return createPortal(
    <div className={`timeline-overlay ${drawer ? 'is-drawer' : ''}`} onMouseDown={(event) => {
      if (event.target === event.currentTarget && !locked) onClose()
    }}>
      <div ref={ref} tabIndex={-1} className={drawer ? 'timeline-chat-drawer' : 'modal-card timeline-project-dialog'} role="dialog" aria-modal="true" aria-label={title}>
        <header className="timeline-overlay-head">
          <h2>{title}</h2>
          <button type="button" className="close-button" disabled={locked} aria-label={drawer ? t('closeChat') : t('closeProjectSetup')} onClick={onClose}><X size={18} /></button>
        </header>
        {children}
      </div>
    </div>, document.body,
  )
}
