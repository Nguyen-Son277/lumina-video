import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BarChart3, LoaderCircle, RefreshCw } from 'lucide-react'
import { errorMessage } from '../api/client'
import { adminApi } from '../api/endpoints'
import type { AdminAccount } from '../api/types'
import {
  USAGE_KINDS,
  USAGE_OUTCOMES,
  adminUsageApi,
  type AdminUsageResponse,
  type UsageEvent,
  type UsageFilters,
  type UsageKind,
  type UsageOutcome,
} from '../api/usage'
import { formatDate, formatNumber, useTranslation } from '../i18n'
import { usageCatalog, type UsageCatalogKey } from '../i18n/catalogs/usage'
import '../styles/usage.css'

/** Số dòng mỗi lần tải; backend giới hạn 1..200. */
const PAGE_SIZE = 25

type KindFilter = 'all' | UsageKind
type OutcomeFilter = 'all' | UsageOutcome

const KIND_KEYS: Record<UsageKind, UsageCatalogKey> = {
  image: 'kindImage',
  video: 'kindVideo',
  llm: 'kindLlm',
}

const OUTCOME_KEYS: Record<UsageOutcome, UsageCatalogKey> = {
  ok: 'outcomeOk',
  failed: 'outcomeFailed',
  unknown: 'outcomeUnknown',
  pending: 'outcomePending',
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'AbortError'
}

function parseDateInput(value: string, endOfDay: boolean): number | undefined {
  if (!value) return undefined
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return undefined
  const date = new Date(year, month - 1, day)
  if (Number.isNaN(date.getTime())) return undefined
  if (endOfDay) date.setHours(23, 59, 59, 999)
  return date.getTime()
}

/**
 * Panel Nhật ký sử dụng toàn hệ thống cho vỏ quản trị.
 *
 * Tự chứa (không giả định sidebar/topbar): chỉ nhận `className` và tự gọi
 * `GET /api/admin/usage`. Lead gắn component này vào một tab của trang quản trị.
 */
