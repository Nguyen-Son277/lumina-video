/**
 * Trang duyệt tài khoản — chỉ dành cho super admin.
 *
 * Nội dung duyệt tài khoản được nhúng trong vỏ quản trị với sidebar dùng chung.
 * Sidebar theo vai trò chỉ cho phép duyệt tài khoản, nhật ký và cài đặt;
 * không có tính năng tạo ảnh/video.
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
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
} from 'lucide-react'
import { errorMessage } from '../api/client'
import { Button, EmptyState, InlineNotice, LoadingState } from '../components/ui'
import { adminApi } from '../api/endpoints'
import type { AccountStatus, AdminAccount, AdminAccountCounts } from '../api/types'
import { useTranslation } from '../i18n'
import { adminCatalog, type AdminCatalogKey } from '../i18n/catalogs/admin'
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

export function AdminUsersPage() {
  const { t, locale } = useTranslation(adminCatalog)

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
      <div className="admin-main">
        <div className="admin-heading">
          <div>
            <h1>{t('adminTitle')}</h1>
            <p>{t('adminSubtitle')}</p>
          </div>
          <Button type="button" className="admin-refresh" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} /> {t('adminRefresh')}
          </Button>
        </div>

        <div className="admin-counts">
          <div className="admin-count waiting"><Clock size={15} /> {t('adminCountPending', { count: counts.pending })}</div>
          <div className="admin-count approved"><Check size={15} /> {t('adminCountApproved', { count: counts.approved })}</div>
          <div className="admin-count rejected"><Ban size={15} /> {t('adminCountRejected', { count: counts.rejected })}</div>
          <div className="admin-count total"><ShieldCheck size={15} /> {t('adminCountTotal', { count: counts.total })}</div>
        </div>

        <div className="admin-controls">
          <div className="admin-filters">
            {FILTERS.map((value) => (
              <Button
                key={value}
                type="button"
                className={`admin-filter ${filter === value ? 'active' : ''}`}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {t(FILTER_KEYS[value])}
              </Button>
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

        {error !== null && <InlineNotice className="auth-error" role="alert">{errorMessage(error)}</InlineNotice>}
        {notice && <InlineNotice className="admin-notice" role="status">{t(notice.key, notice.params)}</InlineNotice>}

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
                    <td className="admin-email" title={account.email}>
                      <div>{account.name}</div>
                      <div>{account.email}</div>
                    </td>
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
                            <Button
                              key={button.action}
                              type="button"
                              className={button.className}
                              onClick={() => void decide(account, button.action)}
                            >
                              {button.icon} {button.label}
                            </Button>
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
            <LoadingState className="admin-hint" announce={false}>
              <LoaderCircle size={16} className="spin" /> {t('adminLoading')}
            </LoadingState>
          )}
          {!loading && users.length === 0 && <EmptyState className="admin-hint">{t('adminEmpty')}</EmptyState>}
        </div>
      </div>
  )
}
