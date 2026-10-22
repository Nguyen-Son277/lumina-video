import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowDownToLine,
  Film,
  Image as ImageIcon,
  LoaderCircle,
  RefreshCw,
  Square,
  Trash2,
} from 'lucide-react'
import { errorMessage, storedErrorMessage } from '../../api/client'
import { generationApi } from '../../api/endpoints'
import type { Asset, Generation, Mode } from '../../api/types'
import { formatBytes, useTranslation } from '../../i18n'
import { shellCatalog } from '../../i18n/catalogs/shell'
import { ImageLightbox } from '../Lightbox'
import { GenerationProgress } from './GenerationProgress'
import { isGenerationActive, statusLabel } from './status'

/** Thẻ hiển thị một kết quả đã tạo, dùng media thật từ API. */
export function CreationCard({ generation, onDelete, onRetry, onEdit, onUseAsSource, onUpdated, busy }: {
  generation: Generation
  onUpdated?: (generation: Generation) => void
  onDelete?: () => void
  onRetry?: () => void
  /** Nạp lại mô tả của nội dung này để sửa thành một bản mới (trang Tạo nội dung đơn lẻ). */
  onEdit?: () => void
  /** Dùng ảnh của nội dung này làm ảnh nguồn cho lần tạo kế tiếp. */
  onUseAsSource?: () => void
  busy?: boolean
}) {
  const [lightboxAsset, setLightboxAsset] = useState<Asset | null>(null)
  const [selectedVariant, setSelectedVariant] = useState<'original' | 'logo_overlay' | null>(null)
  // App polling stops when the provider succeeds. Keep postprocessing updates local
  // to this card, without replacing a newer generation supplied by its parent.
  const [local, setLocal] = useState<{ value: Generation; parent: Generation } | null>(null)
  const [retryingOverlay, setRetryingOverlay] = useState(false)
  const [overlayError, setOverlayError] = useState('')
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState('')
  const stopRequest = useRef<AbortController | null>(null)
  const latestParent = useRef(generation)
  latestParent.current = generation
  const retryRequest = useRef<AbortController | null>(null)
  const { t, locale } = useTranslation(shellCatalog)
  const current = local && local.value.id === generation.id
    && (local.parent === generation || local.value.updatedAt > generation.updatedAt)
    ? local.value : generation
  const latestDisplayed = useRef(current)
  latestDisplayed.current = current
  const overlayActive = current.postprocessStatus === 'queued' || current.postprocessStatus === 'running'
  const original = current.assets.find(item => item.variant !== 'logo_overlay')
  const derived = current.assets.find(item => item.variant === 'logo_overlay' && (!original || item.sourceAssetId === original.id))
    ?? current.assets.find(item => item.variant === 'logo_overlay')
  const hasVariants = Boolean(original && derived)
  const asset = selectedVariant === 'original' ? original ?? current.assets[0]
    : selectedVariant === 'logo_overlay' ? derived ?? original ?? current.assets[0]
      : current.assets[0]
  const isVideo = current.kind === 'video'
  const isActive = isGenerationActive(current)
  const title = current.prompt.split(',')[0].slice(0, 48) || t('untitled')
  const statusText = current.errorCode === 'CANCELLED' ? t('statusCancelled') : current.providerStatus === 'queued' && current.status === 'running' ? statusLabel('queued', locale) : statusLabel(current.status, locale)

  useEffect(() => {
    setSelectedVariant(null)
    setLightboxAsset(null)
    setOverlayError('')
    setRetryingOverlay(false)
    setStopping(false)
    setStopError('')
    return () => { retryRequest.current?.abort(); stopRequest.current?.abort() }
  }, [generation.id])

  useEffect(() => {
    if (!overlayActive && current.libraryPublishStatus !== 'queued') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const controller = new AbortController()
    const poll = async () => {
      try {
        const { generation: result } = await generationApi.get(generation.id, controller.signal)
        if (cancelled) return
        const parent = latestParent.current
        if (result.id !== parent.id) return
        const displayed = latestDisplayed.current
        const stale = displayed.id === result.id && displayed.updatedAt > result.updatedAt
        if (!stale) setLocal({ value: result, parent })
        setOverlayError('')
        const status = stale ? displayed.postprocessStatus : result.postprocessStatus
        if (status !== 'queued' && status !== 'running' && result.libraryPublishStatus !== 'queued') return
      } catch (error) {
        if (cancelled) return
        setOverlayError(errorMessage(error))
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 2000)
    }
    timer = setTimeout(() => void poll(), 2000)
    return () => { cancelled = true; clearTimeout(timer); controller.abort() }
  }, [generation.id, overlayActive, current.libraryPublishStatus])

  const stopQueuedVideo = async () => {
    if (stopping || !(current.canCancel ?? (current.status === 'queued' && !current.providerJobId))) return
    const controller = new AbortController()
    stopRequest.current = controller
    setStopping(true)
    setStopError('')
    try {
      const { generation: result } = await generationApi.cancel(current.id, controller.signal)
      if (controller.signal.aborted || latestParent.current.id !== result.id) return
      const parent = latestParent.current
      if (parent.updatedAt <= result.updatedAt) { setLocal({ value: result, parent }); onUpdated?.(result) }
    } catch (error) {
      if (!controller.signal.aborted) setStopError(errorMessage(error))
    } finally {
      if (!controller.signal.aborted) setStopping(false)
    }
  }

  const retryOverlay = async () => {
    if (retryingOverlay || overlayActive) return
    const controller = new AbortController()
    retryRequest.current = controller
    setRetryingOverlay(true)
    setOverlayError('')
    try {
      const { generation: result } = await generationApi.retryOverlay(current.id, controller.signal)
      if (controller.signal.aborted || latestParent.current.id !== result.id) return
      const parent = latestParent.current
      if (parent.updatedAt <= result.updatedAt) setLocal({ value: result, parent })
    } catch (error) {
      if (!controller.signal.aborted) setOverlayError(errorMessage(error))
    } finally {
      if (!controller.signal.aborted) setRetryingOverlay(false)
    }
  }

  return (
    <article className="creation-card">
      <div className={`creation-image ${isVideo ? 'violet' : 'sunset'}`}>
        {asset && !isVideo && (
          <button
            type="button"
            className="creation-zoom"
            onClick={() => setLightboxAsset(asset)}
            aria-label={t('zoomImageAria', { title })}
            title={t('zoomImageTitle')}
          >
            <img src={asset.url} alt={title} loading="lazy" />
          </button>
        )}
        {asset && isVideo && <video src={asset.url} controls preload="metadata" />}
        {!asset && (
          <div className={`creation-placeholder ${isActive && isVideo ? 'video-processing-placeholder' : ''}`}>
            {isActive ? <LoaderCircle size={isVideo ? 42 : 24} className="spin" aria-hidden="true" /> : isVideo ? <Film size={28} /> : <ImageIcon size={20} />}
            {isVideo && <strong>{statusText}</strong>}
          </div>
        )}
        <div className="creation-hover">
          {asset && (
            <a
              className="icon-link"
              href={`${asset.url}?download=1`}
              download
              aria-label={t('download')}
              title={t('download')}
            >
              <ArrowDownToLine size={15} />
            </a>
          )}
          {current.status === 'failed' && current.providerJobId && onRetry && (
            <button onClick={onRetry} aria-label={t('retryDownload')} title={t('retryDownload')} disabled={busy}>
              <RefreshCw size={15} className={busy ? 'spin' : ''} />
            </button>
          )}
          {onDelete && (
            <button onClick={onDelete} aria-label={t('deleteResult')} title={t('deleteResult')} disabled={isActive || overlayActive || retryingOverlay || busy}>
              <Trash2 size={15} />
            </button>
          )}
        </div>
      </div>

      <div className="creation-info">
        <div className="creation-title-row">
          <div>
            <span className="mini-type">
              {t(isVideo ? 'mediaKindVideo' : 'mediaKindImage')} · {statusText}
              {isActive && current.progress !== null ? ` ${current.progress}%` : ''}
            </span>
            <h3>{title}</h3>
          </div>
        </div>
        <p>{current.prompt}</p>
        {current.imagePurpose && <p>{t('cardImagePurpose', { name: current.imagePurpose.name })}</p>}
        {current.libraryPublishStatus === 'queued' && <p role="status">{t('cardLibraryQueued')}</p>}
        {current.libraryPublishStatus === 'succeeded' && <p role="status">{t('cardLibraryPublished')}</p>}
        {Boolean(current.libraryPublications?.length) && <div className="creation-actions">
          {current.libraryPublications!.map((publication, index) => <a
            className="creation-action"
            key={`${publication.sourceAssetId}:${publication.targetId}`}
            href={`/?page=entities&entity=${encodeURIComponent(publication.targetId)}#entity-${encodeURIComponent(publication.targetId)}`}
          >{current.imagePurpose?.name ?? t('cardLibraryPublished')}{current.libraryPublications!.length > 1 ? ` · ${index + 1}` : ''}</a>)}
        </div>}
        {current.libraryPublishStatus === 'failed' && <div className="card-error" role="alert">
          <p>{t('cardLibraryFailed')}</p>
          <button type="button" className="creation-action" disabled={busy} onClick={async () => {
            try { const { generation: result } = await generationApi.retryLibraryPublication(current.id); setLocal({ value: result, parent: latestParent.current }); onUpdated?.(result) }
            catch (error) { setOverlayError(errorMessage(error)) }
          }}>{t('cardRetryLibrary')}</button>
        </div>}
        {hasVariants && (
          <div className="creation-actions">
            <button type="button" className="creation-action" aria-pressed={asset?.variant !== 'logo_overlay'} onClick={() => setSelectedVariant('original')}>{t('cardOriginal')}</button>
            <button type="button" className="creation-action" aria-pressed={asset?.variant === 'logo_overlay'} onClick={() => setSelectedVariant('logo_overlay')}>{t('cardLogoOverlay')}</button>
          </div>
        )}
        {isVideo && (current.canCancel ?? (current.status === 'queued' && !current.providerJobId)) && (
          <div className="creation-actions">
            <button type="button" className="creation-action" onClick={() => void stopQueuedVideo()} disabled={stopping || busy} title={t('stopQueuedVideoHint')}>
              {stopping ? <LoaderCircle size={14} className="spin" /> : <Square size={14} />} {t(stopping ? 'stoppingQueuedVideo' : 'stopQueuedVideo')}
            </button>
          </div>
        )}
        {stopError && <div className="card-error" role="alert">{stopError}</div>}
        {isActive && <GenerationProgress generation={current} />}
        {overlayActive && (
          <div className="generation-progress" role="status">
            <div className="generation-progress-label"><span>{t(current.postprocessStatus === 'queued' ? 'cardOverlayQueued' : 'cardOverlayRunning')}</span><LoaderCircle size={14} className="spin" aria-hidden="true" /></div>
            <div className="card-progress is-indeterminate" role="progressbar" aria-label={t('cardOverlayProgressAria')} aria-valuemin={0} aria-valuemax={100}><span /></div>
          </div>
        )}
        {current.postprocessStatus === 'failed' && (
          <div className="card-error" role="alert">{t('cardOverlayFailed')}</div>
        )}
        {overlayError && <div className="card-error" role="alert">{overlayActive && <span>{t('cardOverlayPollFailed')} </span>}{overlayError}</div>}
        {current.postprocessStatus === 'failed' && original && (
          <div className="creation-actions">
            <button type="button" className="creation-action" onClick={() => void retryOverlay()} disabled={retryingOverlay || busy} title={t('cardRetryOverlayHint')}>
              <RefreshCw size={14} className={retryingOverlay ? 'spin' : ''} /> {t(retryingOverlay ? 'cardRetryOverlayBusy' : 'cardRetryOverlay')}
            </button>
          </div>
        )}
        {(current.errorMessage || current.errorCode || current.status === 'failed' || current.status === 'unknown') && (
          <div className="card-error" role="alert" title={current.errorMessage ?? undefined}>{storedErrorMessage(current)}</div>
        )}
        {typeof current.errorMessageParams?.requestId === 'string' && <div className="card-diagnostic">{t('providerRequestId', { id: current.errorMessageParams.requestId })}</div>}
        {isVideo && current.status === 'unknown' && !current.providerJobId && <p className="card-unknown-hint">{t('unknownVideoNoIdHint')}</p>}
        <div className="creation-tags">
          <span>{current.model}</span>
          <span>{current.provider}</span>
          <span>{current.projectId ? t('inProject') : t('notInProject')}</span>
          {asset && <span>{formatBytes(asset.byteSize, {}, locale)}</span>}
        </div>
        {(onEdit || onUseAsSource) && (
          <div className="creation-actions">
            {onEdit && (
              <button type="button" className="creation-action" onClick={onEdit}>
                {t('cardEditPrompt')}
              </button>
            )}
            {onUseAsSource && (
              <button type="button" className="creation-action" onClick={onUseAsSource}>
                {t('cardUseAsSource')}
              </button>
            )}
          </div>
        )}
        {current.effectivePrompt && <details className="project-prompt-preview"><summary>{t('promptSent')}</summary><pre>{current.effectivePrompt}</pre></details>}
      </div>

      {lightboxAsset && (
        <ImageLightbox
          src={lightboxAsset.url}
          alt={title}
          downloadHref={`${lightboxAsset.url}?download=1`}
          // The asset id is the only editable identity; a URL is never parsed.
          // Video assets stay view-only because the editor works on still images.
          editableSource={lightboxAsset.mimeType.startsWith('image/') ? { kind: 'asset', id: lightboxAsset.id } : undefined}
          onClose={() => setLightboxAsset(null)}
        />
      )}
    </article>
  )
}

export function ModeIcon({ mode }: { mode: Mode }): ReactNode {
  return mode === 'video' ? <Film size={14} /> : <ImageIcon size={14} />
}
