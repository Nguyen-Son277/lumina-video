import { useMemo, useState } from 'react'
import { Building2, Film, Image as ImageIcon, LoaderCircle } from 'lucide-react'
import '../styles/quick-generation-settings.css'
import type { GenerationParamsInput, ModelInfo } from '../api/types'
import { IMAGE_RATIOS, IMAGE_RESOLUTIONS, imageSizeFor, imageSizeSelection, type ImageRatio, type ImageResolution } from '../../shared/imageControls'
import { sanitizeQuickSettings, type QuickSettings } from '../../shared/quickGenerationPreferences'
import { inferVideoApiStyle, isAgnesFlash } from '../../shared/videoApi'
import { ProviderModelFields } from './generation/ProviderModelFields'
import { VideoProviderControls } from './generation/VideoProviderControls'
import { SceneEditorModal } from './SceneEditorModal'
import { useTranslation } from '../i18n'
import { studioCatalog } from '../i18n/catalogs/studio'

export type QuickGenerationSettingsModalProps = {
  models: ModelInfo[]
  mode: 'image' | 'video'
  initialSettings: QuickSettings
  initialMediaParams?: Record<string, unknown>
  onSave: (settings: QuickSettings, mediaParams?: Record<string, unknown>) => Promise<void>
  onClose: () => void
}

const VIDEO_KEYS: Record<string, Set<string>> = {
  openai: new Set(['modelId', 'params', 'size', 'seconds']),
  agnes: new Set(['modelId', 'params', 'mode', 'size', 'seconds', 'n', 'aspectRatio', 'seed']),
  higgsfield: new Set(['modelId', 'params', 'mode', 'duration', 'resolution', 'bitrateMode', 'generateAudio', 'aspectRatio', 'outputFormat']),
}
const MEDIA_KEYS = new Set(['firstFrame', 'lastFrame', 'referenceImages', 'referenceAudios', 'imageUrl', 'endImageUrl', 'imageUploadId', 'endImageUploadId', 'imageAssetId', 'endImageAssetId', 'useCharacterReference'])
const imageQualities = ['', 'low', 'medium', 'high']
const styleOf = (model: ModelInfo) => model.videoApiStyle ?? inferVideoApiStyle(model.modelId)
const stableParams = (params: Record<string, unknown>, style: string) => Object.fromEntries(Object.entries(params).filter(([key]) => VIDEO_KEYS[style]?.has(key)))

