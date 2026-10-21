import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowUpRight,
  BarChart3,
  CalendarDays,
  Coins,
  Lightbulb,
  LoaderCircle,
  MessagesSquare,
  RefreshCw,
  Save,
  Trash2,
} from 'lucide-react'
import { errorMessage } from '../api/client'
import {
  usageApi,
  usageModelApi,
  type UsageEvent,
  type UsageFilters,
  type UsageListResponse,
  type UsageMessage,
  type UsageModel,
} from '../api/usage'
import { formatBytes, formatDate, formatNumber, useTranslation } from '../i18n'
import { usageCatalog } from '../i18n/catalogs/usage'
import { usageDashboardCatalog } from '../i18n/catalogs/usageDashboard'
import { UsageCharts } from '../components/UsageCharts'
import { UsageRangeControls } from '../components/UsageRangeControls'
import { UsageExportButton } from '../components/UsageExportButton'
import { EmptyState, InlineNotice, LoadingState, PageHeading } from '../components/ui'
import { MetricCard } from '../components/usage/MetricCard'
import { OutcomeSelect, UsageKindSelect, USAGE_KIND_KEYS as KIND_KEYS, USAGE_OUTCOME_KEYS as OUTCOME_KEYS, type UsageKindFilter, type UsageOutcomeFilter } from '../components/usage/UsageFilterSelects'
import { usageDateInputValue, usageRangeBounds, type UsageRange } from '../../shared/usageRanges'
import '../styles/usage.css'

/** Số dòng mỗi lần tải; backend giới hạn 1..200. */
const PAGE_SIZE = 25

/** Chờ người dùng ngừng gõ rồi mới gọi API tìm kiếm. */
const SEARCH_DEBOUNCE_MS = 400

type Tab = 'events' | 'messages'

/** Tiền tệ gợi ý sẵn; API vẫn nhận chuỗi tự do nên đây chỉ là lối tắt. */
const CURRENCIES = ['USD', 'VND', 'EUR', 'JPY']

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'AbortError'
}

/** `?page=planner&session=…` — neo thật để tải lại trang và App đọc lại URL. */
function hrefFor(params: Record<string, string>): string {
  return `?${new URLSearchParams(params).toString()}`
}

