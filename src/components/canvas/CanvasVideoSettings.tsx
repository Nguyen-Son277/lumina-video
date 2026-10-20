import type { CanvasNode, CanvasNodeData } from '../../../shared/canvas'
import { completeSceneVideoParams, sceneVideoDefaults, sceneVideoDurationValid, sceneVideoStyle, switchSceneVideoParams } from '../../../shared/sceneVideoParams'
import { isAgnesFlash } from '../../../shared/videoApi'
import { AGNES_RESOLUTIONS, VIDEO_RATIOS, validVideoSeconds, videoResolutionLabel, videoSizeSelection } from '../../../shared/videoControls'
import { HIGGSFIELD_RATIOS } from '../../../shared/higgsfield'
import type { ModelInfo, GenerationParamsInput } from '../../api/types'
import type { ProjectScene } from '../../api/projectTypes'
import { useTranslation } from '../../i18n'
import { canvasCatalog } from '../../i18n/catalogs/canvas'
import { OpenAIVideoControls } from '../OpenAIVideoControls'
import './video-settings.css'

export type CanvasVideoSettingsProps = {
  node: CanvasNode
  models: ModelInfo[]
  scenes: ProjectScene[]
  hasImageInput?: boolean
  quick?: boolean
  disabled: boolean
  onChange: (patch: Partial<CanvasNodeData>) => void
}

/** Preserve same-protocol media/mode and stable settings; repair model-specific limits. */
function modelParams(model: ModelInfo, previous: Record<string, unknown>): Record<string, unknown> {
  const params = { ...completeSceneVideoParams(model, previous) }
  if (sceneVideoStyle(model) === 'higgsfield' && params.mode === 'image') { delete params.aspectRatio; delete params.outputFormat }
  const defaults = sceneVideoDefaults(model)
  const style = sceneVideoStyle(model)
  const oneOf = (key: string, options: readonly string[]) => {
    if (!options.includes(String(params[key]))) params[key] = defaults[key]
  }
  if (style === 'agnes') {
    oneOf('size', AGNES_RESOLUTIONS)
    oneOf('aspectRatio', VIDEO_RATIOS)
    if (!validVideoSeconds(params.seconds, isAgnesFlash(model.modelId) ? 12 : 30)) params.seconds = defaults.seconds
    else params.seconds = String(params.seconds)
    if (isAgnesFlash(model.modelId)) { params.size = '720P'; params.n = 1 }
  } else if (style === 'higgsfield') {
    oneOf('resolution', ['480p', '720p', '1080p'])
    oneOf('bitrateMode', ['standard', 'high'])
    if (!sceneVideoDurationValid(model, params)) params.duration = defaults.duration
    if (params.mode !== 'image') oneOf('aspectRatio', HIGGSFIELD_RATIOS)
  } else if (!validVideoSeconds(params.seconds)) params.seconds = defaults.seconds
  const keys = style === 'openai' ? ['size', 'seconds'] : style === 'agnes' ? ['mode', 'size', 'seconds', 'aspectRatio', 'n', 'seed'] : ['mode', 'duration', 'resolution', 'bitrateMode', 'generateAudio', 'aspectRatio', 'outputFormat']
  return Object.fromEntries(Object.entries(params).filter(([key]) => keys.includes(key)))
}

