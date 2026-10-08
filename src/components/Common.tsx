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
import type { Generation, Mode } from '../api/types'
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
    <div className="toast">
      <div className="toast-check"><Check size={14} /></div>
      {message}
    </div>
  )
}

export function statusLabel(status: Generation['status']): string {
  switch (status) {
    case 'queued': return 'Đang chờ'
    case 'running': return 'Đang xử lý'
    case 'downloading': return 'Đang tải kết quả'
    case 'succeeded': return 'Hoàn tất'
    case 'failed': return 'Thất bại'
    case 'unknown': return 'Chưa xác định'
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Thẻ hiển thị một kết quả đã tạo, dùng media thật từ API. */
export function CreationCard({ generation, onDelete, onRetry, busy }: {
  generation: Generation
  onDelete?: () => void
  onRetry?: () => void
  busy?: boolean
}) {
  const [zoomOpen, setZoomOpen] = useState(false)
  const asset = generation.assets[0]
  const isVideo = generation.kind === 'video'
  const isActive = generation.status === 'queued' || generation.status === 'running' || generation.status === 'downloading'
  const title = generation.prompt.split(',')[0].slice(0, 48) || 'Chưa đặt tên'

  return (
    <article className="creation-card">
      <div className={`creation-image ${isVideo ? 'violet' : 'sunset'}`}>
        {asset && !isVideo && (
          <button
            type="button"
            className="creation-zoom"
            onClick={() => setZoomOpen(true)}
            aria-label={`Phóng to ảnh: ${title}`}
            title="Bấm để xem chi tiết"
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
              aria-label="Tải xuống"
              title="Tải xuống"
            >
              <ArrowDownToLine size={15} />
            </a>
          )}
          {generation.status === 'failed' && generation.providerJobId && onRetry && (
            <button onClick={onRetry} aria-label="Tải lại kết quả" title="Tải lại kết quả" disabled={busy}>
              <RefreshCw size={15} className={busy ? 'spin' : ''} />
            </button>
          )}
          {onDelete && (
            <button onClick={onDelete} aria-label="Xóa kết quả" title="Xóa kết quả" disabled={isActive || busy}>
              <Trash2 size={15} />
            </button>
          )}
        </div>
      </div>

      <div className="creation-info">
        <div className="creation-title-row">
          <div>
            <span className="mini-type">
              {isVideo ? 'VIDEO' : 'IMAGE'} · {statusLabel(generation.status)}
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
        {generation.errorMessage && (
          <div className="card-error" title={generation.errorMessage}>{generation.errorMessage}</div>
        )}
        <div className="creation-tags">
          <span>{generation.model}</span>
          <span>{generation.provider}</span>
          <span>{generation.projectId ? 'Trong project' : 'Chưa thuộc project'}</span>
          {asset && <span>{formatBytes(asset.byteSize)}</span>}
        </div>
        {generation.effectivePrompt && <details className="project-prompt-preview"><summary>Prompt đã gửi</summary><pre>{generation.effectivePrompt}</pre></details>}
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
