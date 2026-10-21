import type { ReactNode } from 'react'
import type { ModelInfo } from '../../api/types'

export type ProviderModelFieldsProps = {
  /** Callers decide eligibility (kind, enabled status and catalog scope). */
  models: readonly ModelInfo[]
  providerId: string
  modelId: string
  onProviderChange: (id: string) => void
  onModelChange: (id: string) => void
  providerLabel: ReactNode
  modelLabel: ReactNode
  chooseProviderLabel: ReactNode
  chooseModelLabel: ReactNode
  unavailableModelLabel?: ReactNode
  formatModelLabel?: (model: ModelInfo) => ReactNode
  providerOptions?: readonly (readonly [id: string, name: string])[]
  fieldClassName?: string
  providerFieldClassName?: string
  modelFieldClassName?: string
  hideProviderWhenEmpty?: boolean
  providerDisabled?: boolean
  modelDisabled?: boolean
  /** Preserve caller DOM order, e.g. a saved-model warning between fields. */
  betweenFields?: ReactNode
}

/** Controlled selectors only: never choose a default, reset a draft or persist a model. */
export function ProviderModelFields({
  models, providerId, modelId, onProviderChange, onModelChange,
  providerLabel, modelLabel, chooseProviderLabel, chooseModelLabel,
  unavailableModelLabel, formatModelLabel = model => `${model.displayName} · ${model.providerName} · ${model.modelId}`,
  providerOptions, fieldClassName = 'plan-cell', providerFieldClassName, modelFieldClassName,
  hideProviderWhenEmpty = false, providerDisabled, modelDisabled, betweenFields,
}: ProviderModelFieldsProps) {
  const providers = providerOptions ?? [...new Map(models.map(model => [model.providerId, model.providerName])).entries()]
  const missingModel = Boolean(modelId && !models.some(model => model.id === modelId))
  return <>
    {(!hideProviderWhenEmpty || providers.length > 0) && <label className={providerFieldClassName ?? fieldClassName}>
      <span>{providerLabel}</span>
      <select value={providerId} disabled={providerDisabled} onChange={event => onProviderChange(event.target.value)}>
        <option value="">{chooseProviderLabel}</option>
        {providers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select>
    </label>}
    {betweenFields}
    <label className={modelFieldClassName ?? fieldClassName}>
      <span>{modelLabel}</span>
      <select value={modelId} disabled={modelDisabled} onChange={event => onModelChange(event.target.value)}>
        <option value="">{chooseModelLabel}</option>
        {missingModel && unavailableModelLabel != null && <option value={modelId}>{unavailableModelLabel}</option>}
        {models.filter(model => model.providerId === providerId).map(model => <option key={model.id} value={model.id}>{formatModelLabel(model)}</option>)}
      </select>
    </label>
  </>
}