export function AdminUsagePanel({ className = '' }: { className?: string }) {
  const { t, locale } = useTranslation(usageCatalog)

  const [userIdInput, setUserIdInput] = useState('')
  const [userIdSelect, setUserIdSelect] = useState('')
  const [fromInput, setFromInput] = useState('')
  const [toInput, setToInput] = useState('')
  const [kind, setKind] = useState<KindFilter>('all')
  const [outcome, setOutcome] = useState<OutcomeFilter>('all')
  const [refreshKey, setRefreshKey] = useState(0)

  const effectiveUserId = userIdInput.trim() || userIdSelect

  const filters = useMemo<UsageFilters & { userId?: string }>(() => {
    const from = parseDateInput(fromInput, false)
    const to = parseDateInput(toInput, true)
    return {
      ...(effectiveUserId ? { userId: effectiveUserId } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(kind !== 'all' ? { kind: [kind] } : {}),
      ...(outcome !== 'all' ? { outcome: [outcome] } : {}),
    }
  }, [effectiveUserId, fromInput, toInput, kind, outcome])
  const filterKey = JSON.stringify(filters)
  const filtersRef = useRef(filters)
  filtersRef.current = filters

  const [data, setData] = useState<AdminUsageResponse | null>(null)
  const [events, setEvents] = useState<UsageEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  const [users, setUsers] = useState<AdminAccount[]>([])
  const [usersError, setUsersError] = useState<unknown>(null)

  useEffect(() => {
    let cancelled = false
    adminApi
      .users({ status: 'all', limit: 200 })
      .then((result) => {
        if (!cancelled) setUsers(result.users)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setUsersError(cause)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setLoadError(null)
    adminUsageApi
      .list({ ...filtersRef.current, limit: PAGE_SIZE, offset: 0 }, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        setData(result)
        setEvents(result.events)
      })
      .catch((cause: unknown) => {
        if (!isAbortError(cause)) setLoadError(cause)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [filterKey, refreshKey])

  const loadMore = useCallback(async () => {
    if (loadingMore) return
    setLoadingMore(true)
    try {
      const result = await adminUsageApi.list({
        ...filtersRef.current,
        limit: PAGE_SIZE,
        offset: events.length,
      })
      setEvents((current) => [...current, ...result.events])
      setData((current) => (current ? { ...current, total: result.total } : current))
    } catch (cause) {
      setLoadError(cause)
    } finally {
      setLoadingMore(false)
    }
  }, [events.length, loadingMore])

  const summary = data?.summary ?? null
  const overall = summary?.overall ?? null
  const currency = summary?.currency || 'USD'

  const money = useCallback(
    (value: number | null): string =>
      value == null ? t('costUnknownLabel') : `${formatNumber(value, { maximumFractionDigits: 4 }, locale)} ${currency}`,
    [currency, locale, t],
  )

  return (
    <section className={`usage-admin ${className}`.trim()}>
      <div className="usage-admin-head">
        <div>
          <h2><BarChart3 size={17} /> {t('adminTitle')}</h2>
          <p className="usage-muted">{t('adminIntro')}</p>
        </div>
        <button className="secondary-button" onClick={() => setRefreshKey((current) => current + 1)}>
          <RefreshCw size={15} /> {t('refresh')}
        </button>
      </div>

      <div className="usage-panel usage-filters">
        <div className="usage-field-row">
          <label className="usage-field">
            <span>{t('adminUserFilter')}</span>
            <select
              value={userIdSelect}
              onChange={(event) => { setUserIdSelect(event.target.value); setUserIdInput('') }}
              aria-label={t('adminUserFilter')}
            >
              <option value="">{t('adminUserAll')}</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>{user.email}</option>
              ))}
            </select>
          </label>
          <label className="usage-field">
            <span>{t('adminUserPlaceholder')}</span>
            <input
              type="text"
              value={userIdInput}
              placeholder={t('adminUserPlaceholder')}
              onChange={(event) => setUserIdInput(event.target.value)}
              aria-label={t('adminUserPlaceholder')}
            />
          </label>
          <label className="usage-field">
            <span>{t('filterFrom')}</span>
            <input type="date" value={fromInput} onChange={(event) => setFromInput(event.target.value)} aria-label={t('filterFrom')} />
          </label>
          <label className="usage-field">
            <span>{t('filterTo')}</span>
            <input type="date" value={toInput} onChange={(event) => setToInput(event.target.value)} aria-label={t('filterTo')} />
          </label>
          <label className="usage-field">
            <span>{t('filterKind')}</span>
            <select value={kind} onChange={(event) => setKind(event.target.value as KindFilter)} aria-label={t('filterKind')}>
              <option value="all">{t('kindAll')}</option>
              {USAGE_KINDS.map((value) => <option key={value} value={value}>{t(KIND_KEYS[value])}</option>)}
            </select>
          </label>
          <label className="usage-field">
            <span>{t('filterOutcome')}</span>
            <select value={outcome} onChange={(event) => setOutcome(event.target.value as OutcomeFilter)} aria-label={t('filterOutcome')}>
              <option value="all">{t('outcomeAll')}</option>
              {USAGE_OUTCOMES.map((value) => <option key={value} value={value}>{t(OUTCOME_KEYS[value])}</option>)}
            </select>
          </label>
        </div>
        {usersError != null && <p className="usage-muted">{errorMessage(usersError)}</p>}
      </div>

      {loadError != null && (
        <div className="form-error">
          {errorMessage(loadError)}
          <button className="secondary-button usage-inline-button" onClick={() => setRefreshKey((current) => current + 1)}>{t('retry')}</button>
        </div>
      )}

      {summary && overall && (
        <div className="usage-cards">
          <article className="usage-card">
            <span className="usage-card-label">{t('cardTotal')}</span>
            <strong>{formatNumber(overall.count, {}, locale)}</strong>
            <small>{t('cardBreakdown', {
              image: formatNumber(summary.totals.image.count, {}, locale),
              video: formatNumber(summary.totals.video.count, {}, locale),
              llm: formatNumber(summary.totals.llm.count, {}, locale),
            })}</small>
          </article>
          <article className="usage-card">
            <span className="usage-card-label">{t('cardCost')}</span>
            <strong>{formatNumber(overall.cost, { maximumFractionDigits: 4 }, locale)}</strong>
            {overall.costUnknownCount > 0
              ? <small className="usage-warn">{t('costUnknownNote', { count: formatNumber(overall.costUnknownCount, {}, locale) })}</small>
              : <small>{currency}</small>}
          </article>
          <article className="usage-card">
            <span className="usage-card-label">{t('cardTokens')}</span>
            <strong>{formatNumber(overall.promptTokens + overall.completionTokens, {}, locale)}</strong>
            <small>{t('tokenPair', {
              input: formatNumber(overall.promptTokens, {}, locale),
              output: formatNumber(overall.completionTokens, {}, locale),
            })}</small>
          </article>
          <article className="usage-card">
            <span className="usage-card-label">{t('cardFailed')}</span>
            <strong>{formatNumber(overall.failed + overall.unknown, {}, locale)}</strong>
            <small>{t('failedPair', {
              failed: formatNumber(overall.failed, {}, locale),
              unknown: formatNumber(overall.unknown, {}, locale),
            })}</small>
          </article>
          <article className="usage-card">
            <span className="usage-card-label">{t('savingsFailed')}</span>
            <strong>{formatNumber(summary.waste.failedCount, {}, locale)}</strong>
            <small>{money(summary.waste.failedCost)}</small>
          </article>
        </div>
      )}

      <div className="usage-panel">
        <div className="usage-panel-head">
          <h2><BarChart3 size={16} /> {t('adminTitle')}</h2>
          {data && <span className="usage-muted">{t('adminTotal', { count: formatNumber(data.total, {}, locale) })}</span>}
        </div>
        {loading ? (
          <div className="empty-state"><LoaderCircle size={26} className="spin" /><h3>{t('loading')}</h3></div>
        ) : events.length === 0 ? (
          <div className="empty-state">
            <h3>{t('adminEmpty')}</h3>
            <p>{t('adminEmptyHint')}</p>
          </div>
        ) : (
          <>
            <div className="usage-table-wrap">
              <table className="usage-table">
                <thead>
                  <tr>
                    <th scope="col">{t('tableTime')}</th>
                    <th scope="col">{t('adminUserColumn')}</th>
                    <th scope="col">{t('tableKind')}</th>
                    <th scope="col">{t('tableModel')}</th>
                    <th scope="col">{t('tableStatus')}</th>
                    <th scope="col">{t('tableCost')}</th>
                    <th scope="col">{t('tableContent')}</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => (
                    <tr key={event.id}>
                      <td className="usage-nowrap">{formatDate(event.createdAt, { dateStyle: 'short', timeStyle: 'short' }, locale)}</td>
                      <td className="usage-user">{event.userEmail || event.userId}</td>
                      <td>
                        <span className={`usage-kind usage-kind--${event.kind}`}>{t(KIND_KEYS[event.kind])}</span>
                        {event.kind === 'llm' && <code className="usage-source">{event.source}</code>}
                      </td>
                      <td>
                        <span className="usage-model">{event.modelName || event.modelPk || '—'}</span>
                        {event.providerName && <small className="usage-muted">{event.providerName}</small>}
                      </td>
                      <td>
                        <span className={`usage-outcome usage-outcome--${event.outcome}`} title={event.status}>
                          {t(OUTCOME_KEYS[event.outcome])}
                        </span>
                      </td>
                      <td className="usage-nowrap">{money(event.cost)}</td>
                      <td className="usage-content">
                        {event.preview && <p>{event.preview}</p>}
                        {event.responsePreview && <p>{event.responsePreview}</p>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data != null && events.length < data.total && (
              <button className="secondary-button usage-load-more" onClick={() => { void loadMore() }} disabled={loadingMore}>
                {loadingMore ? <LoaderCircle size={15} className="spin" /> : null} {t('loadMore')}
              </button>
            )}
          </>
        )}
      </div>
    </section>
  )
}

export default AdminUsagePanel
