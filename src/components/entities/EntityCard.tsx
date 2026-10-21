import { useEffect, useId, useState, type HTMLAttributes, type ReactNode } from 'react'
import { FileText, ImageOff, LoaderCircle, ZoomIn } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { unifiedLibraryCatalog } from '../../i18n/catalogs/unifiedLibrary'
import { ImageLightbox } from '../Lightbox'
import type { EntityCardData } from './types'
import '../../styles/entity-card.css'

/** A display-only preview; never writes the shortened text back to the entity. */
export function entityDescriptionPreview(value: string, limit = 200): string {
  const characters = Array.from(value)
  const length = Math.max(0, Math.floor(limit))
  if (characters.length <= length) return value
  return length >= 3 ? `${characters.slice(0, length - 3).join('')}...` : '.'.repeat(length)
}

export function useEntityKindLabel(kind: EntityCardData['kind']): string {
  const { t } = useTranslation(unifiedLibraryCatalog)
  switch (kind) {
    case 'character': return t('kindCharacter')
    case 'item': return t('kindItem')
    case 'location': return t('kindLocation')
    case 'logo': return t('kindLogo')
    case 'project': return t('kindProject')
    case 'generation': return t('kindGeneration')
    case 'plan_session': return t('kindPlanSession')
  }
}

/** Shared image button for cards and detail reference views. */
export function EntityImagePreview({
  src, name, isLogo = false, onZoom, className = '', testId, imageStatus,
}: {
  src?: string | null
  name: string
  isLogo?: boolean
  onZoom: (url: string, alt: string) => void
  className?: string
  testId?: string
  imageStatus?: EntityCardData['imageStatus']
}) {
  const { t } = useTranslation(unifiedLibraryCatalog)
  const [failedSource, setFailedSource] = useState<string | null>(null)
  useEffect(() => setFailedSource(null), [src])
  const failed = Boolean(src && failedSource === src)
  const classes = `shared-entity-image${isLogo ? ' shared-entity-image--logo' : ''} ${className}`.trim()
  if (imageStatus) {
    const percent = imageStatus.phase === 'generating' && typeof imageStatus.progress === 'number' && Number.isFinite(imageStatus.progress) && imageStatus.progress >= 0 && imageStatus.progress <= 100
      ? imageStatus.progress : undefined
    return <div className={`${classes} shared-entity-image--processing`} aria-busy="true" data-testid={testId ? `${testId}-processing` : undefined}>
      {src && !failed && <img key={src} src={src} alt={name} onError={() => setFailedSource(src)} />}
      <div className="shared-entity-image-status" data-testid="entity-image-status" data-image-phase={imageStatus.phase}>
        <LoaderCircle size={28} className="shared-entity-spinner" aria-hidden="true" />
        <span>{imageStatus.label}{percent !== undefined ? ` ${percent}%` : ''}</span>
        <progress max={100} value={percent} aria-label={imageStatus.label}/>
      </div>
    </div>
  }
  if (!src || failed) {
    return (
      <div className={`${classes} shared-entity-image--empty`} data-testid={testId ? `${testId}-unavailable` : undefined}>
        <ImageOff size={26} aria-hidden="true" />
        <span>{t(failed ? 'imageUnavailable' : 'noImage')}</span>
      </div>
    )
  }
  return (
    <button
      type="button"
      className={classes}
      onClick={() => onZoom(src, name)}
      aria-label={t('zoomImage', { name })}
      title={t('zoomImage', { name })}
      data-testid={testId}
    >
      <img key={src} src={src} alt={name} loading="lazy" onError={() => setFailedSource(src)} />
      <span className="shared-entity-image-zoom" aria-hidden="true"><ZoomIn size={16} />{t('zoom')}</span>
    </button>
  )
}

export type EntityCardProps = Omit<HTMLAttributes<HTMLElement>, 'children' | 'onClick'> & {
  data: EntityCardData
  onDetails: () => void
  actions?: ReactNode
  metadata?: ReactNode
  kindLabel?: string
  testId?: string
  /** Supply this to let the parent own zoom lifetime, e.g. during trash mutations. */
  onZoom?: (url: string, alt: string) => void
}

export function EntityCard({
  data, onDetails, actions, metadata, kindLabel, onZoom, className = '', testId = 'entity-card', ...attributes
}: EntityCardProps) {
  const { t } = useTranslation(unifiedLibraryCatalog)
  const defaultKindLabel = useEntityKindLabel(data.kind)
  const titleId = useId()
  const [zoom, setZoom] = useState<{ url: string; alt: string } | null>(null)
  useEffect(() => setZoom(null), [data.id, data.imageUrl])
  const openZoom = onZoom ?? ((url: string, alt: string) => setZoom({ url, alt }))
  const preview = data.description ? entityDescriptionPreview(data.description) : t('noDescription')

  return (
    <>
      <article
        {...attributes}
        className={`entity-card shared-entity-card ${className}`.trim()}
        data-testid={testId}
        data-entity-id={data.id}
        data-entity-kind={data.kind}
        aria-labelledby={titleId}
        aria-busy={!!data.imageStatus || undefined}
      >
        <EntityImagePreview src={data.imageUrl} imageStatus={data.imageStatus} name={data.name} isLogo={data.kind === 'logo'} onZoom={openZoom} testId="entity-card-zoom" />
        <div className="shared-entity-card-body">
          <div className="shared-entity-badges">
            <span className="shared-entity-badge shared-entity-badge--kind" title={kindLabel ?? defaultKindLabel}>{kindLabel ?? defaultKindLabel}</span>
            {data.handle && <span className="shared-entity-badge shared-entity-badge--handle" title={data.handle}>{data.handle}</span>}
            {data.badges?.map((badge, index) => <span key={`${index}-${badge.label}`} className="shared-entity-badge" data-tone={badge.tone ?? 'neutral'} title={badge.label}>{badge.label}</span>)}
          </div>
          <h2 id={titleId} className="shared-entity-card-name" data-testid="entity-card-name" title={data.name}>{data.name}</h2>
          <p className="shared-entity-card-description" data-testid="entity-card-description">{preview}</p>
          {metadata != null && <div className="shared-entity-card-metadata">{metadata}</div>}
          <div className="shared-entity-card-actions">
            <button type="button" className="shared-entity-button" onClick={onDetails} data-testid="entity-card-details" title={t('detailsTitle', { name: data.name })} aria-label={t('detailsTitle', { name: data.name })}>
              <FileText size={16} aria-hidden="true" />{t('details')}
            </button>
            {actions}
          </div>
        </div>
      </article>
      {zoom && <ImageLightbox src={zoom.url} alt={zoom.alt} onClose={() => setZoom(null)} />}
    </>
  )
}
