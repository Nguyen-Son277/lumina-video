/**
 * Trang duyệt tài khoản — chỉ dành cho super admin.
 *
 * Trang này cố ý tách khỏi vỏ Studio: quản trị viên chỉ duyệt hoặc từ chối tài
 * khoản, không có tính năng tạo ảnh/video. Vỏ riêng cũng đồng nghĩa không có mục
 * điều hướng nào dẫn tới các trang tạo nội dung.
 *
 * Quy ước i18n: mọi câu hiển thị lấy từ catalog; thông báo sau thao tác lưu dưới
 * dạng khoá + tham số (không lưu chuỗi đã dịch) để đổi ngôn ngữ là đổi ngay.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  Ban,
  Check,
  Clock,
  LoaderCircle,
  LogOut,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { errorMessage } from '../api/client'
import { AdminUsagePanel } from '../components/AdminUsagePanel'
import { adminApi } from '../api/endpoints'
import type { AccountStatus, AdminAccount, AdminAccountCounts, User } from '../api/types'
import { LanguageSwitcher, useTranslation } from '../i18n'
import { adminCatalog, type AdminCatalogKey } from '../i18n/catalogs/admin'
import { shellCatalog } from '../i18n/catalogs/shell'
import { formatDate } from '../i18n/translate'
import type { MessageParams } from '../i18n/types'

/** Bộ lọc trạng thái trên thanh tab; `all` bỏ điều kiện lọc. */
const FILTERS: Array<AccountStatus | 'all'> = ['pending', 'approved', 'rejected', 'all']

/** Nhịp làm mới nền để hàng chờ duyệt tự cập nhật khi có đăng ký mới. */
const POLL_MS = 15_000

const FILTER_KEYS: Record<AccountStatus | 'all', AdminCatalogKey> = {
  pending: 'adminFilterPending',
  approved: 'adminFilterApproved',
  rejected: 'adminFilterRejected',
  all: 'adminFilterAll',
}

const STATUS_KEYS: Record<AccountStatus, AdminCatalogKey> = {
  pending: 'adminStatusPending',
  approved: 'adminStatusApproved',
  rejected: 'adminStatusRejected',
}

/** Thông báo sau thao tác: giữ khoá + tham số để dịch lại theo ngôn ngữ hiện tại. */
type Notice = { key: AdminCatalogKey; params: MessageParams }

