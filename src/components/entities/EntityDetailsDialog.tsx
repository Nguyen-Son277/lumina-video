import { useEffect, useId, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import { Loader2, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useTranslation } from '../../i18n'
import { unifiedLibraryCatalog } from '../../i18n/catalogs/unifiedLibrary'
import { ImageLightbox, useModalLayer } from '../Lightbox'
import { EntityImagePreview, useEntityKindLabel } from './EntityCard'
import type { EntityDetailsData } from './types'
import '../../styles/entity-card.css'

export type EntityDetailsDialogProps = Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'onClose'> & {
  data: EntityDetailsData
  onClose: () => void
  actions?: ReactNode
  metadata?: ReactNode
  kindLabel?: string
  testId?: string
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  onZoom?: (url: string, alt: string) => void
}

/** Full, unmodified entity text lives here; card previews never replace this data. */
export function EntityDetailsDialog({
  data, onClose, actions, metadata, kindLabel, testId = 'entity-details-dialog', loading = false,
  error, onRetry, onZoom, className = '', ...attributes
}: EntityDetailsDialogProps) {
  const { t } = useTranslation(unifiedLibraryCatalog)
  const defaultKindLabel = useEntityKindLabel(data.kind)
  const titleId = useId()
  const nameId = useId()
  const descriptionId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState<{ url: string; alt: string } | null>(null)
  useModalLayer(panelRef, onClose)
  useEffect(() => setZoom(null), [data.id])
  const openZoom = onZoom ?? ((url: string, alt: string) => setZoom({ url, alt }))

  return createPortal(
    <>
      <div className="shared-entity-details-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
        <div
          {...attributes}
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-busy={loading || undefined}
          tabIndex={-1}
          className={`shared-entity-details ${className}`.trim()}
          data-testid={testId}
          data-entity-id={data.id}
          data-entity-kind={data.kind}
        >
          <header className="shared-entity-details-header">
            <h2 id={titleId}>{t('details')}</h2>
            <button type="button" className="shared-entity-icon-button" onClick={onClose} aria-label={t('close')} title={t('close')} data-testid="entity-details-close" data-modal-initial-focus>
              <X size={20} aria-hidden="true" />
            </button>
          </header>
          <div className="shared-entity-details-scroll">
            <div className="shared-entity-details-overview">
              <EntityImagePreview src={data.imageUrl} name={data.name} isLogo={data.kind === 'logo'} onZoom={openZoom} testId="entity-details-zoom" />
              <div className="shared-entity-details-identity">
                <div className="shared-entity-badges">
                  <span className="shared-entity-badge shared-entity-badge--kind" title={kindLabel ?? defaultKindLabel}>{kindLabel ?? defaultKindLabel}</span>
                  {data.handle && <span className="shared-entity-badge shared-entity-badge--handle" title={data.handle}>{data.handle}</span>}
                  {data.badges?.map((badge, index) => <span key={`${index}-${badge.label}`} className="shared-entity-badge" data-tone={badge.tone ?? 'neutral'} title={badge.label}>{badge.label}</span>)}
                </div>
                <h3 id={nameId} className="shared-entity-details-label">{t('name')}</h3>
                <p aria-labelledby={nameId} className="shared-entity-details-name" data-testid="entity-details-name">{data.name}</p>
                {metadata != null && <div className="shared-entity-details-metadata">{metadata}</div>}
              </div>
            </div>
            <section className="shared-entity-details-section" aria-labelledby={descriptionId}>
              <h3 id={descriptionId}>{t('description')}</h3>
              <p data-testid="entity-details-description">{data.description || t('noDescription')}</p>
            </section>
            {loading && <p className="shared-entity-details-status" role="status"><Loader2 size={18} className="shared-entity-spinner" aria-hidden="true" />{t('loadingDetails')}</p>}
            {error && <div className="shared-entity-details-error" role="alert"><p>{error}</p>{onRetry && <button type="button" className="shared-entity-button" onClick={onRetry} disabled={loading}>{t('retry')}</button>}</div>}
            {data.sections && data.sections.length > 0 && <dl className="shared-entity-details-sections">
              {data.sections.map((section, index) => <div key={`${index}-${section.label}`}><dt>{section.label}</dt><dd>{section.value}</dd></div>)}
            </dl>}
            {data.views && data.views.length > 0 && <section className="shared-entity-details-section">
              <h3>{t('referenceViews')}</h3>
              <div className="shared-entity-reference-grid">
                {data.views.map((view) => <figure key={view.id}>
                  <EntityImagePreview src={view.url} name={view.label} isLogo={data.kind === 'logo'} onZoom={openZoom} testId="entity-details-view-zoom" />
                  <figcaption>{view.label}</figcaption>
                </figure>)}
              </div>
            </section>}
          </div>
          {actions != null && <footer className="shared-entity-details-actions">{actions}</footer>}
        </div>
      </div>
      {zoom && <ImageLightbox src={zoom.url} alt={zoom.alt} onClose={() => setZoom(null)} />}
    </>,
    document.body,
  )
}