/** No uploads, consent, or input-mode changes: the canvas/backend owns media routing. */
export function CanvasVideoSettings({ node, models, scenes, hasImageInput = false, quick = false, disabled, onChange }: CanvasVideoSettingsProps) {
  const { t } = useTranslation(canvasCatalog)
  const available = models.filter(model => model.kind === 'video' && model.enabled)
  const scene = scenes.find(item => item.id === node.data.sceneId)
  const own = node.data.videoSettings
  const modelId = node.data.modelId || ''
  const model = available.find(item => item.id === modelId)
  const params = model ? completeSceneVideoParams(model, own?.params ?? scene?.params ?? {}) : own?.params ?? scene?.params ?? {}
  const providers = Array.from(new Map(available.map(item => [item.providerId, item.providerName])).entries())
  const locked = disabled || !model
  const save = (next: Record<string, unknown>) => {
    if (!locked && model) {
      const style = sceneVideoStyle(model)
      const keys = style === 'openai' ? ['size', 'seconds'] : style === 'agnes' ? ['mode', 'size', 'seconds', 'aspectRatio', 'n', 'seed'] : ['mode', 'duration', 'resolution', 'bitrateMode', 'generateAudio', 'aspectRatio', 'outputFormat']
      onChange({ videoSettings: { modelId: model.id, params: Object.fromEntries(Object.entries(next).filter(([key]) => keys.includes(key))) } })
    }
  }
  const choose = (next: ModelInfo, reset: boolean) => {
    if (disabled) return
    const nextParams = reset || !model || sceneVideoStyle(next) !== sceneVideoStyle(model)
      ? modelParams(next, switchSceneVideoParams(next, {}))
      : modelParams(next, params)
    onChange({ modelId: next.id, videoSettings: { modelId: next.id, params: nextParams } })
  }
  const style = model ? sceneVideoStyle(model) : undefined
  const imageMode = style === 'higgsfield' && (params.mode === 'image' || Boolean(own && hasImageInput))
  const duration = style === 'higgsfield' ? params.duration : params.seconds
  const openaiSize = style === 'openai' && typeof params.size === 'string' ? videoSizeSelection(params.size) : undefined
  const resolution = style === 'higgsfield' ? params.resolution : openaiSize && !openaiSize.legacy ? videoResolutionLabel(openaiSize.resolution) : params.size
  const display = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : '—'
  const select = (key: string, label: string, options: readonly string[], fixed = false) => <label className="canvas-video-settings__field">
    <span>{label}</span><select value={display(params[key])} disabled={fixed} onChange={event => save({ ...params, [key]: event.target.value })}>
      {!options.includes(display(params[key])) && <option value={display(params[key])}>{display(params[key])}</option>}
      {options.map(option => <option key={option} value={option}>{key === 'size' || key === 'resolution' ? videoResolutionLabel(option) : key === 'bitrateMode' ? t(option === 'high' ? 'videoBitrateHigh' : 'videoBitrateStandard') : option}</option>)}
    </select>
  </label>

  return <section className="canvas-video-settings nodrag nowheel" aria-label={t('videoSettingsTitle')} aria-busy={disabled}>
    <fieldset disabled={disabled} className="canvas-video-settings__fieldset">
      <legend>{t('videoSettingsTitle')}</legend>
      <div className="canvas-video-settings__grid">
        <label className="canvas-video-settings__field"><span>{t('videoProvider')}</span>
          <select value={model?.providerId ?? ''} disabled={!available.length} onChange={event => {
            const next = available.find(item => item.providerId === event.target.value)
            if (next) choose(next, true)
            else onChange({ modelId: null, videoSettings: undefined })
          }}>
            <option value="">{t('videoChooseProvider')}</option>
            {providers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <label className="canvas-video-settings__field"><span>{t('chooseModel')}</span>
          <select value={model?.id ?? ''} disabled={!available.length} onChange={event => {
            const next = available.find(item => item.id === event.target.value)
            if (next) choose(next, false)
          }}>
            {!model && <option value="">{modelId ? t('videoUnavailableModel', { model: modelId }) : t('runNeedsModel')}</option>}
            {available.filter(item => !model || item.providerId === model.providerId).map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}
          </select>
        </label>
      </div>
      {!available.length && <p role="status" className="canvas-video-settings__hint">{t('videoNoModels')}</p>}
      {modelId && !model && <p role="alert" className="canvas-video-settings__error">{t('videoUnavailableModel', { model: modelId })}</p>}
      {!quick && <div className="canvas-video-settings__source">
        <span>{t(own ? 'videoOwnSettings' : 'videoInheritedSettings')}</span>
        {own ? <button type="button" onClick={() => onChange({ videoSettings: undefined })}>{t('videoUseScene')}</button>
          : <button type="button" disabled={locked} onClick={() => model && save(modelParams(model, params))}>{t('videoUseOwnCopy')}</button>}
      </div>}
      {!own && !quick ? <>
        <p className="canvas-video-settings__hint">{scene ? t('videoSceneSource', { scene: scene.title }) : t('videoNoSceneSettings')}</p>
        {model && <dl className="canvas-video-settings__summary">
          <div><dt>{t('videoDuration')}</dt><dd>{display(duration)} {t('videoSeconds')}</dd></div>
          <div><dt>{t('videoResolution')}</dt><dd>{display(resolution)}</dd></div>
          {!(style === 'higgsfield' && params.mode === 'image') && <div><dt>{t('videoRatio')}</dt><dd>{display(style === 'openai' ? openaiSize && !openaiSize.legacy ? openaiSize.ratio : params.size : params.aspectRatio)}</dd></div>}
          {style === 'higgsfield' && <div><dt>{t('videoBitrate')}</dt><dd>{display(params.bitrateMode)}</dd></div>}
          {params.mode !== undefined && <div><dt>{t('videoInputMode')}</dt><dd>{display(params.mode)}</dd></div>}
        </dl>}
      </> : <fieldset disabled={locked} className="canvas-video-settings__fieldset">
        {style === 'openai' && <OpenAIVideoControls value={params as GenerationParamsInput} onChange={save} />}
        {(style === 'agnes' || style === 'higgsfield') && <div className="canvas-video-settings__grid">
          <label className="canvas-video-settings__field"><span>{t('videoDuration')}</span><input type="number" min={4} max={model && isAgnesFlash(model.modelId) ? 12 : 30} step={1} value={display(duration)} aria-invalid={model ? !sceneVideoDurationValid(model, params) : undefined} onChange={event => save({ ...params, [style === 'higgsfield' ? 'duration' : 'seconds']: style === 'higgsfield' ? Number(event.target.value) : event.target.value })} /></label>
          {style === 'agnes' ? <>
            {select('size', t('videoResolution'), AGNES_RESOLUTIONS, model && isAgnesFlash(model.modelId))}
            {select('aspectRatio', t('videoRatio'), VIDEO_RATIOS)}
          </> : <>
            {select('resolution', t('videoResolution'), ['480p', '720p', '1080p'])}
            {select('bitrateMode', t('videoBitrate'), ['standard', 'high'])}
            {!imageMode && select('aspectRatio', t('videoRatio'), HIGGSFIELD_RATIOS)}
            {imageMode && <p className="canvas-video-settings__hint">{t('videoRatioFromImage')}</p>}
          </>}
        </div>}
        {model && !sceneVideoDurationValid(model, params) && <p role="alert" className="canvas-video-settings__error">{t('videoInvalidDuration', { max: isAgnesFlash(model.modelId) ? 12 : 30 })}</p>}
        {params.mode !== undefined && <p className="canvas-video-settings__hint">{t('videoPreservedMode', { mode: display(params.mode) })}</p>}
      </fieldset>}
    </fieldset>
  </section>
}
