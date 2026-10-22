import { createPortal } from 'react-dom'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useModalLayer } from './ui/useModalLayer'

// Compatibility export: existing domain dialogs keep their original import path.
export { useModalLayer } from './ui/useModalLayer'
import { ArrowDownToLine, Minus, Pencil, Plus, RotateCcw, X } from 'lucide-react'
import { formatNumber, useTranslation } from '../i18n'
import { shellCatalog } from '../i18n/catalogs/shell'
import type { ImageEditorSource } from '../../shared/imageEditor'
import { imageEditorCatalog } from '../i18n/catalogs/imageEditor'
import { ImageEditorModal } from './imageEditor/ImageEditorModal'
import { useImageCharacterAction } from './ImageCharacterBridge'

const MIN_SCALE = 0.5
const MAX_SCALE = 8
const STEP = 1.25

/**
 * Trình xem ảnh phóng to.
 *
 * Không dùng thư viện ngoài: ảnh được biến đổi bằng CSS transform, kéo để di
 * chuyển, lăn chuột để thu phóng. Ở mức 1× ảnh vừa khung nhìn (fit).
 */
export function ImageLightbox({
  src,
  alt,
  downloadHref,
  onClose,
  editableSource,
  onUseAsCharacter,
  modalZIndex,
}: {
  src: string
  alt: string
  downloadHref?: string
  onClose: () => void
  /** Omit for a strictly view-only lightbox; a URL is never treated as an editable source. */
  editableSource?: ImageEditorSource
  onUseAsCharacter?: (source: ImageEditorSource) => void | Promise<void>
  /** Stacking order for nested dialogs; the editor opens one level above it. */
  modalZIndex?: number
}) {
  const [editing, setEditing] = useState(false)
  const { t: editorT } = useTranslation(imageEditorCatalog)
  const characterAction = useImageCharacterAction()
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const { t, locale } = useTranslation(shellCatalog)

  const stageRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const drag = useRef<{ pointerId: number; startX: number; startY: number; baseX: number; baseY: number } | null>(null)

  /** Giới hạn vùng kéo để ảnh không bị đẩy hẳn ra khỏi màn hình. */
  const clampOffset = useCallback((next: { x: number; y: number }, nextScale: number) => {
    const image = imageRef.current
    if (!image) return next
    const maxX = Math.max(0, (image.clientWidth * nextScale - window.innerWidth) / 2 + 40)
    const maxY = Math.max(0, (image.clientHeight * nextScale - window.innerHeight) / 2 + 40)
    return {
      x: Math.min(maxX, Math.max(-maxX, next.x)),
      y: Math.min(maxY, Math.max(-maxY, next.y)),
    }
  }, [])

  const applyScale = useCallback(
    (nextScale: number) => {
      const bounded = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale))
      setScale(bounded)
      // Về mức vừa khung thì căn giữa lại.
      setOffset((current) => (bounded <= 1 ? { x: 0, y: 0 } : clampOffset(current, bounded)))
    },
    [clampOffset],
  )

  const reset = useCallback(() => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }, [])

  const dialogRef = useRef<HTMLDivElement>(null)
  const isTopLayer = useModalLayer(dialogRef, onClose, { enabled: !editing })
  useEffect(reset, [src, reset])

  // Phím tắt: Esc đóng, +/- thu phóng, 0 căn lại.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (editing || !isTopLayer() || (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]'))) return
      if (event.key === '+' || event.key === '=') applyScale(scale * STEP)
      else if (event.key === '-' || event.key === '_') applyScale(scale / STEP)
      else if (event.key === '0') reset()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [applyScale, onClose, reset, scale, editing, isTopLayer])

  // Lăn chuột để thu phóng; cần non-passive để chặn cuộn trang.
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    function onWheel(event: WheelEvent) {
      event.preventDefault()
      applyScale(scale * (event.deltaY < 0 ? STEP : 1 / STEP))
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [applyScale, scale, editing])

  if (editing && editableSource) return <ImageEditorModal source={editableSource} zIndex={modalZIndex === undefined ? undefined : modalZIndex + 1} onClose={() => setEditing(false)} onUseAsCharacter={onUseAsCharacter ?? characterAction ?? undefined} />

  return createPortal(
    <div
      className="lightbox-backdrop"
      ref={dialogRef}
      style={modalZIndex === undefined ? undefined : { zIndex: modalZIndex }}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={t('lightboxViewImage', { title: alt })}
      onMouseDown={(event) => {
        // Chỉ đóng khi bấm đúng nền, không đóng khi vừa kéo ảnh.
        if (event.target === event.currentTarget && !dragging) onClose()
      }}
    >
      <div className="lightbox-toolbar">
        <div className="lightbox-zoom">
          <button type="button" onClick={() => applyScale(scale / STEP)} aria-label={t('zoomOut')} title={t('zoomOutTitle')}>
            <Minus size={16} />
          </button>
          <span className="lightbox-percent" aria-live="polite">
            {formatNumber(scale, { style: 'percent', maximumFractionDigits: 0 }, locale)}
          </span>
          <button type="button" onClick={() => applyScale(scale * STEP)} aria-label={t('zoomIn')} title={t('zoomInTitle')}>
            <Plus size={16} />
          </button>
          <button type="button" onClick={reset} aria-label={t('zoomFit')} title={t('zoomFitTitle')}>
            <RotateCcw size={15} />
          </button>
        </div>
        <div className="lightbox-actions">
          {editableSource && (
            <button type="button" className="lightbox-button lightbox-edit-button" onClick={() => setEditing(true)}>
              <Pencil size={16} aria-hidden="true" />
              <span>{editorT('edit')}</span>
            </button>
          )}
          {downloadHref && (
            <a className="lightbox-button" href={downloadHref} download aria-label={t('download')} title={t('download')}>
              <ArrowDownToLine size={16} />
            </a>
          )}
          <button type="button" className="close-button" onClick={onClose} aria-label={t('close')} title={t('closeTitle')}>
            <X size={20} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div
        className={`lightbox-stage${dragging ? ' dragging' : ''}`}
        ref={stageRef}
        onPointerDown={(event) => {
          if (scale <= 1) return
          drag.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            baseX: offset.x,
            baseY: offset.y,
          }
          setDragging(true)
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          const state = drag.current
          if (!state || state.pointerId !== event.pointerId) return
          setOffset(
            clampOffset(
              {
                x: state.baseX + (event.clientX - state.startX),
                y: state.baseY + (event.clientY - state.startY),
              },
              scale,
            ),
          )
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointerId === event.pointerId) {
            drag.current = null
            setDragging(false)
          }
        }}
        onDoubleClick={() => (scale > 1 ? reset() : applyScale(2))}
      >
        <img
          ref={imageRef}
          src={src}
          alt={alt}
          draggable={false}
          className="lightbox-image"
          style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})` }}
        />
      </div>

      <p className="lightbox-hint">
        {t('lightboxHint')}
      </p>
    </div>,
    document.body,
  )
}
