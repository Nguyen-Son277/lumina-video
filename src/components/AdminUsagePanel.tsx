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
import { usageAdminDashboardCatalog } from '../i18n/catalogs/usageAdminDashboard'
import { UsageCharts } from './UsageCharts'
import { usageDateInputValue, usageRangeBounds, type UsageRange } from '../../shared/usageRanges'
import { UsageRangeControls } from './UsageRangeControls'
import { UsageExportButton } from './UsageExportButton'
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

/**
 * Panel Nhật ký sử dụng toàn hệ thống cho vỏ quản trị.
 *
 * Tự chứa (không giả định sidebar/topbar): chỉ nhận `className` và tự gọi
 * `GET /api/admin/usage`. Lead gắn component này vào một tab của trang quản trị.
 */
export function AdminUsagePanel({ className = '' }: { className?: string }) {
  const { t, locale } = useTranslation(usageCatalog)
  const { t: td } = useTranslation(usageAdminDashboardCatalog)

  const [userIdInput, setUserIdInput] = useState('')
  const [userIdSelect, setUserIdSelect] = useState('')
  const [range, setRange] = useState<UsageRange>('all')
  const [fromInput, setFromInput] = useState(() => usageDateInputValue(Date.now() - 7 * 24 * 60 * 60 * 1000))
  const [toInput, setToInput] = useState(() => usageDateInputValue(Date.now()))
  const [now, setNow] = useState(() => Date.now())
  const [kind, setKind] = useState<KindFilter>('all')
  const [outcome, setOutcome] = useState<OutcomeFilter>('all')
  const [refreshKey, setRefreshKey] = useState(0)

  const effectiveUserId = userIdInput.trim() || userIdSelect
  const rangeError = useMemo(() => {
    if (range !== 'custom') return false
    try {
      usageRangeBounds(range, fromInput, toInput, now)
      return false
    } catch {
      return true
    }
  }, [range, fromInput, toInput, now])

  const filters = useMemo<UsageFilters & { userId?: string }>(() => {
    const bounds = rangeError ? {} : usageRangeBounds(range, fromInput, toInput, now)
    return {
      ...bounds,
      ...(effectiveUserId ? { userId: effectiveUserId } : {}),
      ...(kind !== 'all' ? { kind: [kind] } : {}),
      ...(outcome !== 'all' ? { outcome: [outcome] } : {}),
    }
  }, [range, fromInput, toInput, now, rangeError, effectiveUserId, kind, outcome])
  const getExportFilters = useCallback((): UsageFilters & { userId?: string } => ({
    ...usageRangeBounds(range, fromInput, toInput, Date.now()),
    ...(effectiveUserId ? { userId: effectiveUserId } : {}),
    ...(kind !== 'all' ? { kind: [kind] } : {}),
    ...(outcome !== 'all' ? { outcome: [outcome] } : {}),
  }), [range, fromInput, toInput, effectiveUserId, kind, outcome])
  const filterKey = JSON.stringify(filters)
  const filtersRef = useRef(filters)
  filtersRef.current = filters

  const requestKey = `${filterKey}:${refreshKey}:${rangeError}`
  const requestKeyRef = useRef(requestKey)
  requestKeyRef.current = requestKey
  const moreControllerRef = useRef<AbortController | null>(null)
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
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
      .users({ status: 'all', limit: 100, offset: 0 })
      .then(async (result) => {
        const allUsers = [...result.users]
        while (!cancelled && allUsers.length < result.counts.total) {
          const page = await adminApi.users({ status: 'all', limit: 100, offset: allUsers.length })
          if (page.users.length === 0) break
          allUsers.push(...page.users)
        }
        if (!cancelled) setUsers(allUsers)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setUsersError(cause)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    moreControllerRef.current?.abort()
    moreControllerRef.current = null
    setLoadingMore(false)
    setData(null)
    setEvents([])
    if (rangeError) {
      setLoading(false)
      setLoadError(null)
      setData(null)
      setEvents([])
      return
    }
    const controller = new AbortController()
    setLoading(true)
    setLoadError(null)
    adminUsageApi
      .list({ ...filtersRef.current, limit: PAGE_SIZE, offset: 0 }, controller.signal)
      .then((result) => {
        if (controller.signal.aborted || requestKeyRef.current !== requestKey) return
        setLoadedKey(requestKey)
        setData(result)
        setEvents(result.events)
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted && requestKeyRef.current === requestKey && !isAbortError(cause)) setLoadError(cause)
      })
      .finally(() => {
        if (!controller.signal.aborted && requestKeyRef.current === requestKey) {
          setLoadedKey(requestKey)
          setLoading(false)
        }
      })
    return () => {
      controller.abort()
      moreControllerRef.current?.abort()
    }
  }, [requestKey, rangeError])

  const loadMore = useCallback(async () => {
    if (moreControllerRef.current || loading || rangeError || loadedKey !== requestKey) return
    const controller = new AbortController()
    moreControllerRef.current = controller
    setLoadingMore(true)
    setLoadError(null)
    try {
      const result = await adminUsageApi.list({
        ...filtersRef.current,
        limit: PAGE_SIZE,
        offset: events.length,
      }, controller.signal)
      if (controller.signal.aborted || requestKeyRef.current !== requestKey) return
      setEvents((current) => [...current, ...result.events])
      setData((current) => (current ? { ...current, total: result.total } : current))
    } catch (cause) {
      if (!controller.signal.aborted && requestKeyRef.current === requestKey && !isAbortError(cause)) setLoadError(cause)
    } finally {
      if (moreControllerRef.current === controller) {
        moreControllerRef.current = null
        setLoadingMore(false)
      }
    }
  }, [events.length, loadedKey, loading, rangeError, requestKey])

  const currentData = loadedKey === requestKey && !rangeError ? data : null
  const summary = currentData?.summary ?? null
  const overall = summary?.overall ?? null
  const refreshing = !rangeError && (loading || loadedKey !== requestKey)
  const usersById = useMemo(() => new Map(users.map((user) => [user.id, user])), [users])
  const resetFilters = () => {
    setUserIdInput('')
    setUserIdSelect('')
    setRange('all')
    setKind('all')
    setOutcome('all')
    const time = Date.now()
    setNow(time)
    setFromInput(usageDateInputValue(time - 7 * 24 * 60 * 60 * 1000))
    setToInput(usageDateInputValue(time))
  }

  return (
    <section className={`usage-admin ${className}`.trim()}>
      <div className="usage-admin-head">
        <div>
          <h2><BarChart3 size={17} /> {t('adminTitle')}</h2>
          <p className="usage-muted">{td('intro')}</p>
        </div>
        <div className="usage-admin-actions">
          <UsageExportButton filters={filters} admin getFilters={getExportFilters} disabled={rangeError} />
          <button className="secondary-button" onClick={() => { setNow(Date.now()); setRefreshKey((current) => current + 1) }}>
            <RefreshCw size={15} /> {t('refresh')}
          </button>
        </div>
      </div>

      <div className="usage-panel usage-filters">
        <div className="usage-field-row usage-filter-primary">
          <label className="usage-field">
            <span>{t('adminUserFilter')}</span>
            <select
              value={userIdSelect}
              onChange={(event) => { setUserIdSelect(event.target.value); setUserIdInput('') }}
              aria-label={t('adminUserFilter')}
            >
              <option value="">{t('adminUserAll')}</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>{user.name} — {user.email}</option>
              ))}
            </select>
          </label>
          <UsageRangeControls
            range={range}
            from={fromInput}
            to={toInput}
            onRangeChange={setRange}
            onFromChange={setFromInput}
            onToChange={setToInput}
          />
          <label className="usage-field">
            <span>{t('filterKind')}</span>
            <select value={kind} onChange={(event) => setKind(event.target.value as KindFilter)} aria-label={t('filterKind')}>
              <option value="all">{t('kindAll')}</option>
              {USAGE_KINDS.map((value) => <option key={value} value={value}>{t(KIND_KEYS[value])}</option>)}
            </select>
          </label>
          <button className="secondary-button usage-filter-reset" onClick={resetFilters}>{td('reset')}</button>
        </div>
        <details className="usage-filter-advanced">
          <summary>{td('advanced')}</summary>
          <div className="usage-field-row usage-filter-advanced-fields">
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
            <span>{t('filterOutcome')}</span>
            <select value={outcome} onChange={(event) => setOutcome(event.target.value as OutcomeFilter)} aria-label={t('filterOutcome')}>
              <option value="all">{t('outcomeAll')}</option>
              {USAGE_OUTCOMES.map((value) => <option key={value} value={value}>{t(OUTCOME_KEYS[value])}</option>)}
            </select>
          </label>
          </div>
        </details>
        {usersError != null && <p className="usage-muted">{errorMessage(usersError)}</p>}
        {rangeError && <p className="form-error" role="alert">{t('rangeInvalid')}</p>}
      </div>

      {loadError != null && (
        <div className="form-error">
          {errorMessage(loadError)}
          <button className="secondary-button usage-inline-button" onClick={() => { setNow(Date.now()); setRefreshKey((current) => current + 1) }}>{t('retry')}</button>
        </div>
      )}

      {summary && overall && (
        <div className="usage-cards usage-dashboard-cards">
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
            <span className="usage-card-label">{td('completed')}</span>
            <strong>{formatNumber(overall.ok, {}, locale)}</strong>
            <small>{td('pendingNote', { count: formatNumber(overall.pending, {}, locale) })}</small>
          </article>
          <article className="usage-card">
            <span className="usage-card-label">{t('cardFailed')}</span>
            <strong>{formatNumber(overall.failed + overall.unknown, {}, locale)}</strong>
            <small>{t('failedPair', {
              failed: formatNumber(overall.failed, {}, locale),
              unknown: formatNumber(overall.unknown, {}, locale),
            })}</small>
          </article>
        </div>
      )}

      {summary && <UsageCharts summary={summary} from={filters.from} to={filters.to} loading={refreshing} />}

      <div className="usage-panel">
        <div className="usage-panel-head">
          <h2><BarChart3 size={16} /> {t('adminTitle')}</h2>
          {currentData && <span className="usage-muted">{t('adminTotal', { count: formatNumber(currentData.total, {}, locale) })}</span>}
        </div>
        {refreshing ? (
          <div className="empty-state"><LoaderCircle size={26} className="spin" /><h3>{t('loading')}</h3></div>
        ) : !currentData || events.length === 0 ? (
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
                    <th scope="col">{t('tableContent')}</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => (
                    <tr key={event.id}>
                      <td className="usage-nowrap">{formatDate(event.createdAt, { dateStyle: 'short', timeStyle: 'short' }, locale)}</td>
                      <td className="usage-user">
                        {usersById.get(event.userId)?.name && <span className="usage-user-name">{usersById.get(event.userId)?.name}</span>}
                        <span className="usage-user-email">{event.userEmail || usersById.get(event.userId)?.email || td('accountUnknown')}</span>
                      </td>
                      <td>
                        <span className={`usage-kind usage-kind--${event.kind}`}>{t(KIND_KEYS[event.kind])}</span>
                        {event.kind === 'llm' && <code className="usage-source">{event.source}</code>}
                      </td>
                      <td>
                        <span className="usage-model">{event.modelName || td('modelUnknown')}</span>
                        {event.providerName && <small className="usage-muted">{event.providerName}</small>}
                      </td>
                      <td>
                        <span className={`usage-outcome usage-outcome--${event.outcome}`} title={event.status}>
                          {t(OUTCOME_KEYS[event.outcome])}
                        </span>
                      </td>
                      <td className="usage-content">
                        {event.preview && <p>{event.preview}</p>}
                        {event.responsePreview && <p>{event.responsePreview}</p>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!rangeError && data != null && events.length < data.total && (
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
