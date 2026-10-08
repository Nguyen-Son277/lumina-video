import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, Minus, Plus, RotateCcw, X } from 'lucide-react'

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
}: {
  src: string
  alt: string
  downloadHref?: string
  onClose: () => void
}) {
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)

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

  // Khóa cuộn trang nền khi mở.
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [])

  // Phím tắt: Esc đóng, +/- thu phóng, 0 căn lại.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
      else if (event.key === '+' || event.key === '=') applyScale(scale * STEP)
      else if (event.key === '-' || event.key === '_') applyScale(scale / STEP)
      else if (event.key === '0') reset()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [applyScale, onClose, reset, scale])

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
  }, [applyScale, scale])

  return (
    <div
      className="lightbox-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Xem ảnh: ${alt}`}
      onMouseDown={(event) => {
        // Chỉ đóng khi bấm đúng nền, không đóng khi vừa kéo ảnh.
        if (event.target === event.currentTarget && !dragging) onClose()
      }}
    >
      <div className="lightbox-toolbar">
        <div className="lightbox-zoom">
          <button type="button" onClick={() => applyScale(scale / STEP)} aria-label="Thu nhỏ" title="Thu nhỏ (−)">
            <Minus size={16} />
          </button>
          <span className="lightbox-percent" aria-live="polite">{Math.round(scale * 100)}%</span>
          <button type="button" onClick={() => applyScale(scale * STEP)} aria-label="Phóng to" title="Phóng to (+)">
            <Plus size={16} />
          </button>
          <button type="button" onClick={reset} aria-label="Về kích thước vừa khung" title="Vừa khung (0)">
            <RotateCcw size={15} />
          </button>
        </div>
        <div className="lightbox-actions">
          {downloadHref && (
            <a className="lightbox-button" href={downloadHref} download aria-label="Tải xuống" title="Tải xuống">
              <ArrowDownToLine size={16} />
            </a>
          )}
          <button type="button" className="lightbox-button" onClick={onClose} aria-label="Đóng" title="Đóng (Esc)">
            <X size={18} />
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
        Lăn chuột hoặc nút +/− để thu phóng · kéo để di chuyển khi đã phóng to · nháy đúp để phóng 2×
      </p>
    </div>
  )
}
