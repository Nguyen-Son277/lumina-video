import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, Download, Film, LoaderCircle, RefreshCw, X } from 'lucide-react'
import { canvasExportApi, type ProjectExport } from '../api/exports'
import type { CanvasGraph } from '../../shared/canvas'
import { canvasVideoChains, canvasVideoTitle } from '../../shared/canvasSequence'
import type { CanvasExportPreview } from '../../shared/canvasExport'
import { useTranslation } from '../i18n'
import { canvasCatalog } from '../i18n/catalogs/canvas'
import { errorMessage, storedErrorMessage } from '../api/client'
import { useModalLayer } from './ui/useModalLayer'
import '../styles/projectExport.css'

export function CanvasExportModal({ graph, revision, scope, selectedNodeId, onRefresh, onClose }: {
  graph: CanvasGraph
  revision: number
  scope: { projectId?: string; quickSessionId?: string }
  selectedNodeId: string | null
  onRefresh: () => Promise<number>
  onClose: () => void
}) {
  const { t } = useTranslation(canvasCatalog)
  const { projectId, quickSessionId } = scope
  const api = useMemo(() => canvasExportApi({ projectId, quickSessionId }), [projectId, quickSessionId])
  const chains = useMemo(() => {
    try { return canvasVideoChains(graph) }
    catch { return [] }
  }, [graph])
  const initial = chains.find(chain => chain.some(node => node.id === selectedNodeId))?.[0] ?? chains[0]?.[0]
  const [nodeId, setNodeId] = useState(initial?.id ?? '')
  // A synchronized canvas can remove or split the selected chain while this dialog is open.
  const selectedChain = chains.find(chain => chain.some(node => node.id === nodeId)) ?? chains[0]
  const headId = selectedChain?.[0]?.id ?? ''
  const [preview, setPreview] = useState<CanvasExportPreview | null>(null)
  const [items, setItems] = useState<ProjectExport[]>([])
  const [busy, setBusy] = useState<'preview' | 'create' | null>(null)
  const [error, setError] = useState<unknown>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const requestVersion = useRef(0)
  useModalLayer(dialog, onClose)

  const loadPreview = useCallback(async (id: string, baseRevision: number) => {
    const version = ++requestVersion.current
    setPreview(null)
    if (!id) { setBusy(null); return }
    setBusy('preview')
    setError(null)
    try {
      const result = await api.preview(id, baseRevision)
      if (version === requestVersion.current) setPreview(result.preview)
    } catch (cause) {
      if (version === requestVersion.current) setError(cause)
    } finally {
      if (version === requestVersion.current) setBusy(null)
    }
  }, [api])

  useEffect(() => {
    void loadPreview(headId, revision)
    return () => { requestVersion.current++ }
  }, [headId, revision, loadPreview])

  useEffect(() => {
    let alive = true
    void api.list().then(result => { if (alive) setItems(result.exports) }).catch(cause => { if (alive) setError(cause) })
    return () => { alive = false }
  }, [api])

  const hasActive = items.some(item => item.status === 'queued' || item.status === 'running')
  useEffect(() => {
    if (!hasActive) return
    let alive = true
    const timer = window.setInterval(() => {
      void api.list().then(result => { if (alive) setItems(result.exports) }).catch(() => undefined)
    }, 2000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [api, hasActive])

  async function refresh() {
    setBusy('preview')
    setPreview(null)
    setError(null)
    try { await loadPreview(headId, await onRefresh()) }
    catch (cause) { setError(cause); setBusy(null) }
  }

  async function create() {
    if (!preview?.ready || preview.revision !== revision || preview.nodeId !== headId) return
    setBusy('create')
    setError(null)
    try {
      const created = await api.create(preview.nodeId, preview.revision, preview.stamp)
      setItems(current => [created.export, ...current.filter(item => item.id !== created.export.id)])
    } catch (cause) {
      setError(cause)
      // A stale preview must be refreshed and reviewed before another submission.
      setPreview(null)
    } finally { setBusy(null) }
  }

  return <div className="modal-backdrop project-export-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div ref={dialog} tabIndex={-1} className="modal-card project-export-modal" role="dialog" aria-modal="true" aria-label={t('canvasExportTitle')}>
      <div className="modal-header">
        <h2>{t('canvasExportTitle')}</h2>
        <button type="button" className="close-button" onClick={onClose} aria-label={t('previewClose')}><X size={20} /></button>
      </div>
      <div className="project-export-body">
        <p className="project-export-next-step">{t('sequenceHint')}</p>
        {!chains.length ? <div className="empty-state"><Film size={25} /><p>{t('canvasExportNoVideos')}</p></div> : <>
          <label>{t('canvasExportChain')}
            <select className="canvas-select" aria-label={t('canvasExportChain')} value={headId} disabled={busy !== null} onChange={event => setNodeId(event.target.value)}>
              {chains.map(chain => <option key={chain[0]!.id} value={chain[0]!.id}>{canvasVideoTitle(graph, chain[0]!)} ({chain.length} {t('canvasExportClips')})</option>)}
            </select>
          </label>
          {busy === 'preview' && <p role="status"><LoaderCircle size={16} className="spin" /> {t('canvasExportLoading')}</p>}
          {preview && <div className="project-export-list">
            {preview.items.map((item, index) => <div className="project-export-item" key={item.nodeId}>
              <div className="project-export-item-head">
                <strong>{index + 1}. {item.label}</strong>
                {item.issue
                  ? <span className="project-badge project-export-status is-failed"><AlertTriangle size={12} /> {t(`canvasExportIssue_${item.issue}`)}</span>
                  : <span className="project-badge project-export-status is-succeeded"><Check size={12} /> {item.fallback ? t('canvasExportFallback') : t('canvasExportSelected')}</span>}
              </div>
              {item.generationId && <small className="project-export-version">{t('canvasExportVersion', { id: item.generationId.slice(0, 8) })}</small>}
            </div>)}
          </div>}
          <div className="project-export-toolbar">
            <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void refresh()}><RefreshCw size={14} /> {t('canvasExportRefresh')}</button>
            <button type="button" className="primary-small-button" disabled={!preview?.ready || preview.revision !== revision || preview.nodeId !== headId || busy !== null || hasActive} onClick={() => void create()}>
              {busy === 'create' ? <LoaderCircle size={15} className="spin" /> : <Film size={15} />} {t('canvasExportCreate')}
            </button>
          </div>
        </>}
        {error != null && <div className="form-error" role="alert">{errorMessage(error)}</div>}
        <h3 className="project-export-heading">{t('canvasExportRecent')}</h3>
        {items.map(item => <article className="project-export-item" key={item.id}>
          <div className="project-export-item-head">
            <span className={`project-badge project-export-status is-${item.status}`}>
              {item.status === 'succeeded' ? <Check size={12} /> : item.status === 'failed' ? <AlertTriangle size={12} /> : <LoaderCircle size={12} className="spin" />}
              {t(`canvasExportStatus_${item.status}`)}
            </span>
            <span className="project-export-meta">{item.itemCount} {t('canvasExportClips')}</span>
          </div>
          {item.status === 'failed' && <p className="form-error">{storedErrorMessage(item) || item.errorMessage}</p>}
          {item.downloadUrl && <a className="secondary-button project-export-download" href={item.downloadUrl} download><Download size={14} /> {t('canvasExportDownload')}</a>}
        </article>)}
      </div>
    </div>
  </div>
}
