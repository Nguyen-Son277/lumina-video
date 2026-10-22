import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react'
import { ArrowUpRight, Clock3, LoaderCircle, Sparkles, Workflow, X } from 'lucide-react'
import { generationApi, quickSessionApi, type QuickSession } from '../api/endpoints'
import { errorMessage } from '../api/client'
import type { Generation, Mode } from '../api/types'
import { CreationCard, isGenerationActive } from '../components/Common'
import { DialogFrame } from '../components/ui'
import { useTranslation } from '../i18n'
import { studioCatalog } from '../i18n/catalogs/studio'
import { shellCatalog } from '../i18n/catalogs/shell'
import { StudioPage } from './StudioPage'

type Props = ComponentProps<typeof StudioPage> & {
  onOpenGeneration: (sessionId: string, generationId: string) => void
}
const order = (a: Generation, b: Generation) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)
function merge(current: Generation[], incoming: Generation[]): Generation[] {
  const items = new Map(current.map(item => [item.id, item]))
  for (const item of incoming) if (!items.has(item.id) || items.get(item.id)!.updatedAt <= item.updatedAt) items.set(item.id, item)
  return [...items.values()].sort(order)
}

/** Home stays mounted behind the session view, retaining draft and feed scroll. */
export function QuickPage(props: Props) {
  const { t } = useTranslation(studioCatalog)
  const { t: shellT } = useTranslation(shellCatalog)
  const [homeMode, setHomeMode] = useState<Mode>(props.mode)
  const [filter, setFilter] = useState<'all' | Mode>('all')
  const [items, setItems] = useState<Generation[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [retry, setRetry] = useState(0)
  const [history, setHistory] = useState<QuickSession[] | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyError, setHistoryError] = useState<unknown>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const openCanvasRef = useRef<(() => void) | null>(null)
  const registerCanvas = useCallback((open: (() => void) | null) => { openCanvasRef.current = open }, [])
  const requestRef = useRef(0)
  const filterRef = useRef(filter)
  filterRef.current = filter
  const itemsRef = useRef(items)
  itemsRef.current = items
  const active = items.some(isGenerationActive)
  const query = useCallback(() => ({ scope: 'quick' as const, ...(filter === 'all' ? {} : { kind: filter }), limit: 30 }), [filter])

  useEffect(() => {
    const request = ++requestRef.current
    const controller = new AbortController()
    setLoading(true); setError(null); setItems([]); setCursor(null); setLoadingMore(false)
    generationApi.list(query(), controller.signal).then(result => {
      if (request !== requestRef.current) return
      setItems(current => merge(current, result.generations))
      setCursor(result.nextCursor ?? null)
    }).catch(cause => { if (!controller.signal.aborted) setError(cause) })
      .finally(() => { if (request === requestRef.current) setLoading(false) })
    return () => controller.abort()
  }, [query, retry])

  useEffect(() => {
    if (loading) return
    let stopped = false, inFlight = false
    const controller = new AbortController()
    const poll = async () => {
      if (inFlight) return
      inFlight = true
      const requestedAt = Date.now()
      try {
        const activeItems = itemsRef.current.filter(isGenerationActive)
        const [first, updates] = await Promise.all([
          generationApi.list(query(), controller.signal),
          Promise.all(activeItems.map(async item => {
            try { return (await generationApi.get(item.id, controller.signal)).generation } catch { return null }
          })),
        ])
        if (!stopped) {
          const firstIds = new Set(first.generations.map(item => item.id))
          const boundary = first.generations[first.generations.length - 1]
          setItems(current => merge(current.filter(item => item.createdAt >= requestedAt || firstIds.has(item.id) || (boundary && order(item, boundary) > 0)),
            [...first.generations, ...updates.filter((item): item is Generation => item !== null)]))
        }
      } catch { /* Keep the last successful feed while reconnecting. */ }
      finally { inFlight = false }
    }
    const timer = window.setInterval(() => void poll(), active ? 2000 : 15000)
    return () => { stopped = true; controller.abort(); clearInterval(timer) }
  }, [query, active, loading])

  async function more() {
    if (!cursor || loadingMore) return
    const request = requestRef.current
    setLoadingMore(true); setError(null)
    try {
      const result = await generationApi.list({ ...query(), cursor })
      if (request !== requestRef.current) return
      setItems(current => merge(current, result.generations)); setCursor(result.nextCursor ?? null)
    } catch (cause) { if (request === requestRef.current) setError(cause) }
    finally { if (request === requestRef.current) setLoadingMore(false) }
  }
  async function openHistory() {
    setHistoryOpen(true); setHistory(null); setHistoryError(null)
    try { setHistory((await quickSessionApi.list()).sessions) } catch (cause) { setHistoryError(cause) }
  }
  async function remove(generation: Generation) {
    const acknowledgeUnknown = generation.status === 'unknown' && !generation.providerJobId
    if (acknowledgeUnknown && !window.confirm(shellT(generation.kind === 'video' ? 'confirmTrashUnknownVideo' : 'confirmTrashUnknownImage'))) return
    setDeleting(generation.id)
    try {
      await generationApi.remove(generation.id, { acknowledgeUnknown })
      setItems(current => current.filter(item => item.id !== generation.id))
    } catch (cause) { setError(cause) }
    finally { setDeleting(null) }
  }
  const created = (generation: Generation) => {
    if (filterRef.current === 'all' || generation.kind === filterRef.current) setItems(current => merge(current, [generation]))
    props.onCreated(generation)
  }
  useEffect(() => {
    if (props.sessionId) return
    const controller = new AbortController()
    generationApi.list(query(), controller.signal).then(result => {
      if (!controller.signal.aborted) setItems(current => merge(current, result.generations))
    }).catch(() => {})
    return () => controller.abort()
  }, [props.sessionId, query])
  return <>
    <div hidden={Boolean(props.sessionId)}>
      <div className="page-content studio-page quick-home" data-testid="quick-home">
        <header className="quick-home-header">
          <div><h1>{t('quickHomeTitle')}</h1><p>{t('quickHomeIntro')}</p></div>
          <div className="quick-home-header-actions">
            <div className="quick-home-filters" role="group" aria-label={t('recentResults')}>
              {(['all', 'image', 'video'] as const).map(value => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{t(value === 'all' ? 'quickFilterAll' : value === 'image' ? 'quickFilterImages' : 'quickFilterVideos')}</button>)}
            </div>
            <button type="button" className="secondary-button" onClick={() => void openHistory()}><Clock3 size={16} />{t('quickHistory')}</button>
            <button type="button" className="secondary-button" data-testid="quick-canvas-toggle" onClick={() => openCanvasRef.current?.()}><Workflow size={16} />{t('quickOpenCanvas')}<ArrowUpRight size={14} /></button>
          </div>
        </header>
        <section className="quick-home-feed" aria-label={t('recentResults')}>
          {error != null && <div role="alert" className="form-error">{errorMessage(error)} <button type="button" className="text-button" onClick={() => cursor && items.length ? void more() : setRetry(value => value + 1)}>{t('quickFeedRetry')}</button></div>}
          {loading && !items.length ? <div className="quick-home-empty" role="status"><LoaderCircle className="spin" />{t('loadingShort')}</div> : items.length ? <>
            <div className="quick-home-grid">{items.map(generation => <CreationCard key={generation.id} generation={generation}
              onOpen={() => { if (generation.quickSessionId) { props.onViewChange?.('form'); props.onOpenGeneration(generation.quickSessionId, generation.id) } }}
              onUpdated={updated => setItems(current => merge(current, [updated]))}
              onDelete={() => void remove(generation)} busy={deleting === generation.id} />)}</div>
            {cursor && <button type="button" className="secondary-button quick-results-more" disabled={loadingMore} onClick={() => void more()}>{loadingMore ? <LoaderCircle className="spin" size={16} /> : null}{t('quickFeedMore')}</button>}
          </> : !error && <div className="quick-home-empty"><Sparkles size={42} /><h2>{t('quickHomeEmptyTitle')}</h2><p>{t('quickHomeEmptyHint')}</p></div>}
        </section>
        <StudioPage {...props} mode={homeMode} onModeChange={setHomeMode} compact sessionId="" selectedGenerationId="" view="form" onSelectSession={undefined} onRegisterNavigationGuard={undefined}
          onCreated={created} onRegisterCanvasOpen={registerCanvas} onCanvasReady={id => { props.onViewChange?.('canvas'); props.onSelectSession?.(id) }} />
      </div>
    </div>
    {props.sessionId && <StudioPage {...props} key={props.sessionId} onCreated={created} onSelectSession={id => { if (!id) props.onViewChange?.('form'); props.onSelectSession?.(id) }} />}
    {historyOpen && <DialogFrame portal className="modal-card quick-home-history" aria-label={t('quickHistory')} onClose={() => setHistoryOpen(false)}>
      <header className="modal-header"><h2>{t('quickHistory')}</h2><button className="close-button" type="button" aria-label={shellT('close')} onClick={() => setHistoryOpen(false)}><X size={20} /></button></header>
      {historyError != null ? <div role="alert" className="form-error">{errorMessage(historyError)}<button type="button" onClick={() => void openHistory()}>{t('quickFeedRetry')}</button></div> : history === null ? <LoaderCircle className="spin" /> : history.length ? <ul>{history.map(session => <li key={session.id}><button type="button" onClick={() => { setHistoryOpen(false); props.onViewChange?.('form'); props.onSelectSession?.(session.id) }}>{session.title || t('sessionUntitled')} · {session.generationCount}</button></li>)}</ul> : <p>{t('sessionBrowserEmptyTitle')}</p>}
    </DialogFrame>}
  </>
}
