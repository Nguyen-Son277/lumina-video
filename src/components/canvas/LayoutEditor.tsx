import { useRef, useState } from 'react'
import { ArrowDown, ArrowUp, FlipHorizontal, Maximize2, Trash2, X } from 'lucide-react'
import { CANVAS_ASPECT_RATIOS, CANVAS_LIMITS, emptyCanvasLayout, type CanvasLayout, type CanvasPlacement } from '../../../shared/canvas'
import { useTranslation } from '../../i18n'
import { canvasCatalog } from '../../i18n/catalogs/canvas'

export type LayoutObject = {
  nodeId: string
  kind: 'character' | 'location' | 'item' | 'logo'
  name: string
  imageUrl: string | null
}

/**
 * Khung bố trí cảnh: kéo đặt nhân vật/vật phẩm lên nền và chỉnh lớp.
 *
 * Toạ độ lưu ở dạng chuẩn hoá (0..1) theo khung hình nên không phụ thuộc kích thước
 * màn hình. Mọi thao tác kéo đều có ô số tương ứng để dùng được bằng bàn phím; panel
 * chỉ là chỉ dẫn best-effort cho model, không phải bảo đảm từng pixel.
 */
export function LayoutEditor({ title, layout, objects, backgroundObject, onChange, onClose, onComposite, compositing, readOnly }: {
  title: string
  layout: CanvasLayout
  objects: LayoutObject[]
  /** Đối tượng đang được chọn làm nền, nếu có. */
  backgroundObject?: LayoutObject | null
  onChange: (layout: CanvasLayout) => void
  onClose: () => void
  /** Ghép bố trí thành ảnh nguồn; chỉ hiện khi node là node tạo ảnh. */
  onComposite?: () => void
  compositing?: boolean
  readOnly?: boolean
}) {
  const { t } = useTranslation(canvasCatalog)
  const frameRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<{ id: string; mode: 'move' | 'resize'; startX: number; startY: number; origin: CanvasPlacement } | null>(null)
  const current = layout ?? emptyCanvasLayout()
  const ratio = current.aspectRatio ?? '16:9'
  const [w, h] = ratio.split(':').map(Number)
  const aspect = w && h ? w / h : 16 / 9

  const commit = (instances: CanvasPlacement[]): void => {
    onChange({ ...current, aspectRatio: ratio, instances: instances.slice(0, CANVAS_LIMITS.placements) })
  }

  const patch = (id: string, next: Partial<CanvasPlacement>): void => {
    commit(current.instances.map((item) => (item.id === id ? { ...item, ...next } : item)))
  }

  function onPointerDown(event: React.PointerEvent, placement: CanvasPlacement, mode: 'move' | 'resize'): void {
    if (readOnly) return
    event.stopPropagation()
    ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
    setDragging({ id: placement.id, mode, startX: event.clientX, startY: event.clientY, origin: placement })
  }

  function onPointerMove(event: React.PointerEvent): void {
    if (!dragging || !frameRef.current) return
    const rect = frameRef.current.getBoundingClientRect()
    const dx = (event.clientX - dragging.startX) / rect.width
    const dy = (event.clientY - dragging.startY) / rect.height
    if (dragging.mode === 'move') {
      patch(dragging.id, { x: clamp(dragging.origin.x + dx), y: clamp(dragging.origin.y + dy) })
    } else {
      patch(dragging.id, {
        width: clampSize(dragging.origin.width + dx),
        height: clampSize(dragging.origin.height + dy),
      })
    }
  }

  function addInstance(object: LayoutObject): void {
    if (current.instances.length >= CANVAS_LIMITS.placements) return
    commit([...current.instances, {
      id: crypto.randomUUID(),
      sourceNodeId: object.nodeId,
      imageUploadId: null,
      x: 0.32,
      y: 0.28,
      width: 0.36,
      height: 0.5,
      rotation: 0,
      flipX: false,
      z: current.instances.length,
    }])
  }

  const ordered = [...current.instances].sort((a, b) => a.z - b.z)

  return <div className="canvas-layout-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className="canvas-layout" role="dialog" aria-modal="true" aria-label={t('layoutTitle')}>
      <header>
        <div>
          <div className="eyebrow"><span className="eyebrow-dot" /> {t('layoutTitle')}</div>
          <h3>{title}</h3>
        </div>
        <button type="button" className="close-button" aria-label={t('previewClose')} onClick={onClose}><X size={20} aria-hidden="true" /></button>
      </header>

      <div className="canvas-layout-body">
        <div
          ref={frameRef}
          className="canvas-layout-frame"
          style={{ aspectRatio: String(aspect) }}
          onPointerMove={onPointerMove}
          onPointerUp={() => setDragging(null)}
          onPointerLeave={() => setDragging(null)}
        >
          {backgroundObject?.imageUrl && <img className="canvas-layout-bg" src={backgroundObject.imageUrl} alt="" />}
          {ordered.map((placement) => {
            const object = objects.find((item) => item.nodeId === placement.sourceNodeId)
            return <div
              key={placement.id}
              className={`canvas-layout-instance ${dragging?.id === placement.id ? 'is-dragging' : ''}`}
              style={{
                left: `${placement.x * 100}%`,
                top: `${placement.y * 100}%`,
                width: `${placement.width * 100}%`,
                height: `${placement.height * 100}%`,
                zIndex: placement.z + 1,
                transform: `rotate(${placement.rotation}deg) scaleX(${placement.flipX ? -1 : 1})`,
              }}
              onPointerDown={(event) => onPointerDown(event, placement, 'move')}
            >
              {object?.imageUrl
                ? <img src={object.imageUrl} alt={object.name} />
                : <span className="canvas-layout-label">{object?.name ?? placement.sourceNodeId}</span>}
              {!readOnly && <span
                className="canvas-layout-resize"
                onPointerDown={(event) => onPointerDown(event, placement, 'resize')}
              ><Maximize2 size={11} /></span>}
            </div>
          })}
          {!current.instances.length && <p className="canvas-layout-empty">{objects.length ? t('layoutAddInstance') : t('layoutNoObjects')}</p>}
        </div>

        <aside className="canvas-layout-panel">
          <label className="select-control">
            <span>{t('layoutAspect')}</span>
            <select value={ratio} onChange={(event) => onChange({ ...current, aspectRatio: event.target.value })} disabled={readOnly}>
              {CANVAS_ASPECT_RATIOS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>

          <div className="canvas-layout-objects">
            <span>{t('layoutAddInstance')}</span>
            {objects.map((object) => (
              <button key={object.nodeId} type="button" disabled={readOnly || current.instances.length >= CANVAS_LIMITS.placements} onClick={() => addInstance(object)}>
                {object.imageUrl ? <img src={object.imageUrl} alt="" /> : <span className="canvas-layout-dot" />}
                {object.name}
              </button>
            ))}
          </div>

          {current.instances.map((placement, index) => {
            const object = objects.find((item) => item.nodeId === placement.sourceNodeId)
            return <div className="canvas-layout-row" key={placement.id}>
              <strong>{object?.name ?? placement.sourceNodeId}</strong>
              <div className="canvas-layout-fields">
                <label>{t('layoutWidth')}
                  <input type="number" min={0.05} max={2} step={0.05} value={round(placement.width)} disabled={readOnly}
                    onChange={(event) => patch(placement.id, { width: clampSize(Number(event.target.value)) })} />
                </label>
                <label>{t('layoutHeight')}
                  <input type="number" min={0.05} max={2} step={0.05} value={round(placement.height)} disabled={readOnly}
                    onChange={(event) => patch(placement.id, { height: clampSize(Number(event.target.value)) })} />
                </label>
                <label>{t('layoutRotation')}
                  <input type="number" min={-180} max={180} step={5} value={placement.rotation} disabled={readOnly}
                    onChange={(event) => patch(placement.id, { rotation: clampAngle(Number(event.target.value)) })} />
                </label>
              </div>
              <div className="canvas-layout-actions">
                <button type="button" title={t('layoutCenter')} aria-label={t('layoutCenter')} disabled={readOnly} onClick={() => patch(placement.id, { x: 0.5 - placement.width / 2, y: 0.5 - placement.height / 2 })}><span className="canvas-layout-center" /></button>
                <button type="button" title={t('layoutFlip')} aria-label={t('layoutFlip')} disabled={readOnly} onClick={() => patch(placement.id, { flipX: !placement.flipX })}><FlipHorizontal size={14} /></button>
                <button type="button" title={t('layoutForward')} aria-label={t('layoutForward')} disabled={readOnly} onClick={() => patch(placement.id, { z: index + 1 })}><ArrowUp size={14} /></button>
                <button type="button" title={t('layoutBackward')} aria-label={t('layoutBackward')} disabled={readOnly} onClick={() => patch(placement.id, { z: Math.max(index - 1, 0) })}><ArrowDown size={14} /></button>
                <button type="button" title={t('layoutRemove')} aria-label={t('layoutRemove')} disabled={readOnly} onClick={() => commit(current.instances.filter((item) => item.id !== placement.id))}><Trash2 size={14} /></button>
              </div>
            </div>
          })}

          <p className="project-hint">{t('layoutHint')}</p>
          <p className="project-hint">{t('layoutAlphaNote')}</p>
          {onComposite && <>
            <button type="button" className="secondary-button" disabled={readOnly || compositing || !current.instances.length} onClick={onComposite}>
              {compositing ? t('layoutCompositing') : t('layoutUseComposite')}
            </button>
            <p className="project-hint">{t('compositeNote')}</p>
          </>}
        </aside>
      </div>
    </div>
  </div>
}

const clamp = (value: number): number => Math.min(Math.max(value, -0.05), 1.05)
const clampSize = (value: number): number => (Number.isFinite(value) ? Math.min(Math.max(value, 0.05), 2) : 0.2)
const clampAngle = (value: number): number => (Number.isFinite(value) ? Math.min(Math.max(value, -180), 180) : 0)
const round = (value: number): number => Math.round(value * 100) / 100
