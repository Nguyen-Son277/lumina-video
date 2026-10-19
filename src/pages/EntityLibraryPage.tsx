import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { AtSign, Boxes, ImagePlus, LoaderCircle, Pencil, Plus, RefreshCw, Search, Shapes, Trash2, Users, X } from 'lucide-react'
import { errorMessage } from '../api/client'
import { entityLibraryApi, entityReferenceUrl, type EntityKind, type EntityLibraryEntity, type LibraryAssetKind } from '../api/entityLibrary'
import { notification, useTranslation, type Notification } from '../i18n'
import { entityLibraryCatalog } from '../i18n/catalogs/entityLibrary'
import type { ModelInfo } from '../api/types'
import '../styles/entity-library.css'

type Filter = 'all' | EntityKind
type AssetEditor = { entity: EntityLibraryEntity | null; kind: LibraryAssetKind; name: string; handle: string; description: string; continuityNotes: string; file: File | null; removeReference: boolean; autoHandle: boolean; savedMetadata: string | null }
const metadataKey = (draft: AssetEditor) => JSON.stringify([draft.name.trim(), draft.description, draft.continuityNotes])
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
type HandleEditor = { entity: EntityLibraryEntity; handle: string }
type SuccessKey = 'notifySaved' | 'notifyDeleted'
const FILTERS: Filter[] = ['all', 'item', 'logo', 'character', 'location']
const entityKey = (entity: EntityLibraryEntity) => `${entity.kind}:${entity.id}`
const displayEntityDescription = (entity: EntityLibraryEntity) => {
  if (entity.kind !== 'logo' && entity.kind !== 'location' && entity.kind !== 'character') return entity.description
  const characters = Array.from(entity.description)
  return characters.length > 200 ? `${characters.slice(0, 197).join('')}...` : entity.description
}

function KindIcon({ kind, size = 20 }: { kind: EntityKind; size?: number }) {
  if (kind === 'character') return <Users size={size} aria-hidden="true" />
  if (kind === 'logo') return <Shapes size={size} aria-hidden="true" />
  return <Boxes size={size} aria-hidden="true" />
}

function ReferenceThumbnail({ entity }: { entity: EntityLibraryEntity }) {
  const { t } = useTranslation(entityLibraryCatalog)
  const url = entityReferenceUrl(entity)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  return <div className={`entity-library-reference is-${entity.kind}`}>
    {url && failedUrl !== url
      ? <img src={url} alt={entity.name} loading="lazy" onError={() => setFailedUrl(url)} />
      : <div><KindIcon kind={entity.kind} size={36} /><span>{url ? t('referenceUnavailable') : t('noReference')}</span></div>}
    <span className="entity-library-kind"><KindIcon kind={entity.kind} size={14} />{t(entity.kind)}</span>
  </div>
}

export interface EntityLibraryPageProps {
  llmModels: ModelInfo[]
  onNotify?: (message: Notification) => void
}

