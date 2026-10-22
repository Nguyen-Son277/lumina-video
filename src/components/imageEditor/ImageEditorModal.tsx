import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Undo2, Redo2 } from 'lucide-react'
import { IMAGE_EDITOR_LIMITS, type ImageEditorCapabilities, type ImageEditorModelCapability, type ImageEditorOperation, type ImageEditorPreparedSource, type ImageEditorPreview, type ImageEditorRegion, type ImageEditorRequest, type ImageEditorShape, type ImageEditorSource } from '../../../shared/imageEditor'
import { errorMessage, storedErrorMessage } from '../../api/client'
import { imageEditorApi } from '../../api/imageEditor'
import type { Generation } from '../../api/types'
import { useTranslation } from '../../i18n'
import { imageEditorCatalog } from '../../i18n/catalogs/imageEditor'
import { useModalLayer } from '../ui/useModalLayer'
import { SelectionCanvas, type SelectionTool } from './SelectionCanvas'
import { totalPoints, shapePoints, regionPixelBounds } from './geometry'
import { applyFit, centerFrame, frameContainsSource, frameForRatio, wireFrame, type FrameState } from './frame'
import { IMAGE_RATIOS, type ImageRatio } from '../../../shared/imageControls'
import '../../styles/image-editor.css'

type Document = { regions: ImageEditorRegion[]; operation: ImageEditorOperation; engine: 'local' | 'provider'; modelId: string; prompt: string; frame: FrameState; background: NonNullable<ImageEditorRequest['background']> }
const newRegion = (): ImageEditorRegion => ({ id: crypto.randomUUID(), comment: '', shapes: [] })
function initialDocument(source: ImageEditorPreparedSource): Document {
  return { regions: [newRegion()], operation: 'region', engine: 'provider', modelId: '', prompt: '', frame: { width: source.width, height: source.height, offsetX: 0, offsetY: 0, background: 'transparent', fit: true }, background: { mode: 'remove', color: '#ffffff' } }
}
/**
 * Terminal job states. `unknown` is terminal too: the server stopped reporting
 * progress, so the editor must stop polling and offer a way back to editing.
 */
const terminal = (job: Generation) => ['succeeded', 'failed', 'unknown'].includes(job.status)

/** A model can serve an operation only when it carries the source image. */
function modelUsable(model: ImageEditorModelCapability, doc: Document): boolean {
  if (doc.operation === 'region') return model.region || model.regionPromptOnly
  if (doc.operation === 'background') return model.background && (doc.background.mode !== 'remove' || model.backgroundRemoval)
  return model.reframe
}

/** Short reason shown next to a model that cannot serve the current operation. */
function modelLabelReason(model: ImageEditorModelCapability, doc: Document, translate: (key: 'modelUnavailable' | 'transparentRequired') => string): string {
  if (doc.operation === 'region') return model.region || model.regionPromptOnly ? '' : translate('modelUnavailable')
  if (doc.operation === 'background') {
    if (!model.background) return translate('modelUnavailable')
    if (doc.background.mode === 'remove' && !model.backgroundRemoval) return translate('transparentRequired')
    return ''
  }
  return model.reframe ? '' : translate('modelUnavailable')
}

/**
 * Engine that matches the operation: region edits always need a provider, while
 * reframe and background can run locally when the sidecar is ready.
 */
function defaultEngine(operation: ImageEditorOperation, current: 'local' | 'provider', capabilities: ImageEditorCapabilities | null): 'local' | 'provider' {
  if (operation === 'region') return 'provider'
  if (operation === 'background' && !capabilities?.local.backgroundRemoval) return 'provider'
  return current
}

function DirtyCloseConfirmation({ onKeep, onDiscard }: { onKeep: () => void; onDiscard: () => void }) {
  const { t } = useTranslation(imageEditorCatalog)
  const ref = useRef<HTMLDivElement>(null)
  useModalLayer(ref, onKeep)
  return <div className="ie-confirm"><div ref={ref} role="alertdialog" aria-modal="true" aria-label={t('dirtyTitle')} tabIndex={-1}><h3>{t('dirtyTitle')}</h3><p>{t('dirtyBody')}</p><div className="ie-row"><button type="button" data-modal-initial-focus onClick={onKeep}>{t('keepEditing')}</button><button type="button" className="ie-danger" onClick={onDiscard}>{t('discard')}</button></div></div></div>
}