export function UsagePage({ className = '', onOpenModelCatalog }: { className?: string; onOpenModelCatalog?: () => void }) {
  const { t, locale } = useTranslation(usageCatalog)
  const { t: td } = useTranslation(usageDashboardCatalog)
  const [technicalOpen, setTechnicalOpen] = useState(false)
  const [monthData, setMonthData] = useState<UsageListResponse | null>(null)
  const [monthLoading, setMonthLoading] = useState(false)
  const [monthError, setMonthError] = useState<unknown>(null)

  const [tab, setTab] = useState<Tab>('events')
  const [range, setRange] = useState<UsageRange>('7d')
  const [customFrom, setCustomFrom] = useState(() => usageDateInputValue(Date.now() - 7 * 24 * 60 * 60 * 1000))
  const [customTo, setCustomTo] = useState(() => usageDateInputValue(Date.now()))
  const [kind, setKind] = useState<UsageKindFilter>('all')
  const [outcome, setOutcome] = useState<UsageOutcomeFilter>('all')
  const [modelPk, setModelPk] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  const rangeValidation = useMemo(() => {
    try {
      return { bounds: usageRangeBounds(range, customFrom, customTo, Date.now()), invalid: false as const }
    } catch {
      return { bounds: undefined, invalid: true as const }
    }
  }, [range, customFrom, customTo, refreshKey])
  const filters = useMemo<UsageFilters>(() => ({
    ...(rangeValidation.bounds ?? {}),
    ...(kind !== 'all' ? { kind: [kind] } : {}),
    ...(outcome !== 'all' ? { outcome: [outcome] } : {}),
    ...(modelPk ? { modelPk } : {}),
    ...(search ? { q: search } : {}),
  }), [rangeValidation, kind, outcome, modelPk, search])
  const rangeInvalid = rangeValidation.invalid
  // Hiệu ứng chỉ phụ thuộc chuỗi đã tuần tự hoá để không lặp vô hạn vì object mới.
  const filterKey = JSON.stringify(filters)
  const filtersRef = useRef(filters)
  filtersRef.current = filters
  const requestKey = `${filterKey}:${refreshKey}:${rangeInvalid}`
  const requestKeyRef = useRef(requestKey)
  requestKeyRef.current = requestKey
  const messageFilterKey = JSON.stringify({ from: filters.from, to: filters.to, q: filters.q })
  const messageRequestKey = `${messageFilterKey}:${refreshKey}:${rangeInvalid}:${tab}`
  const messageRequestKeyRef = useRef(messageRequestKey)
  messageRequestKeyRef.current = messageRequestKey

  // ── Sự kiện + tổng quan ───────────────────────────────────────────────────
  const [data, setData] = useState<UsageListResponse | null>(null)
  const [events, setEvents] = useState<UsageEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  useEffect(() => {
    if (rangeInvalid) {
      setLoading(false)
      setLoadError(null)
      setData(null)
      setEvents([])
      return
    }
    const controller = new AbortController()
    setLoading(true)
    setLoadingMore(false)
    setLoadError(null)
    usageApi
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
  }, [filterKey, refreshKey, rangeInvalid])

  const loadMore = useCallback(async () => {
    if (loading || loadingMore || rangeInvalid) return
    const key = requestKeyRef.current
    setLoadingMore(true)
    try {
      const result = await usageApi.list({
        ...filtersRef.current,
        limit: PAGE_SIZE,
        offset: events.length,
      })
      if (key !== requestKeyRef.current) return
      setEvents((current) => [...current, ...result.events])
      setData((current) => (current ? { ...current, total: result.total } : current))
    } catch (cause) {
      if (key === requestKeyRef.current) setLoadError(cause)
    } finally {
      if (key === requestKeyRef.current) setLoadingMore(false)
    }
  }, [events.length, loading, loadingMore, rangeInvalid])

  // ── Tab Tin nhắn ──────────────────────────────────────────────────────────
  const [messages, setMessages] = useState<UsageMessage[]>([])
  const [messagesTotal, setMessagesTotal] = useState(0)
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [messagesError, setMessagesError] = useState<unknown>(null)
  const [messagesLoadingMore, setMessagesLoadingMore] = useState(false)

  useEffect(() => {
    if (tab !== 'messages') return
    if (rangeInvalid) {
      setMessagesLoading(false)
      setMessagesError(null)
      setMessages([])
      setMessagesTotal(0)
      return
    }
    const controller = new AbortController()
    setMessagesLoading(true)
    setMessagesLoadingMore(false)
    setMessagesError(null)
    usageApi
      .messages(
        {
          from: filtersRef.current.from,
          to: filtersRef.current.to,
          q: filtersRef.current.q,
          limit: PAGE_SIZE,
          offset: 0,
        },
        controller.signal,
      )
      .then((result) => {
        if (controller.signal.aborted) return
        setMessages(result.messages)
        setMessagesTotal(result.total)
      })
      .catch((cause: unknown) => {
        if (!isAbortError(cause)) setMessagesError(cause)
      })
      .finally(() => {
        if (!controller.signal.aborted) setMessagesLoading(false)
      })
    return () => controller.abort()
  }, [tab, messageFilterKey, refreshKey, rangeInvalid])

  const loadMoreMessages = useCallback(async () => {
    if (messagesLoading || messagesLoadingMore || rangeInvalid) return
    const key = messageRequestKeyRef.current
    setMessagesLoadingMore(true)
    try {
      const result = await usageApi.messages({
        from: filtersRef.current.from,
        to: filtersRef.current.to,
        q: filtersRef.current.q,
        limit: PAGE_SIZE,
        offset: messages.length,
      })
      if (key !== messageRequestKeyRef.current) return
      setMessages((current) => [...current, ...result.messages])
      setMessagesTotal(result.total)
    } catch (cause) {
      if (key === messageRequestKeyRef.current) setMessagesError(cause)
    } finally {
      if (key === messageRequestKeyRef.current) setMessagesLoadingMore(false)
    }
  }, [messages.length, messagesLoading, messagesLoadingMore, rangeInvalid])

  // ── Ngân sách tháng ───────────────────────────────────────────────────────
  const [budgetInput, setBudgetInput] = useState('')
  const [currencyInput, setCurrencyInput] = useState('USD')
  const [budgetStatus, setBudgetStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [budgetMessage, setBudgetMessage] = useState('')

  useEffect(() => {
    if (!data) return
    setBudgetInput(data.settings.monthlyBudget == null ? '' : String(data.settings.monthlyBudget))
    setCurrencyInput(data.settings.currency || 'USD')
  }, [data?.settings.monthlyBudget, data?.settings.currency])

  const currency = data?.settings.currency || 'USD'

  const saveBudget = useCallback(async () => {
    const trimmed = budgetInput.trim()
    const parsed = trimmed === '' ? null : Number(trimmed.replace(',', '.'))
    if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) {
      setBudgetStatus('error')
      setBudgetMessage(t('budgetInvalid'))
      return
    }
    setBudgetStatus('saving')
    setBudgetMessage('')
    try {
      const result = await usageApi.saveSettings({ monthlyBudget: parsed, currency: currencyInput.trim() || 'USD' })
      setData((current) => (current ? { ...current, settings: result.settings } : current))
      setBudgetStatus('saved')
    } catch (cause) {
      setBudgetStatus('error')
      setBudgetMessage(errorMessage(cause))
    }
  }, [budgetInput, currencyInput, t])

  // ── Danh sách model (dùng cho bộ lọc và top model) ────────────────────────
  const [models, setModels] = useState<UsageModel[]>([])
  const [modelsLoading, setModelsLoading] = useState(true)
  const [modelsError, setModelsError] = useState<unknown>(null)

  useEffect(() => {
    let cancelled = false
    setModelsLoading(true)
    usageModelApi
      .list()
      .then((result) => {
        if (!cancelled) setModels(result)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setModelsError(cause)
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // ── Xoá log ───────────────────────────────────────────────────────────────
  const [logBusy, setLogBusy] = useState(false)
  const [logMessage, setLogMessage] = useState('')
  const [logError, setLogError] = useState<unknown>(null)

  const runLogAction = useCallback(
    async (action: () => Promise<{ deleted: number }>, confirmText: string, success: (count: number) => string) => {
      if (!window.confirm(confirmText)) return
      setLogBusy(true)
      setLogError(null)
      setLogMessage('')
      try {
        const result = await action()
        setLogMessage(success(result.deleted))
        setRefreshKey((current) => current + 1)
      } catch (cause) {
        setLogError(cause)
      } finally {
        setLogBusy(false)
      }
    },
    [],
  )

  const retentionDays = data?.retentionDays ?? 90
  const summary = data?.summary ?? null
  const overall = summary?.overall ?? null
  const budget = data?.settings.monthlyBudget ?? null
  // Only aggregate prices whose currencies are explicitly known and identical.
  const summaryCurrency = (value: UsageListResponse['summary'] | undefined | null): string | null => {
    if (!value || modelsLoading || modelsError || value.overall.costUnknownCount > 0) return null
    const codes = value.byModel.filter(entry => entry.count > 0).map(entry =>
      models.find(model => model.id === entry.modelPk)?.priceCurrency?.trim().toUpperCase() || null)
    if (codes.length === 0) return null
    return codes.every(code => code && code === codes[0]) ? codes[0] : null
  }
  const totalCurrency = summaryCurrency(summary)
  const monthCurrency = summaryCurrency(monthData?.summary)
  const budgetComparable = !monthLoading && monthData != null && monthCurrency === currency.toUpperCase()
  const spent = monthData?.summary.overall.cost ?? 0
  const budgetPercent = budget && budget > 0 && budgetComparable ? Math.round((spent / budget) * 100) : 0

  useEffect(() => {
    if (!technicalOpen) return
    const controller = new AbortController()
    const now = new Date()
    setMonthLoading(true)
    setMonthData(null)
    setMonthError(null)
    usageApi.list({ from: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), to: now.getTime(), limit: 1, offset: 0 }, controller.signal)
      .then(result => { if (!controller.signal.aborted) setMonthData(result) })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setMonthError(cause) })
      .finally(() => { if (!controller.signal.aborted) setMonthLoading(false) })
    return () => controller.abort()
  }, [technicalOpen, refreshKey])

  const money = useCallback(
    (value: number | null, code: string): string =>
      value == null ? t('costUnknownLabel') : `${formatNumber(value, { maximumFractionDigits: 4 }, locale)} ${code}`,
    [locale, t],
  )

  const hasMoreEvents = data != null && events.length < data.total
  const hasMoreMessages = messages.length < messagesTotal
  const topModels = summary?.byModel.slice(0, 3) ?? []

  return (
    <div className={`page-content usage-page ${className}`.trim()}>
      <PageHeading as="section" className="page-heading usage-heading" title={<>{t('pageTitleLead')}<em>{t('pageTitleAccent')}</em></>} description={td('intro')} actions={<div className="usage-heading-actions">
          <UsageExportButton
            filters={{
              ...filters,
              ...(kind !== 'all' ? { kind: [kind] } : {}),
              ...(outcome !== 'all' ? { outcome: [outcome] } : {}),
              ...(modelPk ? { modelPk } : {}),
              q: searchInput.trim() || undefined,
            }}
            disabled={rangeInvalid}
            getFilters={() => ({
              ...usageRangeBounds(range, customFrom, customTo, Date.now()),
              ...(kind !== 'all' ? { kind: [kind] } : {}),
              ...(outcome !== 'all' ? { outcome: [outcome] } : {}),
              ...(modelPk ? { modelPk } : {}),
              ...(searchInput.trim() ? { q: searchInput.trim() } : {}),
            })}
          />
          <button className="secondary-button" onClick={() => setRefreshKey(current => current + 1)}><RefreshCw size={15} /> {t('refresh')}</button>
        </div>}
      />
      <section className="usage-panel usage-filters" aria-label={t('filterRange')}>
        <div className="usage-filter-bar">
          <UsageRangeControls range={range} from={customFrom} to={customTo} onRangeChange={setRange} onFromChange={setCustomFrom} onToChange={setCustomTo} />
          {tab === 'events' && <>
          <UsageKindSelect value={kind} onChange={setKind} />

          <details className="usage-advanced-filters">
            <summary>{td('advanced')}{(Number(outcome !== 'all') + Number(Boolean(modelPk))) > 0 && <span className="usage-badge">{Number(outcome !== 'all') + Number(Boolean(modelPk))}</span>}</summary>
            <div className="usage-field-row">
          <OutcomeSelect value={outcome} onChange={setOutcome} />
          <label className="usage-field">
            <span>{t('filterModel')}</span>
            <select value={modelPk} onChange={(event) => setModelPk(event.target.value)} aria-label={t('filterModel')}>
              <option value="">{t('modelAll')}</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>{model.displayName}</option>
              ))}
            </select>
          </label>

              <button className="secondary-button" onClick={() => { setKind('all'); setOutcome('all'); setModelPk('') }}>{td('reset')}</button>
            </div>
          </details></>}
        </div>
        {rangeInvalid && <InlineNotice as="p" className="form-error">{t('rangeInvalid')}</InlineNotice>}
      </section>
      {loadError != null && <InlineNotice className="form-error">{errorMessage(loadError)} <button className="secondary-button" onClick={() => setRefreshKey(current => current + 1)}>{t('retry')}</button></InlineNotice>}
      <section aria-label={td('activitySummary')}>
        {tab === 'messages' && <p className="usage-muted">{td('eventsSummaryNote')}</p>}
        {loading ? <div className="usage-cards usage-summary-skeleton" role="status" aria-label={t('loading')}>{[0, 1, 2].map(index => <article className="usage-card usage-skeleton" key={index}><span>—</span><strong>—</strong></article>)}</div> : summary && overall && <>
          <div className="usage-cards usage-primary-cards">
            <MetricCard label={t('cardTotal')} value={formatNumber(overall.count, {}, locale)} detail={t('cardBreakdown', { image: formatNumber(summary.totals.image.count, {}, locale), video: formatNumber(summary.totals.video.count, {}, locale), llm: formatNumber(summary.totals.llm.count, {}, locale) })} />
            <MetricCard label={td('completed')} value={formatNumber(overall.ok, {}, locale)} />
            <MetricCard label={td('attention')} value={formatNumber(overall.failed + overall.unknown, {}, locale)} detail={t('failedPair', { failed: formatNumber(overall.failed, {}, locale), unknown: formatNumber(overall.unknown, {}, locale) })} />
          </div>
          {overall.pending > 0 && <p className="usage-muted">{td('pending', { count: formatNumber(overall.pending, {}, locale) })}</p>}
        </>}
        {summary && !rangeInvalid && <UsageCharts summary={summary} from={filters.from} to={filters.to} loading={loading} />}
      </section>
      <div className="usage-history-heading"><h2>{td('history')}</h2>
      <div className="usage-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'events'} className={tab === 'events' ? 'active' : ''} onClick={() => setTab('events')}>
          <BarChart3 size={15} /> {t('tabEvents')}
        </button>
        <button role="tab" aria-selected={tab === 'messages'} className={tab === 'messages' ? 'active' : ''} onClick={() => setTab('messages')}>
          <MessagesSquare size={15} /> {t('tabMessages')}
        </button>
      </div>

      </div>
      <div className="usage-history-toolbar">
          <label className="usage-field usage-field--search">
            <span>{t('filterSearch')}</span>
            <input
              type="search"
              value={searchInput}
              placeholder={t('searchPlaceholder')}
              onChange={(event) => setSearchInput(event.target.value)}
              aria-label={t('filterSearch')}
            />
          </label>
      </div>
      {/* ── Tab Sự kiện ────────────────────────────────────────────────────── */}
      {tab === 'events' && (
        <section className="usage-panel" aria-label={t('tabEvents')}>
          <div className="usage-panel-head">
            <h2><BarChart3 size={16} /> {t('tabEvents')}</h2>
            {data && <span className="usage-muted">{t('showingCount', { shown: formatNumber(events.length, {}, locale), total: formatNumber(data.total, {}, locale) })}</span>}
          </div>
          {loading ? (
            <LoadingState className="empty-state" announce={false}><LoaderCircle size={26} className="spin" /><h3>{t('loading')}</h3></LoadingState>
          ) : events.length === 0 ? (
            <EmptyState icon={<CalendarDays size={26} />} title={t('eventsEmptyTitle')} description={t('eventsEmptyHint')} />
          ) : (
            <>
              <div className="usage-table-wrap">
                <table className="usage-table usage-history-table">
                  <thead><tr><th scope="col">{t('tableTime')}</th><th scope="col">{td('activity')}</th><th scope="col">{t('tableStatus')}</th><th scope="col">{t('tableContent')}</th></tr></thead>
                  <tbody>{events.map(event => {
                    const eventCurrency = models.find(model => model.id === event.modelPk)?.priceCurrency
                    return <tr key={event.id} className="usage-history-row">
                      <td className="usage-history-time" data-label={t('tableTime')}>{formatDate(event.createdAt, { dateStyle: 'short', timeStyle: 'short' }, locale)}</td>
                      <td className="usage-history-activity" data-label={td('activity')}><span className={`usage-kind usage-kind--${event.kind}`}>{t(KIND_KEYS[event.kind])}</span><span className="usage-model">{event.modelName || td('modelUnknown')}</span></td>
                      <td className="usage-history-status" data-label={t('tableStatus')}><span className={`usage-outcome usage-outcome--${event.outcome}`} title={event.status}>{t(OUTCOME_KEYS[event.outcome])}</span></td>
                      <td className="usage-history-preview usage-content" data-label={t('tableContent')}>
                        <p className="usage-preview-text">{event.preview || event.responsePreview || '—'}</p>
                        <details className="usage-event-details"><summary>{td('details')}</summary>
                          {event.preview && <div><span className="usage-content-label">{t('contentPromptLabel')}</span><p>{event.preview}</p></div>}
                          {event.responsePreview && <div><span className="usage-content-label">{t('contentResponseLabel')}</span><p>{event.responsePreview}</p></div>}
                          <dl className="usage-event-metrics">
                            <div><dt>{t('tableCost')}</dt><dd>{eventCurrency ? money(event.cost, eventCurrency) : t('costUnknownLabel')}</dd></div>
                            <div><dt>{t('tableModel')}</dt><dd>{event.modelName || td('modelUnknown')} {event.providerName}</dd></div>
                            <div><dt>{t('tableStatus')}</dt><dd>{event.status}</dd></div>
                            <div><dt>{td('tokens')}</dt><dd>{t('tokenPair', { input: event.promptTokens == null ? '—' : formatNumber(event.promptTokens, {}, locale), output: event.completionTokens == null ? '—' : formatNumber(event.completionTokens, {}, locale) })}</dd></div>
                            <div><dt>{td('latency')}</dt><dd>{td('milliseconds', { value: formatNumber(event.latencyMs, {}, locale) })}</dd></div>
                          </dl>
                          {event.attemptCount > 1 && <small>{t('attemptCount', { count: formatNumber(event.attemptCount, {}, locale) })}</small>}
                          {event.kind === 'llm' && <code className="usage-source">{event.source === 'library_reference_ai' ? t('sourceLibraryReference') : event.source}</code>}
                          <div className="usage-links">
                            {event.projectId && <a href={hrefFor({ page: 'studio' })}>{t('linkProject')}</a>}
                            {event.planSessionId && <a href={hrefFor({ page: 'planner', session: event.planSessionId })}>{t('linkSession')}</a>}
                            {event.sceneId && <a href={hrefFor({ page: 'timeline', ...(event.planSessionId ? { session: event.planSessionId } : {}) })}>{t('linkScene')}</a>}
                            {event.kind !== 'llm' && <a href={hrefFor({ page: 'library' })}>{t('linkLibrary')}</a>}
                          </div>
                        </details>
                      </td>
                    </tr>
                  })}</tbody>
                </table>
              </div>
              {hasMoreEvents && (
                <button className="secondary-button usage-load-more" onClick={() => { void loadMore() }} disabled={loadingMore}>
                  {loadingMore ? <LoaderCircle size={15} className="spin" /> : null} {t('loadMore')}
                </button>
              )}
            </>
          )}
        </section>
      )}

      {/* ── Tab Tin nhắn ───────────────────────────────────────────────────── */}
      {tab === 'messages' && (
        <section className="usage-panel" aria-label={t('tabMessages')}>
          <div className="usage-panel-head">
            <h2><MessagesSquare size={16} /> {t('tabMessages')}</h2>
            {messagesTotal > 0 && <span className="usage-muted">{t('showingCount', { shown: formatNumber(messages.length, {}, locale), total: formatNumber(messagesTotal, {}, locale) })}</span>}
          </div>
          {messagesError != null && <InlineNotice className="form-error">{errorMessage(messagesError)}</InlineNotice>}
          {messagesLoading ? (
            <LoadingState className="empty-state" announce={false}><LoaderCircle size={26} className="spin" /><h3>{t('loading')}</h3></LoadingState>
          ) : messages.length === 0 ? (
            <EmptyState icon={<MessagesSquare size={26} />} title={t('messagesEmptyTitle')} description={t('messagesEmptyHint')} />
          ) : (
            <>
              <ul className="usage-messages">
                {messages.map((message) => (
                  <li key={message.id} className="usage-message">
                    <div className="usage-message-head">
                      <span className={`usage-role usage-role--${message.role}`}>
                        {message.role === 'user' ? t('roleUser') : t('roleAssistant')}
                      </span>
                      <strong>{message.sessionTitle || t('sessionFallback')}</strong>
                      <span className="usage-muted">{formatDate(message.createdAt, { dateStyle: 'short', timeStyle: 'short' }, locale)}</span>
                    </div>
                    <p className="usage-message-preview">{message.preview}</p>
                    <details className="usage-event-details"><summary>{td('details')}</summary><div className="usage-message-meta">
                      <span>{t('messageCalls', { count: formatNumber(message.llmCalls, {}, locale) })}</span>
                      <span>{t('messageChars', { count: formatNumber(message.chars, {}, locale) })}</span>
                      <span title={td('currencyUncertain')}>{t('tableCost')}: {td('currencyUnverified')}</span>
                      {message.costUnknown > 0 && (
                        <span className="usage-warn">{t('messageCostUnknown', { count: formatNumber(message.costUnknown, {}, locale) })}</span>
                      )}
                    </div></details>
                  </li>
                ))}
              </ul>
              {hasMoreMessages && (
                <button className="secondary-button usage-load-more" onClick={() => { void loadMoreMessages() }} disabled={messagesLoadingMore}>
                  {messagesLoadingMore ? <LoaderCircle size={15} className="spin" /> : null} {t('loadMore')}
                </button>
              )}
            </>
          )}
        </section>
      )}

      <details className="usage-technical-details usage-panel" onToggle={event => { if (event.target === event.currentTarget) setTechnicalOpen(event.currentTarget.open) }}>
        <summary>{td('technical')}</summary>
        {overall && !loading && <div className="usage-cards">
          <MetricCard labelClassName="" label={t('cardCost')} value={totalCurrency ? money(overall.cost, totalCurrency) : '—'} detail={!totalCurrency ? td('currencyUncertain') : undefined} />
          <MetricCard labelClassName="" label={t('cardTokens')} value={formatNumber(overall.promptTokens + overall.completionTokens, {}, locale)} detail={t('tokenPair', { input: formatNumber(overall.promptTokens, {}, locale), output: formatNumber(overall.completionTokens, {}, locale) })} />
          <MetricCard labelClassName="" label={t('cardMedia')} value={formatBytes(summary?.mediaBytes ?? 0, {}, locale)} detail={td('storedMedia')} />
        </div>}
      {/* ── Ngân sách tháng ────────────────────────────────────────────────── */}
      <section className="usage-panel" aria-label={t('budgetTitle')}>
        <div className="usage-panel-head">
          <h2><Coins size={16} /> {t('budgetTitle')}</h2>
          {budget && budget > 0 && budgetComparable ? (
            <span className={budgetPercent > 100 ? 'usage-badge usage-badge--danger' : 'usage-badge'}>
              {t('budgetUsed', { percent: formatNumber(budgetPercent, {}, locale) })}
            </span>
          ) : (
            <span className="usage-muted">{budget && budget > 0 ? money(budget, currency) : t('budgetUnset')}</span>
          )}
        </div>
        {budget && budget > 0 && budgetComparable && (
          <>
            <div className="usage-budget-track"><div className={`usage-budget-fill ${budgetPercent > 100 ? 'is-over' : ''}`} style={{ width: `${Math.min(100, budgetPercent)}%` }} /></div>
            <p className="usage-muted">{t('budgetSpent', { spent: money(spent, currency), budget: money(budget, currency) })}</p>
            {budgetPercent > 100 && (
              <p className="usage-warn"><AlertTriangle size={14} /> {t('budgetOver')}</p>
            )}
          </>
        )}
        <p className="usage-muted">{td('monthBudget')}</p>
        {monthLoading && <p role="status">{td('monthLoading')}</p>}
        {monthError != null && <p className="form-error">{errorMessage(monthError)}</p>}
        {!monthLoading && !budgetComparable && <p className="usage-muted">{td('currencyUncertain')}</p>}
        <div className="usage-field-row">
          <label className="usage-field">
            <span>{t('budgetAmountLabel')}</span>
            <input
              type="number"
              min="0"
              inputMode="decimal"
              value={budgetInput}
              onChange={(event) => { setBudgetInput(event.target.value); setBudgetStatus('idle') }}
              aria-label={t('budgetAmountLabel')}
            />
          </label>
          <label className="usage-field">
            <span>{t('budgetCurrencyLabel')}</span>
            <select value={currencyInput} onChange={(event) => { setCurrencyInput(event.target.value); setBudgetStatus('idle') }} aria-label={t('budgetCurrencyLabel')}>
              {CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}
            </select>
          </label>
          <button className="primary-small-button usage-inline-button" onClick={() => { void saveBudget() }} disabled={budgetStatus === 'saving'}>
            <Save size={14} /> {budgetStatus === 'saving' ? t('budgetSaving') : t('budgetSave')}
          </button>
        </div>
        {budgetStatus === 'saved' && <p className="usage-ok">{t('budgetSaved')}</p>}
        {budgetStatus === 'error' && <p className="usage-warn">{budgetMessage}</p>}
      </section>

      {/* ── Gợi ý tiết kiệm ────────────────────────────────────────────────── */}
      {summary && (
        <section className="usage-panel" aria-label={t('savingsTitle')}>
          <div className="usage-panel-head">
            <h2><Lightbulb size={16} /> {t('savingsTitle')}</h2>
            <span className="usage-muted">{t('savingsIntro')}</span>
          </div>
          {summary.waste.failedCount === 0 && summary.waste.retriedCount === 0 && summary.waste.duplicateSceneGenerations === 0 && topModels.length === 0 ? (
            <p className="usage-muted">{t('savingsNone')}</p>
          ) : (
            <ul className="usage-savings">
              <li>
                <span>{t('savingsFailed')}</span>
                <strong>{t('savingsFailedValue', {
                  count: formatNumber(summary.waste.failedCount, {}, locale),
                  cost: totalCurrency ? money(summary.waste.failedCost, totalCurrency) : t('costUnknownLabel'),
                })}</strong>
              </li>
              <li>
                <span>{t('savingsRetried')}</span>
                <strong>{t('savingsRetriedValue', { count: formatNumber(summary.waste.retriedCount, {}, locale) })}</strong>
              </li>
              <li>
                <span>{t('savingsDuplicate')}</span>
                <strong>{t('savingsDuplicateValue', { count: formatNumber(summary.waste.duplicateSceneGenerations, {}, locale) })}</strong>
              </li>
              {topModels.length > 0 && (
                <li>
                  <span>{t('savingsTopModel')}</span>
                  <span className="usage-top-models">
                    {topModels.map((entry) => (
                      <strong key={`${entry.modelPk ?? 'none'}-${entry.kind}`}>
                        {t('savingsTopModelValue', {
                          model: entry.modelName || entry.modelPk || '—',
                          cost: totalCurrency ? money(entry.cost, totalCurrency) : t('costUnknownLabel'),
                        })}
                      </strong>
                    ))}
                  </span>
                </li>
              )}
            </ul>
          )}
        </section>
      )}

      {/* Đơn giá model được nhập cùng chỗ khai báo model, không nhập ở hai nơi. */}
      <section className="usage-panel usage-pricing-hint" aria-label={t('pricingMovedTitle')}>
        <div className="usage-panel-head">
          <h2><Coins size={16} /> {t('pricingMovedTitle')}</h2>
          <span className="usage-muted">{t('pricingMovedBody')}</span>
        </div>
        {modelsError != null && <InlineNotice className="form-error">{errorMessage(modelsError)}</InlineNotice>}
        {onOpenModelCatalog && (
          <button type="button" className="secondary-button" onClick={onOpenModelCatalog}>
            <ArrowUpRight size={15} /> {t('pricingMovedAction')}
          </button>
        )}
      </section>

      {/* ── Lưu log ────────────────────────────────────────────────────────── */}
      <details className="usage-panel usage-danger-details">
        <summary>{t('logsTitle')}</summary>
        <div className="usage-panel-head">
          <h2><Trash2 size={16} /> {t('logsTitle')}</h2>
        </div>
        <p className="usage-muted">{t('logsNote', { days: formatNumber(retentionDays, {}, locale) })}</p>
        <div className="usage-field-row">
          <button
            className="secondary-button"
            disabled={logBusy}
            onClick={() => { void runLogAction(() => usageApi.clearLogs(), t('confirmDeleteLogs'), (count) => t('deletedLogs', { count: formatNumber(count, {}, locale) })) }}
          >
            <Trash2 size={14} /> {t('deleteLogs')}
          </button>
          <button
            className="secondary-button"
            disabled={logBusy}
            onClick={() => { void runLogAction(() => usageApi.purgeLogs(), t('confirmPurgeLogs', { days: formatNumber(retentionDays, {}, locale) }), (count) => t('purgedLogs', { count: formatNumber(count, {}, locale) })) }}
          >
            {t('purgeLogs', { days: formatNumber(retentionDays, {}, locale) })}
          </button>
        </div>
        {logMessage && <p className="usage-ok">{logMessage}</p>}
        {logError != null && <div className="form-error">{errorMessage(logError)}</div>}
      </details>
      </details>
    </div>
  )
}

export default UsagePage
