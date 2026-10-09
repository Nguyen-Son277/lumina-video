import { useState, type ReactNode } from 'react'
import {
  ArrowDownToLine,
  Check,
  ChevronDown,
  Film,
  Image as ImageIcon,
  LoaderCircle,
  Play,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { storedErrorMessage } from '../api/client'
import type { Generation, GenerationStatus, Mode } from '../api/types'
import { formatBytes, getLocale, translate, useTranslation, type Locale } from '../i18n'
import { shellCatalog, type ShellCatalogKey } from '../i18n/catalogs/shell'
import { ImageLightbox } from './Lightbox'

export function SelectControl({ label, value, options, onChange, disabled }: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange?: (value: string) => void
  disabled?: boolean
}) {
  return (
    <label className="select-control">
      <span>{label}</span>
      <div className="select-wrap">
        <select value={value} onChange={(event) => onChange?.(event.target.value)} disabled={disabled}>
          {options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <ChevronDown size={14} />
      </div>
    </label>
  )
}

export function Toast({ message }: { message: string }) {
  if (!message) return null
  return (
    // `role="status"` để trình đọc màn hình đọc thông báo mà không cướp tiêu điểm.
    <div className="toast" role="status" aria-live="polite">
      <div className="toast-check"><Check size={14} /></div>
      {message}
    </div>
  )
}

/** Khoá catalog cho từng trạng thái tác vụ (payload enum không đổi). */
const STATUS_KEYS: Record<GenerationStatus, ShellCatalogKey> = {
  queued: 'statusQueued',
  running: 'statusRunning',
  downloading: 'statusDownloading',
  succeeded: 'statusSucceeded',
  failed: 'statusFailed',
  unknown: 'statusUnknown',
}

/**
 * Nhãn trạng thái tác vụ theo ngôn ngữ hiện tại.
 * `locale` là tham số tuỳ chọn (mặc định ngôn ngữ đang chọn) để giữ API cũ.
 */
export function statusLabel(status: GenerationStatus, locale: Locale = getLocale()): string {
  return translate(shellCatalog, STATUS_KEYS[status], undefined, locale)
}

/** Thẻ hiển thị một kết quả đã tạo, dùng media thật từ API. */
export function CreationCard({ generation, onDelete, onRetry, busy }: {
  generation: Generation
  onDelete?: () => void
  onRetry?: () => void
  busy?: boolean
}) {
  const [zoomOpen, setZoomOpen] = useState(false)
  const { t, locale } = useTranslation(shellCatalog)
  const asset = generation.assets[0]
  const isVideo = generation.kind === 'video'
  const isActive = generation.status === 'queued' || generation.status === 'running' || generation.status === 'downloading'
  const title = generation.prompt.split(',')[0].slice(0, 48) || t('untitled')
  const statusText = statusLabel(generation.status, locale)

  return (
    <article className="creation-card">
      <div className={`creation-image ${isVideo ? 'violet' : 'sunset'}`}>
        {asset && !isVideo && (
          <button
            type="button"
            className="creation-zoom"
            onClick={() => setZoomOpen(true)}
            aria-label={t('zoomImageAria', { title })}
            title={t('zoomImageTitle')}
          >
            <img src={asset.url} alt={title} loading="lazy" />
          </button>
        )}
        {asset && isVideo && <video src={asset.url} controls preload="metadata" />}
        {!asset && (
          <div className="creation-placeholder">
            {isActive ? <LoaderCircle size={20} className="spin" /> : <ImageIcon size={20} />}
          </div>
        )}
        {isVideo && !asset && <span className="video-indicator"><Play size={12} fill="currentColor" /></span>}
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
          {generation.status === 'failed' && generation.providerJobId && onRetry && (
            <button onClick={onRetry} aria-label={t('retryDownload')} title={t('retryDownload')} disabled={busy}>
              <RefreshCw size={15} className={busy ? 'spin' : ''} />
            </button>
          )}
          {onDelete && (
            <button onClick={onDelete} aria-label={t('deleteResult')} title={t('deleteResult')} disabled={isActive || busy}>
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
              {isActive && generation.progress !== null ? ` ${generation.progress}%` : ''}
            </span>
            <h3>{title}</h3>
          </div>
        </div>
        <p>{generation.prompt}</p>
        {isActive && (
          <div className="card-progress">
            <span style={{ width: `${generation.progress ?? 10}%` }} />
          </div>
        )}
        {(generation.errorMessage || generation.errorMessageKey || generation.errorCode) && (
          <div className="card-error" role="alert" title={generation.errorMessage ?? undefined}>{storedErrorMessage(generation)}</div>
        )}
        <div className="creation-tags">
          <span>{generation.model}</span>
          <span>{generation.provider}</span>
          <span>{generation.projectId ? t('inProject') : t('notInProject')}</span>
          {asset && <span>{formatBytes(asset.byteSize, {}, locale)}</span>}
        </div>
        {generation.effectivePrompt && <details className="project-prompt-preview"><summary>{t('promptSent')}</summary><pre>{generation.effectivePrompt}</pre></details>}
      </div>

      {zoomOpen && asset && (
        <ImageLightbox
          src={asset.url}
          alt={title}
          downloadHref={`${asset.url}?download=1`}
          onClose={() => setZoomOpen(false)}
        />
      )}
    </article>
  )
}

export function ModeIcon({ mode }: { mode: Mode }): ReactNode {
  return mode === 'video' ? <Film size={14} /> : <ImageIcon size={14} />
}
