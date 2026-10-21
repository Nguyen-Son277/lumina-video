import { useEffect, useState } from 'react'
import { IMAGE_RATIOS, IMAGE_RESOLUTIONS, imageSizeFor, imageSizeSelection, type ImageRatio, type ImageResolution } from '../../../shared/imageControls'
import { providerApi } from '../../api/endpoints'
import type { ModelInfo } from '../../api/types'
import { useTranslation } from '../../i18n'
import { entityCreationCatalog } from '../../i18n/catalogs/entityCreation'

export function EntityImageSettings({ size, quality, model, disabled, onChange }: {
  size: string; quality: string; model?: ModelInfo; disabled?: boolean
  onChange: (patch: { size?: string; quality?: '' | 'low' | 'medium' | 'high' }) => void
}) {
  const { t } = useTranslation(entityCreationCatalog)
  const selection = imageSizeSelection(size)
  const [styles, setStyles] = useState<Record<string, string>>({})
  useEffect(() => {
    let active = true
    void providerApi.list().then(({ providers }) => { if (active) setStyles(Object.fromEntries(providers.map(provider => [provider.id, provider.imageApiStyle]))) }).catch(() => {})
    return () => { active = false }
  }, [])
  const unsupportedQuality = model && styles[model.providerId] === 'extra_body'
  return <section className="entity-image-settings" aria-label={t('imageSettings')}>
    <h3>{t('imageSettings')}</h3>
    <div className="entity-creation-settings-grid">
      <label>{t('ratio')}<select data-testid="entity-image-ratio" value={selection.legacy ? size : selection.ratio} disabled={disabled} onChange={event => onChange({ size: imageSizeFor(event.target.value as ImageRatio, selection.resolution) })}>
        {selection.legacy && <option value={size}>{size}</option>}{IMAGE_RATIOS.map(ratio => <option key={ratio} value={ratio}>{ratio}</option>)}
      </select></label>
      <label>{t('resolution')}<select data-testid="entity-image-resolution" value={selection.legacy ? size : selection.resolution} disabled={disabled} onChange={event => onChange({ size: imageSizeFor(selection.ratio, event.target.value as ImageResolution) })}>
        {selection.legacy && <option value={size}>{size}</option>}{IMAGE_RESOLUTIONS.map(resolution => <option key={resolution} value={resolution}>{t('pixelSize', { resolution, size: imageSizeFor(selection.ratio, resolution).replace('x', ' × ') })}</option>)}
      </select></label>
      <label>{t('quality')}<select data-testid="entity-image-quality" value={quality} disabled={disabled || !!unsupportedQuality} onChange={event => onChange({ quality: event.target.value as '' | 'low' | 'medium' | 'high' })}>
        <option value="">{t('qualityDefault')}</option>{(['low', 'medium', 'high'] as const).map(value => <option key={value} value={value}>{t(({ low: 'qualityLow', medium: 'qualityMedium', high: 'qualityHigh' } as const)[value])}</option>)}
      </select></label>
    </div>
    <p className="entity-creation-hint">{t('imageSizeHint')}</p>
    {unsupportedQuality && <p className="entity-creation-hint" role="status">{t('qualityUnsupported')}</p>}
  </section>
}
