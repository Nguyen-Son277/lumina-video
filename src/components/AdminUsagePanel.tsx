import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BarChart3, LoaderCircle, RefreshCw } from 'lucide-react'
import { errorMessage } from '../api/client'
import { adminApi } from '../api/endpoints'
import type { AdminAccount } from '../api/types'
import {
  adminUsageApi,
  type AdminUsageResponse,
  type UsageEvent,
  type UsageFilters,
} from '../api/usage'
import { formatDate, formatNumber, useTranslation } from '../i18n'
import { usageCatalog } from '../i18n/catalogs/usage'
import { usageAdminDashboardCatalog } from '../i18n/catalogs/usageAdminDashboard'
import { UsageCharts } from './UsageCharts'
import { usageDateInputValue, usageRangeBounds, type UsageRange } from '../../shared/usageRanges'
import { UsageRangeControls } from './UsageRangeControls'
import { UsageExportButton } from './UsageExportButton'
import { EmptyState, InlineNotice, LoadingState, PageHeading } from './ui'
import { MetricCard } from './usage/MetricCard'
import { OutcomeSelect, UsageKindSelect, USAGE_KIND_KEYS as KIND_KEYS, USAGE_OUTCOME_KEYS as OUTCOME_KEYS, type UsageKindFilter, type UsageOutcomeFilter } from './usage/UsageFilterSelects'
import '../styles/usage.css'

/** Số dòng mỗi lần tải; backend giới hạn 1..200. */
const PAGE_SIZE = 25

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
  const [kind, setKind] = useState<UsageKindFilter>('all')
  const [outcome, setOutcome] = useState<UsageOutcomeFilter>('all')
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
      <PageHeading as="div" className="usage-admin-head" intro={<div>
          <h2><BarChart3 size={17} /> {t('adminTitle')}</h2>
          <p className="usage-muted">{td('intro')}</p>
        </div>} actions={<div className="usage-admin-actions">
          <UsageExportButton filters={filters} admin getFilters={getExportFilters} disabled={rangeError} />
          <button className="secondary-button" onClick={() => { setNow(Date.now()); setRefreshKey((current) => current + 1) }}>
            <RefreshCw size={15} /> {t('refresh')}
          </button>
        </div>} />

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
          <UsageKindSelect value={kind} onChange={setKind} />
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
          <OutcomeSelect value={outcome} onChange={setOutcome} />
          </div>
        </details>
        {usersError != null && <p className="usage-muted">{errorMessage(usersError)}</p>}
        {rangeError && <InlineNotice as="p" className="form-error" role="alert">{t('rangeInvalid')}</InlineNotice>}
      </div>

      {loadError != null && (
        <InlineNotice className="form-error">
          {errorMessage(loadError)}
          <button className="secondary-button usage-inline-button" onClick={() => { setNow(Date.now()); setRefreshKey((current) => current + 1) }}>{t('retry')}</button>
        </InlineNotice>
      )}

      {summary && overall && (
        <div className="usage-cards usage-dashboard-cards">
          <MetricCard label={t('cardTotal')} value={formatNumber(overall.count, {}, locale)} detail={t('cardBreakdown', {
            image: formatNumber(summary.totals.image.count, {}, locale),
            video: formatNumber(summary.totals.video.count, {}, locale),
            llm: formatNumber(summary.totals.llm.count, {}, locale),
          })} />
          <MetricCard label={td('completed')} value={formatNumber(overall.ok, {}, locale)} detail={td('pendingNote', { count: formatNumber(overall.pending, {}, locale) })} />
          <MetricCard label={t('cardFailed')} value={formatNumber(overall.failed + overall.unknown, {}, locale)} detail={t('failedPair', {
            failed: formatNumber(overall.failed, {}, locale),
            unknown: formatNumber(overall.unknown, {}, locale),
          })} />
        </div>
      )}

      {summary && <UsageCharts summary={summary} from={filters.from} to={filters.to} loading={refreshing} />}

      <div className="usage-panel">
        <div className="usage-panel-head">
          <h2><BarChart3 size={16} /> {t('adminTitle')}</h2>
          {currentData && <span className="usage-muted">{t('adminTotal', { count: formatNumber(currentData.total, {}, locale) })}</span>}
        </div>
        {refreshing ? (
          <LoadingState className="empty-state" announce={false}><LoaderCircle size={26} className="spin" /><h3>{t('loading')}</h3></LoadingState>
        ) : !currentData || events.length === 0 ? (
          <EmptyState title={t('adminEmpty')} description={t('adminEmptyHint')} />
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
