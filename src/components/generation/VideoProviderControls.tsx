import type { Key } from 'react'
import type { GenerationParamsInput, ModelInfo } from '../../api/types'
import { AgnesVideoControls, usesAgnes } from '../AgnesVideoControls'
import { HiggsfieldVideoControls, usesHiggsfield } from '../HiggsfieldVideoControls'
import { OpenAIVideoControls } from '../OpenAIVideoControls'

export type VideoProviderControlsProps = {
  model: ModelInfo
  value: GenerationParamsInput
  onChange: (next: GenerationParamsInput) => void
  onUploadingChange?: (uploading: boolean) => void
  /** The caller owns remount policy; Quick keys every provider control. */
  controlKey?: Key
  /** Scene and bulk settings key only the upload-owning Higgsfield control. */
  higgsfieldKey?: Key
}

/** Presentation-only dispatch. Draft defaults, validation and persistence stay with callers. */
export function VideoProviderControls({
  model, value, onChange, onUploadingChange, controlKey, higgsfieldKey,
}: VideoProviderControlsProps) {
  if (usesHiggsfield(model)) return <HiggsfieldVideoControls
    key={higgsfieldKey ?? controlKey}
    value={value}
    onChange={onChange}
    onUploadingChange={onUploadingChange}
  />
  if (usesAgnes(model)) return <AgnesVideoControls key={controlKey} model={model} value={value} onChange={onChange} />
  return <OpenAIVideoControls key={controlKey} value={value} onChange={onChange} />
}
