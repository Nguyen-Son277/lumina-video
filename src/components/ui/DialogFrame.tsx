import { forwardRef, useRef, type HTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import { useModalLayer } from './useModalLayer'

export interface DialogFrameProps extends HTMLAttributes<HTMLDivElement> {
  onClose: () => void
  backdropClassName?: string
  backdropProps?: HTMLAttributes<HTMLDivElement>
  panelProps?: HTMLAttributes<HTMLDivElement>
  /** False preserves legacy shells which do not manage modal keyboard/focus. */
  enabled?: boolean
  closeOnBackdrop?: boolean
  closeOnEscape?: boolean
  closeDisabled?: boolean
  portal?: boolean
}

/** Only the two legacy shell nodes; headers, forms and actions stay caller-owned. */
export const DialogFrame = forwardRef<HTMLDivElement, DialogFrameProps>(function DialogFrame(
  { onClose, className = 'modal-card', backdropClassName = 'modal-backdrop', backdropProps, panelProps,
    enabled = true, closeOnBackdrop = true, closeOnEscape = true, closeDisabled = false, portal = false, children, ...props }, ref,
) {
  const panelRef = useRef<HTMLDivElement>(null)
  const isTopLayer = useModalLayer(panelRef, () => {
    if (!closeDisabled && closeOnEscape) onClose()
  }, { enabled })
  const content = <div {...backdropProps} className={backdropClassName} onMouseDown={event => {
    backdropProps?.onMouseDown?.(event)
    if (!event.defaultPrevented && event.target === event.currentTarget && closeOnBackdrop && !closeDisabled && (!enabled || isTopLayer())) onClose()
  }}>
    <div role="dialog" aria-modal="true" tabIndex={enabled ? -1 : undefined} {...props} {...panelProps} className={className} ref={node => {
      panelRef.current = node
      if (typeof ref === 'function') ref(node)
      else if (ref) ref.current = node
    }}>
      {children}
    </div>
  </div>
  return portal ? createPortal(content, document.body) : content
})
