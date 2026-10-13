import { useEffect, useId, useRef, useState } from 'react'
import { AlertTriangle, ChevronLeft, ChevronRight, Clapperboard, FileText, Image as ImageIcon, LoaderCircle, RefreshCw, RotateCcw, Trash2, Users, X } from 'lucide-react'
import { errorMessage } from '../api/client'
import { trashApi, type TrashItem, type TrashKind, type TrashListResult } from '../api/trash'
import { formatDate, formatNumber, notification, useTranslation, type Notification } from '../i18n'
import { trashCatalog, type TrashCatalogKey } from '../i18n/catalogs/trash'

const PAGE_SIZE = 24
const KINDS: TrashKind[] = ['project', 'character', 'generation', 'plan_session']
type Filter = 'all' | TrashKind
type Confirmation = { type: 'item'; item: TrashItem } | { type: 'empty'; count: number }

function remainingDays(item: TrashItem, now: number): number {
  const expiry = new Date(item.purgeAfter).getTime()
  // Invalid expiry data is not safe to restore either.
  return Number.isFinite(expiry) ? Math.ceil((expiry - now) / 86400000) : 0
}

function KindIcon({ kind }: { kind: TrashKind }) {
  if (kind === 'project') return <Clapperboard size={28} />
  if (kind === 'character') return <Users size={28} />
  if (kind === 'plan_session') return <FileText size={28} />
  return <ImageIcon size={28} />
}

