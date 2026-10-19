import type { GenerationParamsInput } from '../api/types'
import { VIDEO_RATIOS, VIDEO_RESOLUTIONS, videoSizeFor, videoSizeSelection, videoResolutionLabel, validVideoSeconds, type VideoRatio, type VideoResolution } from '../../shared/videoControls'
import { useTranslation } from '../i18n'
import { studioCatalog } from '../i18n/catalogs/studio'

/** Shared by the single-scene editor and bulk configuration. */
export function OpenAIVideoControls({ value, onChange }: {
  value: GenerationParamsInput
  onChange: (next: GenerationParamsInput) => void
}) {
  const { t } = useTranslation(studioCatalog)
  const size = typeof value.size === 'string' ? value.size : '1280x720'
  const selection = videoSizeSelection(size)
  const seconds = String(value.seconds ?? '4')
  const invalid = !validVideoSeconds(seconds)
  const change = (key: string, next: unknown) => onChange({ ...value, [key]: next })
  return <>
    <div className="project-field-row">
      <label className="plan-cell"><span>{t('videoRatio')}</span><select value={selection.legacy ? size : selection.ratio} onChange={event => change('size', videoSizeFor(event.target.value as VideoRatio, selection.resolution))}>
        {selection.legacy && <option value={size}>{t('videoLegacySize', { size })}</option>}
        {VIDEO_RATIOS.map(ratio => <option key={ratio} value={ratio}>{ratio}</option>)}
      </select></label>
      <label className="plan-cell"><span>{t('videoResolution')}</span><select value={selection.legacy ? size : selection.resolution} onChange={event => change('size', videoSizeFor(selection.ratio, event.target.value as VideoResolution))}>
        {selection.legacy && <option value={size}>{t('videoLegacySize', { size })}</option>}
        {VIDEO_RESOLUTIONS.map(resolution => <option key={resolution} value={resolution}>{videoResolutionLabel(resolution)}</option>)}
      </select></label>
      <label className="plan-cell"><span>{t('durationLabel')}</span><input type="number" min={4} max={30} step={1} value={seconds} aria-invalid={invalid} onChange={event => change('seconds', event.target.value)} /></label>
    </div>
    {invalid && <p role="alert" className="form-error">{t('videoSecondsInvalid', { max: 30 })}</p>}
    <p className="project-hint">{t('videoProviderLimitsHint')}</p>
  </>
}
