import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { AlertCircle, Check, Info, LoaderCircle } from 'lucide-react'

export type FeedbackTone = 'info' | 'success' | 'warning' | 'error'

export interface LoadingStateProps extends HTMLAttributes<HTMLDivElement> {
  label?: ReactNode
  icon?: ReactNode
  /** Disable default live-region attributes when retaining a silent legacy state. */
  announce?: boolean
}
export const LoadingState = forwardRef<HTMLDivElement, LoadingStateProps>(function LoadingState(
  { className = 'loading-state', role, 'aria-live': ariaLive, announce = true, label, icon, children, ...props }, ref,
) {
  return <div {...props} ref={ref} className={className} role={role ?? (announce ? 'status' : undefined)} aria-live={ariaLive ?? (announce ? 'polite' : undefined)}>
    {children ?? <>{icon ?? <LoaderCircle size={20} className="spin" aria-hidden="true" />}{label != null && <span>{label}</span>}</>}
  </div>
})

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: ReactNode
  description?: ReactNode
  icon?: ReactNode
  actions?: ReactNode
  headingAs?: 'h2' | 'h3'
}
export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(function EmptyState(
  { className = 'empty-state', title, description, icon, actions, headingAs: Heading = 'h3', children, ...props }, ref,
) {
  return <div {...props} ref={ref} className={className}>
    {children ?? <>{icon}{title != null && <Heading>{title}</Heading>}{description != null && <p>{description}</p>}{actions}</>}
  </div>
})

export interface InlineNoticeProps extends HTMLAttributes<HTMLElement> {
  as?: 'div' | 'p'
  tone?: FeedbackTone
}
/** Semantics are explicit: an informational hint does not silently become an alert. */
export const InlineNotice = forwardRef<HTMLElement, InlineNoticeProps>(function InlineNotice(
  { as: Root = 'div', className = 'ui-inline-notice', tone, ...props }, ref,
) {
  return <Root {...props} ref={ref as never} className={className} data-tone={tone} />
})

export interface ToastProps extends HTMLAttributes<HTMLDivElement> {
  message: ReactNode
  tone?: FeedbackTone
}
export const Toast = forwardRef<HTMLDivElement, ToastProps>(function Toast(
  { message, tone, className = 'toast', role, 'aria-live': ariaLive, ...props }, ref,
) {
  if (!message) return null
  const Icon = tone === 'error' || tone === 'warning' ? AlertCircle : tone === 'info' ? Info : Check
  return <div {...props} ref={ref} className={className} data-tone={tone} role={role ?? (tone === 'error' ? 'alert' : 'status')} aria-live={ariaLive ?? (tone === 'error' ? 'assertive' : 'polite')}>
    <div className="toast-check"><Icon size={14} aria-hidden="true" /></div>
    {message}
  </div>
})
