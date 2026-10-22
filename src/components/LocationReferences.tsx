import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ImagePlus, LoaderCircle, MessageSquare, Pencil, Plus, Sparkles, Trash2, Upload, X } from 'lucide-react'
import { errorMessage, storedErrorMessage } from '../api/client'
import { generationApi } from '../api/endpoints'
import { LOCATION_VIEW_LABELS, type LocationReference, type LocationView } from '../api/locations'
import type { Generation, ModelInfo } from '../api/types'
import type { ImageEditorSource } from '../../shared/imageEditor'
import { useTranslation } from '../i18n'
import { notification, type Notification } from '../i18n/messages'
import { locationsCatalog } from '../i18n/catalogs/locations'
import { ImageLightbox } from './Lightbox'
import '../locations.css'

export type { LocationReference, LocationView }
export type LocationDraft = Omit<LocationReference, 'id' | 'revision' | 'reference' | 'referenceViews'>
/** Adapter supplied by the owner: no endpoint/envelope guesses in the reusable UI. */
export interface LocationReferencesApi {
  save(locations: LocationReference[]): Promise<LocationReference[]>
  propose?(): Promise<LocationReference[]>
  generate?(locationId: string, modelId: string, options?: { requestKey: string; confirmNew?: boolean; viewLabel?: string }): Promise<Generation>
  /** Latest durable generation task; GET-only and safe to call on load/poll. */
  getTask?(locationId: string): Promise<{ generation: Generation | null; task?: { status?: string; error?: string | null; trashedAt?: number | null } | null }>
  listGenerations?(): Promise<Generation[]>
  upload?(locationId: string, file: File): Promise<LocationReference[]>
  attach?(locationId: string, generationId: string, revision?: number, view?: { label?: string; sheet?: boolean }): Promise<LocationReference[]>
  getGeneration?(generationId: string): Promise<Generation>
}
export interface LocationReferencesProps {
  sessionId?: string
  projectId?: string
  locations: LocationReference[]
  imageModels: ModelInfo[]
  selectedModelId?: string | null
  api: LocationReferencesApi
  onChanged: (locations: LocationReference[]) => void
  onNotify?: (message: Notification) => void
  assignedCounts?: Record<string, number>
  referenceUrl?: (uploadId: string) => string
  readOnly?: boolean
  /** Mở cửa sổ chat AI cho bối cảnh & tính liên tục (do trang sở hữu khai báo). */
  onChatClick?: () => void
}
type UiError = { key: 'unknown' | 'timeout' | 'failed' | 'unavailable' } | { cause: unknown } | { generation: Generation }
const blank = (): LocationDraft => ({ name: '', stage: '', description: '', continuityNotes: '', imagePrompt: '' })
/** Service/AI responses may omit id, revision or reference; never render undefined ones. */
export function normalizeLocation(value: Partial<LocationReference> & { id?: string }): LocationReference {
  return {
    id: typeof value.id === 'string' && value.id ? value.id : crypto.randomUUID(),
    name: typeof value.name === 'string' ? value.name : '',
    stage: typeof value.stage === 'string' ? value.stage : '',
    description: typeof value.description === 'string' ? value.description : '',
    continuityNotes: typeof value.continuityNotes === 'string' ? value.continuityNotes : '',
    imagePrompt: typeof value.imagePrompt === 'string' ? value.imagePrompt : '',
    reference: value.reference && typeof value.reference.uploadId === 'string' ? { uploadId: value.reference.uploadId } : null,
    referenceViews: Array.isArray(value.referenceViews)
      ? value.referenceViews.flatMap(view => (view && typeof view.uploadId === 'string'
          ? [{ id: typeof view.id === 'string' && view.id ? view.id : view.uploadId, label: typeof view.label === 'string' ? view.label : '', uploadId: view.uploadId, sheet: view.sheet === true }]
          : []))
      : [],
    revision: typeof value.revision === 'number' && Number.isFinite(value.revision) ? value.revision : 0,
  }
}

