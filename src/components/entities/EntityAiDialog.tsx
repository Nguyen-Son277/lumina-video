import { useEffect, useId, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { errorMessage } from '../../api/client'
import type { EntityKind, EntityLibraryEntity } from '../../api/entityLibrary'
import type { ModelInfo } from '../../api/types'
import { useTranslation } from '../../i18n'
import { entityCreationCatalog } from '../../i18n/catalogs/entityCreation'
import { EntityCard } from './EntityCard'
import { EntityDetailsDialog } from './EntityDetailsDialog'
import type { EntityDetailsData } from './types'
import { CreationModal, IMAGE_TYPES, type EntityDialogCallbacks } from './EntityEditorDialog'
import { useEntityCreation, type CreationCandidate, type CreationIssue } from './useEntityCreation'
import { useEntityPreferences } from './useEntityPreferences'
import { EntityImageSettings } from './EntityImageSettings'
import '../../styles/entity-creation.css'

export interface EntityAiDialogProps extends EntityDialogCallbacks {
  kind: EntityKind
  llmModels: ModelInfo[]
  models: ModelInfo[]
  existingEntity?: EntityLibraryEntity | null
  rememberKind?: boolean
  /** Image editor source, retained server-side without downloading through the browser. */
  initialSource?: { uploadId: string; url: string }
  modalZIndex?: number
}
export function EntityAiDialog(props: EntityAiDialogProps) {
  return <EntityAiForm {...props}/>
}
function EntityAiForm({ kind: initialKind, rememberKind, llmModels, models, existingEntity, initialSource, modalZIndex, onClose, onSaved, onOpenSettings, onRegisterNavigationGuard }: EntityAiDialogProps) {
  const { t, locale } = useTranslation(entityCreationCatalog)
  const preferences = useEntityPreferences()
  const { count, modelId, imageModelId, autoSave, size, quality } = preferences.settings
  const includeImages = !!existingEntity || preferences.settings.includeImages
  const [kind, setKind] = useState(initialKind)
  const hydratedKind = useRef(false)
  useEffect(() => {
    if (preferences.loaded && !hydratedKind.current) {
      hydratedKind.current = true
      if (rememberKind && !existingEntity) setKind(preferences.settings.kind)
      else if (!existingEntity && initialKind !== preferences.settings.kind) preferences.update({ kind: initialKind })
    }
  }, [preferences.loaded, rememberKind, existingEntity, preferences.settings.kind])
  const [description, setDescription] = useState('')
  const [sourceFile, setSourceFile] = useState<File | null>(null)
  const [retainedSource, setRetainedSource] = useState(initialSource)
  const sourcePresent = !!sourceFile || !!retainedSource
  const [preview, setPreview] = useState<string | null>(null)
  const [invalidFile, setInvalidFile] = useState(false)
  const [detailsId, setDetailsId] = useState<string | null>(null)
  const [leave, setLeave] = useState<{action:()=>void} | null>(null)
  const creation = useEntityCreation({ onSaved: () => onSaved(), confirmChanged: () => window.confirm(t('changed')) })
  const latest = useRef({ dirty: false, running: false })
  latest.current = { dirty: !!description || sourcePresent || creation.candidates.some(candidate => candidate.status !== 'saved'), running: creation.running }
  const guardRef = useRef((action:()=>void) => { if (latest.current.dirty || latest.current.running) setLeave({action}); else action() })
  useEffect(() => { onRegisterNavigationGuard?.(action => guardRef.current(action)); return () => onRegisterNavigationGuard?.(null) }, [onRegisterNavigationGuard])
  useEffect(() => {
    const listener = (event: BeforeUnloadEvent) => { if (latest.current.dirty || latest.current.running) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', listener); return () => window.removeEventListener('beforeunload', listener)
  }, [])
  useEffect(() => { const url = sourceFile ? URL.createObjectURL(sourceFile) : null; setPreview(url); return () => { if (url) URL.revokeObjectURL(url) } }, [sourceFile])
  const textModel = llmModels.find(model => model.enabled && model.kind === 'llm' && model.id === modelId)
  const hasImageSource = sourcePresent || !!existingEntity?.reference
  const imageModel = models.find(model => model.enabled && model.kind === 'image' && model.id === imageModelId && (!hasImageSource || model.imageReferenceSupport !== 'no'))
  const activeCandidates = creation.candidates.filter(candidate => creation.activeCandidateIds.includes(candidate.candidateId))
  const imagesInActiveRun = activeCandidates.some(candidate => candidate.run.includeImages)
  const imageLabels = { queued: 'imageQueued', sending: 'imageSending', generating: 'imaging', publishing: 'imagePublishing', saving: 'imageSaving' } as const
  const activeImagePhases = activeCandidates.map(candidate => candidate.imagePhase).filter(Boolean)
  const activityLabel = creation.phase === 'upload' ? t('uploadingSource') : creation.phase === 'text' ? t(sourcePresent ? 'analyzingSource' : 'writingProfiles')
    : creation.phase === 'save' ? t('saving')
    : activeImagePhases.length && activeImagePhases.every(phase => phase === 'saving' || phase === 'publishing') ? t('imageSaving') : t('imaging')
  const activityCount = creation.summary.total > 0 && imagesInActiveRun ? t('imagesCompleted', { count: creation.summary.completed, total: creation.summary.total }) : ''
  const hasStopped = !creation.running && creation.candidates.some(candidate => candidate.status === 'stopped')
  function issueText(issue: CreationIssue) { return issue.key ? t(issue.key) : errorMessage(issue.cause) }
  function data(candidate: CreationCandidate): EntityDetailsData {
    const draft = candidate.draft
    return { id: candidate.candidateId, kind: draft.kind, name: draft.input.name,
      description: draft.kind === 'character' ? draft.input.appearance : draft.input.description,
      handle: draft.kind !== 'character' ? draft.input.handle : undefined,
      imageUrl: candidate.assetUrl ?? candidate.sourcePreview ?? (candidate.run.existingEntity ? candidate.run.existingEntity.reference?.url : undefined),
      imageStatus: creation.running && creation.activeCandidateIds.includes(candidate.candidateId) && candidate.run.includeImages && candidate.imagePhase
        ? { phase: candidate.imagePhase, label: t(imageLabels[candidate.imagePhase]), progress: candidate.progress } : undefined,
      sections: draft.kind === 'character' ? Object.entries(draft.input.voice).map(([label, value]) => ({ label: t(label as keyof typeof draft.input.voice), value })) : [{ label: t('continuity'), value: draft.input.continuityNotes }],
      badges: [{ label: t(candidate.status) }] }
  }
  function actions(candidate: CreationCandidate) {
    const terminalImage = candidate.issue?.key === 'aiImageFailed' || candidate.issue?.key === 'aiNoAsset'
    return <>
      {candidate.status !== 'saved' && <button type="button" disabled={creation.running || (candidate.run.includeImages && !candidate.assetUrl)} onClick={() => void creation.act(candidate.candidateId, 'save')}>{candidate.createdId ? t('retrySave') : t('save')}</button>}
      {candidate.run.includeImages && candidate.status !== 'saved' && !terminalImage && <button type="button" disabled={creation.running} onClick={() => void creation.act(candidate.candidateId, 'resume')}>{t('resume')}</button>}
      {candidate.publicationStatus === 'failed' && <button type="button" disabled={creation.running} onClick={() => void creation.act(candidate.candidateId, 'publication')}>{t('publication')}</button>}
      {candidate.run.includeImages && <button type="button" disabled={creation.running} onClick={() => { if (window.confirm(t('newImageConfirm'))) void creation.act(candidate.candidateId, 'new-image') }}>{t('newImage')}</button>}
    </>
  }
  const details = creation.candidates.find(candidate => candidate.candidateId === detailsId)
  const formId = useId()
  const canSubmit = !preferences.loaded || (!existingEntity && (!textModel || (!description.trim() && !sourcePresent))) || (includeImages && !imageModel)
  const headerActions = creation.running
    ? <button type="button" onClick={event => { event.preventDefault(); creation.stop() }}>{t('stop')}</button>
    : <button type="submit" form={formId} className="primary-small-button" disabled={canSubmit}>{t('generate')}</button>
  return <>
    <CreationModal title={t(existingEntity ? 'illustrate' : 'aiTitle')} testId="entity-ai-dialog" zIndex={modalZIndex} onClose={() => guardRef.current(onClose)} headerActions={headerActions}>
      <form id={formId} aria-busy={creation.running} onSubmit={event => { event.preventDefault(); if (!preferences.loaded || creation.running || (!existingEntity && !textModel) || (includeImages && !imageModel)) return; void creation.generate({ kind, description, count: sourcePresent || existingEntity ? 1 : count, language: locale, modelId, imageModelId, size, quality, includeImages, autoSave: initialSource ? false : autoSave, sourceFile, initialSource: sourceFile ? undefined : retainedSource, existingEntity: existingEntity ?? undefined }) }}>
        <div className="entity-creation-scroll">
          {creation.running && <div className="entity-ai-activity" role="status" aria-live="polite" data-testid="entity-ai-progress" data-phase={creation.phase}>
            <LoaderCircle size={23} className="shared-entity-spinner" aria-hidden="true"/>
            <div><strong>{activityLabel}</strong>{activityCount && <p>{activityCount}</p>}{creation.summary.failed > 0 && <p>{t('imagesFailed', { count: creation.summary.failed })}</p>}</div>
          </div>}
          {hasStopped && <p className="entity-creation-hint" role="status">{t('stoppedNotice')}</p>}
          <p className="entity-creation-hint" role="status">{t(!preferences.loaded ? 'preferencesLoading' : preferences.saving ? 'preferencesSaving' : 'preferencesHint')}</p>
          {preferences.error != null && <div role="alert" className="form-error"><p>{t('preferencesError')}</p><button type="button" onClick={preferences.retry}>{t('retryPreferences')}</button></div>}
          <h3 className="entity-creation-section-title">{t('inputSection')}</h3>
          {!existingEntity && <label>{t('kind')}<select value={kind} disabled={creation.running || !preferences.loaded || !!initialSource} onChange={event => { const next = event.target.value as EntityKind; setKind(next); preferences.update({ kind: next }) }} data-testid="entity-ai-kind">{(['character', 'item', 'logo', 'location'] as const).map(value => <option key={value} value={value}>{t(value)}</option>)}</select></label>}
          {!existingEntity && <label>{t('description')}<textarea name="description" maxLength={2000} rows={4} value={description} disabled={creation.running} onChange={event => setDescription(event.target.value)}/></label>}
          <label>{t('reference')}<input type="file" accept={IMAGE_TYPES.join(',')} disabled={creation.running} data-testid="entity-ai-source" onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (!file) return; if (!IMAGE_TYPES.includes(file.type)) { setInvalidFile(true); return } setInvalidFile(false); setSourceFile(file) }}/></label>
          {preview && <div><img className="entity-creation-source-preview" src={preview} alt={t('reference')}/><button type="button" disabled={creation.running} onClick={() => setSourceFile(null)}>{t('clear')}</button></div>}
          {!preview && retainedSource && <div><img className="entity-creation-source-preview" src={retainedSource.url} alt={t('reference')}/><button type="button" disabled={creation.running} onClick={() => setRetainedSource(undefined)}>{t('clear')}</button></div>}
          {invalidFile && <p role="alert" className="form-error">{t('invalidFile')}</p>}
          <p className="entity-creation-hint">{t('fileHint')}</p>
          <h3 className="entity-creation-section-title">{t('aiSettings')}</h3>
          {!existingEntity && <><label>{t('count')}<input type="number" min={1} max={6} value={sourcePresent ? 1 : count} disabled={creation.running || !preferences.loaded || sourcePresent} onChange={event => preferences.update({ count: Math.max(1, Math.min(6, Math.floor(Number(event.target.value) || 1))) })}/></label>{sourcePresent && <p>{t('sourceOne')}</p>}<label>{t('llm')}<select value={modelId} disabled={creation.running || !preferences.loaded} onChange={event => preferences.update({ modelId: event.target.value })} data-testid="entity-ai-llm"><option value="">{t('chooseModel')}</option>{modelId && !textModel && <option value={modelId}>{t('unavailableModel')}</option>}{llmModels.filter(model => model.enabled && model.kind === 'llm').map(model => <option key={model.id} value={model.id}>{model.displayName} · {model.providerName}</option>)}</select></label></>}
          {!existingEntity && <label className="entity-creation-checkbox"><input type="checkbox" checked={includeImages} disabled={creation.running || !preferences.loaded} onChange={event => preferences.update({ includeImages: event.target.checked })}/>{t('includeImages')}</label>}
          {includeImages && <label>{t('imageModel')}<select value={imageModelId} disabled={creation.running || !preferences.loaded} onChange={event => preferences.update({ imageModelId: event.target.value })} data-testid="entity-ai-image-model"><option value="">{t('chooseModel')}</option>{imageModelId && !imageModel && <option value={imageModelId}>{t('unavailableModel')}</option>}{models.filter(model => model.enabled && model.kind === 'image' && (!hasImageSource || model.imageReferenceSupport !== 'no')).map(model => <option key={model.id} value={model.id}>{model.displayName} · {model.providerName}</option>)}</select></label>}
          {includeImages && <EntityImageSettings size={size} quality={quality} model={imageModel} disabled={creation.running || !preferences.loaded} onChange={preferences.update}/>}
          {!existingEntity && !initialSource && <label className="entity-creation-checkbox"><input type="checkbox" checked={autoSave} disabled={creation.running || !preferences.loaded} onChange={event => preferences.update({ autoSave: event.target.checked })}/>{t('autoSave')}</label>}
          <p className="entity-creation-hint">{t('disclosure')}</p><p className="entity-creation-hint">{t('stopHint')}</p>
          <button type="button" onClick={() => guardRef.current(onOpenSettings)}>{t('settings')}</button>
          {creation.issue && <p role="alert" className="form-error">{issueText(creation.issue)}</p>}
          {creation.candidates.length > 0 && <h3 className="entity-creation-section-title">{t('resultsSection')}</h3>}
          <div className="entity-creation-candidates">{creation.candidates.map(candidate => <EntityCard key={candidate.candidateId} data={data(candidate)} onDetails={() => setDetailsId(candidate.candidateId)} actions={actions(candidate)} metadata={<>{candidate.issue && <p role="alert">{issueText(candidate.issue)}{candidate.issue.key && candidate.issue.cause != null ? ` ${errorMessage(candidate.issue.cause)}` : ''}</p>}</>}/>)}</div>
        </div>{creation.running && <footer><span className="entity-ai-footer-activity" data-testid="entity-ai-footer-progress"><LoaderCircle size={17} className="shared-entity-spinner" aria-hidden="true"/>{activityLabel}{activityCount ? ` · ${activityCount}` : ''}</span></footer>}
      </form>
    </CreationModal>
    {details && <EntityDetailsDialog data={data(details)} modalZIndex={modalZIndex === undefined ? undefined : modalZIndex + 1} onClose={() => setDetailsId(null)} actions={actions(details)}/>}
    {leave && <CreationModal title={t('dirtyTitle')} testId="entity-ai-leave-dialog" zIndex={modalZIndex === undefined ? undefined : modalZIndex + 1} onClose={() => setLeave(null)}><p>{t('leaveAi')}</p><footer><button type="button" onClick={() => setLeave(null)}>{t('stay')}</button><button type="button" onClick={() => { creation.stop(); const action = leave.action; setLeave(null); action() }}>{t('discard')}</button><button type="button" disabled={creation.running || !creation.candidates.length || creation.candidates.some(candidate => candidate.run.includeImages && !candidate.assetUrl)} onClick={() => { const action = leave.action; void (async () => { for (const candidate of creation.candidates) { if (candidate.status !== 'saved' && !await creation.act(candidate.candidateId, 'save')) return } setLeave(null); action() })() }}>{t('saveLeave')}</button></footer></CreationModal>}
  </>
}