/** Account-wide object/logo management; character metadata is intentionally read-only except its handle. */
export function EntityLibraryPage({ llmModels, onNotify }: EntityLibraryPageProps) {
  const { t } = useTranslation(entityLibraryCatalog)
  const fieldId = useId()
  const [entities, setEntities] = useState<EntityLibraryEntity[]>([])
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  const [error, setError] = useState<unknown>(null)
  const [success, setSuccess] = useState<SuccessKey | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const operationLock = useRef(false)
  const alive = useRef(true)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [editor, setEditor] = useState<AssetEditor | null>(null)
  const [handleEditor, setHandleEditor] = useState<HandleEditor | null>(null)
  const editorElement = useRef<HTMLFormElement>(null)
  const [modelId, setModelId] = useState('')
  const [analyzing, setAnalyzing] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const analysisController = useRef<AbortController | null>(null)
  const editorVersion = useRef(0)

  function invalidateAnalysis() {
    editorVersion.current++
    analysisController.current?.abort()
    analysisController.current = null
    setAnalyzing(false)
  }

  useEffect(() => {
    const url = editor?.file ? URL.createObjectURL(editor.file) : null
    setPreviewUrl(url)
    return () => { if (url) URL.revokeObjectURL(url) }
  }, [editor?.file])

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; analysisController.current?.abort(); editorVersion.current++ }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    entityLibraryApi.list({}, controller.signal)
      .then(result => { if (!controller.signal.aborted) setEntities(result.entities) })
      .catch(cause => { if (!controller.signal.aborted) setError(cause) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [reload])

  useEffect(() => {
    if (loading) return
    const id = new URLSearchParams(window.location.search).get('entity')
    if (id) document.getElementById(`entity-${id}`)?.scrollIntoView({ block: 'center' })
  }, [loading, entities])

  useEffect(() => {
    if (editor) {
      editorElement.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
      editorElement.current?.querySelector<HTMLInputElement>('input')?.focus()
    }
  }, [editor?.entity?.id, !!editor])

  const visible = useMemo(() => {
    const search = query.trim().replace(/^@/, '').toLocaleLowerCase()
    return entities.filter(entity => (filter === 'all' || entity.kind === filter) &&
      (!search || `${entity.name}\n${entity.handle}\n${entity.description}`.toLocaleLowerCase().includes(search)))
  }, [entities, filter, query])
  const disabled = loading || busy !== null || analyzing
  const selectedModel = llmModels.find(model => model.id === modelId && model.enabled)
  const editorReference = editor && !editor.removeReference && editor.entity ? entityReferenceUrl(editor.entity) : null

  function closeEditor() {
    invalidateAnalysis()
    setEditor(null)
  }

  async function analyzeReference() {
    if (!editor || !selectedModel || disabled || (!editor.file && !editorReference)) return
    if ([editor.name, editor.description, editor.continuityNotes, ...(!editor.entity ? [editor.handle] : [])].some(value => value.trim()) && !window.confirm(t('aiReplaceConfirm'))) return
    const draft = editor
    const version = ++editorVersion.current
    const controller = new AbortController()
    analysisController.current = controller
    setAnalyzing(true)
    setError(null)
    try {
      const result = draft.file
        ? await entityLibraryApi.analyzeReference(draft.file, draft.kind, modelId, controller.signal)
        : await entityLibraryApi.analyzeExistingReference(draft.entity!.id, modelId, controller.signal)
      if (!alive.current || controller.signal.aborted || version !== editorVersion.current) return
      if (!draft.file && draft.entity && (
        (result.revision !== undefined && result.revision !== draft.entity.revision) ||
        (result.referenceUploadId !== undefined && result.referenceUploadId !== draft.entity.reference?.uploadId)
      )) throw new Error(t('aiStaleReference'))
      setEditor(current => current ? {
        ...current, name: result.suggestion.name, description: result.suggestion.description,
        continuityNotes: result.suggestion.continuityNotes,
        ...(!current.entity ? { handle: result.suggestion.handle, autoHandle: true } : {}),
      } : current)
    } catch (cause) {
      if (alive.current && !controller.signal.aborted && version === editorVersion.current) setError(cause)
    } finally {
      if (alive.current && version === editorVersion.current) { setAnalyzing(false); analysisController.current = null }
    }
  }

  function replaceEntity(entity: EntityLibraryEntity) {
    setEntities(current => {
      const key = entityKey(entity)
      return current.some(item => entityKey(item) === key)
        ? current.map(item => entityKey(item) === key ? entity : item)
        : [...current, entity]
    })
  }

  async function perform(key: string, action: () => Promise<void>, successKey: SuccessKey = 'notifySaved') {
    if (operationLock.current || loading) return
    operationLock.current = true
    setBusy(key)
    setError(null)
    setSuccess(null)
    try {
      await action()
      if (alive.current) {
        if (onNotify) onNotify(notification('entityLibrary', successKey))
        else setSuccess(successKey)
      }
    } catch (cause) { if (alive.current) setError(cause) }
    finally {
      operationLock.current = false
      if (alive.current) setBusy(null)
    }
  }

  function openEditor(entity: EntityLibraryEntity | null) {
    if (disabled || entity?.kind === 'character' || entity?.source) return
    invalidateAnalysis()
    setHandleEditor(null)
    setError(null)
    setSuccess(null)
    setEditor({ entity, kind: entity?.kind ?? 'item', name: entity?.name ?? '', handle: '',
      description: entity?.description ?? '', continuityNotes: entity?.continuityNotes ?? '',
      file: null, removeReference: false, autoHandle: false, savedMetadata: null })
  }

  async function saveAsset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (disabled || !editor || !editor.name.trim()) return
    const draft = editor
    await perform(draft.entity ? entityKey(draft.entity) : 'create', async () => {
      let asset = draft.entity
      if (!asset || draft.savedMetadata !== metadataKey(draft)) {
        const result = asset
          ? await entityLibraryApi.update(asset.id, {
            name: draft.name.trim(), description: draft.description, continuityNotes: draft.continuityNotes, revision: asset.revision,
          })
          : await entityLibraryApi.create({
            kind: draft.kind, name: draft.name.trim(), description: draft.description, continuityNotes: draft.continuityNotes,
            ...(draft.handle.trim() ? { handle: draft.handle.trim(), autoHandle: draft.autoHandle } : {}),
          })
        asset = result.asset
        if (!alive.current) return
        replaceEntity(asset)
        setEditor(current => current ? { ...current, entity: asset, savedMetadata: metadataKey(draft) } : current)
      }
      try {
        if (draft.file) asset = (await entityLibraryApi.uploadReference(asset.id, draft.file)).asset
        else if (draft.removeReference && asset.reference) asset = (await entityLibraryApi.removeReference(asset.id)).asset
      } catch (cause) {
        throw new Error(`${t('metadataSavedReferenceFailed')} ${errorMessage(cause)}`)
      }
      if (!alive.current) return
      replaceEntity(asset)
      closeEditor()
    })
  }

  async function saveHandle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!handleEditor || !handleEditor.handle.trim()) return
    const draft = handleEditor
    await perform(entityKey(draft.entity), async () => {
      const result = await entityLibraryApi.updateHandle(draft.entity.kind, draft.entity.id, draft.handle.trim())
      if (!alive.current) return
      replaceEntity(result.entity)
      setHandleEditor(null)
    })
  }

  async function deleteAsset(entity: EntityLibraryEntity) {
    if (entity.kind === 'character' || disabled || !window.confirm(`${t('deleteConfirm')}\n\n${entity.name} (@${entity.handle})`)) return
    await perform(entityKey(entity), async () => {
      await entityLibraryApi.remove(entity.id)
      if (!alive.current) return
      setEntities(current => current.filter(item => entityKey(item) !== entityKey(entity)))
      if (editor?.entity?.id === entity.id) setEditor(null)
      if (handleEditor?.entity.id === entity.id) setHandleEditor(null)
    }, 'notifyDeleted')
  }

  async function uploadReference(entity: EntityLibraryEntity, file: File) {
    if (entity.kind === 'character') return
    await perform(entityKey(entity), async () => {
      const result = await entityLibraryApi.uploadReference(entity.id, file)
      if (alive.current) replaceEntity(result.asset)
    })
  }

  async function removeReference(entity: EntityLibraryEntity) {
    if (entity.kind === 'character') return
    await perform(entityKey(entity), async () => {
      const result = await entityLibraryApi.removeReference(entity.id)
      if (alive.current) replaceEntity(result.asset)
    })
  }

  return (
    <div className="page-content entity-library-page" data-testid="entity-library-page">
      <section className="page-heading">
        <div><h1>{t('title')}</h1><p>{t('subtitle')}</p></div>
        <div className="entity-library-heading-actions">
          <button type="button" className="secondary-button" disabled={disabled} onClick={() => setReload(current => current + 1)}><RefreshCw size={17} aria-hidden="true" />{t('refresh')}</button>
          <button type="button" className="primary-small-button" disabled={disabled} onClick={() => openEditor(null)} data-testid="entity-library-create">
            <Plus size={17} aria-hidden="true" />{t('create')}
          </button>
        </div>
      </section>

      <p className="entity-library-help"><AtSign size={18} aria-hidden="true" />{t('libraryCharacters')}</p>

      {error != null && <div className="form-error entity-library-error" role="alert">
        <p>{errorMessage(error)}</p>
        <button type="button" className="secondary-button" disabled={disabled} onClick={() => setReload(current => current + 1)}>{t('retry')}</button>
      </div>}
      {success && <p className="entity-library-success" role="status">{t(success)}</p>}

      {editor && <form ref={editorElement} className="entity-library-editor" onSubmit={saveAsset} aria-labelledby={`${fieldId}-editor-title`} data-testid="entity-library-editor">
        <div className="entity-library-editor-heading">
          <h2 id={`${fieldId}-editor-title`}>{editor.entity ? t('edit') : t('create')}</h2>
          <button type="button" className="secondary-button" aria-label={t('cancel')} disabled={loading || busy !== null} onClick={closeEditor}><X size={17} /></button>
        </div>
        <section className="entity-library-draft-reference" aria-label={t('reference')}>
          <div className="entity-library-draft-preview">
            {previewUrl || editorReference ? <img src={previewUrl || editorReference!} alt={t('reference')} /> : <><ImagePlus size={32} /><span>{t('noReference')}</span></>}
          </div>
          <div className="entity-library-draft-controls">
            <div className="entity-library-upload">
              <label className={`secondary-button${disabled ? ' is-disabled' : ''}`}>
                <ImagePlus size={16} />{editor.file || editorReference ? t('replaceReference') : t('upload')}
                <input type="file" accept={IMAGE_TYPES.join(',')} disabled={disabled} aria-label={t('upload')} data-testid="entity-library-draft-file" onChange={event => {
                  const file = event.currentTarget.files?.[0]
                  event.currentTarget.value = ''
                  if (!file) return
                  if (!IMAGE_TYPES.includes(file.type)) { setError(new Error(t('supportedFormats'))); return }
                  invalidateAnalysis()
                  setError(null)
                  setEditor({ ...editor, file, removeReference: false })
                }} />
              </label>
              {(editor.file || editorReference) && <button type="button" className="secondary-button" disabled={disabled} onClick={() => {
                invalidateAnalysis()
                setEditor({ ...editor, file: null, removeReference: true })
              }}><X size={15} />{t('clearReference')}</button>}
            </div>
            <p>{t('supportedFormats')}</p>
            <p>{t('draftReferenceHint')}</p>
            <label htmlFor={`${fieldId}-ai-model`}>{t('aiModel')}
              <select id={`${fieldId}-ai-model`} value={modelId} disabled={disabled} onChange={event => { invalidateAnalysis(); setModelId(event.target.value) }} data-testid="entity-library-ai-model">
                <option value="">{t('aiChooseModel')}</option>
                {llmModels.filter(model => model.enabled).map(model => <option key={model.id} value={model.id}>{model.displayName} · {model.providerName}</option>)}
              </select>
            </label>
            <p>{t('aiVisionNotice')}</p>
            <p>{t('aiDisclosure')}{selectedModel ? ` ${selectedModel.providerName} · ${selectedModel.displayName}` : ''}</p>
            <button type="button" className="secondary-button" data-testid="entity-library-ai" disabled={disabled || !selectedModel || (!editor.file && !editorReference)} onClick={() => void analyzeReference()}>
              {analyzing && <LoaderCircle size={16} className="spin" />}{analyzing ? t('aiAnalyzing') : t('aiFill')}
            </button>
            {analyzing && <span role="status">{t('aiAnalyzing')}</span>}
          </div>
        </section>
        <div className="entity-library-form-grid">
          <label htmlFor={`${fieldId}-name`}>{t('name')}
            <input id={`${fieldId}-name`} name="name" required maxLength={200} value={editor.name} disabled={disabled} onChange={event => setEditor({ ...editor, name: event.target.value })} />
          </label>
          <label htmlFor={`${fieldId}-kind`}>{t('kind')}
            <select id={`${fieldId}-kind`} name="kind" value={editor.kind} disabled={disabled || !!editor.entity} onChange={event => setEditor({ ...editor, kind: event.target.value as LibraryAssetKind })}>
              <option value="item">{t('item')}</option><option value="logo">{t('logo')}</option><option value="location">{t('location')}</option>
            </select>
          </label>
          {!editor.entity && <label className="entity-library-form-wide" htmlFor={`${fieldId}-handle`}>{t('handle')}
            <input id={`${fieldId}-handle`} name="handle" maxLength={80} autoCapitalize="none" autoCorrect="off" spellCheck={false} value={editor.handle} disabled={disabled} aria-describedby={`${fieldId}-handle-hint`} onChange={event => setEditor({ ...editor, handle: event.target.value, autoHandle: false })} />
            <small id={`${fieldId}-handle-hint`}>{t('handleHint')}</small>
          </label>}
          <label className="entity-library-form-wide" htmlFor={`${fieldId}-description`}>{t('description')}
            <textarea id={`${fieldId}-description`} name="description" maxLength={5000} rows={3} value={editor.description} disabled={disabled} onChange={event => setEditor({ ...editor, description: event.target.value })} />
          </label>
          <label className="entity-library-form-wide" htmlFor={`${fieldId}-continuity`}>{t('continuity')}
            <textarea id={`${fieldId}-continuity`} name="continuityNotes" maxLength={5000} rows={3} value={editor.continuityNotes} disabled={disabled} onChange={event => setEditor({ ...editor, continuityNotes: event.target.value })} />
          </label>
        </div>
        <div className="entity-library-form-actions">
          <button type="button" className="secondary-button" disabled={loading || busy !== null} onClick={closeEditor}>{t('cancel')}</button>
          <button type="submit" className="primary-small-button" disabled={disabled || !editor.name.trim()}>{busy ? <><LoaderCircle className="spin" size={16} />{t('busy')}</> : t('save')}</button>
        </div>
      </form>}

      <div className="entity-library-toolbar">
        <div className="entity-library-filters" role="group" aria-label={t('kind')}>
          {FILTERS.map(kind => <button type="button" key={kind} aria-pressed={filter === kind} className={filter === kind ? 'active' : ''} onClick={() => setFilter(kind)} data-testid={`entity-library-filter-${kind}`}>
            {t(kind)}<span>{entities.filter(entity => kind === 'all' || entity.kind === kind).length}</span>
          </button>)}
        </div>
        <label className="entity-library-search" htmlFor={`${fieldId}-search`}>
          <Search size={17} aria-hidden="true" />
          <input id={`${fieldId}-search`} type="search" aria-label={t('search')} placeholder={t('searchPlaceholder')} value={query} onChange={event => setQuery(event.target.value)} data-testid="entity-library-search" />
        </label>
      </div>

      <section aria-busy={loading} aria-label={t('title')}>
        {loading ? <div className="empty-state" role="status"><LoaderCircle size={28} className="spin" /><h2>{t('loading')}</h2></div>
          : visible.length ? <div className="entity-library-grid">
            {visible.map(entity => {
              const key = entityKey(entity)
              const editingHandle = handleEditor?.entity.id === entity.id && handleEditor.entity.kind === entity.kind
              return <article id={`entity-${entity.id}`} key={key} className="entity-library-card" data-testid="entity-library-card" data-entity-id={entity.id} data-entity-kind={entity.kind}>
                <ReferenceThumbnail entity={entity} />
                <div className="entity-library-card-body">
                  <h2 title={entity.name}>{entity.name}</h2>
                  {entity.source && <p>{t('linkedSource')} · <a href={entity.source.kind === 'project' ? `/?page=studio&project=${encodeURIComponent(entity.source.scopeId)}` : `/?page=timeline&session=${encodeURIComponent(entity.source.scopeId)}`}>{t('openSource')}</a></p>}
                  {Boolean(entity.referenceViews?.length) && <div className="project-source-strip">{entity.referenceViews!.map(view=><figure key={view.id}><img src={`/api/uploads/${encodeURIComponent(view.uploadId)}`} alt={view.label||entity.name} style={{width:96,height:72,objectFit:'cover'}}/><figcaption>{view.label||t('defaultView')}</figcaption></figure>)}</div>}
                  <p className="entity-library-handle" title={`@${entity.handle}`}>@{entity.handle}</p>
                  {entity.description && <p className="entity-library-description">{displayEntityDescription(entity)}</p>}
                  {entity.continuityNotes && <div className="entity-library-continuity"><strong>{t('continuity')}</strong><p>{entity.continuityNotes}</p></div>}

                  {editingHandle && handleEditor && <form className="entity-library-handle-editor" onSubmit={saveHandle}>
                    <label htmlFor={`${fieldId}-${entity.id}-handle`}>{t('handle')}</label>
                    <input id={`${fieldId}-${entity.id}-handle`} name="handle" required maxLength={80} autoCapitalize="none" autoCorrect="off" spellCheck={false} value={handleEditor.handle} disabled={disabled} aria-describedby={`${fieldId}-${entity.id}-hint`} onChange={event => setHandleEditor({ ...handleEditor, handle: event.target.value })} />
                    <small id={`${fieldId}-${entity.id}-hint`}>{t('handleHint')}</small>
                    <div className="entity-library-form-actions">
                      <button type="button" className="secondary-button" disabled={disabled} onClick={() => setHandleEditor(null)}>{t('cancel')}</button>
                      <button type="submit" className="primary-small-button" disabled={disabled || !handleEditor.handle.trim()}>{t('save')}</button>
                    </div>
                  </form>}

                  <div className="entity-library-card-actions">
                    <button type="button" className="secondary-button" disabled={disabled} onClick={() => { closeEditor(); setHandleEditor({ entity, handle: entity.handle }) }} aria-label={`${t('edit')} — ${t('handle')} — ${entity.name}`}><AtSign size={15} />{t('handle')}</button>
                    {entity.kind !== 'character' && !entity.source && <>
                      <button type="button" className="secondary-button" disabled={disabled} onClick={() => openEditor(entity)} aria-label={`${t('edit')} — ${entity.name}`}><Pencil size={15} />{t('edit')}</button>
                      <button type="button" className="secondary-button entity-library-danger" disabled={disabled} onClick={() => void deleteAsset(entity)} aria-label={`${t('remove')} — ${entity.name}`}><Trash2 size={15} />{t('remove')}</button>
                    </>}
                  </div>
                  {entity.kind !== 'character' && !entity.source && <div className="entity-library-upload">
                    <label htmlFor={`${fieldId}-${entity.id}-reference`} className={`secondary-button${disabled ? ' is-disabled' : ''}`}>
                      <ImagePlus size={16} aria-hidden="true" />{t('upload')}
                      <input id={`${fieldId}-${entity.id}-reference`} type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={disabled} aria-label={`${t('upload')} — ${entity.name}`} onChange={event => {
                        const file = event.currentTarget.files?.[0]
                        event.currentTarget.value = ''
                        if (file) void uploadReference(entity, file)
                      }} />
                    </label>
                    {entity.reference && <button type="button" className="secondary-button" disabled={disabled} onClick={() => void removeReference(entity)} aria-label={`${t('clearReference')} — ${entity.name}`}><X size={15} />{t('clearReference')}</button>}
                    <p>{t('referenceHint')}</p>
                  </div>}
                  {busy === key && <p className="entity-library-card-status" role="status"><LoaderCircle size={15} className="spin" />{t('busy')}</p>}
                </div>
              </article>
            })}
          </div> : <div className="empty-state"><Boxes size={32} /><h2>{entities.length ? t('mentionEmpty') : t('empty')}</h2></div>}
      </section>
    </div>
  )
}