/** Legacy payloads carry only `reference`; expose it as a single non-sheet view. */
function withLegacyView(location: LocationReference): LocationReference {
  if (location.referenceViews.length || !location.reference) return location
  return { ...location, referenceViews: [{ id: location.reference.uploadId, label: '', uploadId: location.reference.uploadId, sheet: false }] }
}
const normalizeList = (values: unknown): LocationReference[] =>
  Array.isArray(values) ? values.map(value => withLegacyView(normalizeLocation(value as Partial<LocationReference>))) : []
const VIEW_LABEL_KEYS: Record<string, 'viewWide' | 'viewLeft' | 'viewRight' | 'viewBehind' | 'viewDetail'> = { wide: 'viewWide', left: 'viewLeft', right: 'viewRight', behind: 'viewBehind', detail: 'viewDetail' }
/** Nhãn góc lưu ở dạng chuẩn (không phụ thuộc ngôn ngữ); dịch khi hiển thị. */
const viewLabelKey = (label: string): 'viewWide' | 'viewLeft' | 'viewRight' | 'viewBehind' | 'viewDetail' | null =>
  VIEW_LABEL_KEYS[label.trim().toLowerCase()] ?? null
const POLL_MS = 1500
const MAX_POLL_MS = 6 * 60_000

/** Reusable session/project location-reference editor. UI locale never modifies content. */
export function LocationReferences({
  sessionId, projectId, locations, imageModels, selectedModelId, api, onChanged, onNotify,
  assignedCounts = {}, referenceUrl = id => `/api/uploads/${encodeURIComponent(id)}`, readOnly = false,
  onChatClick,
}: LocationReferencesProps) {
  const { t } = useTranslation(locationsCatalog)
  const [editor, setEditor] = useState<{ id: string | null; draft: LocationDraft } | null>(null)
  const [removeId, setRemoveId] = useState<string | null>(null)
  const [attachId, setAttachId] = useState<string | null>(null)
  const [selectedResultId, setSelectedResultId] = useState('')
  const [results, setResults] = useState<Generation[]>([])
  const [tasks, setTasks] = useState<Record<string, { generation: Generation | null; task?: { status?: string; error?: string | null; trashedAt?: number | null } | null; timedOut?: boolean }>>({})
  const requestKeys = useRef<Record<string, string>>({})
  const [modelId, setModelId] = useState(selectedModelId ?? '')
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<UiError | null>(null)
  const [preview, setPreview] = useState<LocationReference | null>(null)
  /** Bối cảnh đang mở bảng chọn góc để tạo thêm ảnh góc riêng. */
  const [viewPicker, setViewPicker] = useState<string | null>(null)
  const [viewLabel, setViewLabel] = useState<string>(LOCATION_VIEW_LABELS[0])
  /** Ảnh góc đang xem lớn: giữ url + tên bối cảnh. */
  const [viewZoom, setViewZoom] = useState<{ url: string; name: string; editableSource?: ImageEditorSource } | null>(null)
  const alive = useRef(true)
  const busyRef = useRef(busy)
  busyRef.current = busy
  const latest = useRef({ api, onChanged, onNotify, locations })
  latest.current = { api, onChanged, onNotify, locations }
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { if (selectedModelId) setModelId(selectedModelId) }, [selectedModelId])
  // Reconcile durable tasks after load. This loop performs GETs only; creating a task is always explicit.
  useEffect(() => {
    if (!api.getTask || !locations.length) return
    let stopped = false
    const poll = async () => {
      const ids = locations.map(location => location.id)
      await Promise.all(ids.map(async id => {
        try {
          const info = await latest.current.api.getTask!(id)
          if (!stopped) setTasks(previous => ({ ...previous, [id]: { ...info, timedOut: previous[id]?.timedOut } }))
        } catch (cause) {
          if (!stopped) setTasks(previous => ({ ...previous, [id]: { generation: previous[id]?.generation ?? null, task: { status: 'error', error: cause instanceof Error ? cause.message : String(cause) }, timedOut: previous[id]?.timedOut } }))
        }
      }))
      const startedAt = Date.now()
      while (!stopped) {
        await new Promise(resolve => window.setTimeout(resolve, POLL_MS))
        const activeIds = ids.filter(id => ['queued', 'running', 'downloading'].includes(tasksRef.current[id]?.generation?.status ?? tasksRef.current[id]?.task?.status ?? ''))
        if (!activeIds.length) break
        if (Date.now() - startedAt >= MAX_POLL_MS) {
          if (!stopped) setTasks(previous => Object.fromEntries(Object.entries(previous).map(([id, value]) => [id, activeIds.includes(id) ? { ...value, timedOut: true } : value])))
          break
        }
        await Promise.all(activeIds.map(async id => {
          try {
            const info = await latest.current.api.getTask!(id)
            if (!stopped) setTasks(previous => ({ ...previous, [id]: { ...info, timedOut: previous[id]?.timedOut } }))
          } catch (cause) {
            if (!stopped) setTasks(previous => ({ ...previous, [id]: { generation: previous[id]?.generation ?? null, task: { status: 'error', error: cause instanceof Error ? cause.message : String(cause) }, timedOut: previous[id]?.timedOut } }))
          }
        }))
      }
    }
    void poll()
    return () => { stopped = true }
  // Re-run after parent location list changes; task polling reads the latest API through ref.
  }, [locations.map(location => location.id).join('|'), Boolean(api.getTask)])
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const values = api.listGenerations ? await latest.current.api.listGenerations!() : (await generationApi.list({ kind: 'image', ...(sessionId ? { quickSessionId: sessionId } : {}), ...(projectId ? { projectId } : {}), limit: 100 })).generations
        if (!cancelled) setResults(values.filter(item => item.kind === 'image' && item.status === 'succeeded' && item.assets?.length))
      } catch { if (!cancelled) setResults([]) }
    }
    void load()
    return () => { cancelled = true }
  }, [sessionId, projectId, Boolean(api.listGenerations)])
  useEffect(() => {
    if (!editor && !removeId && !attachId) return
    const previous = document.activeElement as HTMLElement | null
    const dialog = document.querySelector<HTMLElement>('.locations-dialog')
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? [])
    focusable()[0]?.focus()
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) { setEditor(null); setRemoveId(null); setAttachId(null) }
      if (event.key !== 'Tab') return
      const items = focusable(); const first = items[0]; const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', handleKey)
    return () => { document.removeEventListener('keydown', handleKey); previous?.focus() }
  }, [Boolean(editor), removeId, attachId])
  const models = imageModels.filter(model => model.kind === 'image' && model.enabled)
  const errorText = error ? 'key' in error ? t(error.key) : 'cause' in error ? errorMessage(error.cause) : storedErrorMessage(error.generation) || t('failed') : ''
  const rawError = error && 'generation' in error ? error.generation.errorMessage ?? undefined : error && 'cause' in error && error.cause instanceof Error ? error.cause.message : undefined
  const unavailable = () => setError({ key: 'unavailable' })

  async function run(tag: string, action: () => Promise<void>) {
    if (busyRef.current || readOnly) return
    busyRef.current = tag
    setBusy(tag); setError(null)
    try { await action() } catch (cause) { if (alive.current) setError({ cause }) }
    finally { busyRef.current = null; if (alive.current) { setBusy(null); setProgress(null) } }
  }
  /** AI proposals are additive and persisted before exposing them to reference generation. */
  async function applyProposal(result: unknown): Promise<boolean> {
    if (!alive.current) return false
    if (!Array.isArray(result)) { setError({ key: 'unavailable' }); return false }
    const keyOf = (item: LocationReference) => `${item.name.trim().toLowerCase()}|${item.stage.trim().toLowerCase()}`
    const seen = new Set(latest.current.locations.map(keyOf))
    const additions: LocationReference[] = []
    for (const item of normalizeList(result)) {
      const key = keyOf(item)
      if (!item.name.trim() || seen.has(key)) continue
      seen.add(key)
      additions.push(item)
    }
    if (!additions.length) {
      latest.current.onNotify?.(notification('locations', 'proposed'))
      return true
    }
    // The generation route resolves locations from persisted session data, so save
    // the AI suggestions before rendering buttons that can create reference images.
    const saved = await latest.current.api.save([...latest.current.locations, ...additions])
    if (!alive.current) return false
    return applyResult(saved, 'proposed')
  }

  /** Apply a service result only when it is a real array; never wipe the list on a bad envelope. */
  function applyResult(result: unknown, key: 'saved' | 'deleted' | 'referenceSaved' | 'proposed'): boolean {
    if (!alive.current) return false
    if (!Array.isArray(result)) { setError({ key: 'unavailable' }); return false }
    const normalized = normalizeList(result)
    latest.current.onChanged(normalized)
    latest.current.onNotify?.(notification('locations', key))
    return true
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!editor || !editor.draft.name.trim()) return
    const current = editor
    await run('save', async () => {
      const existing = latest.current.locations.find(location => location.id === current.id)
      const value: LocationReference = {
        ...current.draft, name: current.draft.name.trim(), id: current.id ?? crypto.randomUUID(),
        revision: existing?.revision ?? 0, reference: existing?.reference ?? null,
        referenceViews: existing?.referenceViews ?? [],
      }
      const next = existing ? latest.current.locations.map(location => location.id === value.id ? value : location) : [...latest.current.locations, value]
      const saved = await latest.current.api.save(next)
      if (applyResult(saved, 'saved')) setEditor(null)
    })
  }
  async function generate(location: LocationReference, confirmNew = false) {
    if (!api.generate || !api.attach) return unavailable()
    if (!modelId) return
    await run(`generate:${location.id}`, async () => {
      const requestKey = confirmNew ? crypto.randomUUID() : (requestKeys.current[location.id] ?? (requestKeys.current[location.id] = crypto.randomUUID()))
      if (confirmNew) requestKeys.current[location.id] = requestKey
      let generation = await latest.current.api.generate!(location.id, modelId, { requestKey, ...(confirmNew ? { confirmNew: true } : {}) })
      setTasks(previous => ({ ...previous, [location.id]: { generation } }))
      const started = Date.now()
      while (alive.current && ['queued', 'running', 'downloading'].includes(generation.status)) {
        setProgress(generation.progress ?? 0)
        if (Date.now() - started > MAX_POLL_MS) {
          setTasks(previous => ({ ...previous, [location.id]: { generation: previous[location.id]?.generation ?? generation, timedOut: true } }))
          setError({ key: 'timeout' }); return
        }
        await new Promise(resolve => window.setTimeout(resolve, POLL_MS))
        if (!alive.current) return
        const info = latest.current.api.getTask ? await latest.current.api.getTask(location.id) : null
        generation = info?.generation ?? (latest.current.api.getGeneration ? await latest.current.api.getGeneration(generation.id) : (await generationApi.get(generation.id)).generation)
        setTasks(previous => ({ ...previous, [location.id]: { generation, task: info?.task } }))
      }
      if (!alive.current) return
      if (generation.status === 'unknown') { setTasks(previous => ({ ...previous, [location.id]: { generation } })); setError({ key: 'unknown' }); return }
      if (generation.status !== 'succeeded') { delete requestKeys.current[location.id]; setTasks(previous => ({ ...previous, [location.id]: { generation } })); setError({ generation }); return }
      // Server checks the captured revision too; never silently approve edits made during generation.
      const savedLocation = latest.current.locations.find(item => item.id === location.id)
      if (savedLocation) applyResult(await latest.current.api.attach!(location.id, generation.id, location.revision), 'referenceSaved')
      delete requestKeys.current[location.id]
      setTasks(previous => ({ ...previous, [location.id]: { generation } }))
    })
  }
  /** Tạo một ảnh cho đúng một góc và thêm nó vào bộ ảnh của bối cảnh. */
  async function generateView(location: LocationReference, label: string) {
    if (!modelId) return
    setViewPicker(null)
    await run(`view:${location.id}`, async () => {
      const requestKey = crypto.randomUUID()
      let generation = await latest.current.api.generate!(location.id, modelId, { requestKey, viewLabel: label })
      setTasks(previous => ({ ...previous, [location.id]: { generation } }))
      const started = Date.now()
      while (alive.current && ['queued', 'running', 'downloading'].includes(generation.status)) {
        setProgress(generation.progress ?? 0)
        if (Date.now() - started > MAX_POLL_MS) { setError({ key: 'timeout' }); return }
        await new Promise(resolve => window.setTimeout(resolve, POLL_MS))
        if (!alive.current) return
        const info = latest.current.api.getTask ? await latest.current.api.getTask(location.id) : null
        generation = info?.generation ?? (await generationApi.get(generation.id)).generation
        setTasks(previous => ({ ...previous, [location.id]: { generation, task: info?.task } }))
      }
      if (!alive.current) return
      if (generation.status !== 'succeeded') { setTasks(previous => ({ ...previous, [location.id]: { generation } })); setError({ generation }); return }
      // Ghi ảnh góc vào bộ tham chiếu; cùng nhãn thì thay thế góc đó.
      applyResult(await latest.current.api.attach!(location.id, generation.id, location.revision, { label, sheet: false }), 'referenceSaved')
      setTasks(previous => ({ ...previous, [location.id]: { generation } }))
    })
  }

  /** Tải ảnh lên cho một góc cụ thể của bối cảnh. */
  async function uploadView(location: LocationReference, label: string, file: File) {
    if (!api.upload) return
    await run(`upload:${location.id}`, async () => {
      const saved = await latest.current.api.upload!(location.id, file)
      const uploaded = normalizeList(saved).find(item => item.id === location.id)
      const uploadedViews = uploaded?.referenceViews ?? []
      const uploadId = uploadedViews.length ? uploadedViews[uploadedViews.length - 1]!.uploadId : undefined
      if (!uploadId) { applyResult(saved, 'referenceSaved'); return }
      applyResult(await latest.current.api.save(normalizeList(saved).map(item => item.id === location.id
        ? { ...item, referenceViews: [...item.referenceViews.filter(view => view.label.toLowerCase() !== label.toLowerCase()), { id: crypto.randomUUID(), label, uploadId, sheet: false }] }
        : item)), 'referenceSaved')
    })
  }

  /** Bỏ một ảnh góc; các góc còn lại được giữ nguyên. */
  async function removeView(location: LocationReference, viewId: string) {
    await run(`view-remove:${location.id}`, async () => {
      const next = latest.current.locations.map(item => item.id === location.id
        ? { ...item, referenceViews: item.referenceViews.filter(view => view.id !== viewId) }
        : item)
      applyResult(await latest.current.api.save(next), 'referenceSaved')
    })
  }

  async function checkTask(location: LocationReference) {
    if (!api.getTask) return
    await run(`check:${location.id}`, async () => {
      const info = await latest.current.api.getTask!(location.id)
      setTasks(previous => ({ ...previous, [location.id]: info }))
      if (info.generation?.status === 'succeeded' && latest.current.api.attach) {
        applyResult(await latest.current.api.attach(location.id, info.generation.id), 'referenceSaved')
      }
    })
  }

  async function attachSelected(locationId: string, selectedId: string) {
    const generation = results.find(item => item.id === selectedId)
    if (!generation || generation.status !== 'succeeded' || !generation.assets?.length || !latest.current.api.attach) return
    const current = latest.current.locations.find(item => item.id === locationId)
    if (!current) return
    await run(`attach:${locationId}`, async () => {
      if (applyResult(await latest.current.api.attach!(locationId, generation.id, current.revision), 'referenceSaved')) setAttachId(null)
    })
  }
  const deleted = locations.find(location => location.id === removeId)
  const disabled = Boolean(busy) || readOnly
  return (
    <section className="location-references" data-testid="location-references" data-source={sessionId ? 'session' : projectId ? 'project' : 'custom'}>
      <header className="locations-header">
        <div><h3>{t('title')}</h3><p>{t('intro')}</p></div>
        <div className="locations-actions">
          {onChatClick && <button type="button" className="secondary-button" title={t('chatHint')} onClick={onChatClick}><MessageSquare size={15} />{t('chat')}</button>}
          {sessionId && api.propose && <button type="button" className="secondary-button" disabled={disabled} onClick={() => void run('propose', async () => { await applyProposal(await latest.current.api.propose!()) })}><Sparkles size={15} />{busy === 'propose' ? t('proposing') : t('propose')}</button>}
          <button type="button" className="primary-small-button" disabled={disabled} onClick={() => { setError(null); setEditor({ id: null, draft: blank() }) }}><Plus size={15} />{t('add')}</button>
        </div>
      </header>
      <label className="locations-model"><span>{t('model')}</span><select value={modelId} disabled={disabled} onChange={event => setModelId(event.target.value)}><option value="">{t('noModel')}</option>{models.map(model => <option value={model.id} key={model.id}>{model.displayName || model.modelId}</option>)}</select></label>
      {errorText && <div className="form-error" role="alert" title={rawError}>{errorText}</div>}
      {progress !== null && <p role="status"><LoaderCircle className="spin" size={15} />{t('generating', { progress })}</p>}
      {!locations.length && <div className="locations-empty"><h4>{t('empty')}</h4><p>{t('emptyHint')}</p></div>}
      <div className="locations-grid">
        {locations.map(location => (
          <article className="location-card" key={location.id} data-location-id={location.id}>
            {location.referenceViews.length ? (
              <div className="location-views" aria-label={t('viewsTitle', { count: location.referenceViews.length })}>
                {location.referenceViews.map(view => (
                  <figure className="location-view" key={view.id} data-view-id={view.id}>
                    <button type="button" className="location-view-image" aria-label={t('viewPreview', { name: location.name })} onClick={() => setViewZoom({ url: referenceUrl(view.uploadId), name: location.name, editableSource: readOnly ? undefined : { kind: 'upload', id: view.uploadId } })}>
                      <img src={referenceUrl(view.uploadId)} alt={view.label || location.name} loading="lazy" />
                      {view.sheet && <span className="location-view-badge">{t('sheetLabel')}</span>}
                    </button>
                    <figcaption>{(() => { const key = viewLabelKey(view.label); return key ? t(key) : view.label || (view.sheet ? t('sheetLabel') : t('viewAngle')) })()}</figcaption>
                    <button type="button" className="location-view-remove" disabled={disabled} aria-label={`${t('viewRemove')}: ${(() => { const key = viewLabelKey(view.label); return key ? t(key) : view.label || t('viewAngle') })()}`} title={t('viewRemove')} onClick={() => void removeView(location, view.id)}><X size={12} /></button>
                  </figure>
                ))}
              </div>
            ) : <div className="location-image location-image-empty"><ImagePlus size={30} /><span>{t('noReference')}</span></div>}
            <div className="location-card-copy"><h4>{location.name}</h4><p className={`location-task-status ${(tasks[location.id]?.generation?.status === 'failed' || tasks[location.id]?.generation?.status === 'unknown' || tasks[location.id]?.task?.status === 'failed' || tasks[location.id]?.task?.status === 'unknown' || tasks[location.id]?.task?.status === 'error') ? 'is-error' : ''}`} role="status">{tasks[location.id]?.task?.trashedAt ? t('taskTrashed') : ['queued','running','downloading'].includes(tasks[location.id]?.generation?.status ?? tasks[location.id]?.task?.status ?? '') ? t('taskRunning') : tasks[location.id]?.generation?.status === 'succeeded' ? t('taskSucceeded') : tasks[location.id]?.generation?.status === 'failed' || tasks[location.id]?.task?.status === 'failed' ? t('taskFailed') : tasks[location.id]?.generation?.status === 'unknown' || tasks[location.id]?.task?.status === 'unknown' || tasks[location.id]?.timedOut ? t('taskUnknown') : tasks[location.id]?.task?.status === 'error' ? t('taskError') : t(location.reference ? 'referenceReady' : 'referenceMissing')}</p>{tasks[location.id]?.timedOut && <p>{t('taskTimeoutHint')}</p>}{(tasks[location.id]?.generation?.status === 'unknown' || tasks[location.id]?.task?.status === 'unknown') && api.generate && <div className="location-task-warning"><p>{t('unknownConfirm')}</p><button type="button" className="secondary-button" disabled={disabled || !modelId} onClick={() => void generate(location, true)}>{t('confirmNewGeneration')}</button></div>}{(tasks[location.id]?.task?.error || tasks[location.id]?.generation?.errorMessage) && <details className="location-diagnostic"><summary>{t('diagnostic')} · {location.name} · {tasks[location.id]?.generation?.status ?? tasks[location.id]?.task?.status ?? 'unknown'}</summary><pre>{String(tasks[location.id]?.task?.error ?? tasks[location.id]?.generation?.errorMessage).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1200)}</pre></details>}
              <div className="locations-actions">
                <button type="button" className="secondary-button" disabled={disabled} aria-label={t('edit')} onClick={() => { setError(null); setEditor({ id: location.id, draft: { name: location.name, stage: location.stage, description: location.description, continuityNotes: location.continuityNotes, imagePrompt: location.imagePrompt } }) }}><Pencil size={14} />{t('edit')}</button>
                <button type="button" className="secondary-button" disabled={disabled} onClick={() => setRemoveId(location.id)}><Trash2 size={14} />{t('remove')}</button>
                {api.getTask && tasks[location.id]?.generation && <button type="button" className="secondary-button" disabled={disabled} onClick={() => void checkTask(location)}>{t('checkTask')}</button>}
                {api.generate && <button type="button" className="primary-small-button" disabled={disabled || !modelId || ['queued','running','downloading','unknown'].includes(tasks[location.id]?.generation?.status ?? tasks[location.id]?.task?.status ?? '')} onClick={() => void generate(location)}><Sparkles size={14} />{busy === `generate:${location.id}` ? t('working') : t(location.reference ? 'regenerate' : 'generate')}</button>}
                {api.upload && <label className={`secondary-button locations-upload ${disabled ? 'is-disabled' : ''}`}><Upload size={14} />{t('upload')}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled} aria-label={t('upload')} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void run(`upload:${location.id}`, async () => { applyResult(await latest.current.api.upload!(location.id, file), 'referenceSaved') }) }} /></label>}
                {api.attach && <button type="button" className="secondary-button" disabled={disabled || !results.length} onClick={() => { setSelectedResultId(''); setAttachId(location.id); setError(null) }}>{t('attach')}</button>}
                {api.generate && api.upload && <button type="button" className="secondary-button" disabled={disabled || !modelId} onClick={() => { setViewLabel(LOCATION_VIEW_LABELS[0]); setViewPicker(location.id); setError(null) }}>{t('addView')}</button>}
              </div>
            </div>
          </article>
        ))}
      </div>
      {editor && <div className="locations-overlay"><div className="locations-dialog" role="dialog" aria-modal="true" aria-label={t(editor.id ? 'edit' : 'add')}><header><h3>{t(editor.id ? 'edit' : 'add')}</h3><button type="button" className="close-button" onClick={() => setEditor(null)} disabled={Boolean(busy)} aria-label={t('close')}><X size={20} aria-hidden="true" /></button></header><form onSubmit={save}>
        {(['name', 'description', 'continuityNotes'] as const).map(field => <label key={field}><span>{t(field === 'continuityNotes' ? 'continuity' : field)}</span>{field === 'name' ? <input required maxLength={200} value={editor.draft[field]} onChange={event => setEditor({ ...editor, draft: { ...editor.draft, [field]: event.target.value } })} /> : <textarea rows={3} maxLength={4000} value={editor.draft[field]} onChange={event => setEditor({ ...editor, draft: { ...editor.draft, [field]: event.target.value } })} />}</label>)}<details className="location-advanced"><summary>{t('advanced')}</summary><label><span>{t('stage')}</span><input maxLength={200} value={editor.draft.stage} placeholder={t('stageHint')} onChange={event => setEditor({ ...editor, draft: { ...editor.draft, stage: event.target.value } })} /></label><label><span>{t('prompt')}</span><textarea rows={3} maxLength={4000} value={editor.draft.imagePrompt} onChange={event => setEditor({ ...editor, draft: { ...editor.draft, imagePrompt: event.target.value } })} /></label><p>{t('promptHint')}</p></details>
        {errorText && <div role="alert" className="form-error">{errorText}</div>}<footer><button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => setEditor(null)}>{t('cancel')}</button><button className="primary-small-button" disabled={disabled || !editor.draft.name.trim()}>{busy === 'save' ? t('saving') : t('save')}</button></footer>
      </form></div></div>}
      {deleted && <div className="locations-overlay"><div className="locations-dialog" role="dialog" aria-modal="true" aria-label={t('confirmTitle')}><h3>{t('confirmTitle')}</h3><p>{t('confirmText', { name: deleted.name })}</p>{(assignedCounts[deleted.id] ?? 0) > 0 && <p role="alert">{t('assignedWarning', { count: assignedCounts[deleted.id] })}</p>}{errorText && <div className="form-error" role="alert">{errorText}</div>}<footer><button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => setRemoveId(null)}>{t('cancel')}</button><button type="button" className="primary-small-button" disabled={disabled} onClick={() => void run('remove', async () => { if (applyResult(await latest.current.api.save(latest.current.locations.filter(location => location.id !== deleted.id)), 'deleted')) setRemoveId(null) })}>{t('remove')}</button></footer></div></div>}
      {attachId && <div className="locations-overlay"><div className="locations-dialog" role="dialog" aria-modal="true" aria-label={t('attach')}><h3>{t('attach')}</h3><p>{t('attachHint')}</p><label><span>{t('existingImage')}</span><select value={selectedResultId} onChange={event => setSelectedResultId(event.target.value)}><option value="">{t('chooseImage')}</option>{results.map(item => <option key={item.id} value={item.id}>{item.model || item.provider} · {new Date(item.createdAt).toLocaleString()} · {item.id.slice(0,8)}</option>)}</select></label>{errorText && <div className="form-error" role="alert">{errorText}</div>}<footer><button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => setAttachId(null)}>{t('cancel')}</button><button type="button" className="primary-small-button" disabled={disabled || !selectedResultId} onClick={() => void attachSelected(attachId, selectedResultId)}>{t('attach')}</button></footer></div></div>}
      {viewPicker && (() => {
        const location = locations.find(item => item.id === viewPicker)
        if (!location) return null
        return <div className="locations-overlay"><div className="locations-dialog" role="dialog" aria-modal="true" aria-label={t('addViewTitle')}>
          <header><h3>{t('addViewTitle')}</h3><button type="button" className="close-button" onClick={() => setViewPicker(null)} disabled={Boolean(busy)} aria-label={t('close')}><X size={20} aria-hidden="true" /></button></header>
          <p>{t('addViewHint')}</p>
          <label><span>{t('viewAngle')}</span>
            <select value={viewLabel} onChange={event => setViewLabel(event.target.value)}>
              {LOCATION_VIEW_LABELS.map(label => <option key={label} value={label}>{t(VIEW_LABEL_KEYS[label])}</option>)}
            </select>
          </label>
          {errorText && <div className="form-error" role="alert">{errorText}</div>}
          <footer>
            <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => setViewPicker(null)}>{t('cancel')}</button>
            <label className={`secondary-button locations-upload ${disabled ? 'is-disabled' : ''}`}>
              <Upload size={14} />{t('viewUpload')}
              <input type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled} aria-label={t('viewUpload')}
                onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void uploadView(location, viewLabel, file) }} />
            </label>
            <button type="button" className="primary-small-button" disabled={disabled || !modelId} onClick={() => void generateView(location, viewLabel)}>
              <Sparkles size={14} />{busy?.startsWith('view:') ? t('viewGenerating') : t('generate')}
            </button>
          </footer>
        </div></div>
      })()}
      {viewZoom && <ImageLightbox src={viewZoom.url} alt={viewZoom.name} editableSource={viewZoom.editableSource} onClose={() => setViewZoom(null)} />}
    </section>
  )
}
