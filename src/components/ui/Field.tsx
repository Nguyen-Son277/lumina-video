import { forwardRef, type LabelHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type ChangeEvent } from 'react'
import { ChevronDown } from 'lucide-react'

export interface FieldProps extends LabelHTMLAttributes<HTMLLabelElement> {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  hintId?: string
  errorId?: string
  /** False preserves legacy labels whose text is a direct child. */
  labelWrapper?: boolean
}

/** The wrapping native label keeps implicit and explicit label association intact. */
export const Field = forwardRef<HTMLLabelElement, FieldProps>(function Field(
  { label, hint, error, hintId, errorId, labelWrapper = true, children, ...props }, ref,
) {
  return <label {...props} ref={ref}>
    {labelWrapper ? <span>{label}</span> : label}
    {children}
    {hint != null && <span className="ui-field-hint" id={hintId}>{hint}</span>}
    {error != null && <span className="ui-field-error" id={errorId} role="alert">{error}</span>}
  </label>
})

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}
export interface SelectControlProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'className'> {
  label: ReactNode
  options?: ReadonlyArray<SelectOption>
  /** Legacy callback receives the selected value; the native event is also available. */
  onChange?: (value: string, event: ChangeEvent<HTMLSelectElement>) => void
  onNativeChange?: (event: ChangeEvent<HTMLSelectElement>) => void
  /** Exact class on the wrapping label; no extra layout wrapper is introduced. */
  className?: string
  labelProps?: LabelHTMLAttributes<HTMLLabelElement>
  selectClassName?: string
  wrapClassName?: string
}

export const SelectControl = forwardRef<HTMLSelectElement, SelectControlProps>(function SelectControl(
  { label, options, onChange, onNativeChange, className = 'select-control', labelProps, selectClassName, wrapClassName = 'select-wrap', children, ...props }, ref,
) {
  return <label {...labelProps} className={className}>
    <span>{label}</span>
    <div className={wrapClassName}>
      <select {...props} ref={ref} className={selectClassName} onChange={event => {
        onChange?.(event.target.value, event)
        onNativeChange?.(event)
      }}>
        {options?.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
        {children}
      </select>
      <ChevronDown size={14} aria-hidden="true" />
    </div>
  </label>
})
