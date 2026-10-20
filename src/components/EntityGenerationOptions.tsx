import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { EntityKind, PromptDocument } from '../../shared/promptMentions'
import type { LogoOverlay } from '../api/endpoints'
import { entityLibraryApi, entityReferenceUrl, type EntityLibraryEntity } from '../api/entityLibrary'
import { useTranslation } from '../i18n'
import { entityOptionsCatalog } from '../i18n/catalogs/entityOptions'
import '../styles/entity-options.css'

export interface EntityGenerationOptionsProps {
  document: PromptDocument
  overlays: LogoOverlay[]
  onOverlaysChange: (specs: LogoOverlay[]) => void
  allowTemporaryMedia: boolean
  onAllowTemporaryMediaChange: (allowed: boolean) => void
  disabled?: boolean
  projectId?: string
}

const MAX_OVERLAYS = 8
const DEFAULT_OVERLAY = { x: 0.8, y: 0.05, width: 0.15, opacity: 1 }
const FIELDS = ['x', 'y', 'width', 'opacity'] as const
type PlacementField = typeof FIELDS[number]
const FIELD_LABELS = { x: 'horizontal', y: 'vertical', width: 'width', opacity: 'opacity' } as const

function normalized(value: number, field: PlacementField): number {
  const fallback = DEFAULT_OVERLAY[field]
  return Number.isFinite(value) ? Math.min(1, Math.max(field === 'width' ? 0.01 : 0, value)) : fallback
}

function percentage(value: number, field: PlacementField): number {
  return Math.round(normalized(value, field) * 10000) / 100
}

function LogoThumbnail({ entity }: { entity: EntityLibraryEntity | undefined }) {
  const { t } = useTranslation(entityOptionsCatalog)
  const url = entity ? entityReferenceUrl(entity) : null
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  if (!url || failedUrl === url) return <span className="entity-options__no-image">{t('referenceUnavailable')}</span>
  return (
    <a className="entity-options__thumbnail" href={url} target="_blank" rel="noopener noreferrer" aria-label={t('previewReference')}>
      <img src={url} alt={t('referenceAlt', { name: entity!.name })} loading="lazy" onError={() => setFailedUrl(url)} />
    </a>
  )
}

