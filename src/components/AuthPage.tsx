import { useState } from 'react'
import { ArrowRight, KeyRound, LoaderCircle, LockKeyhole, Mail, Sparkles } from 'lucide-react'
import { authApi } from '../api/endpoints'
import { errorMessage } from '../api/client'
import type { User } from '../api/types'

type Mode = 'login' | 'register'

/**
 * Trang đăng nhập và đăng ký.
 * Tài khoản tách biệt provider, model, tác vụ và media của từng người.
 */
export function AuthPage({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return

    setError('')
    if (mode === 'register' && email.trim().toLowerCase().split('@')[1] !== 'gigone.com') {
      setError('Chỉ email thuộc tên miền @gigone.com mới được đăng ký.')
      return
    }
    setBusy(true)
    try {
      const result =
        mode === 'login'
          ? await authApi.login(email.trim(), password)
          : await authApi.register(email.trim(), password)
      onAuthenticated(result.user)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="brand-lockup auth-brand">
          <div className="brand-mark"><Sparkles size={19} strokeWidth={2.4} /></div>
          <div>
            <div className="brand-name">lumina<span>.</span></div>
            <div className="brand-caption">CREATIVE WORKSPACE</div>
          </div>
        </div>

        <h1 className="auth-title">
          {mode === 'login' ? 'Đăng nhập để tiếp tục' : 'Tạo tài khoản mới'}
        </h1>
        <p className="auth-subtitle">
          Mỗi tài khoản có provider, model và thư viện riêng. API key của bạn được mã hóa và không
          hiển thị lại.
        </p>

        <form className="auth-form" onSubmit={submit}>
          <label>
            Email
            <div className="auth-input">
              <Mail size={15} />
              <input
                type="email"
                autoComplete="email"
                required
                placeholder="ban@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
          </label>

          <label>
            Mật khẩu
            <div className="auth-input">
              <LockKeyhole size={15} />
              <input
                type="password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                required
                minLength={mode === 'register' ? 10 : 1}
                placeholder={mode === 'register' ? 'Ít nhất 10 ký tự' : 'Nhập mật khẩu'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          </label>

          {mode === 'register' && (
            <div className="auth-hint">
              <KeyRound size={14} /> Chỉ đăng ký bằng email @gigone.com. Mật khẩu cần ít nhất 10 ký tự.
            </div>
          )}

          {error && <div className="auth-error">{error}</div>}

          <button className="generate-button" type="submit" disabled={busy}>
            {busy ? <LoaderCircle size={18} className="spin" /> : <ArrowRight size={18} />}
            {busy ? 'Đang xử lý...' : mode === 'login' ? 'Đăng nhập' : 'Tạo tài khoản'}
          </button>
        </form>

        <div className="auth-switch">
          {mode === 'login' ? 'Chưa có tài khoản?' : 'Đã có tài khoản?'}
          <button
            type="button"
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login')
              setError('')
            }}
          >
            {mode === 'login' ? 'Đăng ký ngay' : 'Đăng nhập'}
          </button>
        </div>
      </div>
    </div>
  )
}
