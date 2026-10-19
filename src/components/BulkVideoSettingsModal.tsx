import { useMemo } from 'react'
import type { ReactNode } from 'react'
import type { GenerationParamsInput, ModelInfo } from '../api/types'
import { completeSceneVideoParams, sceneVideoDurationValid } from '../../shared/sceneVideoParams'
import { AgnesVideoControls, usesAgnes } from './AgnesVideoControls'
import { HiggsfieldVideoControls, usesHiggsfield } from './HiggsfieldVideoControls'
import { OpenAIVideoControls } from './OpenAIVideoControls'
import { SceneEditorModal } from './SceneEditorModal'
import { useTranslation } from '../i18n'
import { studioCatalog } from '../i18n/catalogs/studio'

export type BulkVideoSettingsModalProps = {
  models: ModelInfo[]
  providerId: string
  modelId: string
  params: string
  onProviderChange: (id: string) => void
  onModelChange: (id: string) => void
  onParamsChange: (text: string) => void
  onApply: () => void
  onClose: () => void
  busy: boolean
  readOnly: boolean
  error: ReactNode | null
  targetCount: number
  selectedCount: number
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="plan-cell"><span>{label}</span>{children}</label>
}

function parseParams(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text || '{}')
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

/** Controlled bulk video settings draft; all persistence and model switching belong to the parent. */
export function BulkVideoSettingsModal({
  models, providerId, modelId, params, onProviderChange, onModelChange, onParamsChange,
  onApply, onClose, busy, readOnly, error, targetCount, selectedCount,
}: BulkVideoSettingsModalProps) {
  const { t } = useTranslation(studioCatalog)
  const parsedParams = useMemo(() => parseParams(params), [params])
  const model = models.find(item => item.id === modelId)
  const providers = [...new Map(models.map(item => [item.providerId, item.providerName])).entries()]
  const effectiveParams = model ? completeSceneVideoParams(model, parsedParams ?? {}) : {}
  const durationInvalid = Boolean(model && !sceneVideoDurationValid(model, effectiveParams))
  const invalidDraft = !parsedParams
  const cannotApply = targetCount <= 0 || busy || readOnly || !model || invalidDraft || durationInvalid

  return <SceneEditorModal
    title={t('sceneBulkVideoSettings')}
    closeLabel={t('close')}
    closeDisabled={busy}
    onClose={onClose}
  >
    <div className="project-bulk-video-modal">
      <fieldset className="project-bulk-video-settings" disabled={busy || readOnly}>
        <legend>{t('sceneBulkVideoSettings')}</legend>
        <p className="project-hint">
          {selectedCount > 0
            ? t('bulkSettingsScopeSelected', { count: selectedCount })
            : t('bulkSettingsScopeMissing', { count: targetCount })}
        </p>
        <p className="project-hint">{t('bulkSettingsDraftHint')}</p>
        {targetCount <= 0 && <p className="project-hint" role="status">{t('bulkSettingsNoTargets')}</p>}
        <div className="project-field-row">
          <Field label={t('sceneProviderLabel')}>
            <select value={providerId} onChange={event => onProviderChange(event.target.value)}>
              <option value="">{t('sceneChooseProvider')}</option>
              {providers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </Field>
          <Field label={t('videoModelLabel')}>
            <select value={modelId} onChange={event => onModelChange(event.target.value)}>
              <option value="">{t('sceneChooseModel')}</option>
              {modelId && !model && <option value={modelId}>{t('sceneModelUnavailable')}</option>}
              {models.filter(item => item.providerId === providerId).map(item => <option key={item.id} value={item.id}>
                {item.displayName} · {item.providerName} · {item.modelId}
              </option>)}
            </select>
          </Field>
        </div>
        {modelId && !model && <p className="form-error" role="alert">{t('sceneModelUnavailable')}</p>}
        {model && parsedParams && (usesHiggsfield(model)
          ? <HiggsfieldVideoControls key={model.id} value={effectiveParams as GenerationParamsInput} onChange={next => onParamsChange(JSON.stringify(next, null, 2))} />
          : usesAgnes(model)
            ? <AgnesVideoControls model={model} value={effectiveParams as GenerationParamsInput} onChange={next => onParamsChange(JSON.stringify(next, null, 2))} />
            : <OpenAIVideoControls value={effectiveParams as GenerationParamsInput} onChange={next => onParamsChange(JSON.stringify(next, null, 2))} />)}
        {invalidDraft && <p className="form-error" role="alert">{t('advancedParamsMustBeObject')}</p>}
        {model && <details className="project-advanced">
          <summary>{t('advancedJsonSummary')}</summary>
          <textarea value={params} spellCheck={false} onChange={event => onParamsChange(event.target.value)} />
        </details>}
        <p className="project-hint">{t('sceneBulkSharedMediaHint')}</p>
        <p className="project-hint">{t('sceneBulkApplyVideoSettingsHint')}</p>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="project-actions">
          <button type="button" className="secondary-button" disabled={cannotApply} onClick={onApply}>
            {t('sceneBulkApplyVideoSettings')}
          </button>
        </div>
      </fieldset>
    </div>
  </SceneEditorModal>
}

export default BulkVideoSettingsModal
