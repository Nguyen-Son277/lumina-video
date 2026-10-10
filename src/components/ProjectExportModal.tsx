import { useEffect, useId, useRef, useState } from 'react'
import { AlertTriangle, Check, Download, Film, LoaderCircle, Trash2, X } from 'lucide-react'
import { ApiError, errorMessage, storedErrorMessage } from '../api/client'
import { exportApi, type ProjectExport } from '../api/exports'
import { formatBytes, formatDate, useTranslation } from '../i18n'
import { studioCatalog } from '../i18n/catalogs/studio'
import '../styles/projectExport.css'

/** Nhịp làm mới khi còn bản xuất đang chờ/đang chạy. */
const POLL_MS = 2_000

/** Phần tử nhận tiêu điểm bên trong hộp thoại, dùng cho bẫy tiêu điểm. */
const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]'

const isActive = (item: ProjectExport) => item.status === 'queued' || item.status === 'running'

/**
 * Chi tiết thô của lỗi API: `errorMessage()` đã là bản dịch theo ngôn ngữ hiện tại,
 * nên văn bản gốc chỉ đặt ở tooltip và không bao giờ bị dịch máy.
 */
function rawDetail(cause: unknown): string | undefined {
  if (cause instanceof ApiError) {
    const raw = cause.message.trim()
    return raw && raw !== errorMessage(cause) ? raw : undefined
  }
  return cause instanceof Error ? cause.message : undefined
}

function statusIcon(status: ProjectExport['status']) {
  if (status === 'succeeded') return <Check size={12} />
  if (status === 'failed') return <AlertTriangle size={12} />
  return <LoaderCircle size={12} className="spin" />
}

/**
 * Hộp thoại xuất video của một dự án.
 *
 * Chỉ đọc danh sách bản xuất và tạo bản mới khi người dùng bấm nút: mở hộp thoại
 * không tự tạo bản xuất nào. Khi còn bản `queued`/`running`, danh sách tự làm mới
 * mỗi 2 giây; hộp thoại đóng là component gỡ nên vòng làm mới dừng theo.
 */
