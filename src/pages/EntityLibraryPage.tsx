import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { AtSign, Boxes, BrainCircuit, Copy, ImagePlus, LoaderCircle, Pencil, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react'
import { ApiError, errorMessage } from '../api/client'
import { characterApi } from '../api/endpoints'
import { entityLibraryApi, type EntityKind, type EntityLibraryEntity } from '../api/entityLibrary'
import type { CharacterUsage, ProjectCharacter } from '../api/projectTypes'
import type { ModelInfo } from '../api/types'
import { notification, useTranslation, type Notification } from '../i18n'
import { entityLibraryCatalog } from '../i18n/catalogs/entityLibrary'
import { charactersCatalog } from '../i18n/catalogs/characters'
import type { EntityLibraryFilter, SelectedEntityRef } from '../entityLibraryLocation'
import { CharacterIllustrateModal } from '../components/CharacterIllustrateModal'
import { CharacterPromptModal } from '../components/CharacterPromptModal'
import { useModalLayer } from '../components/Lightbox'
import { EntityCard } from '../components/entities/EntityCard'
import { EntityDetailsDialog } from '../components/entities/EntityDetailsDialog'
import { EntityEditorDialog } from '../components/entities/EntityEditorDialog'
import { EntityAiDialog } from '../components/entities/EntityAiDialog'
import { entityCardData, entityKey, useEntityLibrary } from '../components/entities/useEntityLibrary'
import type { EntityDetailsData } from '../components/entities/types'
import '../styles/entity-library.css'

const FILTERS: EntityLibraryFilter[] = ['all', 'character', 'item', 'location', 'logo']
type Guard = ((action: () => void) => void) | null
export interface EntityLibraryPageProps {
  llmModels: ModelInfo[]
  models: ModelInfo[]
  onNotify: (message: Notification) => void
  onOpenSettings: () => void
  filter: EntityLibraryFilter
  selectedEntity: SelectedEntityRef | null
  onLocationChange: (kind: EntityLibraryFilter, selected: SelectedEntityRef | null) => void
  onRegisterNavigationGuard?: (guard: Guard) => void
}

/** The catalog is the list source; character writes always use their native DTO. */
export function EntityLibraryPage({ llmModels, models, onNotify, onOpenSettings, filter, selectedEntity, onLocationChange, onRegisterNavigationGuard }: EntityLibraryPageProps) {
  const { t } = useTranslation(entityLibraryCatalog)
  const { t: tc } = useTranslation(charactersCatalog)
  const catalog = useEntityLibrary()
  const fieldId = useId()
  const [query, setQuery] = useState('')
  const [editor, setEditor] = useState<{ kind: EntityKind; entity?: EntityLibraryEntity } | null>(null)
  const [ai, setAi] = useState<{ kind: EntityKind; existingEntity?: EntityLibraryEntity } | null>(null)
  const [handle, setHandle] = useState<EntityLibraryEntity | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const lock = useRef(false)
  const [error, setError] = useState<unknown>(null)
  const [character, setCharacter] = useState<ProjectCharacter | null>(null)
  const [characterLoading, setCharacterLoading] = useState(false)
  const [characterError, setCharacterError] = useState<unknown>(null)
  const [detailRevision, setDetailRevision] = useState(0)
  const [illustration, setIllustration] = useState<ProjectCharacter | null>(null)
  const [prompt, setPrompt] = useState<ProjectCharacter | null>(null)
  const [trashTarget, setTrashTarget] = useState<EntityLibraryEntity | null>(null)
  const [recentlyTrashed, setRecentlyTrashed] = useState(false)
  const [inUse, setInUse] = useState<{ entity: EntityLibraryEntity; usage: CharacterUsage } | null>(null)
  const guard = useRef<Guard>(null)
  const registerGuard = useCallback((next: Guard) => {
    const wrapped: Guard = next ? action => next(() => { setEditor(null); setAi(null); action() }) : null
    guard.current = wrapped
    onRegisterNavigationGuard?.(wrapped)
  }, [onRegisterNavigationGuard])
  useEffect(() => () => onRegisterNavigationGuard?.(null), [onRegisterNavigationGuard])
  const guarded = (action: () => void) => guard.current ? guard.current(action) : action()
  const selected = selectedEntity ? catalog.entities.find(entity => entity.id === selectedEntity.id && (!selectedEntity.kind || entity.kind === selectedEntity.kind)) : undefined
  const selectedKey = selected ? entityKey(selected) : ''
  useEffect(() => {
    setCharacter(null); setCharacterError(null)
    if (!selected || selected.kind !== 'character') { setCharacterLoading(false); return }
    const controller = new AbortController()
    setCharacterLoading(true)
    characterApi.get(selected.id, controller.signal).then(result => { if (!controller.signal.aborted) setCharacter(result.character) })
      .catch(cause => { if (!controller.signal.aborted) setCharacterError(cause) })
      .finally(() => { if (!controller.signal.aborted) setCharacterLoading(false) })
    return () => controller.abort()
  }, [selectedKey, selected?.revision, detailRevision])
  const visible = useMemo(() => {
    const search = query.trim().replace(/^[@#]/, '').toLocaleLowerCase()
    return catalog.entities.filter(entity => (filter === 'all' || entity.kind === filter) && (!search || `${entity.name}\n${entity.handle}\n${entity.description}\n${entity.continuityNotes}`.toLocaleLowerCase().includes(search)))
  }, [catalog.entities, filter, query])
  const defaultKind = filter === 'all' ? 'character' : filter
  const disabled = busy !== null
  async function perform(key: string, action: () => Promise<void>) {
    if (lock.current) return
    lock.current = true; setBusy(key); setError(null)
    try { await action() } catch (cause) { setError(cause) } finally { lock.current = false; setBusy(null) }
  }
  function closeDetails() { onLocationChange(filter, null) }
  function saved(entity?: Pick<EntityLibraryEntity, 'id' | 'kind'>) {
    void catalog.refresh(); setDetailRevision(value => value + 1)
    if (entity && editor?.entity && editor.entity.kind !== entity.kind) onLocationChange(entity.kind, null)
    onNotify(notification('entityLibrary', 'notifySaved'))
  }
  function openEditor(entity: EntityLibraryEntity) { guarded(() => { closeDetails(); setEditor({ kind: entity.kind, entity }) }) }
  async function nativeAction(entity: EntityLibraryEntity, action: 'illustrate' | 'prompt') {
    await perform(entityKey(entity), async () => {
      const result = await characterApi.get(entity.id)
      closeDetails()
      if (action === 'illustrate') setIllustration(result.character); else setPrompt(result.character)
    })
  }
  async function remove(entity: EntityLibraryEntity, detach = false) {
    await perform(entityKey(entity), async () => {
      try {
        if (entity.kind === 'character') await characterApi.remove(entity.id, { detach })
        else await entityLibraryApi.remove(entity.id)
      } catch (cause) {
        if (cause instanceof ApiError && cause.messageKey === 'characters.in_use') {
          const usage = (cause.details as { usage?: CharacterUsage } | undefined)?.usage
          if (usage && Array.isArray(usage.scenes) && Array.isArray(usage.canvas)) { closeDetails(); setTrashTarget(null); setInUse({ entity, usage }); return }
        }
        throw cause
      }
      catalog.remove(entity); closeDetails(); setInUse(null); setTrashTarget(null); setRecentlyTrashed(true)
      onNotify(notification('entityLibrary', 'notifyDeleted'))
    })
  }
  function sourceLink(entity: EntityLibraryEntity) {
    return entity.source && <p className="entity-library-source"><span>{t('linkedSource')}</span><a href={entity.source.kind === 'project' ? `/?page=studio&project=${encodeURIComponent(entity.source.scopeId)}` : `/?page=timeline&session=${encodeURIComponent(entity.source.scopeId)}`}>{t('openSource')}</a></p>
  }
  function actions(entity: EntityLibraryEntity, detail = false) {
    return <>
      {detail && <button type="button" className="secondary-button" disabled={disabled} onClick={() => { closeDetails(); setHandle(entity) }}><AtSign size={15} />{t('handle')}</button>}
      {!entity.source && <>
        <button type="button" className="secondary-button" disabled={disabled} aria-label={`${t('edit')} — ${entity.name}`} onClick={() => openEditor(entity)}><Pencil size={15} />{t('edit')}</button>
        {detail && <>
          <button type="button" className="secondary-button" disabled={disabled} onClick={() => entity.kind === 'character' ? void nativeAction(entity, 'illustrate') : (closeDetails(), setAi({ kind: entity.kind, existingEntity: entity }))}><ImagePlus size={15} />{t('illustrate')}</button>
          {entity.kind === 'character' && <button type="button" className="secondary-button" disabled={disabled} onClick={() => void nativeAction(entity, 'prompt')}><Copy size={15} />{t('prompt')}</button>}
        </>}
        <button type="button" className="secondary-button entity-library-danger" disabled={disabled} aria-label={`${t('remove')} — ${entity.name}`} data-testid={detail ? 'entity-detail-trash' : 'entity-card-trash'} onClick={() => guarded(() => { closeDetails(); setError(null); setTrashTarget(entity) })}><Trash2 size={15} />{t('remove')}</button>
      </>}
    </>
  }
  function usageGroups(usage: CharacterUsage) {
    const groups = new Map<string, { name: string; state: 'active' | 'archived' | 'trashed'; scenes: string[]; canvas: number }>()
    const entry = (item: CharacterUsage['scenes'][number] | CharacterUsage['canvas'][number]) => {
      if (!groups.has(item.projectId)) groups.set(item.projectId, { name: item.projectName, state: item.projectState, scenes: [], canvas: 0 })
      return groups.get(item.projectId)!
    }
    usage.scenes.forEach(item => entry(item).scenes.push(item.sceneTitle))
    usage.canvas.forEach(item => { entry(item).canvas++ })
    return [...groups].map(([id, group]) => ({ id, ...group }))
  }
  const detailData: EntityDetailsData | null = selected ? {
    ...entityCardData(selected), handle: `${selected.kind === 'character' ? '@' : '#'}${selected.handle}`,
    sections: selected.kind === 'character' && character?.id === selected.id ? [
      ...(['language', 'accent', 'pitch', 'timbre', 'pace', 'articulation', 'habits'] as const).filter(key => character.voice[key]).map(key => ({ label: t(({ language: 'voiceLanguage', accent: 'voiceAccent', pitch: 'voicePitch', timbre: 'voiceTimbre', pace: 'voicePace', articulation: 'voiceArticulation', habits: 'voiceHabits' } as const)[key]), value: character.voice[key] })),
    ] : selected.continuityNotes ? [{ label: t('continuity'), value: selected.continuityNotes }] : [],
  } : null
  return <div className="page-content entity-library-page" data-testid="entity-library-page">
    <section className="page-heading"><div><h1>{t('title')}</h1><p>{t('subtitle')}</p></div><div className="entity-library-heading-actions">
      <button type="button" className="secondary-button" disabled={catalog.loading || disabled} onClick={() => guarded(() => { void catalog.refresh() })}><RefreshCw size={17} />{t('refresh')}</button>
      <button type="button" className="secondary-button" disabled={disabled} onClick={() => guarded(() => setAi({ kind: defaultKind }))} data-testid="entity-library-ai-create"><BrainCircuit size={17} />{t('aiCreate')}</button>
      <button type="button" className="primary-small-button" disabled={disabled} onClick={() => guarded(() => setEditor({ kind: defaultKind }))} data-testid="entity-library-create"><Plus size={17} />{t('addIdentity')}</button>
    </div></section>
    <p className="entity-library-help"><AtSign size={18} />{t('libraryCharacters')}</p>
    {recentlyTrashed && <div className="notice-banner" role="status" data-testid="entity-trash-success"><span>{t('notifyDeleted')}</span> <a href="/?page=trash" data-testid="entity-open-trash" onClick={event => { event.preventDefault(); guarded(() => { window.location.assign('/?page=trash') }) }}>{t('openTrash')}</a></div>}
    {(error || catalog.error) != null && <div className="form-error entity-library-error" role="alert"><p>{errorMessage(error || catalog.error)}</p><button type="button" className="secondary-button" onClick={() => { setError(null); void catalog.refresh() }}>{t('retry')}</button></div>}
    <div className="entity-library-toolbar"><div className="entity-library-filters" role="group" aria-label={t('kind')}>
      {FILTERS.map(kind => <button type="button" key={kind} aria-pressed={filter === kind} className={filter === kind ? 'active' : ''} onClick={() => guarded(() => { setQuery(''); onLocationChange(kind, null) })} data-testid={`entity-library-filter-${kind}`}>{t(kind)}<span>{catalog.entities.filter(entity => kind === 'all' || entity.kind === kind).length}</span></button>)}
    </div><label className="entity-library-search" htmlFor={`${fieldId}-search`}><Search size={17} /><input id={`${fieldId}-search`} type="search" aria-label={t('search')} placeholder={t('searchPlaceholder')} value={query} onChange={event => setQuery(event.target.value)} data-testid="entity-library-search" /></label></div>
    <section aria-busy={catalog.loading} aria-label={t('title')}>
      {catalog.loading ? <div className="empty-state" role="status"><LoaderCircle size={28} className="spin" /><h2>{t('loading')}</h2></div> : visible.length ? <div className="entity-library-grid">
        {visible.map(entity => <EntityCard key={entityKey(entity)} id={`entity-${entity.id}`} className="entity-library-card" testId="entity-library-card" data={{ ...entityCardData(entity), handle: `${entity.kind === 'character' ? '@' : '#'}${entity.handle}`, badges: entity.source ? [{ label: t('linkedSource') }] : entity.projectId ? [{ label: t('projectScope') }] : [] }} onDetails={() => guarded(() => onLocationChange(filter, { id: entity.id, kind: entity.kind }))} actions={actions(entity)} />)}
      </div> : <div className="empty-state"><Boxes size={32} /><h2>{catalog.entities.length ? t('mentionEmpty') : t('empty')}</h2></div>}
    </section>
    {!catalog.loading && !catalog.error && selectedEntity && !selected && <div className="notice-banner" role="status"><p>{t('missingEntity')}</p><button type="button" className="secondary-button" onClick={closeDetails}>{t('close')}</button></div>}
    {selected && detailData && <EntityDetailsDialog data={detailData} onClose={closeDetails} loading={characterLoading} error={characterError || error ? errorMessage(characterError || error) : null} onRetry={characterError ? () => setDetailRevision(value => value + 1) : undefined} metadata={sourceLink(selected)} actions={actions(selected, true)} />}
    {editor && <EntityEditorDialog kind={editor.kind} entity={editor.entity} llmModels={llmModels} onClose={() => setEditor(null)} onConverted={entity => { void catalog.refresh(); onLocationChange(entity.kind, null) }} onSaved={saved} onOpenSettings={onOpenSettings} onNotify={onNotify} onRegisterNavigationGuard={registerGuard} />}
    {ai && <EntityAiDialog rememberKind={filter === 'all'} kind={ai.kind} existingEntity={ai.existingEntity} llmModels={llmModels} models={models} onClose={() => setAi(null)} onSaved={saved} onOpenSettings={onOpenSettings} onNotify={onNotify} onRegisterNavigationGuard={registerGuard} />}
    {handle && <HandleDialog entity={handle} onClose={() => setHandle(null)} onSaved={entity => { catalog.replace(entity); setHandle(null); onNotify(notification('entityLibrary', 'notifySaved')) }} />}
    {illustration && <CharacterIllustrateModal character={illustration} models={models} onClose={() => setIllustration(null)} onAttached={() => { setIllustration(null); saved() }} onNotify={onNotify} />}
    {prompt && <CharacterPromptModal character={prompt} onClose={() => setPrompt(null)} onNotify={onNotify} />}
    {trashTarget && <UsageDialog title={t('remove')} busy={disabled} onClose={() => setTrashTarget(null)} testId="entity-trash-confirm-dialog">
      <p><strong>{trashTarget.name}</strong></p><p>{t('deleteConfirm')}</p><p data-testid="entity-trash-retention">{t('trashRetention')}</p>
      {error != null && <div className="form-error" role="alert">{errorMessage(error)}</div>}
      <div className="modal-actions"><button type="button" className="secondary-button" disabled={disabled} data-testid="entity-trash-cancel" onClick={() => setTrashTarget(null)}>{t('cancel')}</button><button type="button" className="primary-small-button" disabled={disabled} data-testid="entity-trash-confirm" onClick={() => void remove(trashTarget)}>{disabled ? t('busy') : t('remove')}</button></div>
    </UsageDialog>}
    {inUse && <UsageDialog title={tc('inUseTitle')} onClose={() => setInUse(null)} busy={disabled}>
      <p>{tc('inUseBody', { count: new Set([...inUse.usage.scenes, ...inUse.usage.canvas].map(item => item.projectId)).size })}</p>
      <ul className="character-usage-list">{usageGroups(inUse.usage).map(group => <li key={group.id}><div className="character-usage-head"><strong>{group.name}</strong><span className={`character-usage-state is-${group.state}`}>{tc(({ active: 'inUseStateActive', archived: 'inUseStateArchived', trashed: 'inUseStateTrashed' } as const)[group.state])}</span></div><p>{group.scenes.length ? tc('inUseScenes', { count: group.scenes.length }) : ''}{group.scenes.length && group.canvas ? ' · ' : ''}{group.canvas ? tc('inUseCanvas', { count: group.canvas }) : ''}</p>{group.scenes.length > 0 && <small>{tc('inUseSceneList', { titles: group.scenes.slice(0, 5).join(', ') })}</small>}</li>)}</ul>
      <p className="modal-warning">{tc('inUseNote')}</p>{error != null && <div className="form-error" role="alert">{errorMessage(error)}</div>}<div className="modal-actions"><button type="button" className="secondary-button" disabled={disabled} onClick={() => setInUse(null)}>{tc('inUseCancel')}</button><button type="button" className="primary-small-button" disabled={disabled} onClick={() => void remove(inUse.entity, true)}>{tc('inUseConfirm')}</button></div>
    </UsageDialog>}
  </div>
}

function UsageDialog({ title, busy, onClose, children, testId }: { title: string; busy: boolean; onClose: () => void; children: ReactNode; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const { t } = useTranslation(entityLibraryCatalog)
  useModalLayer(ref, () => { if (!busy) onClose() })
  return <div className="modal-backdrop"><div ref={ref} data-testid={testId} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className="modal-card project-modal"><div className="modal-header"><h2>{title}</h2><button type="button" className="close-button" disabled={busy} onClick={onClose} aria-label={t('close')}><X size={18} aria-hidden="true" /></button></div>{children}</div></div>
}
function HandleDialog({ entity, onClose, onSaved }: { entity: EntityLibraryEntity; onClose: () => void; onSaved: (entity: EntityLibraryEntity) => void }) {
  const { t } = useTranslation(entityLibraryCatalog)
  const [value, setValue] = useState(entity.handle)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const submitted = useRef(false)
  const id = useId()
  async function save(event: FormEvent) {
    event.preventDefault(); if (submitted.current) return
    submitted.current = true; setBusy(true); setError(null)
    try { onSaved((await entityLibraryApi.updateHandle(entity.kind, entity.id, value.trim())).entity) } catch (cause) { setError(cause) } finally { submitted.current = false; setBusy(false) }
  }
  return <UsageDialog title={t('handle')} busy={busy} onClose={onClose}><form onSubmit={save} className="modal-form"><label htmlFor={id}>{t('handle')}<input id={id} required maxLength={80} autoCapitalize="none" autoCorrect="off" spellCheck={false} value={value} disabled={busy} onChange={event => setValue(event.target.value)} /></label><p>{t('handleHint')}</p>{error != null && <div className="form-error" role="alert">{errorMessage(error)}</div>}<div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>{t('cancel')}</button><button type="submit" className="primary-small-button" disabled={busy || !value.trim()}>{t('save')}</button></div></form></UsageDialog>
}
