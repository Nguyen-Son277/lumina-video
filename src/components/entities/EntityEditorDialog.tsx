import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { ApiError, assertResponseOk, errorMessage } from '../../api/client'
import { characterApi } from '../../api/endpoints'
import { entityLibraryApi, entityReferenceUrl, type EntityKind, type EntityLibraryEntity } from '../../api/entityLibrary'
import type { CharacterVoice } from '../../api/projectTypes'
import type { ModelInfo } from '../../api/types'
import { useTranslation, type Notification } from '../../i18n'
import { entityCreationCatalog } from '../../i18n/catalogs/entityCreation'
import { ImageLightbox, useModalLayer } from '../Lightbox'
import { useEntityPreferences } from './useEntityPreferences'
import '../../styles/entity-creation.css'

export type NavigationGuard = (action: () => void) => void
export interface EntityDialogCallbacks {
  onClose: () => void
  onSaved: (entity?: Pick<EntityLibraryEntity, 'id' | 'kind'>) => void
  onOpenSettings: () => void
  onNotify?: (message: Notification) => void
  onConverted?: (entity: EntityLibraryEntity) => void
  onRegisterNavigationGuard?: (guard: NavigationGuard | null) => void
}
export function CreationModal({ title, onClose, children, testId }: {title: string; onClose: () => void; children: ReactNode; testId: string}) {
  const ref = useRef<HTMLDivElement>(null)
  const id = useId()
  const { t } = useTranslation(entityCreationCatalog)
  useModalLayer(ref, onClose)
  return createPortal(<div className="entity-creation-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><div ref={ref} className="entity-creation-dialog" role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} data-testid={testId}><header><h2 id={id}>{title}</h2><button type="button" className="close-button" aria-label={t('close')} onClick={onClose}><X size={20} aria-hidden="true"/></button></header>{children}</div></div>, document.body)
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
  return <EntityEditorForm {...props}/>
}
function EntityEditorForm({ kind: initialKind, entity, llmModels, onClose, onSaved, onConverted, onOpenSettings, onRegisterNavigationGuard }: EntityEditorDialogProps) {
  const [kind, setKind] = useState(initialKind)
  const [persistedKind, setPersistedKind] = useState(initialKind)
  const { t, locale } = useTranslation(entityCreationCatalog)
  const preferences = useEntityPreferences()
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
  const [loading, setLoading] = useState(!!entity)
  const [loadVersion, setLoadVersion] = useState(0)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [analyzing, setAnalyzing] = useState(false)
  const modelId = preferences.settings.modelId
  const [referenceRevision, setReferenceRevision] = useState(entity?.revision)
  const [error, setError] = useState<unknown>(null)
  const [localError, setLocalError] = useState<'partialSave' | 'invalidFile' | 'stale' | null>(null)
  const [zoom, setZoom] = useState(false)
  const [pending, setPending] = useState<{ action: () => void } | null>(null)
  const mounted = useRef(true)
  const version = useRef(0)
  const analysis = useRef<AbortController | null>(null)
  const metadata = JSON.stringify([kind, name.trim(), handle, description, continuity, voice])
  const initial = useRef(metadata)
  const dirty = !loading && (metadata !== initial.current || file !== null || removeReference)
  const selectedModel = llmModels.find(model => model.id === modelId && model.enabled && model.kind === 'llm')
  const disabled = busy || loading || loadFailed || analyzing
  const conversionUsage = error instanceof ApiError && Array.isArray((error.details as { usage?: unknown[] } | undefined)?.usage)
    ? (error.details as { usage: Array<{ label?: string; type?: string; projectId?: string; sessionId?: string }> }).usage : []
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
    if (!entity) return
    const controller = new AbortController()
    setLoading(true); setLoadFailed(false); setError(null)
    void (async () => {
      const [specific, original] = await Promise.all([
        entityLibraryApi.conversionData(entity.kind, entity.id, controller.signal),
        entity.kind === 'character' ? characterApi.get(entity.id, controller.signal).then(result => result.character) : entityLibraryApi.get(entity.id, controller.signal).then(result => result.asset),
      ])
      if (controller.signal.aborted) return
      const originalName = original.name
      const originalDescription = 'appearance' in original ? original.appearance : original.description
      const originalRevision = 'appearance' in original ? original.updatedAt : original.revision
      if (specific.revision !== originalRevision || (!('appearance' in original) && original.kind !== entity.kind)) throw new Error(t('stale'))
      const nextVoice = { ...emptyVoice(), ...specific.voice }
      setName(originalName); setDescription(originalDescription); setVoice(nextVoice); setContinuity(specific.continuityNotes)
      setReferenceRevision(originalRevision)
      if ('appearance' in original) setReference(original.referenceUrl)
      else { setAsset(original); setReference(entityReferenceUrl(original)) }
      initial.current = JSON.stringify([entity.kind, originalName.trim(), '', originalDescription, specific.continuityNotes, nextVoice])
    })().catch(cause => { if (!controller.signal.aborted) { setError(cause); setLoadFailed(true) } }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [entity?.id, loadVersion])

  async function save(): Promise<boolean> {
    if (busyRef.current || disabled || !name.trim() || description.length > (kind === 'character' ? 4000 : 5000)) return false
    busyRef.current = true; setBusy(true); setError(null); setLocalError(null); invalidateAnalysis()
    const snapshot = metadata
    try {
      if (savedMetadata.current !== snapshot) {
        if (retainedId.current && kind !== persistedKind) {
          const result = await entityLibraryApi.convert(persistedKind, retainedId.current, {
            targetKind: kind, expectedRevision: referenceRevision!, name: name.trim(), description, continuityNotes: continuity, voice,
          })
          setPersistedKind(result.entity.kind); setAsset(result.entity); setReferenceRevision(result.entity.revision)
          setReference(entityReferenceUrl(result.entity))
          onConverted?.(result.entity)
        } else if (kind === 'character') {
          const input = { name: name.trim(), appearance: description, voice }
          const result = retainedId.current ? await characterApi.update(retainedId.current, input) : await characterApi.create(input)
          retainedId.current = result.character.id
          if (mounted.current) { setPersistedKind('character'); setReferenceRevision(result.character.updatedAt) }
        } else {
          const result = retainedId.current
            ? await entityLibraryApi.update(retainedId.current, { name: name.trim(), description, continuityNotes: continuity, revision: asset?.revision })
            : await entityLibraryApi.create({ kind, name: name.trim(), description, continuityNotes: continuity, ...(handle.trim() ? { handle: handle.trim(), autoHandle } : {}) })
          retainedId.current = result.asset.id
          if (mounted.current) { setPersistedKind(result.asset.kind); setAsset(result.asset); setReferenceRevision(result.asset.revision) }
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
      onSaved(retainedId.current ? { id: retainedId.current, kind } : undefined)
      return true
    } catch (cause) { if (mounted.current) setError(cause); return false }
    finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }
  async function analyze() {
    if (!preferences.loaded || !selectedModel || disabled || (!file && !referenceUrl)) return
    if ([name, description, ...(kind !== 'character' ? [continuity, ...(!retainedId.current ? [handle] : [])] : [])].some(value => value.trim()) && !window.confirm(t('overwrite'))) return
    const token = ++version.current
    const controller = new AbortController(); analysis.current = controller
    setAnalyzing(true); setError(null); setLocalError(null)
    try {
      const revisionOfSource = async () => {
        if (persistedKind === 'character') return (await characterApi.get(retainedId.current!, controller.signal)).character.updatedAt
        const current = (await entityLibraryApi.get(retainedId.current!, controller.signal)).asset
        return current.kind === persistedKind ? current.revision : undefined
      }
      let analysisFile = file
      if (!analysisFile && kind !== persistedKind) {
        // Read through the original representation; a pending type change is not saved yet.
        if (await revisionOfSource() !== referenceRevision) { setLocalError('stale'); return }
        const response = await fetch(referenceUrl!, { credentials: 'include', cache: 'no-store', signal: controller.signal })
        await assertResponseOk(response)
        const blob = await response.blob()
        if (await revisionOfSource() !== referenceRevision) { setLocalError('stale'); return }
        analysisFile = new File([blob], 'reference', { type: blob.type })
      }
      if (kind === 'character') {
        const result = analysisFile ? await characterApi.analyzeReference(analysisFile, modelId, locale, controller.signal) : await characterApi.analyzeExistingReference(retainedId.current!, modelId, locale, controller.signal)
        if (!mounted.current || controller.signal.aborted || token !== version.current) return
        if (!analysisFile && result.revision !== referenceRevision) { setLocalError('stale'); return }
        if (!file && await revisionOfSource() !== referenceRevision) { setLocalError('stale'); return }
        if (!mounted.current || controller.signal.aborted || token !== version.current) return
        setName(result.suggestion.name); setDescription(result.suggestion.appearance)
        return
      }
      const result = analysisFile ? await entityLibraryApi.analyzeReference(analysisFile, kind, modelId, controller.signal) : await entityLibraryApi.analyzeExistingReference(retainedId.current!, modelId, controller.signal)
      if (!mounted.current || controller.signal.aborted || token !== version.current) return
      if (!analysisFile && asset && ((result.revision !== undefined && result.revision !== asset.revision) || (result.referenceUploadId !== undefined && result.referenceUploadId !== asset.reference?.uploadId))) { setLocalError('stale'); return }
      if (!file && await revisionOfSource() !== referenceRevision) { setLocalError('stale'); return }
      if (!mounted.current || controller.signal.aborted || token !== version.current) return
      setName(result.suggestion.name); setDescription(result.suggestion.description); setContinuity(result.suggestion.continuityNotes)
      if (!retainedId.current) { setHandle(result.suggestion.handle); setAutoHandle(true) }
    } catch (cause) { if (mounted.current && !controller.signal.aborted && token === version.current) setError(cause) }
    finally { if (mounted.current && token === version.current) { setAnalyzing(false); analysis.current = null } }
  }
  return <>
    <CreationModal title={t(entity ? 'edit' : 'create')} testId="entity-editor-dialog" onClose={() => guard(onClose)}>
      <form onSubmit={event => { event.preventDefault(); void save().then(ok => { if (ok) onClose() }) }}>
        <div className="entity-creation-scroll">
          <label>{t('kind')}<select value={kind} disabled={busy || loading || loadFailed || !!entity?.source || !!entity?.projectId} onChange={event => { invalidateAnalysis(); setKind(event.target.value as EntityKind) }} data-testid="entity-editor-kind">{(['character', 'item', 'logo', 'location'] as const).map(value => <option key={value} value={value}>{t(value)}</option>)}</select></label>
          {entity && <p className="entity-creation-hint">{t(entity.source || entity.projectId ? 'conversionScoped' : 'conversionHint')}</p>}
          {entity && kind !== persistedKind && <p role="status" className="notice-banner">{t('conversionPending')}</p>}
          {description.length > (kind === 'character' ? 4000 : 5000) && <p role="alert" className="form-error">{t('conversionDescriptionLong')}</p>}
          {conversionUsage.length > 0 && <ul className="entity-conversion-usage">{conversionUsage.map((usage, index) => <li key={index}>{usage.label || usage.type}{usage.projectId && <a href={`/?page=studio&project=${encodeURIComponent(usage.projectId)}`}>{t('conversionOpenUsage')}</a>}{usage.sessionId && !usage.projectId && <a href={usage.type === 'quick_session' || usage.type === 'quick_canvas' ? `/?page=quick&session=${encodeURIComponent(usage.sessionId)}${usage.type === 'quick_canvas' ? '&view=canvas' : ''}` : `/?page=timeline&session=${encodeURIComponent(usage.sessionId)}`}>{t('conversionOpenUsage')}</a>}</li>)}</ul>}
          {loading && <p role="status">{t('busy')}</p>}
          {(error != null || localError) && <div className="form-error" role="alert">{localError && <p>{t(localError)}</p>}{error != null && <p>{conversionUsage.length ? t('conversionInUse') : errorMessage(error)}</p>}{loadFailed && <button type="button" onClick={() => setLoadVersion(value => value + 1)}>{t('resume')}</button>}</div>}
          <section className="entity-creation-reference"><div>{referenceUrl && <button type="button" className={`entity-creation-preview is-${kind}`} onClick={() => setZoom(true)} aria-label={t('reference')}><img src={referenceUrl} alt={t('reference')}/></button>}</div><label>{t('reference')}<input type="file" accept={IMAGE_TYPES.join(',')} disabled={disabled} data-testid="entity-editor-file" onChange={event => {
            const next = event.currentTarget.files?.[0]; event.currentTarget.value = ''
            if (!next) return
            if (!IMAGE_TYPES.includes(next.type)) { setLocalError('invalidFile'); return }
            invalidateAnalysis(); setFile(next); setRemoveReference(false); setLocalError(null)
          }}/></label>{referenceUrl && <button type="button" disabled={disabled} onClick={() => { invalidateAnalysis(); setFile(null); setRemoveReference(true) }}>{t('clear')}</button>}<p className="entity-creation-hint">{t('fileHint')}</p></section>
          <section className="entity-creation-ai-settings"><label>{t('llm')}<select value={modelId} disabled={busy || loading || !preferences.loaded} onChange={event => { invalidateAnalysis(); preferences.update({ modelId: event.target.value }) }} data-testid="entity-editor-ai-model"><option value="">{t('chooseModel')}</option>{modelId && !selectedModel && <option value={modelId}>{t('unavailableModel')}</option>}{llmModels.filter(model => model.enabled && model.kind === 'llm').map(model => <option key={model.id} value={model.id}>{model.displayName} · {model.providerName}</option>)}</select></label><p className="entity-creation-hint">{t('disclosure')}</p><button type="button" disabled={disabled || !preferences.loaded || !selectedModel || !referenceUrl} onClick={() => void analyze()} data-testid="entity-editor-analyze">{analyzing ? t('busy') : t('analyze')}</button><button type="button" disabled={busy} onClick={() => guard(onOpenSettings)}>{t('settings')}</button></section>
          <p className="entity-creation-hint" role="status">{t(!preferences.loaded ? 'preferencesLoading' : preferences.saving ? 'preferencesSaving' : 'preferencesHint')}</p>
          {preferences.error != null && <div className="form-error" role="alert"><p>{t('preferencesError')}</p><button type="button" onClick={preferences.retry}>{t('retryPreferences')}</button></div>}
          <div className="entity-creation-fields">
            <label htmlFor={`${id}-name`}>{t('name')}<input id={`${id}-name`} name="name" required maxLength={200} value={name} disabled={disabled} onChange={event => setName(event.target.value)}/></label>
            {kind !== 'character' && !retainedId.current && <label>{t('handle')}<input name="handle" value={handle} maxLength={80} disabled={disabled} autoCapitalize="none" spellCheck={false} onChange={event => { setHandle(event.target.value); setAutoHandle(false) }}/></label>}
            <label>{t(kind === 'character' ? 'appearance' : 'description')}<textarea name={kind === 'character' ? 'appearance' : 'description'} rows={5} maxLength={kind === 'character' ? 4000 : 5000} value={description} disabled={disabled} onChange={event => setDescription(event.target.value)}/></label>
            {kind === 'character' ? <div className="entity-creation-voice">{voiceFields.map(field => <label key={field}>{t(field)}<textarea name={`voice.${field}`} rows={2} maxLength={field === 'habits' ? 1000 : field === 'timbre' || field === 'articulation' ? 500 : 200} value={voice[field]} disabled={disabled} onChange={event => setVoice(current => ({ ...current, [field]: event.target.value }))}/></label>)}</div> : <label>{t('continuity')}<textarea name="continuityNotes" rows={4} maxLength={5000} value={continuity} disabled={disabled} onChange={event => setContinuity(event.target.value)}/></label>}
          </div>
        </div><footer><button type="button" disabled={busy} onClick={() => guard(onClose)}>{t('close')}</button><button type="submit" className="primary-small-button" disabled={disabled || !name.trim() || description.length > (kind === 'character' ? 4000 : 5000)}>{busy ? t('busy') : t('save')}</button></footer>
      </form>
    </CreationModal>
    {pending && <CreationModal title={t('dirtyTitle')} testId="entity-dirty-dialog" onClose={() => setPending(null)}><p>{t('dirtyHint')}</p><footer><button type="button" onClick={() => setPending(null)}>{t('stay')}</button><button type="button" onClick={() => { invalidateAnalysis(); const action = pending.action; setPending(null); action() }}>{t('discard')}</button><button type="button" disabled={disabled || !name.trim() || description.length > (kind === 'character' ? 4000 : 5000)} onClick={() => { const action = pending.action; void save().then(ok => { if (ok) { setPending(null); action() } }) }}>{t('saveLeave')}</button></footer></CreationModal>}
    {zoom && referenceUrl && <ImageLightbox src={referenceUrl} alt={name || t('reference')} onClose={() => setZoom(false)}/>}
  </>
}