export function ProjectExportModal({
  projectId,
  onClose,
}: {
  projectId: string
  onClose: () => void
}) {
  const { t, locale } = useTranslation(studioCatalog)
  const [items, setItems] = useState<ProjectExport[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [deletingId, setDeletingId] = useState('')
  /** Lỗi tạo/xoá/tải danh sách giữ nguyên đối tượng gốc để dịch lại khi đổi ngôn ngữ. */
  const [error, setError] = useState<unknown>(null)

  const dialog = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const introId = useId()
  // Giữ callback mới nhất mà không phải chạy lại hiệu ứng bẫy tiêu điểm.
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    let alive = true
    exportApi
      .list(projectId)
      .then((result) => {
        if (alive) setItems(result.exports)
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [projectId])

  const hasActive = items.some(isActive)

  useEffect(() => {
    if (!hasActive) return
    let alive = true
    const timer = window.setInterval(() => {
      exportApi
        .list(projectId)
        .then((result) => {
          if (alive) setItems(result.exports)
        })
        .catch(() => {
          /* bỏ qua lỗi tạm thời khi làm mới nền */
        })
    }, POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [projectId, hasActive])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus()

    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
      const first = elements[0]
      const last = elements[elements.length - 1]
      if (!first || !last) {
        event.preventDefault()
        dialog.current?.focus()
        return
      }
      const inside = dialog.current?.contains(document.activeElement) ?? false
      if (event.shiftKey && (document.activeElement === first || !inside)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !inside)) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('keydown', keydown)
      document.body.style.overflow = previousOverflow
      if (previous?.isConnected) previous.focus()
    }
  }, [])

  async function start() {
    setCreating(true)
    setError(null)
    try {
      const { export: created } = await exportApi.create(projectId)
      setItems((current) => [created, ...current.filter((item) => item.id !== created.id)])
    } catch (cause) {
      setError(cause)
    } finally {
      setCreating(false)
    }
  }

  async function remove(id: string) {
    setDeletingId(id)
    setError(null)
    try {
      await exportApi.remove(id)
      setItems((current) => current.filter((item) => item.id !== id))
    } catch (cause) {
      setError(cause)
    } finally {
      setDeletingId('')
    }
  }

  function statusText(item: ProjectExport): string {
    if (item.status === 'queued') return t('exportStatusQueued')
    if (item.status === 'running') return t('exportStatusRunning', { progress: item.progress ?? 0 })
    if (item.status === 'succeeded') return t('exportStatusSucceeded')
    return t('exportStatusFailed')
  }

  return (
    <div
      className="modal-backdrop project-export-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialog}
        className="modal-card project-export-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={introId}
        tabIndex={-1}
      >
        <div className="modal-header">
          <h2 id={titleId}>{t('exportModalTitle')}</h2>
          <button className="close-button" onClick={onClose} aria-label={t('close')}>
            <X size={18} />
          </button>
        </div>

        <div className="project-export-body">
          <p id={introId} className="modal-description">
            {t('exportIntro')}
          </p>
          <ul className="project-export-requirements">
            <li>{t('exportRequirementOrder')}</li>
            <li>{t('exportRequirementVideos')}</li>
            <li>{t('exportRequirementFfmpeg')}</li>
          </ul>

          <div className="project-export-toolbar">
            <button
              className="primary-small-button"
              disabled={creating}
              onClick={() => void start()}
            >
              {creating ? <LoaderCircle size={15} className="spin" /> : <Film size={15} />}{' '}
              {creating ? t('exportStarting') : t('exportStart')}
            </button>
          </div>

          {error != null && (
            <div className="form-error" role="alert" title={rawDetail(error)}>
              {errorMessage(error)}
            </div>
          )}

          <h3 className="project-export-heading">{t('exportRecentTitle')}</h3>

          {loading ? (
            <div className="empty-state" role="status">
              <LoaderCircle size={22} className="spin" />
              <h3>{t('exportLoading')}</h3>
            </div>
          ) : items.length ? (
            <div className="project-export-list">
              {items.map((item) => (
                <article key={item.id} className="project-export-item">
                  <div className="project-export-item-head">
                    <span className={`project-badge project-export-status is-${item.status}`}>
                      {statusIcon(item.status)} {statusText(item)}
                    </span>
                    <span className="project-export-meta">
                      {t('sceneCount', { count: item.itemCount })}
                    </span>
                    {item.status === 'succeeded' && item.byteSize != null && (
                      <span className="project-export-meta">
                        {formatBytes(item.byteSize, {}, locale)}
                      </span>
                    )}
                    <span className="project-export-meta">
                      {t('exportCreatedAt', {
                        date: formatDate(
                          item.createdAt,
                          { dateStyle: 'short', timeStyle: 'short' },
                          locale,
                        ),
                      })}
                    </span>
                  </div>

                  {item.status === 'running' && (
                    <div
                      className="project-export-progress"
                      role="progressbar"
                      aria-label={t('exportProgressLabel')}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={item.progress ?? 0}
                    >
                      <span style={{ width: `${Math.min(100, Math.max(0, item.progress ?? 0))}%` }} />
                    </div>
                  )}

                  {item.status === 'failed' && (
                    <div className="form-error project-export-error" role="alert" title={item.errorMessage ?? undefined}>
                      <span>{storedErrorMessage(item) || t('exportStatusFailed')}</span>
                      {item.errorCode === 'FFMPEG_MISSING' && (
                        <p className="project-export-hint">{t('exportFfmpegHint')}</p>
                      )}
                    </div>
                  )}

                  <div className="project-export-item-actions">
                    {item.status === 'succeeded' && item.downloadUrl && (
                      <a className="secondary-button project-export-download" href={item.downloadUrl} download>
                        <Download size={14} /> {t('exportDownload')}
                      </a>
                    )}
                    <button
                      className="secondary-button project-trash-danger"
                      disabled={deletingId === item.id || isActive(item)}
                      onClick={() => void remove(item.id)}
                    >
                      {deletingId === item.id ? (
                        <LoaderCircle size={14} className="spin" />
                      ) : (
                        <Trash2 size={14} />
                      )}{' '}
                      {deletingId === item.id ? t('exportDeleting') : t('deleteAction')}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-state project-export-empty">
              <Film size={26} />
              <p>{t('exportEmpty')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