export function TrashPage({ onNotify, onChanged }: {
  onNotify: (message: Notification) => void
  onChanged: () => Promise<void> | void
}) {
  const { t, locale } = useTranslation(trashCatalog)
  const [filter, setFilter] = useState<Filter>('all')
  const [offset, setOffset] = useState(0)
  const [revision, setRevision] = useState(0)
  const [data, setData] = useState<TrashListResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const busyRef = useRef(false)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [now, setNow] = useState(Date.now)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    trashApi.list({ kind: filter === 'all' ? undefined : filter, limit: PAGE_SIZE, offset }, controller.signal)
      .then(result => {
        if (controller.signal.aborted) return
        // Deleting the last card on a page must not leave an empty out-of-range page.
        if (offset > 0 && offset >= result.total) {
          setOffset(Math.max(0, Math.ceil(result.total / PAGE_SIZE) - 1) * PAGE_SIZE)
          return
        }
        setData(result)
        setNow(Date.now())
      })
      .catch(cause => {
        if (!controller.signal.aborted) { setError(cause); setData(null) }
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [filter, offset, revision])

  const allCount = KINDS.reduce((sum, kind) => sum + (data?.counts[kind] ?? 0), 0)
  const busy = busyKey !== null
  const total = data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const refresh = () => setRevision(current => current + 1)

  async function refreshWorkspace() {
    try { await onChanged() }
    catch { onNotify(notification('trash', 'cacheRefreshFailed')) }
  }

  async function restore(item: TrashItem) {
    if (busyRef.current) return
    if (remainingDays(item, Date.now()) <= 0) {
      setNow(Date.now())
      onNotify(notification('trash', 'expiredHint'))
      return
    }
    busyRef.current = true
    setBusyKey(`${item.kind}:${item.id}`)
    setError(null)
    try {
      await trashApi.restore(item.kind, item.id)
      onNotify(notification('trash', item.kind === 'character' ? 'characterRestored' : 'restored'))
      refresh()
      await refreshWorkspace()
    } catch (cause) { setError(cause) }
    finally { busyRef.current = false; setBusyKey(null) }
  }

  async function confirmDeletion() {
    if (!confirmation || busyRef.current) return
    busyRef.current = true
    setBusyKey(confirmation.type === 'empty' ? 'empty' : `${confirmation.item.kind}:${confirmation.item.id}`)
    try {
      if (confirmation.type === 'empty') {
        const result = await trashApi.empty()
        onNotify(notification('trash', 'emptied', result))
      } else {
        const result = await trashApi.purge(confirmation.item.kind, confirmation.item.id)
        onNotify(notification('trash', 'purged', { count: result.purged }))
      }
      setConfirmation(null)
      setError(null)
      refresh()
      await refreshWorkspace()
    } finally { busyRef.current = false; setBusyKey(null) }
  }

  const date = (value: number) => formatDate(value, { dateStyle: 'medium', timeStyle: 'short' }, locale) || t('unknownDate')

  return (
    <div className="page-content trash-page">
      <section className="page-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-dot" />{t('eyebrow')}</div>
          <h1>{t('title')}</h1>
          <p>{t('description', { days: data?.retentionDays ?? 30 })}</p>
        </div>
        <div className="heading-actions">
          <button type="button" className="secondary-button" onClick={refresh} disabled={loading || busy}>
            <RefreshCw size={16} className={loading ? 'spin' : ''} />{t('refresh')}
          </button>
          <button type="button" className="secondary-button trash-danger" onClick={() => setConfirmation({ type: 'empty', count: allCount })} disabled={!data || !allCount || loading || busy || error != null}>
            <Trash2 size={16} />{t('empty')}
          </button>
        </div>
      </section>

      <div className="notice-banner">
        <AlertTriangle size={19} aria-hidden="true" />
        <div><strong>{t('characterWarning')}</strong><p>{t('parentWarning')}</p></div>
      </div>

      <div className="library-toolbar trash-toolbar">
        <div className="library-tabs trash-filters" role="group" aria-label={t('filters')}>
          {(['all', ...KINDS] as Filter[]).map(kind => (
            <button type="button" key={kind} className={filter === kind ? 'active' : ''} aria-pressed={filter === kind} disabled={busy} onClick={() => { setFilter(kind); setOffset(0) }}>
              {t(kind)}<span>{formatNumber(kind === 'all' ? allCount : data?.counts[kind] ?? 0, {}, locale)}</span>
            </button>
          ))}
        </div>
      </div>

      {error != null && <div className="form-error trash-error" role="alert">{errorMessage(error)}</div>}
      <div aria-busy={loading}>
        {loading ? (
          <div className="empty-state" role="status"><LoaderCircle size={26} className="spin" /><h3>{t('loading')}</h3></div>
        ) : data?.items.length ? (
          <div className="trash-grid">
            {data.items.map(item => {
              const key = `${item.kind}:${item.id}`
              const days = remainingDays(item, now)
              const expired = days <= 0
              const title = item.title || t('untitled')
              return (
                <article className="trash-card" key={key}>
                  <TrashThumbnail item={item} title={title} />
                  <div className="trash-card-body">
                    <div className="trash-card-kind">{t(item.kind)}</div>
                    <h2 title={title}>{title}</h2>
                    <p className="trash-card-subtitle" title={item.subtitle}>{item.subtitle ? t(item.subtitle as 'image' | 'video') : t('noSubtitle')}</p>
                    <dl className="trash-dates">
                      <div><dt>{t('deletedAt')}</dt><dd><time dateTime={new Date(item.deletedAt).toISOString()}>{date(item.deletedAt)}</time></dd></div>
                      <div><dt>{t('purgeAfter')}</dt><dd><time dateTime={new Date(item.purgeAfter).toISOString()}>{date(item.purgeAfter)}</time></dd></div>
                    </dl>
                    <span className={`trash-expiry ${expired ? 'is-expired' : ''}`}>{expired ? t('expired') : t('daysRemaining', { count: days })}</span>
                    <div className="trash-card-actions">
                      <button type="button" className="secondary-button" disabled={expired || busy || loading} title={expired ? t('expiredHint') : undefined} aria-label={t('restoreAria', { title })} onClick={() => { void restore(item) }}>
                        {busyKey === key ? <LoaderCircle size={15} className="spin" /> : <RotateCcw size={15} />}{t('restore')}
                      </button>
                      <button type="button" className="secondary-button trash-danger" disabled={busy || loading} aria-label={t('purgeAria', { title })} onClick={() => setConfirmation({ type: 'item', item })}>
                        <Trash2 size={15} />{t('purge')}
                      </button>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        ) : error == null ? (
          <div className="empty-state"><Trash2 size={28} /><h3>{t('emptyTitle')}</h3><p>{t('emptyHint')}</p></div>
        ) : null}
      </div>

      {data && total > 0 && (
        <nav className="trash-pagination" aria-label={t('pagination')}>
          <span>{t('range', { from: formatNumber(offset + 1, {}, locale), to: formatNumber(Math.min(offset + PAGE_SIZE, total), {}, locale), total: formatNumber(total, {}, locale) })}</span>
          <div>
            <button type="button" className="secondary-button" disabled={!offset || loading || busy} onClick={() => setOffset(current => Math.max(0, current - PAGE_SIZE))}><ChevronLeft size={16} />{t('previous')}</button>
            <span aria-live="polite">{t('page', { page: Math.floor(offset / PAGE_SIZE) + 1, pages })}</span>
            <button type="button" className="secondary-button" disabled={offset + PAGE_SIZE >= total || loading || busy} onClick={() => setOffset(current => current + PAGE_SIZE)}>{t('next')}<ChevronRight size={16} /></button>
          </div>
        </nav>
      )}
      {confirmation && <TrashConfirmation confirmation={confirmation} busy={busy} onClose={() => { if (!busyRef.current) setConfirmation(null) }} onConfirm={confirmDeletion} />}
    </div>
  )
}

function TrashThumbnail({ item, title }: { item: TrashItem; title: string }) {
  const { t } = useTranslation(trashCatalog)
  const [failed, setFailed] = useState(false)
  return <div className="trash-thumbnail">
    {item.thumbnailUrl && !failed ? <img src={item.thumbnailUrl} alt={t('thumbnailAlt', { title })} loading="lazy" onError={() => setFailed(true)} /> : <KindIcon kind={item.kind} />}
  </div>
}

/** Same keyboard, focus and error handling as the existing project trash dialog. */
function TrashConfirmation({ confirmation, busy, onClose, onConfirm }: {
  confirmation: Confirmation
  busy: boolean
  onClose: () => void
  onConfirm: () => Promise<void>
}) {
  const { t } = useTranslation(trashCatalog)
  const [error, setError] = useState<unknown>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const submitting = useRef(false)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const titleId = useId()
  const bodyId = useId()

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    cancel.current?.focus()
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); if (!submitting.current) closeRef.current() }
      if (event.key !== 'Tab') return
      const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') ?? [])
      const first = elements[0]
      const last = elements[elements.length - 1]
      if (!first) { event.preventDefault(); dialog.current?.focus(); return }
      if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('keydown', keydown)
      document.body.style.overflow = overflow
      if (previous?.isConnected) previous.focus()
      else document.querySelector<HTMLElement>('.trash-filters button.active')?.focus()
    }
  }, [])

  async function submit() {
    if (submitting.current) return
    submitting.current = true
    setError(null)
    try { await onConfirm() }
    catch (cause) { setError(cause) }
    finally { submitting.current = false }
  }

  const titleKey: TrashCatalogKey = confirmation.type === 'empty' ? 'emptyConfirmTitle' : 'purgeConfirmTitle'
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <div ref={dialog} className="modal-card trash-confirmation" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} aria-busy={busy} tabIndex={-1}>
      <div className="modal-header"><h2 id={titleId}>{t(titleKey)}</h2><button type="button" className="close-button" disabled={busy} onClick={onClose} aria-label={t('close')}><X size={18} /></button></div>
      <p className="modal-description" id={bodyId}>{confirmation.type === 'empty' ? t('emptyConfirmBody', { count: confirmation.count }) : t('purgeConfirmBody', { title: confirmation.item.title || t('untitled') })}</p>
      {error != null && <div className="form-error" role="alert">{errorMessage(error)}</div>}
      <div className="modal-actions">
        <button ref={cancel} type="button" className="secondary-button" disabled={busy} onClick={onClose}>{t('cancel')}</button>
        <button type="button" className="secondary-button trash-danger" disabled={busy} onClick={() => { void submit() }}>{busy && <LoaderCircle size={15} className="spin" />}{busy ? t('deleting') : t(confirmation.type === 'empty' ? 'empty' : 'purge')}</button>
      </div>
    </div>
  </div>
}
