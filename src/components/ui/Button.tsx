import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { shellCatalog } from '../../i18n/catalogs/shell'

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'unstyled'
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
}

const variantClasses: Record<ButtonVariant, string | undefined> = {
  primary: 'primary-small-button',
  secondary: 'secondary-button',
  danger: 'ui-button ui-button--danger',
  ghost: 'ui-button ui-button--ghost',
  unstyled: undefined,
}

/** A native button: callers opt into submit and retain all native attributes. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { type = 'button', variant = 'unstyled', className, ...props }, ref,
) {
  return <button {...props} ref={ref} type={type} className={className ?? variantClasses[variant]} />
})

export interface IconButtonProps extends ButtonProps {
  label: string
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, className = 'icon-button', ...props }, ref,
) {
  return <Button {...props} ref={ref} className={className} aria-label={props['aria-label'] ?? label} />
})

export interface CloseButtonProps extends ButtonProps {
  label?: string
  iconSize?: number
}

export const CloseButton = forwardRef<HTMLButtonElement, CloseButtonProps>(function CloseButton(
  { label, className = 'close-button', iconSize = 20, children, ...props }, ref,
) {
  const { t } = useTranslation(shellCatalog)
  return <Button {...props} ref={ref} className={className} aria-label={props['aria-label'] ?? label ?? t('close')}>
    {children ?? <X size={iconSize} aria-hidden="true" />}
  </Button>
})
