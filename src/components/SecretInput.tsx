import { useId, useState, type InputHTMLAttributes, type ReactNode } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { useTranslation } from '../i18n'
import { shellCatalog } from '../i18n/catalogs/shell'

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  label: string
  secretKind?: 'password' | 'apiKey'
  icon?: ReactNode
  wrapperClassName?: string
}

/** Visibility is local UI state only: never fetches a previously saved secret. */
export function SecretInput({ label, secretKind = 'password', icon, wrapperClassName = 'key-input', id, ...inputProps }: Props) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const [visible, setVisible] = useState(false)
  const { t } = useTranslation(shellCatalog)
  const ariaLabel = secretKind === 'apiKey'
    ? t(visible ? 'hideApiKey' : 'showApiKey')
    : t(visible ? 'hidePassword' : 'showPassword')
  return <div className="secret-field">
    <label htmlFor={inputId}>{label}</label>
    <div className={`${wrapperClassName} secret-input`}>
      {icon}
      <input {...inputProps} id={inputId} type={visible ? 'text' : 'password'} />
      <button type="button" className="secret-toggle" aria-label={ariaLabel} title={ariaLabel} aria-controls={inputId} aria-pressed={visible} disabled={inputProps.disabled} onClick={() => setVisible(current => !current)}>
        {visible ? <EyeOff size={20} aria-hidden="true" /> : <Eye size={20} aria-hidden="true" />}
      </button>
    </div>
  </div>
}