/** Controlled per-task choices. The only request here is read-only catalog metadata. */
export function EntityGenerationOptions({
  document: promptDocument, overlays, onOverlaysChange, allowTemporaryMedia,
  onAllowTemporaryMediaChange, disabled = false, projectId,
}: EntityGenerationOptionsProps) {
  const { t } = useTranslation(entityOptionsCatalog)
  const id = useId()
  const logos = useMemo(() => {
    const unique = new Map<string, { id: string; label: string }>()
    for (const binding of promptDocument.mentions) {
      if (binding.entity.kind === 'logo' && !unique.has(binding.entity.id)) {
        unique.set(binding.entity.id, { id: binding.entity.id, label: binding.label })
      }
    }
    return [...unique.values()]
  }, [promptDocument])
  const logoKey = JSON.stringify(logos)
  const [catalog, setCatalog] = useState<{ projectId?: string; key: string; entities: EntityLibraryEntity[] } | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    if (!logos.length) { setCatalog(null); setLoading(false); setLoadFailed(false); return }
    const controller = new AbortController()
    let cancelled = false
    setCatalog(null)
    setLoading(true)
    setLoadFailed(false)
    void entityLibraryApi.list({ projectId }, controller.signal)
      .then(result => { if (!cancelled) setCatalog({ projectId, key: logoKey, entities: result.entities }) })
      .catch(() => { if (!cancelled) setLoadFailed(true) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true; controller.abort() }
  }, [projectId, logoKey])

  const ready = catalog !== null && catalog.projectId === projectId && catalog.key === logoKey
  const byId = new Map((ready ? catalog.entities : []).filter(entity => entity.kind === 'logo').map(entity => [entity.id, entity]))

  function selectMode(entityId: string, mode: string) {
    if (disabled) return
    const remaining = overlays.filter(spec => spec.entityId !== entityId)
    if (mode === 'ai') onOverlaysChange(remaining)
    else if (mode === 'overlay' && remaining.length < MAX_OVERLAYS) {
      onOverlaysChange([...remaining, { entityId, ...DEFAULT_OVERLAY }])
    }
  }

  function changeField(entityId: string, field: PlacementField, value: number) {
    if (disabled || !Number.isFinite(value)) return
    const updated = overlays.map(spec => spec.entityId === entityId ? {
      ...spec,
      ...Object.fromEntries(FIELDS.map(key => [key, normalized(spec[key], key)])),
      [field]: normalized(value / 100, field),
      // Explicit coordinates switch a restored preset back to legacy placement.
      ...((field === 'x' || field === 'y') ? { anchor: undefined } : {}),
    } : spec)
    onOverlaysChange(updated)
  }

  return (
    <section className="entity-options">
      {logos.length > 0 && (
        <fieldset className="entity-options__fieldset" disabled={disabled} aria-describedby={`${id}-logo-help`}>
          <legend>{t('logoTitle')}</legend>
          <p id={`${id}-logo-help`} className="entity-options__help">{t('logoHelp')}</p>
          {loading && <p role="status" className="entity-options__help">{t('metadataLoading')}</p>}
          {loadFailed && <p role="status" className="entity-options__warning">{t('metadataError')}</p>}
          <div className="entity-options__logos">
            {logos.map((logo, index) => {
              const entity = byId.get(logo.id)
              const spec = overlays.find(overlay => overlay.entityId === logo.id)
              const overlayFull = !spec && overlays.length >= MAX_OVERLAYS
              const prefix = `${id}-logo-${index}`
              return (
                <div className="entity-options__logo" key={logo.id}>
                  <div className="entity-options__identity">
                    <LogoThumbnail entity={entity} />
                    <div>
                      <strong>{entity?.name ?? `@${logo.label}`}</strong>
                      <p>{t('boundHandle', { handle: logo.label })}</p>
                      {entity && (entity.handle !== logo.label || entity.name !== logo.label) && <p className="entity-options__help">{t('renameHelp', { name: entity.name, handle: entity.handle })}</p>}
                      <small className="entity-options__id">{t('identity', { id: logo.id })}</small>
                      {ready && !entity && <p className="entity-options__warning">{t('unavailable')}</p>}
                    </div>
                  </div>
                  <label className="entity-options__field" htmlFor={`${prefix}-mode`}>
                    <span>{t('mode')}</span>
                    <select id={`${prefix}-mode`} value={spec ? 'overlay' : 'ai'} onChange={event => selectMode(logo.id, event.target.value)}>
                      <option value="ai">{t('aiReference')}</option>
                      <option value="overlay" disabled={overlayFull}>{t('originalOverlay')}</option>
                    </select>
                  </label>
                  {overlayFull && <p className="entity-options__help">{t('overlayLimit')}</p>}
                  {spec && (
                    <>
                      {ready && !entity?.reference && <p className="entity-options__warning">{t('missingReference')}</p>}
                      <div className="entity-options__placement" aria-describedby={`${prefix}-placement-help`}>
                        {FIELDS.map(field => (
                          <label className="entity-options__field" htmlFor={`${prefix}-${field}`} key={field}>
                            <span>{t(FIELD_LABELS[field])}</span>
                            <input id={`${prefix}-${field}`} type="number" min={field === 'width' ? 1 : 0} max={100} step="0.1"
                              value={percentage(spec[field], field)} onChange={event => changeField(logo.id, field, event.currentTarget.valueAsNumber)} />
                          </label>
                        ))}
                      </div>
                      <p id={`${prefix}-placement-help`} className="entity-options__help">{t('percentageHelp')}</p>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        </fieldset>
      )}
      <fieldset className="entity-options__fieldset" disabled={disabled}>
        <legend>{t('temporaryTitle')}</legend>
        <label className="entity-options__consent" htmlFor={`${id}-temporary`}>
          <input id={`${id}-temporary`} type="checkbox" checked={allowTemporaryMedia}
            onChange={event => onAllowTemporaryMediaChange(event.currentTarget.checked)} />
          <span>{t('temporaryConsent')}</span>
        </label>
      </fieldset>
    </section>
  )
}

/** Server-owned preview: never infer that a catalog thumbnail was actually sent. */
export interface EntityGenerationPreview {
  prompt: string
  entities: Array<{ id: string; kind: EntityKind; name: string; handle: string; referenceMode: string }>
  referenceCount: number
  maxReferenceCount: number
  warnings: string[]
  overlays: LogoOverlay[]
}

export interface GenerationPreviewDialogProps {
  preview: EntityGenerationPreview
  onConfirm: () => void
  onCancel: () => void
  disabled?: boolean
}

/** Native modal: opening/closing it performs no provider or paid requests. */
export function GenerationPreviewDialog({ preview, onConfirm, onCancel, disabled = false }: GenerationPreviewDialogProps) {
  const { t } = useTranslation(entityOptionsCatalog)
  const id = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const tooMany = preview.referenceCount > preview.maxReferenceCount
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.showModal()
    return () => { dialog.close(); if (previous?.isConnected) previous.focus() }
  }, [])
  const modeLabel = (mode: string) => mode === 'sent' ? t('sent') : mode === 'overlay' ? t('overlay') : mode === 'description-only' ? t('descriptionOnly') : mode
  return (
    <dialog ref={dialogRef} className="entity-preview" aria-labelledby={`${id}-title`} aria-describedby={`${id}-help`}
      onCancel={event => { event.preventDefault(); if (!disabled) onCancel() }}>
      <div className="entity-preview__content">
        <h2 id={`${id}-title`}>{t('previewTitle')}</h2>
        <p id={`${id}-help`} className="entity-options__help">{t('previewHelp')}</p>
        <section className="entity-preview__section">
          <h3>{t('references', { count: preview.referenceCount, max: preview.maxReferenceCount })}</h3>
          <p className="entity-options__help">{t('referenceCountHelp')}</p>
          {tooMany && <p role="alert" className="entity-options__warning">{t('tooManyReferences')}</p>}
          <h3>{t('entities')}</h3>
          {preview.entities.length === 0 ? <p>{t('noEntities')}</p> : (
            <ul className="entity-preview__entities">
              {preview.entities.map((entity, index) => (
                <li key={`${entity.kind}:${entity.id}:${index}`}>
                  <div><strong>{entity.name}</strong> <span className="entity-preview__kind">{t(entity.kind)}</span></div>
                  <span>@{entity.handle}</span>
                  <small className="entity-options__id">{t('identity', { id: entity.id })}</small>
                  <span className={`entity-preview__mode${entity.referenceMode === 'sent' ? ' entity-preview__mode--sent' : ''}`}>{modeLabel(entity.referenceMode)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        {preview.warnings.length > 0 && <section className="entity-preview__section entity-options__warning">
          <h3>{t('warnings')}</h3><ul>{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
        </section>}
        <section className="entity-preview__section">
          <h3>{t('effectivePrompt')}</h3>
          <pre className="entity-preview__prompt">{preview.prompt || t('emptyPrompt')}</pre>
        </section>
        {preview.overlays.length > 0 && <section className="entity-preview__section">
          <h3>{t('overlays')}</h3>
          <ul className="entity-preview__overlays">{preview.overlays.map((overlay, index) => {
            const entity = preview.entities.find(item => item.kind === 'logo' && item.id === overlay.entityId)
            return <li key={`${overlay.entityId}:${index}`}>
              <strong>{entity?.name ?? overlay.entityId}</strong>
              <p>{t('placement', { x: percentage(overlay.x, 'x'), y: percentage(overlay.y, 'y'), width: percentage(overlay.width, 'width'), opacity: percentage(overlay.opacity, 'opacity') })}</p>
            </li>
          })}</ul>
        </section>}
        <p className="entity-options__help">{t('paidNotice')}</p>
        <div className="entity-preview__actions">
          <button type="button" disabled={disabled} onClick={onCancel}>{t('cancel')}</button>
          <button type="button" className="entity-preview__confirm" disabled={disabled || tooMany || !preview.prompt.trim()} onClick={onConfirm}>{t('confirm')}</button>
        </div>
      </div>
    </dialog>
  )
}
