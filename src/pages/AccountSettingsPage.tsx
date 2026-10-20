import { useId, useRef, useState, type FormEvent } from 'react'
import { KeyRound, LoaderCircle, ShieldCheck } from 'lucide-react'
import { errorMessage } from '../api/client'
import { authApi } from '../api/endpoints'
import type { User } from '../api/types'
import { SecretInput } from '../components/SecretInput'
import { useTranslation } from '../i18n'
import { accountSettingsCatalog, type AccountSettingsCatalogKey } from '../i18n/catalogs/accountSettings'
import '../styles/account-settings.css'

type PasswordField = 'currentPassword' | 'newPassword' | 'confirmPassword'
type FieldErrors = Partial<Record<PasswordField, AccountSettingsCatalogKey>>
type Result = { kind: 'success' } | { kind: 'error'; cause: unknown } | null

export function AccountSettingsPage({ user }: { user: User }) {
  const { t } = useTranslation(accountSettingsCatalog)
  const id = useId()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [result, setResult] = useState<Result>(null)
  const [busy, setBusy] = useState(false)
  // React state updates are asynchronous; guard even same-tick repeat submissions.
  const submitting = useRef(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current) return
    const nextErrors: FieldErrors = {}
    if (!currentPassword) nextErrors.currentPassword = 'currentRequired'
    else if (currentPassword.length > 200) nextErrors.currentPassword = 'currentTooLong'
    if (newPassword.length < 10 || newPassword.length > 200) nextErrors.newPassword = 'newPasswordLength'
    if (confirmPassword !== newPassword || !confirmPassword) nextErrors.confirmPassword = 'passwordMismatch'
    setErrors(nextErrors)
    setResult(null)
    const firstInvalid = Object.keys(nextErrors)[0]
    if (firstInvalid) {
      const input = event.currentTarget.elements.namedItem(firstInvalid)
      if (input instanceof HTMLInputElement) input.focus()
      return
    }

    submitting.current = true
    setBusy(true)
    try {
      // Do not trim secrets or replace the current logged-in session.
      await authApi.changePassword(currentPassword, newPassword)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setErrors({})
      setResult({ kind: 'success' })
    } catch (cause: unknown) {
      setResult({ kind: 'error', cause })
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  return (
    <section className="account-settings-page" aria-labelledby={`${id}-title`}>
      <header className="account-settings-heading">
        <span className="account-settings-icon"><ShieldCheck size={24} aria-hidden="true" /></span>
        <div>
          <h1 id={`${id}-title`}>{t('title')}</h1>
          <p>{t('description')}</p>
        </div>
      </header>

      <div className="account-settings-card account-settings-email">
        <label htmlFor={`${id}-email`}>{t('email')}</label>
        <input id={`${id}-email`} type="email" name="email" autoComplete="username" value={user.email} readOnly aria-describedby={`${id}-email-hint`} />
        <p id={`${id}-email-hint`} className="account-settings-hint">{t('emailHint')}</p>
      </div>

      <form className="account-settings-card account-settings-form" onSubmit={handleSubmit} noValidate aria-labelledby={`${id}-password-title`} aria-busy={busy}>
        <div className="account-settings-card-heading">
          <h2 id={`${id}-password-title`}>{t('passwordTitle')}</h2>
          <p>{t('passwordDescription')}</p>
        </div>

        <div className="account-settings-field">
          <SecretInput id={`${id}-current`} name="currentPassword" label={t('currentPassword')} autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} maxLength={200} required disabled={busy} aria-invalid={Boolean(errors.currentPassword)} aria-describedby={errors.currentPassword ? `${id}-current-error` : undefined} />
          {errors.currentPassword && <p id={`${id}-current-error`} className="account-settings-field-error" role="alert">{t(errors.currentPassword)}</p>}
        </div>

        <div className="account-settings-field">
          <SecretInput id={`${id}-new`} name="newPassword" label={t('newPassword')} autoComplete="new-password" value={newPassword} onChange={event => setNewPassword(event.target.value)} minLength={10} maxLength={200} required disabled={busy} aria-invalid={Boolean(errors.newPassword)} aria-describedby={`${id}-password-hint${errors.newPassword ? ` ${id}-new-error` : ''}`} />
          <p id={`${id}-password-hint`} className="account-settings-hint">{t('passwordHint')}</p>
          {errors.newPassword && <p id={`${id}-new-error`} className="account-settings-field-error" role="alert">{t(errors.newPassword)}</p>}
        </div>

        <div className="account-settings-field">
          <SecretInput id={`${id}-confirm`} name="confirmPassword" label={t('confirmPassword')} autoComplete="new-password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} maxLength={200} required disabled={busy} aria-invalid={Boolean(errors.confirmPassword)} aria-describedby={errors.confirmPassword ? `${id}-confirm-error` : undefined} />
          {errors.confirmPassword && <p id={`${id}-confirm-error`} className="account-settings-field-error" role="alert">{t(errors.confirmPassword)}</p>}
        </div>

        {result?.kind === 'error' && <div className="account-settings-notice account-settings-notice--error" role="alert">{errorMessage(result.cause)}</div>}
        {result?.kind === 'success' && <div className="account-settings-notice account-settings-notice--success" role="status">{t('success')}</div>}

        <p className="account-settings-hint account-settings-session-hint">{t('sessionHint')}</p>
        <button className="account-settings-submit" type="submit" disabled={busy}>
          {busy ? <LoaderCircle size={17} className="account-settings-spinner" aria-hidden="true" /> : <KeyRound size={17} aria-hidden="true" />}
          <span aria-live="polite">{t(busy ? 'saving' : 'submit')}</span>
        </button>
      </form>
    </section>
  )
}