export function AdminUsersPage({ user, onLogout }: { user: User; onLogout: () => void }) {
  const { t, locale } = useTranslation(adminCatalog)
  const { t: tShell } = useTranslation(shellCatalog)

  const [filter, setFilter] = useState<AccountStatus | 'all'>('pending')
  const [query, setQuery] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [users, setUsers] = useState<AdminAccount[]>([])
  const [counts, setCounts] = useState<AdminAccountCounts>({
    pending: 0,
    approved: 0,
    rejected: 0,
    total: 0,
  })
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  /** Khu vực đang mở: duyệt tài khoản hay nhật ký sử dụng toàn hệ thống. */
  const [tab, setTab] = useState<'accounts' | 'usage'>('accounts')

  // Gõ tới đâu tìm tới đó nhưng chờ 300ms để không gọi API mỗi ký tự.
  useEffect(() => {
    const timer = window.setTimeout(() => setSearchTerm(query.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [query])

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true)
      try {
        const result = await adminApi.users({ status: filter, q: searchTerm, limit: 100 })
        setUsers(result.users)
        setCounts(result.counts)
        setError(null)
      } catch (cause) {
        setError(cause)
      } finally {
        if (!silent) setLoading(false)
      }
    },
    [filter, searchTerm],
  )

  useEffect(() => {
    void load()
  }, [load])

  // Làm mới nền: hàng chờ có thể xuất hiện tài khoản mới mà admin không thao tác gì.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!busyId) void load(true)
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [load, busyId])

  async function decide(account: AdminAccount, action: 'approve' | 'reject' | 'revoke'): Promise<void> {
    setBusyId(account.id)
    setError(null)
    try {
      const result =
        action === 'approve'
          ? await adminApi.approve(account.id)
          : action === 'reject'
            ? await adminApi.reject(account.id)
            : await adminApi.revoke(account.id)
      setCounts(result.counts)
      setNotice({
        key:
          action === 'approve'
            ? 'adminApproveNotice'
            : action === 'reject'
              ? 'adminRejectNotice'
              : 'adminRevokeNotice',
        params: { email: result.user.email },
      })
      await load(true)
    } catch (cause) {
      setError(cause)
    } finally {
      setBusyId('')
    }
  }

  /** Nút thao tác khả dụng theo trạng thái hiện tại; tài khoản admin không sửa được. */
  function actionsFor(account: AdminAccount) {
    if (account.role === 'admin') return null
    const buttons: Array<{ action: 'approve' | 'reject' | 'revoke'; label: string; icon: ReactNode; className: string }> = []
    if (account.status !== 'approved') {
      buttons.push({ action: 'approve', label: t('adminApprove'), icon: <Check size={14} />, className: 'admin-action approve' })
    }
    if (account.status !== 'rejected') {
      buttons.push({ action: 'reject', label: t('adminReject'), icon: <Ban size={14} />, className: 'admin-action reject' })
    }
    if (account.status === 'approved') {
      buttons.push({ action: 'revoke', label: t('adminRevoke'), icon: <RotateCcw size={14} />, className: 'admin-action revoke' })
    }
    return buttons
  }

  return (
    <div className="admin-shell">
      <header className="admin-topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><Sparkles size={19} strokeWidth={2.4} /></div>
          <div>
            <div className="brand-name">lumina<span>.</span></div>
            <div className="brand-caption">{tShell('brandCaption')}</div>
          </div>
        </div>
        <div className="admin-topbar-actions">
          <LanguageSwitcher />
          <span className="admin-signed-in">{t('adminSignedInAs', { email: user.email })}</span>
          <button type="button" className="admin-logout" onClick={onLogout}>
            <LogOut size={15} /> {tShell('logout')}
          </button>
        </div>
      </header>

      <main className="admin-main">
        <div className="admin-heading">
          <div>
            <h1>{t('adminTitle')}</h1>
            <p>{t('adminSubtitle')}</p>
          </div>
          <button type="button" className="admin-refresh" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} /> {t('adminRefresh')}
          </button>
        </div>

        <div className="admin-tabs" role="tablist" aria-label={t('adminTabsAria')}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'accounts'}
            className={`admin-filter ${tab === 'accounts' ? 'active' : ''}`}
            onClick={() => setTab('accounts')}
          >
            {t('adminTabAccounts')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'usage'}
            className={`admin-filter ${tab === 'usage' ? 'active' : ''}`}
            onClick={() => setTab('usage')}
          >
            {t('adminTabUsage')}
          </button>
        </div>

        {tab === 'usage' ? (
          <AdminUsagePanel />
        ) : (
          <>
        <div className="admin-counts">
          <div className="admin-count waiting"><Clock size={15} /> {t('adminCountPending', { count: counts.pending })}</div>
          <div className="admin-count approved"><Check size={15} /> {t('adminCountApproved', { count: counts.approved })}</div>
          <div className="admin-count rejected"><Ban size={15} /> {t('adminCountRejected', { count: counts.rejected })}</div>
          <div className="admin-count total"><ShieldCheck size={15} /> {t('adminCountTotal', { count: counts.total })}</div>
        </div>

        <div className="admin-controls">
          <div className="admin-filters">
            {FILTERS.map((value) => (
              <button
                key={value}
                type="button"
                className={`admin-filter ${filter === value ? 'active' : ''}`}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {t(FILTER_KEYS[value])}
              </button>
            ))}
          </div>
          <label className="admin-search">
            <Search size={15} />
            <input
              type="search"
              value={query}
              aria-label={t('adminSearchLabel')}
              placeholder={t('adminSearchPlaceholder')}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>

        {error !== null && <div className="auth-error" role="alert">{errorMessage(error)}</div>}
        {notice && <div className="admin-notice" role="status">{t(notice.key, notice.params)}</div>}

        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>{t('adminColumnEmail')}</th>
                <th>{t('adminColumnStatus')}</th>
                <th>{t('adminColumnRole')}</th>
                <th>{t('adminColumnCreated')}</th>
                <th>{t('adminColumnActions')}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((account) => {
                const actions = actionsFor(account)
                return (
                  <tr key={account.id} className="admin-row" data-email={account.email}>
                    <td className="admin-email" title={account.email}>{account.email}</td>
                    <td>
                      <span className={`admin-status ${account.status}`}>{t(STATUS_KEYS[account.status])}</span>
                    </td>
                    <td>{account.role === 'admin' ? t('adminRoleAdmin') : t('adminRoleUser')}</td>
                    <td className="admin-created">{formatDate(account.createdAt, {}, locale)}</td>
                    <td>
                      <div className="admin-actions">
                        {busyId === account.id ? (
                          <LoaderCircle size={16} className="spin" />
                        ) : actions === null ? (
                          <span className="admin-protected" title={t('adminRoleAdmin')}>
                            <ShieldCheck size={15} />
                          </span>
                        ) : (
                          actions.map((button) => (
                            <button
                              key={button.action}
                              type="button"
                              className={button.className}
                              onClick={() => void decide(account, button.action)}
                            >
                              {button.icon} {button.label}
                            </button>
                          ))
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {loading && (
            <div className="admin-hint">
              <LoaderCircle size={16} className="spin" /> {t('adminLoading')}
            </div>
          )}
          {!loading && users.length === 0 && <div className="admin-hint">{t('adminEmpty')}</div>}
        </div>
          </>
        )}
      </main>
    </div>
  )
}
