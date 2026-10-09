import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { LoaderCircle, X } from 'lucide-react'
import { ApiError, errorMessage } from '../api/client'
import type { Project } from '../api/projectTypes'
import { useTranslation } from '../i18n'
import { studioCatalog } from '../i18n/catalogs/studio'
import '../project-trash.css'

/**
 * Chi tiết thô từ provider/máy chủ, chỉ đặt ở tooltip: `errorMessage()` đã là bản dịch
 * theo ngôn ngữ hiện tại, còn văn bản gốc không bao giờ bị dịch máy.
 */
function rawErrorDetail(cause: unknown): string | undefined {
  if (!(cause instanceof ApiError)) return undefined
  const raw = cause.message.trim()
  return raw && raw !== errorMessage(cause) ? raw : undefined
}

export function ProjectTrashDialog({ project, onClose, onConfirm }: {
  project: Project
  onClose: () => void
  onConfirm: (deleteResults: boolean) => Promise<void>
}) {
  const { t } = useTranslation(studioCatalog)
  const [deleteResults, setDeleteResults] = useState(false)
  const [busy, setBusy] = useState(false)
  /**
   * Lỗi được lưu dưới dạng đối tượng gốc, không định dạng sẵn: `errorMessage()` đọc
   * ngôn ngữ tại thời điểm render nên thông báo tự dịch lại khi đổi en/vi.
   */
  const [error, setError] = useState<unknown>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const busyRef = useRef(false)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    cancel.current?.focus()
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (!busyRef.current) closeRef.current()
      }
      if (event.key === 'Tab') {
        const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? [])
        const first = elements[0]
        const last = elements[elements.length - 1]
        if (!first) { event.preventDefault(); dialog.current?.focus(); return }
        if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) {
          event.preventDefault(); last.focus()
        } else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) {
          event.preventDefault(); first.focus()
        }
      }
    }
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('keydown', keydown)
      document.body.style.overflow = previousOverflow
      if (previous?.isConnected) previous.focus()
      else document.querySelector<HTMLElement>('.project-trash-filter')?.focus()
    }
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try { await onConfirm(deleteResults) }
    catch (cause) { setError(cause) }
    finally { busyRef.current = false; setBusy(false) }
  }

  return (
    <div className="modal-backdrop project-trash-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busyRef.current) onClose()
    }}>
      <div ref={dialog} className="modal-card project-trash-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={busy} tabIndex={-1}>
        <div className="modal-header">
          <h2 id={titleId}>{t('trashTitle')}</h2>
          <button className="close-button" onClick={onClose} disabled={busy} aria-label={t('close')}><X size={18} /></button>
        </div>
        <form onSubmit={submit}>
          <div className="project-trash-dialog-body">
            <p id={descriptionId}>{t('trashBodyPrefix')}<strong>{project.name}</strong>{t('trashBodySuffix')}</p>
            <p>{t('trashKeepResultsNote')}</p>
            <label className="project-trash-checkbox">
              <input type="checkbox" checked={deleteResults} onChange={(event) => setDeleteResults(event.target.checked)} disabled={busy} />
              <span>{t('trashDeleteResultsLabel')}</span>
            </label>
            <p className="project-hint">{t('trashDeleteResultsHint')}</p>
            {error != null && (
              <div className="form-error" role="alert" title={rawErrorDetail(error)}>
                {errorMessage(error)}
              </div>
            )}
          </div>
          <div className="modal-actions">
            <button ref={cancel} type="button" className="secondary-button" disabled={busy} onClick={onClose}>{t('cancel')}</button>
            <button type="submit" className="secondary-button project-trash-danger" disabled={busy}>
              {busy && <LoaderCircle size={14} className="spin" />} {busy ? t('trashBusy') : t('trashTitle')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
