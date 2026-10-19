import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

type Props = {
  title: string
  closeLabel: string
  closeDisabled?: boolean
  /** A nested lightbox or native preview dialog owns keyboard/focus handling. */
  suspended?: boolean
  onClose: () => void
  children: ReactNode
}

const focusableSelector = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])'

/** Portal shell only: the workspace owns persistence, dirty confirmation and busy state. */
export function SceneEditorModal({ title, closeLabel, closeDisabled = false, suspended = false, onClose, children }: Props) {
  const titleId = useId()
  const modalRef = useRef<HTMLElement>(null)
  const lastFocused = useRef<HTMLElement | null>(null)
  const wasSuspended = useRef(suspended)
  const current = useRef({ closeDisabled, suspended, onClose })
  current.current = { closeDisabled, suspended, onClose }

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const modal = modalRef.current
    if (!modal) return () => { document.body.style.overflow = overflow }

    const nestedOverlayOpen = () => current.current.suspended
      || Boolean(document.querySelector('dialog[open], .lightbox-backdrop'))
    const focusables = () => Array.from(modal.querySelectorAll<HTMLElement>(focusableSelector))
      .filter(element => element.getClientRects().length > 0 && !element.closest('[inert]'))
    const focusInitial = () => {
      const input = modal.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled), select:not(:disabled)')
      const target = input ?? focusables()[0] ?? modal
      target.focus()
      lastFocused.current = target
    }
    if (!nestedOverlayOpen()) focusInitial()

    function onKeyDown(event: KeyboardEvent) {
      if (nestedOverlayOpen() || event.defaultPrevented) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (!current.current.closeDisabled) current.current.onClose()
      } else if (event.key === 'Tab') {
        const elements = focusables()
        const first = elements[0]
        const last = elements[elements.length - 1]
        if (!first) {
          event.preventDefault()
          modal!.focus()
        } else if (!modal!.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
          event.preventDefault()
          ;(event.shiftKey ? last : first).focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    function onFocusIn(event: FocusEvent) {
      if (!nestedOverlayOpen() && event.target instanceof HTMLElement && modal!.contains(event.target)) {
        lastFocused.current = event.target
      }
      if (!nestedOverlayOpen() && event.target instanceof Node && !modal!.contains(event.target)) {
        ;(focusables()[0] ?? modal!).focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('focusin', onFocusIn)
      document.body.style.overflow = overflow
      if (previous?.isConnected) previous.focus()
    }
  }, [])

  useEffect(() => {
    if (wasSuspended.current && !suspended) {
      const modal = modalRef.current
      const target = lastFocused.current
      if (modal && (!modal.contains(document.activeElement) || document.activeElement === document.body)) {
        ;(target?.isConnected ? target : modal).focus()
      }
    }
    wasSuspended.current = suspended
  }, [suspended])

  return createPortal(
    <div className="project-scene-modal-backdrop">
      <section ref={modalRef} className="project-scene-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="project-scene-modal-header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="secondary-button close-button project-scene-modal-close" aria-label={closeLabel} title={closeLabel} disabled={closeDisabled} onClick={onClose}>
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <div className="project-scene-modal-body">{children}</div>
      </section>
    </div>,
    document.body,
  )
}
