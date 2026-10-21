import { useEffect, useId, useRef, useState } from 'react'
import { AlertTriangle, ChevronLeft, ChevronRight, LoaderCircle, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import { EntityCard } from '../components/entities/EntityCard'
import { EntityDetailsDialog } from '../components/entities/EntityDetailsDialog'
import { ImageLightbox, useModalLayer } from '../components/Lightbox'
import { Button, CloseButton, DialogFrame, EmptyState, InlineNotice, LoadingState, PageHeading } from '../components/ui'
import type { EntityDetailsData } from '../components/entities/types'
import { unifiedLibraryCatalog } from '../i18n/catalogs/unifiedLibrary'
import { errorMessage } from '../api/client'
import { trashApi, type TrashDetail, type TrashItem, type TrashKind, type TrashListResult } from '../api/trash'
import { formatDate, formatNumber, notification, useTranslation, type Notification } from '../i18n'
import { trashCatalog, type TrashCatalogKey } from '../i18n/catalogs/trash'

const PAGE_SIZE = 24
const KINDS: TrashKind[] = ['project', 'character', 'generation', 'plan_session', 'library_asset']
type Filter = 'all' | TrashKind
type Confirmation = { type: 'item'; item: TrashItem } | { type: 'empty'; count: number }

function remainingDays(item: TrashItem, now: number): number {
  const expiry = new Date(item.purgeAfter).getTime()
  // Invalid expiry data is not safe to restore either.
  return Number.isFinite(expiry) ? Math.ceil((expiry - now) / 86400000) : 0
}

function safeIso(value: number): string | undefined {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

function cardData(item: TrashItem, untitled: string): EntityDetailsData {
  return { id: item.id, kind: item.entityKind ?? (item.kind === 'library_asset' ? 'item' : item.kind), name: item.title || untitled, description: item.description, imageUrl: item.thumbnailUrl, handle: item.handle }
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
  const { t: shared } = useTranslation(unifiedLibraryCatalog)
  const [selected, setSelected] = useState<TrashItem | null>(null)
  const [detail, setDetail] = useState<TrashDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<unknown>(null)
  const [restoreError, setRestoreError] = useState<{ key: string; cause: unknown } | null>(null)
  const [detailRevision, setDetailRevision] = useState(0)
  const [zoom, setZoom] = useState<{ url: string; alt: string } | null>(null)
  useEffect(() => {
    setDetail(null); setDetailError(null); setZoom(null)
    if (!selected) { setDetailLoading(false); return }
    const controller = new AbortController()
    setDetailLoading(true)
    trashApi.detail(selected.kind, selected.id, controller.signal)
      .then(result => { if (!controller.signal.aborted) setDetail(result.item) })
      .catch(cause => { if (!controller.signal.aborted) setDetailError(cause) })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false) })
    return () => controller.abort()
  }, [selected, detailRevision])
  function closeInspection() { setSelected(null); setZoom(null); setRestoreError(null) }
  function openInspection(item: TrashItem) { setRestoreError(null); setSelected(item) }

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
    setRestoreError(null)
    try {
      await trashApi.restore(item.kind, item.id)
      closeInspection()
      onNotify(notification('trash', item.kind === 'character' ? 'characterRestored' : 'restored'))
      refresh()
      await refreshWorkspace()
    } catch (cause) { setError(cause); setRestoreError({ key: `${item.kind}:${item.id}`, cause }) }
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
      closeInspection()
      setError(null)
      refresh()
      await refreshWorkspace()
    } finally { busyRef.current = false; setBusyKey(null) }
  }

  const date = (value: number) => formatDate(value, { dateStyle: 'medium', timeStyle: 'short' }, locale) || t('unknownDate')
  const openZoom = (url: string, alt: string) => setZoom({ url, alt })
  const currentDetail = detail && selected && detail.id === selected.id && detail.kind === selected.kind ? detail : null
  const detailsData = selected ? cardData(currentDetail ?? selected, t('untitled')) : null
  if (detailsData && currentDetail) {
    const detail = currentDetail
    detailsData.views = detail.referenceViews?.map(view => ({ id: view.id, label: view.label, url: view.url }))
    detailsData.sections = []
    const add = (label: string, value?: string) => { if (value) detailsData.sections!.push({ label, value }) }
    add(shared('prompt'), detail.prompt)
    if (detail.appearance && detail.appearance !== detail.description) add(shared('appearance'), detail.appearance)
    add(shared('continuityNotes'), detail.continuityNotes)
    for (const key of ['language', 'accent', 'pitch', 'timbre', 'pace', 'articulation', 'habits'] as const) {
      const labels = { language: 'voiceLanguage', accent: 'voiceAccent', pitch: 'voicePitch', timbre: 'voiceTimbre', pace: 'voicePace', articulation: 'voiceArticulation', habits: 'voiceHabits' } as const
      add(shared(labels[key]), detail.voice?.[key])
    }
    if (detail.createdAt != null) add(shared('createdAt'), date(detail.createdAt))
    if (detail.updatedAt != null) add(shared('updatedAt'), date(detail.updatedAt))
  }
  const itemMetadata = (item: TrashItem) => <>
    <dl className="trash-dates">
      <div><dt>{t('deletedAt')}</dt><dd><time dateTime={safeIso(item.deletedAt)}>{date(item.deletedAt)}</time></dd></div>
      <div><dt>{t('purgeAfter')}</dt><dd><time dateTime={safeIso(item.purgeAfter)}>{date(item.purgeAfter)}</time></dd></div>
    </dl>
    <span className={`trash-expiry ${remainingDays(item, now) <= 0 ? 'is-expired' : ''}`}>{remainingDays(item, now) <= 0 ? t('expired') : t('daysRemaining', { count: remainingDays(item, now) })}</span>
  </>
  const itemActions = (item: TrashItem) => <>
    <Button type="button" className="secondary-button" disabled={remainingDays(item, now) <= 0 || busy || loading} title={remainingDays(item, now) <= 0 ? t('expiredHint') : undefined} aria-label={t('restoreAria', { title: item.title || t('untitled') })} onClick={() => { void restore(item) }}>
      {busyKey === `${item.kind}:${item.id}` ? <LoaderCircle size={15} className="spin" /> : <RotateCcw size={15} />}{t('restore')}
    </Button>
    <Button type="button" className="secondary-button trash-danger" disabled={busy || loading} aria-label={t('purgeAria', { title: item.title || t('untitled') })} onClick={() => { setZoom(null); setConfirmation({ type: 'item', item }) }}><Trash2 size={15} />{t('purge')}</Button>
  </>

  return (
    <div className="page-content trash-page">
      <PageHeading
        intro={<div>
          <div className="eyebrow"><span className="eyebrow-dot" />{t('eyebrow')}</div>
          <h1>{t('title')}</h1>
          <p>{t('description', { days: data?.retentionDays ?? 30 })}</p>
        </div>}
        actions={<div className="heading-actions">
          <Button type="button" className="secondary-button" onClick={refresh} disabled={loading || busy}>
            <RefreshCw size={16} className={loading ? 'spin' : ''} />{t('refresh')}
          </Button>
          <Button type="button" className="secondary-button trash-danger" onClick={() => setConfirmation({ type: 'empty', count: allCount })} disabled={!data || !allCount || loading || busy || error != null}>
            <Trash2 size={16} />{t('empty')}
          </Button>
        </div>}
      />

      <InlineNotice className="notice-banner">
        <AlertTriangle size={19} aria-hidden="true" />
        <div><strong>{t('characterWarning')}</strong><p>{t('parentWarning')}</p><p>{t('libraryWarning')}</p></div>
      </InlineNotice>

      <div className="library-toolbar trash-toolbar">
        <div className="library-tabs trash-filters" role="group" aria-label={t('filters')}>
          {(['all', ...KINDS] as Filter[]).map(kind => (
            <Button type="button" key={kind} className={filter === kind ? 'active' : ''} aria-pressed={filter === kind} disabled={busy} onClick={() => { setFilter(kind); setOffset(0) }}>
              {t(kind)}<span>{formatNumber(kind === 'all' ? allCount : data?.counts[kind] ?? 0, {}, locale)}</span>
            </Button>
          ))}
        </div>
      </div>

      {error != null && <InlineNotice className="form-error trash-error" role="alert">{errorMessage(error)}</InlineNotice>}
      <div aria-busy={loading}>
        {loading ? (
          <LoadingState className="empty-state" role="status" announce={false}><LoaderCircle size={26} className="spin" /><h3>{t('loading')}</h3></LoadingState>
        ) : data?.items.length ? (
          <div className="trash-grid">
            {data.items.map(item => <EntityCard
              key={`${item.kind}:${item.id}`} className="trash-card" data={cardData(item, t('untitled'))}
              kindLabel={item.kind === 'library_asset' ? undefined : t(item.kind)}
              onDetails={() => openInspection(item)} onZoom={openZoom}
              metadata={itemMetadata(item)} actions={itemActions(item)}
            />)}
          </div>
        ) : error == null ? (
          <EmptyState icon={<Trash2 size={28} />} title={t('emptyTitle')} description={t('emptyHint')} />
        ) : null}
      </div>

      {data && total > 0 && (
        <nav className="trash-pagination" aria-label={t('pagination')}>
          <span>{t('range', { from: formatNumber(offset + 1, {}, locale), to: formatNumber(Math.min(offset + PAGE_SIZE, total), {}, locale), total: formatNumber(total, {}, locale) })}</span>
          <div>
            <Button type="button" className="secondary-button" disabled={!offset || loading || busy} onClick={() => setOffset(current => Math.max(0, current - PAGE_SIZE))}><ChevronLeft size={16} />{t('previous')}</Button>
            <span aria-live="polite">{t('page', { page: Math.floor(offset / PAGE_SIZE) + 1, pages })}</span>
            <Button type="button" className="secondary-button" disabled={offset + PAGE_SIZE >= total || loading || busy} onClick={() => setOffset(current => current + PAGE_SIZE)}>{t('next')}<ChevronRight size={16} /></Button>
          </div>
        </nav>
      )}
      {selected && detailsData && <EntityDetailsDialog data={detailsData} onClose={closeInspection}
        kindLabel={selected.kind === 'library_asset' ? undefined : t(selected.kind)}
        loading={detailLoading} error={restoreError?.key === `${selected.kind}:${selected.id}` ? errorMessage(restoreError.cause) : detailError != null ? errorMessage(detailError) : null}
        onRetry={detailError != null && restoreError?.key !== `${selected.kind}:${selected.id}` ? () => setDetailRevision(value => value + 1) : undefined} metadata={itemMetadata(selected)} actions={itemActions(selected)} onZoom={openZoom} />}
      {zoom && <ImageLightbox src={zoom.url} alt={zoom.alt} onClose={() => setZoom(null)} />}
      {confirmation && <TrashConfirmation confirmation={confirmation} busy={busy} onClose={() => { if (!busyRef.current) setConfirmation(null) }} onConfirm={confirmDeletion} />}
    </div>
  )
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
  const titleId = useId()
  const bodyId = useId()
  useModalLayer(dialog, () => { if (!submitting.current) onClose() })

  async function submit() {
    if (submitting.current) return
    submitting.current = true
    setError(null)
    try { await onConfirm() }
    catch (cause) { setError(cause) }
    finally { submitting.current = false }
  }

  const titleKey: TrashCatalogKey = confirmation.type === 'empty' ? 'emptyConfirmTitle' : 'purgeConfirmTitle'
  return <DialogFrame ref={dialog} className="modal-card trash-confirmation" aria-labelledby={titleId} aria-describedby={bodyId} aria-busy={busy} tabIndex={-1} onClose={onClose} enabled={false} closeDisabled={busy}>
    <div className="modal-header"><h2 id={titleId}>{t(titleKey)}</h2><CloseButton type="button" disabled={busy} onClick={onClose} label={t('close')} iconSize={20} /></div>
    <p className="modal-description" id={bodyId}>{confirmation.type === 'empty' ? t('emptyConfirmBody', { count: confirmation.count }) : t('purgeConfirmBody', { title: confirmation.item.title || t('untitled') })}</p>
    {error != null && <InlineNotice className="form-error" role="alert">{errorMessage(error)}</InlineNotice>}
    <div className="modal-actions">
      <Button ref={cancel} data-modal-initial-focus type="button" className="secondary-button" disabled={busy} onClick={onClose}>{t('cancel')}</Button>
      <Button type="button" className="secondary-button trash-danger" disabled={busy} onClick={() => { void submit() }}>{busy && <LoaderCircle size={15} className="spin" />}{busy ? t('deleting') : t(confirmation.type === 'empty' ? 'empty' : 'purge')}</Button>
    </div>
  </DialogFrame>
}
