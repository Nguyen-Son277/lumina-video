import { useMemo } from 'react'
import { Building2, Film, Layers3, LoaderCircle } from 'lucide-react'
import '../styles/bulk-video-settings.css'
import type { ReactNode } from 'react'
import type { GenerationParamsInput, ModelInfo } from '../api/types'
import { completeSceneVideoParams, sceneVideoDurationValid } from '../../shared/sceneVideoParams'
import { ProviderModelFields } from './generation/ProviderModelFields'
import { VideoProviderControls } from './generation/VideoProviderControls'
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
    <div className="project-bulk-video-modal bulk-config-modal">
      <fieldset className="project-bulk-video-settings" disabled={busy || readOnly}>
        <legend className="bulk-config-sr-only">{t('sceneBulkVideoSettings')}</legend>
        <section className="bulk-config-scope"><Layers3 size={22} aria-hidden="true" /><div><strong>{t('bulkSettingsScopeTitle')}<span className="bulk-config-count">{targetCount}</span></strong>
        <p className="project-hint">
          {selectedCount > 0
            ? t('bulkSettingsScopeSelected', { count: selectedCount })
            : t('bulkSettingsScopeMissing', { count: targetCount })}
        </p>
        </div></section>
        <p className="bulk-config-intro">{t('bulkSettingsDraftHint')}</p>
        {targetCount <= 0 && <p className="project-hint" role="status">{t('bulkSettingsNoTargets')}</p>}
        <section className="bulk-config-section"><h3><Building2 size={18} aria-hidden="true" />{t('bulkSettingsProviderTitle')}</h3>
        <div className="project-field-row">
          <ProviderModelFields
            models={models}
            providerOptions={providers}
            providerId={providerId}
            modelId={modelId}
            onProviderChange={onProviderChange}
            onModelChange={onModelChange}
            providerLabel={t('sceneProviderLabel')}
            modelLabel={t('videoModelLabel')}
            chooseProviderLabel={t('sceneChooseProvider')}
            chooseModelLabel={t('sceneChooseModel')}
            unavailableModelLabel={t('sceneModelUnavailable')}
          />
        </div>
        </section>
        {modelId && !model && <p className="form-error" role="alert">{t('sceneModelUnavailable')}</p>}
        {model && parsedParams && <section className="bulk-config-section"><h3><Film size={18} aria-hidden="true" />{t('bulkSettingsParamsTitle')}</h3>
        <VideoProviderControls model={model} higgsfieldKey={model.id} value={effectiveParams as GenerationParamsInput} onChange={next => onParamsChange(JSON.stringify(next, null, 2))} />
        </section>}
        {invalidDraft && <p className="form-error" role="alert">{t('advancedParamsMustBeObject')}</p>}
        {model && <details className="project-advanced">
          <summary>{t('advancedJsonSummary')}</summary>
          <textarea value={params} spellCheck={false} onChange={event => onParamsChange(event.target.value)} />
        </details>}
        <p className="project-hint">{t('sceneBulkSharedMediaHint')}</p>
        <p className="project-hint">{t('sceneBulkApplyVideoSettingsHint')}</p>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="project-actions bulk-config-actions">
          <p>{t('bulkSettingsNoGeneration')}</p>
          <button type="button" className="secondary-button bulk-config-close" disabled={busy} onClick={onClose}>{t('close')}</button>
          <button type="button" className="bulk-config-apply" disabled={cannotApply} onClick={onApply}>
            {busy && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
            {busy ? t('bulkSettingsSaving') : t('sceneBulkApplyVideoSettings')}
          </button>
        </div>
      </fieldset>
    </div>
  </SceneEditorModal>
}

export default BulkVideoSettingsModal
