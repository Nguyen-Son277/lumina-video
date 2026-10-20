import { useEffect, useRef, useState } from 'react'
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
import '../../styles/entity-creation.css'

export interface EntityAiDialogProps extends EntityDialogCallbacks {
  kind: EntityKind
  llmModels: ModelInfo[]
  models: ModelInfo[]
  existingEntity?: EntityLibraryEntity | null
}
export function EntityAiDialog(props: EntityAiDialogProps) {
  const [selectedKind, setSelectedKind] = useState(props.kind)
  return <EntityAiForm key={selectedKind} {...props} kind={selectedKind} onChangeKind={setSelectedKind}/>
}
function EntityAiForm({ kind, llmModels, models, existingEntity, onClose, onSaved, onOpenSettings, onRegisterNavigationGuard, onChangeKind }: EntityAiDialogProps & { onChangeKind: (kind: EntityKind) => void }) {
  const { t, locale } = useTranslation(entityCreationCatalog)
  const [description, setDescription] = useState('')
  const [count, setCount] = useState(1)
  const [modelId, setModelId] = useState('')
  const [imageModelId, setImageModelId] = useState('')
  const [includeImages, setIncludeImages] = useState(!!existingEntity)
  const [autoSave, setAutoSave] = useState(false)
  const [sourceFile, setSourceFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [invalidFile, setInvalidFile] = useState(false)
  const [detailsId, setDetailsId] = useState<string | null>(null)
  const [leave, setLeave] = useState<{action:()=>void} | null>(null)
  const creation = useEntityCreation({ onSaved: () => onSaved(), confirmChanged: () => window.confirm(t('changed')) })
  const latest = useRef({ dirty: false, running: false })
  latest.current = { dirty: !!description || !!sourceFile || creation.candidates.some(candidate => candidate.status !== 'saved'), running: creation.running }
  const guardRef = useRef((action:()=>void) => { if (latest.current.dirty || latest.current.running) setLeave({action}); else action() })
  useEffect(() => { onRegisterNavigationGuard?.(action => guardRef.current(action)); return () => onRegisterNavigationGuard?.(null) }, [onRegisterNavigationGuard])
  useEffect(() => {
    const listener = (event: BeforeUnloadEvent) => { if (latest.current.dirty || latest.current.running) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', listener); return () => window.removeEventListener('beforeunload', listener)
  }, [])
  useEffect(() => { const url = sourceFile ? URL.createObjectURL(sourceFile) : null; setPreview(url); return () => { if (url) URL.revokeObjectURL(url) } }, [sourceFile])
  const textModel = llmModels.find(model => model.enabled && model.id === modelId)
  const hasImageSource = !!sourceFile || !!existingEntity?.reference
  const imageModel = models.find(model => model.enabled && model.kind === 'image' && model.id === imageModelId && (!hasImageSource || model.imageReferenceSupport !== 'no'))
  function issueText(issue: CreationIssue) { return issue.key ? t(issue.key) : errorMessage(issue.cause) }
  function data(candidate: CreationCandidate): EntityDetailsData {
    const draft = candidate.draft
    return { id: candidate.candidateId, kind: draft.kind, name: draft.input.name,
      description: draft.kind === 'character' ? draft.input.appearance : draft.input.description,
      handle: draft.kind !== 'character' ? draft.input.handle : undefined,
      imageUrl: candidate.assetUrl ?? candidate.sourcePreview,
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
  return <>
    <CreationModal title={t(existingEntity ? 'illustrate' : 'aiTitle')} testId="entity-ai-dialog" onClose={() => guardRef.current(onClose)}>
      <form onSubmit={event => { event.preventDefault(); if (creation.running || (!existingEntity && !textModel) || (includeImages && !imageModel)) return; void creation.generate({ kind, description, count: sourceFile || existingEntity ? 1 : count, language: locale, modelId, imageModelId, includeImages: includeImages || !!existingEntity, autoSave, sourceFile, existingEntity: existingEntity ?? undefined }) }}>
        <div className="entity-creation-scroll">
          {!existingEntity && <label>{t('kind')}<select value={kind} disabled={creation.running} onChange={event => { const next = event.target.value as EntityKind; guardRef.current(() => onChangeKind(next)) }} data-testid="entity-ai-kind">{(['character', 'item', 'logo', 'location'] as const).map(value => <option key={value} value={value}>{t(value)}</option>)}</select></label>}
          {!existingEntity && <label>{t('description')}<textarea name="description" maxLength={2000} rows={4} value={description} disabled={creation.running} onChange={event => setDescription(event.target.value)}/></label>}
          <label>{t('reference')}<input type="file" accept={IMAGE_TYPES.join(',')} disabled={creation.running} data-testid="entity-ai-source" onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (!file) return; if (!IMAGE_TYPES.includes(file.type)) { setInvalidFile(true); return } setInvalidFile(false); setSourceFile(file); setCount(1) }}/></label>
          {preview && <div><img className="entity-creation-source-preview" src={preview} alt={t('reference')}/><button type="button" disabled={creation.running} onClick={() => setSourceFile(null)}>{t('clear')}</button></div>}
          {invalidFile && <p role="alert" className="form-error">{t('invalidFile')}</p>}
          <p className="entity-creation-hint">{t('fileHint')}</p>
          {!existingEntity && <><label>{t('count')}<input type="number" min={1} max={6} value={sourceFile ? 1 : count} disabled={creation.running || !!sourceFile} onChange={event => setCount(Math.max(1, Math.min(6, Math.floor(Number(event.target.value) || 1))))}/></label>{sourceFile && <p>{t('sourceOne')}</p>}<label>{t('llm')}<select value={modelId} disabled={creation.running} onChange={event => setModelId(event.target.value)} data-testid="entity-ai-llm"><option value="">{t('chooseModel')}</option>{llmModels.filter(model => model.enabled).map(model => <option key={model.id} value={model.id}>{model.displayName} · {model.providerName}</option>)}</select></label></>}
          {!existingEntity && <label className="entity-creation-checkbox"><input type="checkbox" checked={includeImages} disabled={creation.running} onChange={event => setIncludeImages(event.target.checked)}/>{t('includeImages')}</label>}
          {includeImages && <label>{t('imageModel')}<select value={imageModelId} disabled={creation.running} onChange={event => setImageModelId(event.target.value)} data-testid="entity-ai-image-model"><option value="">{t('chooseModel')}</option>{models.filter(model => model.enabled && model.kind === 'image' && (!hasImageSource || model.imageReferenceSupport !== 'no')).map(model => <option key={model.id} value={model.id}>{model.displayName} · {model.providerName}</option>)}</select></label>}
          {!existingEntity && <label className="entity-creation-checkbox"><input type="checkbox" checked={autoSave} disabled={creation.running} onChange={event => setAutoSave(event.target.checked)}/>{t('autoSave')}</label>}
          <p className="entity-creation-hint">{t('disclosure')}</p><p className="entity-creation-hint">{t('stopHint')}</p>
          <button type="button" onClick={() => guardRef.current(onOpenSettings)}>{t('settings')}</button>
          {creation.issue && <p role="alert" className="form-error">{issueText(creation.issue)}</p>}
          <div className="entity-creation-candidates">{creation.candidates.map(candidate => <EntityCard key={candidate.candidateId} data={data(candidate)} onDetails={() => setDetailsId(candidate.candidateId)} actions={actions(candidate)} metadata={<>{candidate.progress != null && <progress max={100} value={candidate.progress}/>} {candidate.issue && <p role="alert">{issueText(candidate.issue)}{candidate.issue.key && candidate.issue.cause != null ? ` ${errorMessage(candidate.issue.cause)}` : ''}</p>}</>}/>)}</div>
        </div><footer><button type="button" onClick={() => guardRef.current(onClose)}>{t('close')}</button>{creation.running ? <button key="stop" type="button" onClick={event => { event.preventDefault(); creation.stop() }}>{t('stop')}</button> : <button key="generate" type="submit" className="primary-small-button" disabled={(!existingEntity && (!textModel || (!description.trim() && !sourceFile))) || (includeImages && !imageModel)}>{t('generate')}</button>}</footer>
      </form>
    </CreationModal>
    {details && <EntityDetailsDialog data={data(details)} onClose={() => setDetailsId(null)} actions={actions(details)}/>}
    {leave && <CreationModal title={t('dirtyTitle')} testId="entity-ai-leave-dialog" onClose={() => setLeave(null)}><p>{t('leaveAi')}</p><footer><button type="button" onClick={() => setLeave(null)}>{t('stay')}</button><button type="button" onClick={() => { creation.stop(); const action = leave.action; setLeave(null); action() }}>{t('discard')}</button><button type="button" disabled={creation.running || !creation.candidates.length || creation.candidates.some(candidate => candidate.run.includeImages && !candidate.assetUrl)} onClick={() => { const action = leave.action; void (async () => { for (const candidate of creation.candidates) { if (candidate.status !== 'saved' && !await creation.act(candidate.candidateId, 'save')) return } setLeave(null); action() })() }}>{t('saveLeave')}</button></footer></CreationModal>}
  </>
}
