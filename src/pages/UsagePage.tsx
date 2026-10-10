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
  USAGE_KINDS,
  USAGE_OUTCOMES,
  usageApi,
  usageModelApi,
  type UsageEvent,
  type UsageFilters,
  type UsageKind,
  type UsageListResponse,
  type UsageMessage,
  type UsageModel,
  type UsageOutcome,
} from '../api/usage'
import { formatBytes, formatDate, formatNumber, useTranslation } from '../i18n'
import { usageCatalog, type UsageCatalogKey } from '../i18n/catalogs/usage'
import '../styles/usage.css'

/** Số dòng mỗi lần tải; backend giới hạn 1..200. */
const PAGE_SIZE = 25

/** Chờ người dùng ngừng gõ rồi mới gọi API tìm kiếm. */
const SEARCH_DEBOUNCE_MS = 400

type QuickRange = 'today' | '7d' | '30d' | 'all' | 'custom'
type KindFilter = 'all' | UsageKind
type OutcomeFilter = 'all' | UsageOutcome
type Tab = 'events' | 'messages'

/** Tiền tệ gợi ý sẵn; API vẫn nhận chuỗi tự do nên đây chỉ là lối tắt. */
const CURRENCIES = ['USD', 'VND', 'EUR', 'JPY']

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

function startOfDay(value: Date): number {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** `input[type=date]` → epoch ms của đầu/cuối ngày theo giờ địa phương. */
function parseDateInput(value: string, endOfDay: boolean): number | undefined {
  if (!value) return undefined
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return undefined
  const date = new Date(year, month - 1, day)
  if (Number.isNaN(date.getTime())) return undefined
  if (endOfDay) date.setHours(23, 59, 59, 999)
  return date.getTime()
}

function toDateInputValue(epoch: number): string {
  const date = new Date(epoch)
  const pad = (value: number): string => (value < 10 ? `0${value}` : String(value))
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function rangeBounds(range: QuickRange, from: string, to: string): { from?: number; to?: number } {
  const now = Date.now()
  if (range === 'today') return { from: startOfDay(new Date(now)) }
  if (range === '7d') return { from: now - 7 * 24 * 60 * 60 * 1000 }
  if (range === '30d') return { from: now - 30 * 24 * 60 * 60 * 1000 }
  if (range === 'custom') {
    const start = parseDateInput(from, false)
    const end = parseDateInput(to, true)
    return { ...(start !== undefined ? { from: start } : {}), ...(end !== undefined ? { to: end } : {}) }
  }
  return {}
}

/** `?page=planner&session=…` — neo thật để tải lại trang và App đọc lại URL. */
function hrefFor(params: Record<string, string>): string {
  return `?${new URLSearchParams(params).toString()}`
}

export function UsagePage({ className = '', onOpenModelCatalog }: { className?: string; onOpenModelCatalog?: () => void }) {
  const { t, locale } = useTranslation(usageCatalog)

  const [tab, setTab] = useState<Tab>('events')
  const [range, setRange] = useState<QuickRange>('7d')
  const [customFrom, setCustomFrom] = useState(() => toDateInputValue(Date.now() - 7 * 24 * 60 * 60 * 1000))
  const [customTo, setCustomTo] = useState(() => toDateInputValue(Date.now()))
  const [kind, setKind] = useState<KindFilter>('all')
  const [outcome, setOutcome] = useState<OutcomeFilter>('all')
  const [modelPk, setModelPk] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  const filters = useMemo<UsageFilters>(() => {
    const bounds = rangeBounds(range, customFrom, customTo)
    return {
      ...bounds,
      ...(kind !== 'all' ? { kind: [kind] } : {}),
      ...(outcome !== 'all' ? { outcome: [outcome] } : {}),
      ...(modelPk ? { modelPk } : {}),
      ...(search ? { q: search } : {}),
    }
  }, [range, customFrom, customTo, kind, outcome, modelPk, search])
  // Hiệu ứng chỉ phụ thuộc chuỗi đã tuần tự hoá để không lặp vô hạn vì object mới.
  const filterKey = JSON.stringify(filters)
  const filtersRef = useRef(filters)
  filtersRef.current = filters

  // ── Sự kiện + tổng quan ───────────────────────────────────────────────────
  const [data, setData] = useState<UsageListResponse | null>(null)
  const [events, setEvents] = useState<UsageEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
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
  }, [filterKey, refreshKey])

  const loadMore = useCallback(async () => {
    if (loadingMore) return
    setLoadingMore(true)
    try {
      const result = await usageApi.list({
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

  // ── Tab Tin nhắn ──────────────────────────────────────────────────────────
  const [messages, setMessages] = useState<UsageMessage[]>([])
  const [messagesTotal, setMessagesTotal] = useState(0)
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [messagesError, setMessagesError] = useState<unknown>(null)
  const [messagesLoadingMore, setMessagesLoadingMore] = useState(false)

  useEffect(() => {
    if (tab !== 'messages') return
    const controller = new AbortController()
    setMessagesLoading(true)
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
  }, [tab, filterKey, refreshKey])

  const loadMoreMessages = useCallback(async () => {
    if (messagesLoadingMore) return
    setMessagesLoadingMore(true)
    try {
      const result = await usageApi.messages({
        from: filtersRef.current.from,
        to: filtersRef.current.to,
        q: filtersRef.current.q,
        limit: PAGE_SIZE,
        offset: messages.length,
      })
      setMessages((current) => [...current, ...result.messages])
      setMessagesTotal(result.total)
    } catch (cause) {
      setMessagesError(cause)
    } finally {
      setMessagesLoadingMore(false)
    }
  }, [messages.length, messagesLoadingMore])

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
  const spent = overall?.cost ?? 0
  const budgetPercent = budget && budget > 0 ? Math.round((spent / budget) * 100) : 0

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
      <section className="page-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-dot" /> {t('pageEyebrow')}</div>
          <h1>{t('pageTitleLead')}<em>{t('pageTitleAccent')}</em></h1>
          <p>{t('pageIntro')}</p>
        </div>
        <button className="secondary-button" onClick={() => setRefreshKey((current) => current + 1)}>
          <RefreshCw size={15} /> {t('refresh')}
        </button>
      </section>

      <div className="usage-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'events'} className={tab === 'events' ? 'active' : ''} onClick={() => setTab('events')}>
          <BarChart3 size={15} /> {t('tabEvents')}
        </button>
        <button role="tab" aria-selected={tab === 'messages'} className={tab === 'messages' ? 'active' : ''} onClick={() => setTab('messages')}>
          <MessagesSquare size={15} /> {t('tabMessages')}
        </button>
      </div>

      {/* ── Bộ lọc ─────────────────────────────────────────────────────────── */}
      <section className="usage-panel usage-filters" aria-label={t('filterRange')}>
        <div className="usage-range-row">
          <span className="usage-label">{t('filterRange')}</span>
          <div className="usage-range-buttons">
            {(['today', '7d', '30d', 'all', 'custom'] as QuickRange[]).map((option) => (
              <button
                key={option}
                className={range === option ? 'active' : ''}
                onClick={() => setRange(option)}
              >
                {t(option === 'today' ? 'rangeToday' : option === '7d' ? 'range7d' : option === '30d' ? 'range30d' : option === 'all' ? 'rangeAll' : 'rangeCustom')}
              </button>
            ))}
          </div>
        </div>
        {range === 'custom' && (
          <div className="usage-field-row">
            <label className="usage-field">
              <span>{t('filterFrom')}</span>
              <input type="date" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} aria-label={t('filterFrom')} />
            </label>
            <label className="usage-field">
              <span>{t('filterTo')}</span>
              <input type="date" value={customTo} onChange={(event) => setCustomTo(event.target.value)} aria-label={t('filterTo')} />
            </label>
          </div>
        )}
        <div className="usage-field-row">
          <label className="usage-field">
            <span>{t('filterKind')}</span>
            <select value={kind} onChange={(event) => setKind(event.target.value as KindFilter)} aria-label={t('filterKind')}>
              <option value="all">{t('kindAll')}</option>
              {USAGE_KINDS.map((value) => (
                <option key={value} value={value}>{t(KIND_KEYS[value])}</option>
              ))}
            </select>
          </label>
          <label className="usage-field">
            <span>{t('filterOutcome')}</span>
            <select value={outcome} onChange={(event) => setOutcome(event.target.value as OutcomeFilter)} aria-label={t('filterOutcome')}>
              <option value="all">{t('outcomeAll')}</option>
              {USAGE_OUTCOMES.map((value) => (
                <option key={value} value={value}>{t(OUTCOME_KEYS[value])}</option>
              ))}
            </select>
          </label>
          <label className="usage-field">
            <span>{t('filterModel')}</span>
            <select value={modelPk} onChange={(event) => setModelPk(event.target.value)} aria-label={t('filterModel')}>
              <option value="">{t('modelAll')}</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>{model.displayName}</option>
              ))}
            </select>
          </label>
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
      </section>

      {loadError != null && (
        <div className="form-error">
          {errorMessage(loadError)}
          <button className="secondary-button usage-inline-button" onClick={() => setRefreshKey((current) => current + 1)}>{t('retry')}</button>
        </div>
      )}

      {/* ── Thẻ tổng quan ──────────────────────────────────────────────────── */}
      {summary && overall && (
        <section className="usage-cards" aria-label={t('cardTotal')}>
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
            <span className="usage-card-label">{t('cardMedia')}</span>
            <strong>{formatBytes(summary.mediaBytes, {}, locale)}</strong>
            <small>{t('savingsRetriedValue', { count: formatNumber(summary.waste.retriedCount, {}, locale) })}</small>
          </article>
        </section>
      )}

      {/* ── Ngân sách tháng ────────────────────────────────────────────────── */}
      <section className="usage-panel" aria-label={t('budgetTitle')}>
        <div className="usage-panel-head">
          <h2><Coins size={16} /> {t('budgetTitle')}</h2>
          {budget && budget > 0 ? (
            <span className={budgetPercent > 100 ? 'usage-badge usage-badge--danger' : 'usage-badge'}>
              {t('budgetUsed', { percent: formatNumber(budgetPercent, {}, locale) })}
            </span>
          ) : (
            <span className="usage-muted">{t('budgetUnset')}</span>
          )}
        </div>
        {budget && budget > 0 && (
          <>
            <div className="usage-budget-track"><div className={`usage-budget-fill ${budgetPercent > 100 ? 'is-over' : ''}`} style={{ width: `${Math.min(100, budgetPercent)}%` }} /></div>
            <p className="usage-muted">{t('budgetSpent', { spent: money(spent, currency), budget: money(budget, currency) })}</p>
            {budgetPercent > 100 && (
              <p className="usage-warn"><AlertTriangle size={14} /> {t('budgetOver')}</p>
            )}
          </>
        )}
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

      {/* ── Tab Sự kiện ────────────────────────────────────────────────────── */}
      {tab === 'events' && (
        <section className="usage-panel" aria-label={t('tabEvents')}>
          <div className="usage-panel-head">
            <h2><BarChart3 size={16} /> {t('tabEvents')}</h2>
            {data && <span className="usage-muted">{t('showingCount', { shown: formatNumber(events.length, {}, locale), total: formatNumber(data.total, {}, locale) })}</span>}
          </div>
          {loading ? (
            <div className="empty-state"><LoaderCircle size={26} className="spin" /><h3>{t('loading')}</h3></div>
          ) : events.length === 0 ? (
            <div className="empty-state">
              <CalendarDays size={26} />
              <h3>{t('eventsEmptyTitle')}</h3>
              <p>{t('eventsEmptyHint')}</p>
            </div>
          ) : (
            <>
              <div className="usage-table-wrap">
                <table className="usage-table">
                  <thead>
                    <tr>
                      <th scope="col">{t('tableTime')}</th>
                      <th scope="col">{t('tableKind')}</th>
                      <th scope="col">{t('tableModel')}</th>
                      <th scope="col">{t('tableStatus')}</th>
                      <th scope="col">{t('tableCost')}</th>
                      <th scope="col">{t('tableContent')}</th>
                      <th scope="col">{t('tableLinks')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((event) => (
                      <tr key={event.id}>
                        <td className="usage-nowrap">{formatDate(event.createdAt, { dateStyle: 'short', timeStyle: 'short' }, locale)}</td>
                        <td>
                          <span className={`usage-kind usage-kind--${event.kind}`}>{t(KIND_KEYS[event.kind])}</span>
                          {event.kind === 'llm' && <code className="usage-source">{event.source}</code>}
                        </td>
                        <td>
                          <span className="usage-model">{event.modelName || event.modelPk || '—'}</span>
                          {event.providerName && <small className="usage-muted">{event.providerName}</small>}
                        </td>
                        <td>
                          <span
                            className={`usage-outcome usage-outcome--${event.outcome}`}
                            title={event.status}
                          >
                            {t(OUTCOME_KEYS[event.outcome])}
                          </span>
                          {event.attemptCount > 1 && (
                            <small className="usage-muted">{t('attemptCount', { count: formatNumber(event.attemptCount, {}, locale) })}</small>
                          )}
                        </td>
                        <td className="usage-nowrap">{money(event.cost, currency)}</td>
                        <td className="usage-content">
                          {event.preview && (
                            <div>
                              <span className="usage-content-label">{t('contentPromptLabel')}</span>
                              <p>{event.preview}</p>
                            </div>
                          )}
                          {event.responsePreview && (
                            <div>
                              <span className="usage-content-label">{t('contentResponseLabel')}</span>
                              <p>{event.responsePreview}</p>
                            </div>
                          )}
                        </td>
                        <td>
                          <div className="usage-links">
                            {event.projectId && (
                              <a href={hrefFor({ page: 'studio' })}>{t('linkProject')}</a>
                            )}
                            {event.planSessionId && (
                              <a href={hrefFor({ page: 'planner', session: event.planSessionId })}>{t('linkSession')}</a>
                            )}
                            {event.sceneId && (
                              <a href={hrefFor({
                                page: 'timeline',
                                ...(event.planSessionId ? { session: event.planSessionId } : {}),
                              })}>{t('linkScene')}</a>
                            )}
                            {event.kind !== 'llm' && (
                              <a href={hrefFor({ page: 'library' })}>{t('linkLibrary')}</a>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
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
          {messagesError != null && <div className="form-error">{errorMessage(messagesError)}</div>}
          {messagesLoading ? (
            <div className="empty-state"><LoaderCircle size={26} className="spin" /><h3>{t('loading')}</h3></div>
          ) : messages.length === 0 ? (
            <div className="empty-state">
              <MessagesSquare size={26} />
              <h3>{t('messagesEmptyTitle')}</h3>
              <p>{t('messagesEmptyHint')}</p>
            </div>
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
                    <div className="usage-message-meta">
                      <span>{t('messageCalls', { count: formatNumber(message.llmCalls, {}, locale) })}</span>
                      <span>{t('messageChars', { count: formatNumber(message.chars, {}, locale) })}</span>
                      <span>{money(message.cost, currency)}</span>
                      {message.costUnknown > 0 && (
                        <span className="usage-warn">{t('messageCostUnknown', { count: formatNumber(message.costUnknown, {}, locale) })}</span>
                      )}
                    </div>
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
                  cost: money(summary.waste.failedCost, currency),
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
                          cost: money(entry.cost, currency),
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
        {modelsError != null && <div className="form-error">{errorMessage(modelsError)}</div>}
        {onOpenModelCatalog && (
          <button type="button" className="secondary-button" onClick={onOpenModelCatalog}>
            <ArrowUpRight size={15} /> {t('pricingMovedAction')}
          </button>
        )}
      </section>

      {/* ── Lưu log ────────────────────────────────────────────────────────── */}
      <section className="usage-panel" aria-label={t('logsTitle')}>
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
      </section>
    </div>
  )
}

export default UsagePage
