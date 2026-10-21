import { useCallback, useEffect, useRef, type RefObject } from 'react'

const modalLayers: symbol[] = []
let bodyOverflow = ''

export interface ModalLayerOptions {
  /** Inactive drawers neither own body scroll nor install focus/keyboard listeners. */
  enabled?: boolean
}

function isVisible(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('[hidden], [inert]') || !element.getClientRects().length) return false
  const style = getComputedStyle(element)
  return style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.display !== 'none'
}

function focusableElements(panel: HTMLElement | null): HTMLElement[] {
  return Array.from(panel?.querySelectorAll<HTMLElement>(
    'button, a[href], input, select, textarea, summary, [tabindex]',
  ) ?? []).filter(element => !element.matches(':disabled') && element.getAttribute('tabindex') !== '-1' && isVisible(element))
}

/** Shared nested-modal keyboard/focus/scroll ownership. Only the top layer handles Escape. */
export function useModalLayer(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  { enabled = true }: ModalLayerOptions = {},
): () => boolean {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const token = useRef(Symbol('modal'))
  useEffect(() => {
    if (!enabled) return
    const id = token.current
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!modalLayers.length) {
      bodyOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    }
    modalLayers.push(id)
    const panel = ref.current
    const focusable = () => focusableElements(panel)
    // Native modal dialogs live in the browser's top layer, above our shared stack.
    const nativeModalOpen = () => Boolean(document.querySelector('dialog:modal'))
    const initial = panel?.querySelector<HTMLElement>('[data-modal-initial-focus]')
    if (!nativeModalOpen()) (initial && isVisible(initial) && !initial.matches(':disabled') ? initial : focusable()[0] ?? panel)?.focus()
    function keydown(event: KeyboardEvent) {
      if (modalLayers[modalLayers.length - 1] !== id || nativeModalOpen()) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const elements = focusable(), first = elements[0], last = elements[elements.length - 1]
      if (!first || !last) { event.preventDefault(); panel?.focus(); return }
      if (event.shiftKey && (document.activeElement === first || !panel?.contains(document.activeElement))) {
        event.preventDefault(); last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !panel?.contains(document.activeElement))) {
        event.preventDefault(); first.focus()
      }
    }
    function focusin(event: FocusEvent) {
      if (nativeModalOpen()) return
      if (modalLayers[modalLayers.length - 1] === id && !panel?.contains(event.target as Node)) (focusable()[0] ?? panel)?.focus()
    }
    document.addEventListener('keydown', keydown, true)
    document.addEventListener('focusin', focusin)
    return () => {
      document.removeEventListener('keydown', keydown, true)
      document.removeEventListener('focusin', focusin)
      const wasTop = modalLayers[modalLayers.length - 1] === id
      const index = modalLayers.indexOf(id)
      if (index !== -1) modalLayers.splice(index, 1)
      if (!modalLayers.length) document.body.style.overflow = bodyOverflow
      // Responsive drawers may hide the mobile opener when they deactivate.
      if (wasTop && previous && isVisible(previous)) previous.focus()
    }
  }, [ref, enabled])
  return useCallback(() => modalLayers[modalLayers.length - 1] === token.current, [])
}
