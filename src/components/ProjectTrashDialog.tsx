import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { LoaderCircle, X } from 'lucide-react'
import { errorMessage } from '../api/client'
import type { Project } from '../api/projectTypes'
import '../project-trash.css'

export function ProjectTrashDialog({ project, onClose, onConfirm }: {
  project: Project
  onClose: () => void
  onConfirm: (deleteResults: boolean) => Promise<void>
}) {
  const [deleteResults, setDeleteResults] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
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
    setError('')
    try { await onConfirm(deleteResults) }
    catch (cause) { setError(errorMessage(cause)) }
    finally { busyRef.current = false; setBusy(false) }
  }

  return (
    <div className="modal-backdrop project-trash-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busyRef.current) onClose()
    }}>
      <div ref={dialog} className="modal-card project-trash-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={busy} tabIndex={-1}>
        <div className="modal-header">
          <h2 id={titleId}>Chuyển vào thùng rác</h2>
          <button className="close-button" onClick={onClose} disabled={busy} aria-label="Đóng"><X size={18} /></button>
        </div>
        <form onSubmit={submit}>
          <div className="project-trash-dialog-body">
            <p id={descriptionId}>Dự án <strong>{project.name}</strong> sẽ được giữ trong thùng rác 30 ngày. Bạn có thể khôi phục trong thời gian này; sau đó dự án sẽ bị xóa vĩnh viễn.</p>
            <p>Kết quả đã tạo được giữ nguyên mặc định. Dự án còn tác vụ đang chạy hoặc chưa rõ trạng thái phải đợi tác vụ kết thúc trước khi xóa. Khôi phục không tự xếp hàng tạo lại.</p>
            <label className="project-trash-checkbox">
              <input type="checkbox" checked={deleteResults} onChange={(event) => setDeleteResults(event.target.checked)} disabled={busy} />
              <span>Xóa cả tệp kết quả sau 30 ngày</span>
            </label>
            <p className="project-hint">Tùy chọn này chỉ có hiệu lực khi hết hạn, không xóa tệp ngay bây giờ.</p>
            {error && <div className="form-error" role="alert">{error}</div>}
          </div>
          <div className="modal-actions">
            <button ref={cancel} type="button" className="secondary-button" disabled={busy} onClick={onClose}>Hủy</button>
            <button type="submit" className="secondary-button project-trash-danger" disabled={busy}>
              {busy && <LoaderCircle size={14} className="spin" />} {busy ? 'Đang chuyển…' : 'Chuyển vào thùng rác'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
