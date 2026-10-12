import type { GenerationParamsInput, ModelInfo } from '../api/types'
import { inferVideoApiStyle, isAgnesFlash } from '../../shared/videoApi'
import { useTranslation } from '../i18n'
import { studioCatalog } from '../i18n/catalogs/studio'

export function usesAgnes(model?: ModelInfo): boolean {
  return Boolean(model && (model.videoApiStyle ?? inferVideoApiStyle(model.modelId)) === 'agnes')
}
const ratios = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']
const lines = (text: string) => text.split('\n')

/** Both quick creation and project scenes use this exact Agnes parameter surface. */
export function AgnesVideoControls({ model, value, onChange }: {
  model: ModelInfo
  value: GenerationParamsInput
  onChange: (next: GenerationParamsInput) => void
}) {
  const { t } = useTranslation(studioCatalog)
  const mode = value.mode ?? 'text'
  const change = (field: keyof GenerationParamsInput, next: unknown) => onChange({ ...value, [field]: next })
  return <div className="agnes-controls">
    <div className="controls-grid">
      <label className="select-control"><span>{t('agnesMode')}</span>
        <select value={mode} onChange={event => {
          const { firstFrame: _first, lastFrame: _last, referenceImages: _images, referenceAudios: _audios, ...rest } = value
          onChange({ ...rest, mode: event.target.value as GenerationParamsInput['mode'] })
        }}>
          <option value="text">{t('agnesText')}</option>
          <option value="keyframe">{t('agnesKeyframe')}</option>
          <option value="reference">{t('agnesReference')}</option>
        </select>
      </label>
      <label className="select-control"><span>{t('agnesSize')}</span>
        <input value={isAgnesFlash(model.modelId) ? '720P' : value.size ?? '720P'} disabled={isAgnesFlash(model.modelId)} onChange={event => change('size', event.target.value)} />
      </label>
      <label className="select-control"><span>{t('agnesRatio')}</span><select value={value.aspectRatio ?? '16:9'} onChange={event => change('aspectRatio', event.target.value)}>
        {ratios.map(ratio => <option key={ratio} value={ratio}>{ratio}</option>)}
      </select></label>
      <label className="select-control"><span>{t('durationLabel')}</span><select value={String(value.seconds ?? '5')} onChange={event => change('seconds', event.target.value)}>
        {Array.from({ length: 9 }, (_, i) => i + 4).map(seconds => <option key={seconds} value={String(seconds)}>{t('secondsOption', { count: seconds })}</option>)}
      </select></label>
      <label className="select-control"><span>{t('agnesSeed')}</span><input type="number" step="1" value={value.seed ?? ''} onChange={event => change('seed', event.target.value === '' ? undefined : Number(event.target.value))} /></label>
    </div>
    {mode === 'keyframe' && <div className="controls-grid">
      <label className="select-control"><span>{t('agnesFirst')}</span><input type="url" value={value.firstFrame ?? ''} onChange={event => change('firstFrame', event.target.value)} /></label>
      <label className="select-control"><span>{t('agnesLast')}</span><input type="url" value={value.lastFrame ?? ''} onChange={event => change('lastFrame', event.target.value)} /></label>
    </div>}
    {mode === 'reference' && <>
      <label className="select-control"><span>{t('agnesImages')}</span><textarea value={(value.referenceImages ?? []).join('\n')} onChange={event => change('referenceImages', lines(event.target.value))} /></label>
      <label className="select-control"><span>{t('agnesAudios')}</span><textarea value={(value.referenceAudios ?? []).join('\n')} onChange={event => change('referenceAudios', lines(event.target.value))} /></label>
    </>}
    <p className="project-hint">{t('agnesPublicHint')}</p>
  </div>
}

/** Drop fields from a previously selected mode; never send private references to Agnes. */
export function agnesInput(value: GenerationParamsInput, model: ModelInfo): GenerationParamsInput {
  const mode = value.mode ?? 'text'
  return {
    size: isAgnesFlash(model.modelId) ? '720P' : value.size ?? '720P',
    seconds: String(value.seconds ?? '5'), mode, aspectRatio: value.aspectRatio ?? '16:9', n: 1,
    useCharacterReference: false,
    ...(value.seed !== undefined ? { seed: value.seed } : {}),
    ...(mode === 'keyframe' ? { ...(value.firstFrame ? { firstFrame: value.firstFrame } : {}), ...(value.lastFrame ? { lastFrame: value.lastFrame } : {}) } : {}),
    ...(mode === 'reference' ? { referenceImages: (value.referenceImages ?? []).map(url => url.trim()).filter(Boolean), referenceAudios: (value.referenceAudios ?? []).map(url => url.trim()).filter(Boolean) } : {}),
  }
}