export function QuickGenerationSettingsModal({ models, mode, initialSettings, initialMediaParams, onSave, onClose }: QuickGenerationSettingsModalProps) {
  const { t } = useTranslation(studioCatalog)
  const initial = mode === 'image' ? ('size' in initialSettings ? initialSettings : { modelId: '', size: '1024x1024', quality: '', count: 1 }) : ('params' in initialSettings ? initialSettings : { modelId: '', params: {} }) as QuickSettings
  const [modelId, setModelId] = useState(initial.modelId)
  const [providerId, setProviderId] = useState(() => models.find(item => item.id === initial.modelId)?.providerId ?? '')
  const [image, setImage] = useState(() => mode === 'image' && 'size' in initial ? { ...initial } : { modelId, size: '1024x1024', quality: '', count: 1 })
  const initialVideo = mode === 'video' && 'params' in initial ? initial.params : {}
  const [params, setParams] = useState<Record<string, unknown>>(() => ({ ...initialVideo, ...(initialMediaParams ?? {}) }))
  const [mediaParams, setMediaParams] = useState<Record<string, unknown>>(() => ({ ...(initialMediaParams ?? {}) }))
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const eligible = useMemo(() => models.filter(model => model.enabled && model.kind === mode), [models, mode])
  const providers = useMemo(() => [...new Map(eligible.map(item => [item.providerId, item.providerName])).entries()], [eligible])
  const model = eligible.find(item => item.id === modelId)
  const savedMissing = Boolean(modelId && !model)
  const imageSelection = imageSizeSelection(image.size)

  const setParamObject = (next: Record<string, unknown>) => {
    setParams(next)
    setMediaParams(Object.fromEntries(Object.entries(next).filter(([key]) => MEDIA_KEYS.has(key))))
  }
  let valid = Boolean(model)
  if (model) {
    try {
      if (mode === 'image') sanitizeQuickSettings('image', { ...image, modelId }, model)
      else sanitizeQuickSettings('video', { modelId, params: stableParams(params, styleOf(model)) }, model)
    } catch { valid = false }
  }

  async function save() {
    if (!model || saving || uploading || !valid) return
    setSaving(true); setError('')
    try {
      const settings = mode === 'image'
        ? sanitizeQuickSettings('image', { ...image, modelId }, model)
        : sanitizeQuickSettings('video', { modelId, params: stableParams(params, styleOf(model)) }, model)
      const media = Object.fromEntries(Object.entries(params).filter(([key]) => MEDIA_KEYS.has(key)))
      await onSave(settings, mode === 'video' ? { ...mediaParams, ...media } : undefined)
      onClose()
    } catch {
      setError(t('quickConfigSaveFailed'))
    } finally { setSaving(false) }
  }
  const setImageValue = (patch: Partial<typeof image>) => setImage(current => ({ ...current, ...patch, modelId }))
  const changeModel = (nextId: string, providerChanged = false) => {
    const nextModel = eligible.find(item => item.id === nextId)
    const oldModel = model
    setModelId(nextId)
    if (nextModel) setProviderId(nextModel.providerId)
    if (mode === 'video') {
      if (providerChanged || !nextModel || !oldModel || oldModel.providerId !== nextModel.providerId || styleOf(oldModel) !== styleOf(nextModel)) {
        setParams({}); setMediaParams({})
      } else if (isAgnesFlash(nextModel.modelId)) {
        setParamObject({ ...params, size: '720P' })
      }
    } else setImage(current => ({ ...current, modelId: nextId }))
  }

  return <SceneEditorModal title={t('quickConfigTitle')} closeLabel={t('quickConfigCancel')} closeDisabled={saving || uploading} onClose={onClose}>
    <div className="project-bulk-video-modal quick-config-modal">
      <fieldset className="project-bulk-video-settings" disabled={saving || uploading}>
        <section className="quick-config-section quick-config-provider-section">
          <div className="quick-config-section-heading">
            <span className="quick-config-section-icon" aria-hidden="true"><Building2 size={18} /></span>
            <div><h3>{t('providerLabel')} &amp; {t(mode === 'image' ? 'imageModelLabel' : 'videoModelLabel')}</h3></div>
          </div>
          <div className="project-field-row quick-config-provider-grid">
            <ProviderModelFields
              models={eligible}
              providerOptions={providers}
              providerId={providerId}
              modelId={modelId}
              onProviderChange={nextProvider => {
                const first = eligible.find(item => item.providerId === nextProvider)
                setProviderId(nextProvider)
                changeModel(first?.id ?? '', true)
              }}
              onModelChange={nextId => changeModel(nextId)}
              providerLabel={t('providerLabel')}
              modelLabel={t(mode === 'image' ? 'imageModelLabel' : 'videoModelLabel')}
              chooseProviderLabel={t('sceneChooseProvider')}
              chooseModelLabel={t('sceneChooseModel')}
              unavailableModelLabel={`${modelId} · ${t('quickConfigUnavailable')}`}
              formatModelLabel={item => `${item.displayName} · ${item.modelId}`}
              fieldClassName="plan-cell quick-config-selection-card"
              hideProviderWhenEmpty
              modelDisabled={!providerId}
            />
          </div>
          {eligible.length === 0 && <div className="quick-config-empty" role="status">
            <strong>{t(mode === 'image' ? 'noImageModel' : 'noVideoModel')}</strong>
            <p>{t('noModelsHint')}</p>
          </div>}
        </section>
        {savedMissing && <p className="form-error" role="alert">{t('quickConfigUnavailable')}</p>}
        {model && mode === 'image' && <section className="quick-config-section quick-config-image-section">
          <div className="quick-config-section-heading">
            <span className="quick-config-section-icon" aria-hidden="true"><ImageIcon size={18} /></span>
            <div><h3>{t('imageRatioLabel')} &amp; {t('imageResolutionLabel')}</h3></div>
          </div>
          <div className="project-field-row quick-config-image-grid">
          <label className="plan-cell"><span>{t('imageRatioLabel')}</span><select value={imageSelection.legacy ? image.size : imageSelection.ratio} onChange={event => setImageValue({ size: imageSizeFor(event.target.value as ImageRatio, imageSelection.resolution) })}>
            {imageSelection.legacy && <option value={image.size}>{t('imageSavedSize', { size: image.size })}</option>}{IMAGE_RATIOS.map(ratio => <option key={ratio} value={ratio}>{ratio}</option>)}
          </select></label>
          <label className="plan-cell"><span>{t('imageResolutionLabel')}</span><select value={imageSelection.legacy ? image.size : imageSelection.resolution} onChange={event => setImageValue({ size: imageSizeFor(imageSelection.ratio, event.target.value as ImageResolution) })}>
            {imageSelection.legacy && <option value={image.size}>{t('imageSavedSize', { size: image.size })}</option>}{IMAGE_RESOLUTIONS.map(resolution => <option key={resolution} value={resolution}>{`${resolution} · ${imageSizeFor(imageSelection.ratio, resolution).replace('x', ' × ')} px`}</option>)}
          </select></label>
          <label className="plan-cell"><span>{t('qualityLabel')}</span><select value={image.quality} onChange={event => setImageValue({ quality: event.target.value })}>{imageQualities.map(quality => <option key={quality} value={quality}>{quality ? t(`quality${quality[0]?.toUpperCase()}${quality.slice(1)}` as 'qualityLow' | 'qualityMedium' | 'qualityHigh') : t('qualityDefault')}</option>)}</select></label>
          <label className="plan-cell"><span>{t('imageCountLabel')}</span><input type="number" min={1} max={4} step={1} value={image.count} onChange={event => setImageValue({ count: Number(event.target.value) })} /></label>
          </div>
        </section>}
        {model && mode === 'video' && <section className="quick-config-section quick-config-video-section">
          <div className="quick-config-section-heading">
            <span className="quick-config-section-icon" aria-hidden="true"><Film size={18} /></span>
            <div><h3>{t('videoModelLabel')}</h3></div>
          </div>
          <VideoProviderControls model={model} controlKey={model.id} value={params as GenerationParamsInput} onChange={setParamObject} onUploadingChange={setUploading} />
        </section>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="project-actions quick-config-actions">
          <button type="button" className="secondary-button quick-config-cancel" disabled={saving || uploading} onClick={onClose}>{t('quickConfigCancel')}</button>
          <button type="button" className="quick-config-save" disabled={!valid || saving || uploading} onClick={() => void save()}>
            {saving && <LoaderCircle size={15} className="spin" aria-hidden="true" />}
            {t('quickConfigSave')}
          </button>
        </div>
      </fieldset>
    </div>
  </SceneEditorModal>
}

export default QuickGenerationSettingsModal