export function ImageEditorModal({ source, onClose, onUseAsCharacter, zIndex }: { source: ImageEditorSource; onClose: () => void; onUseAsCharacter?: (source: ImageEditorSource) => void | Promise<void>; zIndex?: number }) {
  const { t } = useTranslation(imageEditorCatalog)
  const [prepared, setPrepared] = useState<ImageEditorPreparedSource | null>(null), [capabilities, setCapabilities] = useState<ImageEditorCapabilities | null>(null)
  const [history, setHistory] = useState<Document[]>([]), [index, setIndex] = useState(0), [selectedId, setSelectedId] = useState('')
  const [tool, setTool] = useState<SelectionTool>('rect'), [brushSize, setBrushSize] = useState(40), [overlay, setOverlay] = useState(true)
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [confirmClose, setConfirmClose] = useState(false)
  const [preview, setPreview] = useState<{ value: ImageEditorPreview; request: ImageEditorRequest } | null>(null), [job, setJob] = useState<Generation | null>(null)
  const [resultIndex, setResultIndex] = useState(0), [showBefore, setShowBefore] = useState(false)
  const [retry, setRetry] = useState(0)
  const panel = useRef<HTMLDivElement>(null), alive = useRef(true), previewAbort = useRef<AbortController | null>(null)
  // Guards against a double click submitting the same reviewed request twice.
  const submitting = useRef(false)
  const doc = history[index]
  // Any edit, prompt, comment or submitted job makes the editor dirty.
  const dirty = index > 0 || Boolean(job) || Boolean(doc && (doc.prompt.trim() || doc.regions.some(region => region.comment.trim() || region.shapes.length)))
  const close = useCallback(() => { if (dirty || busy) setConfirmClose(true); else onClose() }, [dirty, busy, onClose])
  const isTop = useModalLayer(panel, close)
  useEffect(() => { alive.current = true; return () => { alive.current = false; previewAbort.current?.abort() } }, [])
  const sourceKey = JSON.stringify(source)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    Promise.all([imageEditorApi.prepare(source, controller.signal), imageEditorApi.capabilities(controller.signal)]).then(([result, caps]) => {
      const document = initialDocument(result.source)
      setPrepared(result.source); setCapabilities(caps); setHistory([document]); setIndex(0); setSelectedId(document.regions[0].id)
    }).catch(cause => { if (!controller.signal.aborted) setError(errorMessage(cause)) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  // The serialized stable source identity avoids prepare requests on parent rerenders.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, retry])
  function commit(next: Document) {
    previewAbort.current?.abort(); setPreview(null); setError('')
    setHistory(current => [...current.slice(0, index + 1), next]); setIndex(index + 1)
  }
  function update(patch: Partial<Document>) { if (doc) commit({ ...doc, ...patch }) }
  const undo = useCallback(() => { setIndex(i => Math.max(0, i - 1)); setPreview(null) }, [])
  const redo = useCallback(() => { setIndex(i => Math.min(history.length - 1, i + 1)); setPreview(null) }, [history.length])
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (!isTop() || busy || job && !terminal(job) || (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]'))) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo() }
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo() }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [isTop, busy, job, undo, redo])
  useEffect(() => {
    if (!job || terminal(job)) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = () => {
      imageEditorApi.job(job.id, controller.signal).then(result => {
        if (controller.signal.aborted) return
        setJob(result.generation)
        if (!terminal(result.generation)) timer = setTimeout(poll, 1500)
      }).catch(cause => {
        if (controller.signal.aborted) return
        setError(errorMessage(cause)); timer = setTimeout(poll, 4000)
      })
    }
    timer = setTimeout(poll, 1000)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [job?.id, job?.status])
  const limits = capabilities?.limits ?? IMAGE_EDITOR_LIMITS
  const model = capabilities?.models.find(item => item.id === doc?.modelId)
  /**
   * A model without verified mask support can still edit regions, but only in
   * prompt-directed mode: the provider receives the whole image and the region
   * boundaries are advisory. The UI must say so before anything is submitted.
   */
  const promptDirected = Boolean(doc && model && doc.operation === 'region' && !model.region && model.regionPromptOnly)
  const modelReason = useMemo(() => {
    if (!doc || !model) return ''
    if (doc.operation === 'region') {
      if (!model.region && !model.regionPromptOnly) return t('modelUnavailable')
      if (model.regionPromptOnly && !model.region) return ''
      return ''
    }
    if (!model[doc.operation]) return t('modelUnavailable')
    if (doc.operation === 'background' && doc.background.mode === 'remove' && !model.backgroundRemoval) return t('transparentRequired')
    return ''
  }, [doc, model, t])
  const validModel = Boolean(model && doc && !modelReason)
  const selected = doc?.regions.find(region => region.id === selectedId) ?? doc?.regions[0]
  // Pixel readout of the selected region in the intrinsic source image.
  const selectedBounds = useMemo(() => selected && prepared ? regionPixelBounds(selected, prepared) : null, [selected, prepared])
  const validation = useMemo(() => {
    if (!doc || !prepared) return ''
    if (doc.engine === 'provider' && !validModel) return t('chooseModel')
    if (doc.engine === 'local' && doc.operation === 'region') return t('regionNeedsAI')
    if (doc.operation === 'background' && doc.engine === 'local' && !capabilities?.local.backgroundRemoval) return t('localUnavailable')
    if (doc.operation === 'region' && (!doc.regions.length || doc.regions.some(region => !region.comment.trim() || !region.shapes.some(shape => !shape.erase)))) return t('noRegions')
    if (doc.operation === 'region' && doc.regions.reduce((sum, region) => sum + region.comment.length, 0) > limits.maxTotalCommentLength) return t('limit')
    if (doc.operation === 'reframe' && (!Number.isInteger(doc.frame.width) || !Number.isInteger(doc.frame.height) || doc.frame.width < 1 || doc.frame.height < 1 || doc.frame.width > limits.maxDimension || doc.frame.height > limits.maxDimension || doc.frame.width * doc.frame.height > limits.maxPixels || !Number.isInteger(doc.frame.offsetX) || !Number.isInteger(doc.frame.offsetY) || doc.frame.offsetX < 0 || doc.frame.offsetY < 0 || (doc.frame.scale !== undefined && (!Number.isFinite(doc.frame.scale) || doc.frame.scale <= 0 || doc.frame.scale > 1)))) return t('invalidFrame', { max: limits.maxDimension, pixels: limits.maxPixels })
    if (doc.operation === 'reframe' && !frameContainsSource(doc.frame, prepared)) return t('frameTooSmall')
    return ''
  }, [doc, prepared, validModel, capabilities, limits, t])
  function request(): ImageEditorRequest {
    return { source: { kind: 'upload', id: prepared!.uploadId }, operation: doc.operation, engine: doc.engine, ...(doc.engine === 'provider' ? { modelId: doc.modelId } : {}), prompt: doc.prompt, ...(doc.operation === 'region' ? { regions: doc.regions } : doc.operation === 'reframe' ? { frame: wireFrame(doc.frame) } : { background: doc.background }) }
  }
  async function review() {
    if (validation) { setError(validation); return }
    const controller = new AbortController(); previewAbort.current?.abort(); previewAbort.current = controller
    const input = request(); setBusy(true); setError('')
    try { const value = await imageEditorApi.preview(input, controller.signal); if (!controller.signal.aborted) setPreview({ value, request: input }) }
    catch (cause) { if (!controller.signal.aborted) setError(errorMessage(cause)) }
    finally { if (alive.current) setBusy(false) }
  }
  async function submit() {
    if (!preview || submitting.current) return
    submitting.current = true
    setBusy(true); setError('')
    try {
      // Retain the key with this reviewed request for safe retries after a lost response.
      const input = preview.request
      input.idempotencyKey ??= crypto.randomUUID()
      const result = await imageEditorApi.submit(input)
      if (alive.current) { setJob(result.generation); setPreview(null); setResultIndex(0) }
    } catch (cause) { if (alive.current) setError(errorMessage(cause)) }
    finally { submitting.current = false; if (alive.current) setBusy(false) }
  }
  async function useResult(character: boolean) {
    const asset = job?.assets[resultIndex]
    if (!asset) return
    setBusy(true); setError('')
    try {
      const result = await imageEditorApi.prepare({ kind: 'asset', id: asset.id })
      if (!alive.current) return
      if (character) await onUseAsCharacter?.({ kind: 'upload', id: result.source.uploadId })
      else {
        const document = initialDocument(result.source)
        setPrepared(result.source); setHistory([document]); setIndex(0); setSelectedId(document.regions[0].id); setJob(null); setShowBefore(false)
      }
    } catch (cause) { if (alive.current) setError(errorMessage(cause)) }
    finally { if (alive.current) setBusy(false) }
  }
  function addShape(shape: ImageEditorShape) {
    if (!selected || !doc) return
    if (selected.shapes.length >= limits.maxShapesPerRegion || totalPoints(doc.regions) + shapePoints(shape) > limits.maxTotalPoints) { setError(t('limit')); return }
    update({ regions: doc.regions.map(region => region.id === selected.id ? { ...region, shapes: [...region.shapes, shape] } : region) })
  }
  const processing = Boolean(job && !terminal(job))
  const asset = job?.assets[resultIndex]
  const fitSource = doc?.operation === 'reframe' ? doc.frame.fit : false
  return createPortal(<div className="ie-backdrop" style={zIndex === undefined ? undefined : { zIndex }} onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
    <div className="ie-modal" ref={panel} role="dialog" aria-modal="true" aria-label={t('title')} tabIndex={-1}>
      <header className="ie-header"><div><h2>{t('title')}</h2>{prepared && <p>{t('normalized', { width: prepared.width, height: prepared.height })}</p>}</div><button type="button" className="ie-icon" aria-label={t('close')} onClick={close}><X size={20} /></button></header>
      {loading ? <div className="ie-empty" role="status">{t('loading')}</div> : !prepared || !doc ? <div className="ie-empty"><p role="alert">{error}</p><button type="button" onClick={() => setRetry(n => n + 1)}>{t('retry')}</button></div> : <>
        {error && <div className="ie-error" role="alert">{error}</div>}
        {job ? <div className="ie-results">
          <p role="status">{t(job.status)}{job.progress !== null && !terminal(job) ? ` · ${Math.round(job.progress)}%` : ''}</p>
          {job.status === 'failed' && <p className="ie-error" role="alert">{storedErrorMessage(job) || t('failed')}</p>}
          {job.status === 'unknown' && <p className="ie-error" role="alert">{storedErrorMessage(job) || t('unknownDescription')}</p>}
          {asset && <><div className="ie-result-switch"><button type="button" aria-pressed={showBefore} onClick={() => setShowBefore(true)}>{t('before')}</button><button type="button" aria-pressed={!showBefore} onClick={() => setShowBefore(false)}>{t('after')}</button></div><div className="ie-result-image"><img src={showBefore ? prepared.url : asset.url} alt={t(showBefore ? 'before' : 'after')} /></div>
          {job.assets.length > 1 && <div className="ie-result-switch">{job.assets.map((item, i) => <button type="button" key={item.id} aria-pressed={i === resultIndex} onClick={() => { setResultIndex(i); setShowBefore(false) }}>{i + 1}</button>)}</div>}
          <div className="ie-result-actions"><a href={asset.url} download>{t('download')}</a><button type="button" disabled={busy} onClick={() => void useResult(false)}>{t('next')}</button>{onUseAsCharacter && <button type="button" disabled={busy} onClick={() => void useResult(true)}>{t('character')}</button>}</div></>}
          {!processing && <button type="button" disabled={busy} onClick={() => { setJob(null); setError('') }}>{t('back')}</button>}
        </div> : preview ? <div className="ie-preview"><h3>{t('previewTitle')}</h3><p>{t('previewHelp')}</p><p>{t('pixels', { width: preview.value.width, height: preview.value.height })}</p>{preview.value.promptDirected && <p className="ie-warning">{t('promptDirectedPreview')}</p>}<pre>{preview.value.prompt}</pre>{preview.value.maskUrl && <img className="ie-mask-preview" src={preview.value.maskUrl} alt={t('overlay')} />}{preview.value.warnings.length > 0 && <ul>{preview.value.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}<footer><button type="button" disabled={busy} onClick={() => setPreview(null)}>{t('back')}</button><button type="button" className="ie-primary" disabled={busy} onClick={() => void submit()}>{busy ? t('busy') : t(preview.request.engine === 'provider' ? 'submit' : 'applyLocal')}</button></footer></div> : <>
          <div className="ie-body"><main className="ie-workspace"><div className="ie-tools"><div className="ie-tabs">{(['region', 'reframe', 'background'] as const).map(operation => <button type="button" key={operation} aria-pressed={doc.operation === operation} onClick={() => update({ operation, engine: defaultEngine(operation, doc.engine, capabilities) })}>{t(operation)}</button>)}</div><div className="ie-history"><button type="button" aria-label={t('undo')} disabled={!index} onClick={undo}><Undo2 size={17} /></button><button type="button" aria-label={t('redo')} disabled={index >= history.length - 1} onClick={redo}><Redo2 size={17} /></button></div></div>
          {doc.operation === 'region' && <div className="ie-tools ie-drawing-tools">{(['rect', 'lasso', 'brush', 'eraser', 'pan'] as const).map(value => <button type="button" key={value} aria-pressed={tool === value} onClick={() => setTool(value)}>{t(value)}</button>)}{(tool === 'brush' || tool === 'eraser') && <label>{t('brushSize')}<input aria-label={t('brushSize')} type="range" min="2" max={Math.max(2, Math.min(300, Math.min(prepared.width, prepared.height)))} value={brushSize} onChange={event => setBrushSize(Number(event.target.value))} /></label>}<label className="ie-check"><input type="checkbox" checked={overlay} onChange={event => setOverlay(event.target.checked)} />{t('overlay')}</label></div>}
          <SelectionCanvas source={prepared} regions={doc.regions} selectedId={selected?.id ?? ''} tool={doc.operation === 'region' ? tool : 'pan'} brushSize={brushSize} overlay={overlay && doc.operation === 'region'} onShape={addShape} frame={doc.operation === 'reframe' ? doc.frame : undefined} zoomLabel={{ in: t('zoomIn'), out: t('zoomOut'), fit: t('fit') }} />
          </main><aside className="ie-sidebar">
          {doc.operation === 'region' && <section><p className="ie-help">{t('regionHelp')}</p><div className="ie-regions">{doc.regions.map((region, i) => <button type="button" key={region.id} aria-pressed={selected?.id === region.id} onClick={() => setSelectedId(region.id)}>{t('regionName', { number: i + 1 })}</button>)}</div><div className="ie-row"><button type="button" disabled={doc.regions.length >= limits.maxRegions} onClick={() => { const region = newRegion(); update({ regions: [...doc.regions, region] }); setSelectedId(region.id) }}>{t('newRegion')}</button><button type="button" disabled={!selected} onClick={() => { const regions = doc.regions.filter(region => region.id !== selected?.id); update({ regions }); setSelectedId(regions[0]?.id ?? '') }}>{t('deleteRegion')}</button><button type="button" disabled={!doc.regions.some(region => region.shapes.length)} onClick={() => update({ regions: doc.regions.map(region => ({ ...region, shapes: [] })) })}>{t('clearAll')}</button></div>{selected && <><p className="ie-coordinates" data-testid="editor-region-coordinates">{selectedBounds ? t('coordinates', { x: selectedBounds.x, y: selectedBounds.y, width: selectedBounds.width, height: selectedBounds.height }) : t('coordinatesEmpty')}</p><label>{t('comment')}<textarea value={selected.comment} maxLength={limits.maxCommentLength} onChange={event => update({ regions: doc.regions.map(region => region.id === selected.id ? { ...region, comment: event.target.value } : region) })} /></label></>}</section>}
          {doc.operation === 'reframe' && <section><p className="ie-help">{t('frameHelp')}</p><label>{t('ratio')}<select value={doc.frame.ratio ?? ''} onChange={event => { const ratio = event.target.value as ImageRatio | ''; if (!ratio) return; const size = frameForRatio(ratio, prepared); update({ frame: centerFrame({ ...applyFit({ ...doc.frame, ...size }, prepared, true), ratio }, prepared) }) }}><option value="">{t('ratioCustom')}</option>{IMAGE_RATIOS.map(ratio => <option key={ratio} value={ratio}>{ratio}</option>)}</select></label><div className="ie-fields">{(['width', 'height', 'offsetX', 'offsetY'] as const).map(key => <label key={key}>{t(key)}<input type="number" step="1" min={key === 'width' || key === 'height' ? 1 : undefined} max={key === 'width' || key === 'height' ? limits.maxDimension : undefined} value={doc.frame[key]} onChange={event => { const next = { ...doc.frame, [key]: Number(event.target.value), ratio: undefined }; update({ frame: key === 'width' || key === 'height' ? applyFit(next, prepared, doc.frame.fit) : next }) }} /></label>)}</div><label className="ie-check"><input type="checkbox" checked={fitSource} onChange={event => update({ frame: applyFit(doc.frame, prepared, event.target.checked) })} />{t('fitSource')}</label>{!fitSource && <label>{t('scale')}<input type="number" step="0.05" min="0.05" max="1" value={doc.frame.scale ?? 1} onChange={event => update({ frame: centerFrame({ ...doc.frame, scale: Math.min(1, Math.max(0.05, Number(event.target.value))) }, prepared) })} /></label>}<button type="button" onClick={() => update({ frame: centerFrame(doc.frame, prepared) })}>{t('center')}</button><label className="ie-check"><input type="checkbox" checked={doc.frame.background === 'transparent'} onChange={event => update({ frame: { ...doc.frame, background: event.target.checked ? 'transparent' : '#ffffff' } })} />{t('transparent')}</label>{doc.frame.background !== 'transparent' && <label>{t('fillColor')}<input type="color" value={doc.frame.background} onChange={event => update({ frame: { ...doc.frame, background: event.target.value } })} /></label>}</section>}
          {doc.operation === 'background' && <section><label>{t('background')}<select value={doc.background.mode} onChange={event => update({ background: { ...doc.background, mode: event.target.value as 'remove' | 'replace' } })}><option value="remove">{t('remove')}</option><option value="replace">{t('replace')}</option></select></label>{doc.background.mode === 'replace' && <label>{t('fillColor')}<input type="color" value={doc.background.color ?? '#ffffff'} onChange={event => update({ background: { ...doc.background, color: event.target.value } })} /></label>}</section>}
          <section><label>{t('engine')}<select value={doc.engine} onChange={event => update({ engine: event.target.value as 'local' | 'provider', modelId: '' })}><option value="local" disabled={doc.operation === 'region' || doc.operation === 'background' && !capabilities?.local.backgroundRemoval}>{t('local')}</option><option value="provider">{t('provider')}</option></select></label>{doc.operation === 'region' && <p className="ie-help">{t('regionNeedsAI')}</p>}{doc.operation === 'background' && !capabilities?.local.backgroundRemoval && <p className="ie-warning">{t('localUnavailable')}</p>}
          {doc.engine === 'provider' && <><label>{t('model')}<select value={doc.modelId} onChange={event => update({ modelId: event.target.value })}><option value="">{t('chooseModel')}</option>{capabilities?.models.map(item => <option key={item.id} value={item.id} disabled={!modelUsable(item, doc)}>{item.label}{modelLabelReason(item, doc, t) ? ` — ${modelLabelReason(item, doc, t)}` : ''}</option>)}</select></label>{modelReason && <p className="ie-warning">{modelReason}</p>}{promptDirected && <p className="ie-warning">{t('promptDirected')}</p>}{model?.maskSupport === 'unknown' && !promptDirected && <p className="ie-help">{t('unknownMask')}</p>}{promptDirected && <p className="ie-help">{t('promptDirectedHelp')}</p>}</>}
          <label>{t('prompt')}<textarea maxLength={limits.maxPromptLength} value={doc.prompt} onChange={event => update({ prompt: event.target.value })} /></label></section>
          {validation && <p className="ie-help" role="status">{validation}</p>}<button type="button" className="ie-primary" disabled={busy || Boolean(validation)} onClick={() => void review()}>{busy ? t('reviewing') : t('preview')}</button>
          {onUseAsCharacter && <button type="button" disabled={busy} onClick={() => { setBusy(true); Promise.resolve(onUseAsCharacter({ kind: 'upload', id: prepared.uploadId })).catch(cause => setError(errorMessage(cause))).finally(() => { if (alive.current) setBusy(false) }) }}>{t('character')}</button>}
          </aside></div>
        </>}
      </>}
      {confirmClose && <DirtyCloseConfirmation onKeep={() => setConfirmClose(false)} onDiscard={onClose} />}
    </div>
  </div>, document.body)
}
