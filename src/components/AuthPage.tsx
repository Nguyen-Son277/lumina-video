import { useState } from 'react'
import {
  ArrowRight,
  Clock,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Mail,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { authApi } from '../api/endpoints'
import { errorMessage } from '../api/client'
import type { User } from '../api/types'
import { LanguageSwitcher, useTranslation } from '../i18n'
import { shellCatalog, type ShellCatalogKey } from '../i18n/catalogs/shell'

type Mode = 'login' | 'register'

/**
 * Lỗi hiển thị trên form: lỗi do ứng dụng tạo ra lưu bằng khoá dịch (dịch lại được
 * khi đổi ngôn ngữ); lỗi API/mạng lưu đối tượng lỗi gốc và chỉ gọi `errorMessage`
 * lúc render nên đổi ngôn ngữ là câu lỗi đổi ngay.
 */
type AuthError = { key: ShellCatalogKey } | { error: unknown }

/**
 * Trang đăng nhập và đăng ký.
 * Tài khoản tách biệt provider, model, tác vụ và media của từng người.
 *
 * Tài khoản mới chờ super admin duyệt: đăng ký KHÔNG tạo phiên, màn hình chuyển
 * sang thông báo chờ duyệt thay vì vào ứng dụng.
 */
export function AuthPage({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<AuthError | null>(null)
  const [busy, setBusy] = useState(false)
  /** Email vừa đăng ký xong và đang chờ duyệt; có giá trị thì hiện thông báo. */
  const [pendingEmail, setPendingEmail] = useState<string | null>(null)
  const { t } = useTranslation(shellCatalog)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return

    setError(null)
    if (mode === 'register' && email.trim().toLowerCase().split('@')[1] !== 'gigone.com') {
      setError({ key: 'authDomainError' })
      return
    }
    setBusy(true)
    try {
      if (mode === 'login') {
        const result = await authApi.login(email.trim(), password)
        onAuthenticated(result.user)
        return
      }
      const result = await authApi.register(email.trim(), password)
      if (result.approvalRequired) {
        // Không có phiên: chỉ báo cho người dùng biết tài khoản đang chờ duyệt.
        setPendingEmail(result.user.email)
        setPassword('')
        return
      }
      onAuthenticated(result.user)
    } catch (cause) {
      setError({ error: cause })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-locale" style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 18 }}>
          <LanguageSwitcher />
        </div>

        <div className="brand-lockup auth-brand">
          <div className="brand-mark"><Sparkles size={19} strokeWidth={2.4} /></div>
          <div>
            <div className="brand-name">lumina<span>.</span></div>
            <div className="brand-caption">{t('brandCaption')}</div>
          </div>
        </div>

        {pendingEmail !== null ? (
          <>
            <h1 className="auth-title">{t('authPendingTitle')}</h1>
            <p className="auth-subtitle">{t('authPendingBody')}</p>
            <div className="auth-hint">
              <Clock size={14} /> {pendingEmail}
            </div>
            <button
              className="generate-button"
              type="button"
              onClick={() => {
                setPendingEmail(null)
                setMode('login')
                setError(null)
              }}
            >
              <ArrowRight size={18} /> {t('authPendingBack')}
            </button>
          </>
        ) : (
          <>
            <h1 className="auth-title">
              {mode === 'login' ? t('authLoginTitle') : t('authRegisterTitle')}
            </h1>
            <p className="auth-subtitle">
              {t('authSubtitle')}
            </p>

            <form className="auth-form" onSubmit={submit}>
              <label>
                {t('emailLabel')}
                <div className="auth-input">
                  <Mail size={15} />
                  <input
                    type="email"
                    autoComplete="email"
                    required
                    placeholder={t('emailPlaceholder')}
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </div>
              </label>

              <label>
                {t('passwordLabel')}
                <div className="auth-input">
                  <LockKeyhole size={15} />
                  <input
                    type="password"
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    required
                    minLength={mode === 'register' ? 10 : 1}
                    placeholder={mode === 'register' ? t('passwordMinPlaceholder') : t('passwordPlaceholder')}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </div>
              </label>

              {mode === 'register' && (
                <div className="auth-hint">
                  <KeyRound size={14} /> {t('authRegisterHint')}
                </div>
              )}

              {mode === 'register' && (
                <div className="auth-hint">
                  <ShieldCheck size={14} /> {t('authApprovalHint')}
                </div>
              )}

              {error && (
                <div className="auth-error" role="alert">
                  {'key' in error ? t(error.key) : errorMessage(error.error)}
                </div>
              )}

              <button className="generate-button" type="submit" disabled={busy}>
                {busy ? <LoaderCircle size={18} className="spin" /> : <ArrowRight size={18} />}
                {busy ? t('authBusy') : mode === 'login' ? t('authLoginAction') : t('authRegisterAction')}
              </button>
            </form>

            <div className="auth-switch">
              {mode === 'login' ? t('authNoAccount') : t('authHaveAccount')}
              <button
                type="button"
                onClick={() => {
                  setMode(mode === 'login' ? 'register' : 'login')
                  setError(null)
                }}
              >
                {mode === 'login' ? t('authRegisterNow') : t('authLoginAction')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
