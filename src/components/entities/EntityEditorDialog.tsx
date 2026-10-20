import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { errorMessage } from '../../api/client'
import { characterApi } from '../../api/endpoints'
import { entityLibraryApi, entityReferenceUrl, type EntityKind, type EntityLibraryEntity } from '../../api/entityLibrary'
import type { CharacterVoice } from '../../api/projectTypes'
import type { ModelInfo } from '../../api/types'
import { useTranslation, type Notification } from '../../i18n'
import { entityCreationCatalog } from '../../i18n/catalogs/entityCreation'
import { ImageLightbox, useModalLayer } from '../Lightbox'
import '../../styles/entity-creation.css'

export type NavigationGuard = (action: () => void) => void
export interface EntityDialogCallbacks {
  onClose: () => void
  onSaved: () => void
  onOpenSettings: () => void
  onNotify?: (message: Notification) => void
  onRegisterNavigationGuard?: (guard: NavigationGuard | null) => void
}
export function CreationModal({ title, onClose, children, testId }: {title: string; onClose: () => void; children: ReactNode; testId: string}) {
  const ref = useRef<HTMLDivElement>(null)
  const id = useId()
  const { t } = useTranslation(entityCreationCatalog)
  useModalLayer(ref, onClose)
  return createPortal(<div className="entity-creation-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><div ref={ref} className="entity-creation-dialog" role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} data-testid={testId}><header><h2 id={id}>{title}</h2><button type="button" className="close-button" aria-label={t('close')} onClick={onClose}><X size={20}/></button></header>{children}</div></div>, document.body)
}
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const voiceFields: Array<keyof CharacterVoice> = ['language', 'accent', 'pitch', 'timbre', 'pace', 'articulation', 'habits']
const emptyVoice = (): CharacterVoice => ({ language: '', accent: '', pitch: '', timbre: '', pace: '', articulation: '', habits: '' })
export interface EntityEditorDialogProps extends EntityDialogCallbacks {
  kind: EntityKind
  entity?: EntityLibraryEntity | null
  llmModels: ModelInfo[]
}

export function EntityEditorDialog(props: EntityEditorDialogProps) {
  const [selectedKind, setSelectedKind] = useState(props.kind)
  return <EntityEditorForm key={selectedKind} {...props} kind={selectedKind} onChangeKind={setSelectedKind}/>
}
function EntityEditorForm({ kind, entity, llmModels, onClose, onSaved, onOpenSettings, onRegisterNavigationGuard, onChangeKind }: EntityEditorDialogProps & { onChangeKind: (kind: EntityKind) => void }) {
  const { t } = useTranslation(entityCreationCatalog)
  const id = useId()
  const [name, setName] = useState(entity?.name ?? '')
  const [handle, setHandle] = useState('')
  const [autoHandle, setAutoHandle] = useState(false)
  const [description, setDescription] = useState(entity?.description ?? '')
  const [continuity, setContinuity] = useState(entity?.continuityNotes ?? '')
  const [voice, setVoice] = useState(emptyVoice)
  const [file, setFile] = useState<File | null>(null)
  const [removeReference, setRemoveReference] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [reference, setReference] = useState(entity ? entityReferenceUrl(entity) : null)
  const [asset, setAsset] = useState(entity ?? null)
  const retainedId = useRef(entity?.id)
  const savedMetadata = useRef<string | null>(null)
  const [loading, setLoading] = useState(kind === 'character' && !!entity)
  const [loadVersion, setLoadVersion] = useState(0)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [modelId, setModelId] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [localError, setLocalError] = useState<'partialSave' | 'invalidFile' | 'stale' | null>(null)
  const [zoom, setZoom] = useState(false)
  const [pending, setPending] = useState<{ action: () => void } | null>(null)
  const mounted = useRef(true)
  const version = useRef(0)
  const analysis = useRef<AbortController | null>(null)
  const metadata = JSON.stringify([name.trim(), handle, description, continuity, voice])
  const initial = useRef(metadata)
  const dirty = !loading && (metadata !== initial.current || file !== null || removeReference)
  const selectedModel = llmModels.find(model => model.id === modelId && model.enabled)
  const disabled = busy || loading || loadFailed || analyzing
  const referenceUrl = preview ?? (!removeReference ? reference : null)
  const latest = useRef({ dirty, busy, analyzing })
  latest.current = { dirty, busy, analyzing }
  function invalidateAnalysis() { version.current++; analysis.current?.abort(); analysis.current = null; setAnalyzing(false) }
  function guard(action: () => void) {
    if (latest.current.busy) return
    if (latest.current.dirty || latest.current.analyzing) setPending({ action })
    else action()
  }
  const guardRef = useRef(guard); guardRef.current = guard
  useEffect(() => {
    onRegisterNavigationGuard?.(action => guardRef.current(action))
    return () => onRegisterNavigationGuard?.(null)
  }, [onRegisterNavigationGuard])
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (latest.current.dirty || latest.current.busy || latest.current.analyzing) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', beforeUnload)
    mounted.current = true
    return () => { mounted.current = false; analysis.current?.abort(); version.current++; window.removeEventListener('beforeunload', beforeUnload) }
  }, [])
  useEffect(() => {
    const url = file ? URL.createObjectURL(file) : null
    setPreview(url)
    return () => { if (url) URL.revokeObjectURL(url) }
  }, [file])
  useEffect(() => {
    if (kind !== 'character' || !entity) return
    const controller = new AbortController()
    setLoading(true); setLoadFailed(false); setError(null)
    characterApi.get(entity.id, controller.signal).then(({ character }) => {
      if (controller.signal.aborted) return
      setName(character.name); setDescription(character.appearance); setVoice(character.voice); setReference(character.referenceUrl)
      initial.current = JSON.stringify([character.name.trim(), '', character.appearance, entity.continuityNotes ?? '', character.voice])
    }).catch(cause => { if (!controller.signal.aborted) { setError(cause); setLoadFailed(true) } }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [entity?.id, kind, loadVersion])

  async function save(): Promise<boolean> {
    if (busyRef.current || disabled || !name.trim()) return false
    busyRef.current = true; setBusy(true); setError(null); setLocalError(null); invalidateAnalysis()
    const snapshot = metadata
    try {
      if (savedMetadata.current !== snapshot) {
        if (kind === 'character') {
          const input = { name: name.trim(), appearance: description, voice }
          const result = retainedId.current ? await characterApi.update(retainedId.current, input) : await characterApi.create(input)
          retainedId.current = result.character.id
        } else {
          const result = retainedId.current
            ? await entityLibraryApi.update(retainedId.current, { name: name.trim(), description, continuityNotes: continuity, revision: asset?.revision })
            : await entityLibraryApi.create({ kind, name: name.trim(), description, continuityNotes: continuity, ...(handle.trim() ? { handle: handle.trim(), autoHandle } : {}) })
          retainedId.current = result.asset.id
          if (mounted.current) setAsset(result.asset)
        }
        savedMetadata.current = snapshot
      }
      try {
        if (file) {
          if (kind === 'character') await characterApi.uploadReference(retainedId.current!, file)
          else await entityLibraryApi.uploadReference(retainedId.current!, file)
        } else if (removeReference && reference) {
          if (kind === 'character') await characterApi.removeReference(retainedId.current!)
          else await entityLibraryApi.removeReference(retainedId.current!)
        }
      } catch (cause) { if (mounted.current) setLocalError('partialSave'); throw cause }
      initial.current = snapshot
      onSaved()
      return true
    } catch (cause) { if (mounted.current) setError(cause); return false }
    finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }
  async function analyze() {
    if (kind === 'character' || !selectedModel || disabled || (!file && !referenceUrl)) return
    if ([name, description, continuity, ...(!retainedId.current ? [handle] : [])].some(value => value.trim()) && !window.confirm(t('overwrite'))) return
    const token = ++version.current
    const controller = new AbortController(); analysis.current = controller
    setAnalyzing(true); setError(null); setLocalError(null)
    try {
      const result = file ? await entityLibraryApi.analyzeReference(file, kind, modelId, controller.signal) : await entityLibraryApi.analyzeExistingReference(retainedId.current!, modelId, controller.signal)
      if (!mounted.current || controller.signal.aborted || token !== version.current) return
      if (!file && asset && ((result.revision !== undefined && result.revision !== asset.revision) || (result.referenceUploadId !== undefined && result.referenceUploadId !== asset.reference?.uploadId))) { setLocalError('stale'); return }
      setName(result.suggestion.name); setDescription(result.suggestion.description); setContinuity(result.suggestion.continuityNotes)
      if (!retainedId.current) { setHandle(result.suggestion.handle); setAutoHandle(true) }
    } catch (cause) { if (mounted.current && !controller.signal.aborted && token === version.current) setError(cause) }
    finally { if (mounted.current && token === version.current) { setAnalyzing(false); analysis.current = null } }
  }
  return <>
    <CreationModal title={t(entity ? 'edit' : 'create')} testId="entity-editor-dialog" onClose={() => guard(onClose)}>
      <form onSubmit={event => { event.preventDefault(); void save().then(ok => { if (ok) onClose() }) }}>
        <div className="entity-creation-scroll">
          {!entity && <label>{t('kind')}<select value={kind} disabled={busy || loading} onChange={event => { const next = event.target.value as EntityKind; guard(() => onChangeKind(next)) }} data-testid="entity-editor-kind">{(['character', 'item', 'logo', 'location'] as const).map(value => <option key={value} value={value}>{t(value)}</option>)}</select></label>}
          {loading && <p role="status">{t('busy')}</p>}
          {(error != null || localError) && <div className="form-error" role="alert">{localError && <p>{t(localError)}</p>}{error != null && <p>{errorMessage(error)}</p>}{loadFailed && <button type="button" onClick={() => setLoadVersion(value => value + 1)}>{t('resume')}</button>}</div>}
          <section className="entity-creation-reference"><div>{referenceUrl && <button type="button" className={`entity-creation-preview is-${kind}`} onClick={() => setZoom(true)} aria-label={t('reference')}><img src={referenceUrl} alt={t('reference')}/></button>}</div><label>{t('reference')}<input type="file" accept={IMAGE_TYPES.join(',')} disabled={disabled} data-testid="entity-editor-file" onChange={event => {
            const next = event.currentTarget.files?.[0]; event.currentTarget.value = ''
            if (!next) return
            if (!IMAGE_TYPES.includes(next.type)) { setLocalError('invalidFile'); return }
            invalidateAnalysis(); setFile(next); setRemoveReference(false); setLocalError(null)
          }}/></label>{referenceUrl && <button type="button" disabled={disabled} onClick={() => { invalidateAnalysis(); setFile(null); setRemoveReference(true) }}>{t('clear')}</button>}<p className="entity-creation-hint">{t('fileHint')}</p></section>
          {kind !== 'character' && <section className="entity-creation-ai-settings"><label>{t('llm')}<select value={modelId} disabled={busy || loading} onChange={event => { invalidateAnalysis(); setModelId(event.target.value) }} data-testid="entity-editor-ai-model"><option value="">{t('chooseModel')}</option>{llmModels.filter(model => model.enabled).map(model => <option key={model.id} value={model.id}>{model.displayName} · {model.providerName}</option>)}</select></label><p className="entity-creation-hint">{t('disclosure')}</p><button type="button" disabled={disabled || !selectedModel || !referenceUrl} onClick={() => void analyze()} data-testid="entity-editor-analyze">{analyzing ? t('busy') : t('analyze')}</button><button type="button" disabled={busy} onClick={() => guard(onOpenSettings)}>{t('settings')}</button></section>}
          <div className="entity-creation-fields">
            <label htmlFor={`${id}-name`}>{t('name')}<input id={`${id}-name`} name="name" required maxLength={200} value={name} disabled={disabled} onChange={event => setName(event.target.value)}/></label>
            {kind !== 'character' && !retainedId.current && <label>{t('handle')}<input name="handle" value={handle} maxLength={80} disabled={disabled} autoCapitalize="none" spellCheck={false} onChange={event => { setHandle(event.target.value); setAutoHandle(false) }}/></label>}
            <label>{t(kind === 'character' ? 'appearance' : 'description')}<textarea name={kind === 'character' ? 'appearance' : 'description'} rows={5} maxLength={kind === 'character' ? 4000 : 5000} value={description} disabled={disabled} onChange={event => setDescription(event.target.value)}/></label>
            {kind === 'character' ? <div className="entity-creation-voice">{voiceFields.map(field => <label key={field}>{t(field)}<textarea name={`voice.${field}`} rows={2} maxLength={field === 'habits' ? 1000 : field === 'timbre' || field === 'articulation' ? 500 : 200} value={voice[field]} disabled={disabled} onChange={event => setVoice(current => ({ ...current, [field]: event.target.value }))}/></label>)}</div> : <label>{t('continuity')}<textarea name="continuityNotes" rows={4} maxLength={5000} value={continuity} disabled={disabled} onChange={event => setContinuity(event.target.value)}/></label>}
          </div>
        </div><footer><button type="button" disabled={busy} onClick={() => guard(onClose)}>{t('close')}</button><button type="submit" className="primary-small-button" disabled={disabled || !name.trim()}>{busy ? t('busy') : t('save')}</button></footer>
      </form>
    </CreationModal>
    {pending && <CreationModal title={t('dirtyTitle')} testId="entity-dirty-dialog" onClose={() => setPending(null)}><p>{t('dirtyHint')}</p><footer><button type="button" onClick={() => setPending(null)}>{t('stay')}</button><button type="button" onClick={() => { invalidateAnalysis(); const action = pending.action; setPending(null); action() }}>{t('discard')}</button><button type="button" disabled={disabled || !name.trim()} onClick={() => { const action = pending.action; void save().then(ok => { if (ok) { setPending(null); action() } }) }}>{t('saveLeave')}</button></footer></CreationModal>}
    {zoom && referenceUrl && <ImageLightbox src={referenceUrl} alt={name || t('reference')} onClose={() => setZoom(false)}/>}
  </>
}
