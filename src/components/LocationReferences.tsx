import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ImagePlus, LoaderCircle, MessageSquare, Pencil, Plus, Sparkles, Trash2, Upload, X } from 'lucide-react'
import { errorMessage, storedErrorMessage } from '../api/client'
import { generationApi } from '../api/endpoints'
import type { Generation, ModelInfo } from '../api/types'
import { useTranslation } from '../i18n'
import { notification, type Notification } from '../i18n/messages'
import { locationsCatalog } from '../i18n/catalogs/locations'
import { ImageLightbox } from './Lightbox'
import '../locations.css'

export interface LocationReference {
  id: string
  name: string
  stage: string
  description: string
  continuityNotes: string
  imagePrompt: string
  reference: { uploadId: string } | null
  revision: number
}
export type LocationDraft = Omit<LocationReference, 'id' | 'revision' | 'reference'>
/** Adapter supplied by the owner: no endpoint/envelope guesses in the reusable UI. */
export interface LocationReferencesApi {
  save(locations: LocationReference[]): Promise<LocationReference[]>
  propose?(): Promise<LocationReference[]>
  generate?(locationId: string, modelId: string): Promise<Generation>
  upload?(locationId: string, file: File): Promise<LocationReference[]>
  attach?(locationId: string, generationId: string, revision?: number): Promise<LocationReference[]>
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
    revision: typeof value.revision === 'number' && Number.isFinite(value.revision) ? value.revision : 0,
  }
}
const normalizeList = (values: unknown): LocationReference[] =>
  Array.isArray(values) ? values.map(value => normalizeLocation(value as Partial<LocationReference>)) : []
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
  const [generationId, setGenerationId] = useState('')
  const [modelId, setModelId] = useState(selectedModelId ?? '')
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<UiError | null>(null)
  const [preview, setPreview] = useState<LocationReference | null>(null)
  const alive = useRef(true)
  const busyRef = useRef(busy)
  busyRef.current = busy
  const latest = useRef({ api, onChanged, onNotify, locations })
  latest.current = { api, onChanged, onNotify, locations }
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { if (selectedModelId) setModelId(selectedModelId) }, [selectedModelId])
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
  /** AI proposals are additive: keep existing locations, append suggestions that differ by name+stage. */
  function applyProposal(result: unknown): boolean {
    if (!alive.current) return false
    if (!Array.isArray(result)) { setError({ key: 'unavailable' }); return false }
    const keyOf = (item: LocationReference) => `${item.name.trim().toLowerCase()}|${item.stage.trim().toLowerCase()}`
    const seen = new Set(latest.current.locations.map(keyOf))
    const additions = normalizeList(result).filter(item => item.name.trim() && !seen.has(keyOf(item)))
    latest.current.onChanged([...latest.current.locations, ...additions])
    latest.current.onNotify?.(notification('locations', 'proposed'))
    return true
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
      }
      const next = existing ? latest.current.locations.map(location => location.id === value.id ? value : location) : [...latest.current.locations, value]
      const saved = await latest.current.api.save(next)
      if (applyResult(saved, 'saved')) setEditor(null)
    })
  }
  async function generate(location: LocationReference) {
    if (!api.generate || !api.attach) return unavailable()
    if (!modelId) return
    await run(`generate:${location.id}`, async () => {
      let generation = await latest.current.api.generate!(location.id, modelId)
      const started = Date.now()
      while (alive.current && ['queued', 'running', 'downloading'].includes(generation.status)) {
        setProgress(generation.progress ?? 0)
        if (Date.now() - started > MAX_POLL_MS) { setError({ key: 'timeout' }); return }
        await new Promise(resolve => window.setTimeout(resolve, POLL_MS))
        if (!alive.current) return
        generation = latest.current.api.getGeneration ? await latest.current.api.getGeneration(generation.id) : (await generationApi.get(generation.id)).generation
      }
      if (!alive.current) return
      if (generation.status === 'unknown') { setError({ key: 'unknown' }); return }
      if (generation.status !== 'succeeded') { setError({ generation }); return }
      applyResult(await latest.current.api.attach!(location.id, generation.id, location.revision), 'referenceSaved')
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
          {sessionId && api.propose && <button type="button" className="secondary-button" disabled={disabled} onClick={() => void run('propose', async () => { applyProposal(await latest.current.api.propose!()) })}><Sparkles size={15} />{busy === 'propose' ? t('proposing') : t('propose')}</button>}
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
            {location.reference ? <button className="location-image" type="button" aria-label={t('preview', { name: location.name })} onClick={() => setPreview(location)}><img src={referenceUrl(location.reference.uploadId)} alt={location.name} loading="lazy" /></button> : <div className="location-image location-image-empty"><ImagePlus size={30} /><span>{t('noReference')}</span></div>}
            <div className="location-card-copy"><h4>{location.name}</h4>{location.stage && <p className="location-stage">{location.stage}</p>}<span className="location-revision">{t('revision', { revision: location.revision })}</span><p>{location.description}</p>{location.continuityNotes && <p><strong>{t('continuity')}: </strong>{location.continuityNotes}</p>}
              <div className="locations-actions">
                <button type="button" className="secondary-button" disabled={disabled} aria-label={t('edit')} onClick={() => { setError(null); setEditor({ id: location.id, draft: { name: location.name, stage: location.stage, description: location.description, continuityNotes: location.continuityNotes, imagePrompt: location.imagePrompt } }) }}><Pencil size={14} />{t('edit')}</button>
                <button type="button" className="secondary-button" disabled={disabled} onClick={() => setRemoveId(location.id)}><Trash2 size={14} />{t('remove')}</button>
                {api.generate && <button type="button" className="secondary-button" disabled={disabled || !modelId} onClick={() => void generate(location)}><Sparkles size={14} />{t('generate')}</button>}
                {api.upload && <label className={`secondary-button locations-upload ${disabled ? 'is-disabled' : ''}`}><Upload size={14} />{t('upload')}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled} aria-label={t('upload')} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void run(`upload:${location.id}`, async () => { applyResult(await latest.current.api.upload!(location.id, file), 'referenceSaved') }) }} /></label>}
                {api.attach && <button type="button" className="secondary-button" disabled={disabled} onClick={() => { setGenerationId(''); setAttachId(location.id); setError(null) }}>{t('attach')}</button>}
              </div>
            </div>
          </article>
        ))}
      </div>
      {editor && <div className="locations-overlay"><div className="locations-dialog" role="dialog" aria-modal="true" aria-label={t(editor.id ? 'edit' : 'add')}><header><h3>{t(editor.id ? 'edit' : 'add')}</h3><button type="button" onClick={() => setEditor(null)} disabled={Boolean(busy)} aria-label={t('close')}><X size={18} /></button></header><form onSubmit={save}>
        {(['name', 'stage', 'description', 'continuityNotes', 'imagePrompt'] as const).map(field => <label key={field}><span>{t(field === 'continuityNotes' ? 'continuity' : field === 'imagePrompt' ? 'prompt' : field)}</span>{field === 'name' || field === 'stage' ? <input required={field === 'name'} maxLength={200} value={editor.draft[field]} placeholder={field === 'stage' ? t('stageHint') : undefined} onChange={event => setEditor({ ...editor, draft: { ...editor.draft, [field]: event.target.value } })} /> : <textarea rows={3} maxLength={4000} value={editor.draft[field]} onChange={event => setEditor({ ...editor, draft: { ...editor.draft, [field]: event.target.value } })} />}</label>)}
        <p>{t('promptHint')}</p>{errorText && <div role="alert" className="form-error">{errorText}</div>}<footer><button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => setEditor(null)}>{t('cancel')}</button><button className="primary-small-button" disabled={disabled || !editor.draft.name.trim()}>{busy === 'save' ? t('saving') : t('save')}</button></footer>
      </form></div></div>}
      {deleted && <div className="locations-overlay"><div className="locations-dialog" role="dialog" aria-modal="true" aria-label={t('confirmTitle')}><h3>{t('confirmTitle')}</h3><p>{t('confirmText', { name: deleted.name })}</p>{(assignedCounts[deleted.id] ?? 0) > 0 && <p role="alert">{t('assignedWarning', { count: assignedCounts[deleted.id] })}</p>}{errorText && <div className="form-error" role="alert">{errorText}</div>}<footer><button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => setRemoveId(null)}>{t('cancel')}</button><button type="button" className="primary-small-button" disabled={disabled} onClick={() => void run('remove', async () => { if (applyResult(await latest.current.api.save(latest.current.locations.filter(location => location.id !== deleted.id)), 'deleted')) setRemoveId(null) })}>{t('remove')}</button></footer></div></div>}
      {attachId && <div className="locations-overlay"><div className="locations-dialog" role="dialog" aria-modal="true" aria-label={t('attach')}><h3>{t('attach')}</h3><p>{t('attachHint')}</p><label><span>{t('generationId')}</span><input value={generationId} onChange={event => setGenerationId(event.target.value)} /></label>{errorText && <div className="form-error" role="alert">{errorText}</div>}<footer><button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => setAttachId(null)}>{t('cancel')}</button><button type="button" className="primary-small-button" disabled={disabled || !generationId.trim()} onClick={() => void run('attach', async () => { if (applyResult(await latest.current.api.attach!(attachId, generationId.trim()), 'referenceSaved')) setAttachId(null) })}>{t('attach')}</button></footer></div></div>}
      {preview?.reference && <ImageLightbox src={referenceUrl(preview.reference.uploadId)} alt={preview.name} onClose={() => setPreview(null)} />}
    </section>
  )
}
