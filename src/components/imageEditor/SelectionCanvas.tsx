import { useEffect, useId, useRef, useState, type PointerEvent } from 'react'
import type { ImageEditorPoint, ImageEditorPreparedSource, ImageEditorRegion, ImageEditorShape } from '../../../shared/imageEditor'

export type SelectionTool = 'rect' | 'lasso' | 'brush' | 'eraser' | 'pan'
const colors = ['#aa8bff', '#35d7be', '#ffb855', '#f787b5', '#6dbdff']
const MIN_SCALE = 0.25
const MAX_SCALE = 8

/** One selection shape, painted in the given color (white adds, black erases). */
function Shape({ shape, width, height, color }: { shape: ImageEditorShape; width: number; height: number; color: string }) {
  if (shape.kind === 'rect') return <rect x={shape.x * width} y={shape.y * height} width={shape.width * width} height={shape.height * height} fill={color} />
  if (shape.kind === 'ellipse') return <ellipse cx={(shape.x + shape.width / 2) * width} cy={(shape.y + shape.height / 2) * height} rx={shape.width * width / 2} ry={shape.height * height / 2} fill={color} />
  if ('points' in shape) {
    const points = shape.points.map(p => `${p.x * width},${p.y * height}`).join(' ')
    if (shape.kind === 'polygon') return <polygon points={points} fill={color} />
    const radius = shape.radius * Math.min(width, height)
    return <><polyline points={points} fill="none" stroke={color} strokeWidth={radius * 2} strokeLinecap="round" strokeLinejoin="round" />{shape.points.length === 1 && <circle cx={shape.points[0].x * width} cy={shape.points[0].y * height} r={radius} fill={color} />}</>
  }
  return null
}

export function SelectionCanvas({ source, regions, selectedId, tool, brushSize, overlay, onShape, frame, zoomLabel }: {
  source: ImageEditorPreparedSource; regions: ImageEditorRegion[]; selectedId: string; tool: SelectionTool; brushSize: number; overlay: boolean
  onShape: (shape: ImageEditorShape) => void; frame?: { width: number; height: number; offsetX: number; offsetY: number; background: string; scale?: number }
  zoomLabel: { in: string; out: string; fit: string }
}) {
  const stage = useRef<HTMLDivElement>(null), svg = useRef<SVGSVGElement>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null), [scale, setScale] = useState(1), [offset, setOffset] = useState({ x: 0, y: 0 })
  const [draft, setDraft] = useState<ImageEditorShape | null>(null)
  const gesture = useRef<{ id: number; start: ImageEditorPoint; points: ImageEditorPoint[]; pan: boolean; offset: ImageEditorPoint; client: ImageEditorPoint; bounds: DOMRect } | null>(null)
  const unique = useId().replace(/:/g, '')
  const width = frame?.width || source.width, height = frame?.height || source.height
  const sourceScale = frame?.scale ?? 1
  const drawnWidth = source.width * sourceScale, drawnHeight = source.height * sourceScale
  // The surface is only painted once the stage is measured, so a stroke always
  // lands on the pixels the user actually sees.
  const fit = size ? Math.min((size.width - 32) / width, (size.height - 32) / height, 1) : 0
  const displayWidth = Math.max(1, width * fit), displayHeight = Math.max(1, height * fit)
  useEffect(() => {
    if (!stage.current) return
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(stage.current)
    // The first observation arrives after paint, so measure synchronously too.
    const bounds = stage.current.getBoundingClientRect()
    if (bounds.width > 0 && bounds.height > 0) setSize({ width: bounds.width, height: bounds.height })
    return () => observer.disconnect()
  }, [])
  useEffect(() => { setScale(1); setOffset({ x: 0, y: 0 }) }, [source.uploadId])
  // The surface transform is translate + scale around the stage centre, so the
  // source pixel under the cursor is solved analytically instead of approximated.
  function zoomAt(nextScale: number, clientX: number, clientY: number) {
    const bounds = stage.current?.getBoundingClientRect()
    if (!bounds) return
    const centre = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
    const current = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale))
    const local = { x: (clientX - centre.x - offset.x) / scale, y: (clientY - centre.y - offset.y) / scale }
    setOffset({ x: clientX - centre.x - current * local.x, y: clientY - centre.y - current * local.y })
    setScale(current)
  }
  useEffect(() => {
    const element = stage.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      zoomAt(scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15), event.clientX, event.clientY)
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [scale, offset])
  function point(event: PointerEvent, bounds = svg.current!.getBoundingClientRect()): ImageEditorPoint {
    return { x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) }
  }
  function makeShape(points: ImageEditorPoint[]): ImageEditorShape {
    if (tool === 'rect') {
      const start = points[0], end = points[points.length - 1]
      return { kind: 'rect', x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }
    }
    if (tool === 'lasso') return { kind: 'polygon', points }
    return { kind: 'brush', points, radius: brushSize / 2 / Math.min(source.width, source.height), ...(tool === 'eraser' ? { erase: true } : {}) }
  }
  function centrePoint() {
    const bounds = stage.current?.getBoundingClientRect()
    return { x: (bounds?.left ?? 0) + (bounds?.width ?? 0) / 2, y: (bounds?.top ?? 0) + (bounds?.height ?? 0) / 2 }
  }
  const transform = `translate(${offset.x}px, ${offset.y}px) scale(${scale})`
  return <div className="ie-canvas-wrap">
    <div className={`ie-stage ie-tool-${tool}`} ref={stage} data-testid="editor-stage" data-ready={size ? 'true' : 'false'}
      onPointerDown={event => {
        if (!size || (event.button !== 0 && event.button !== 1)) return
        const pan = tool === 'pan' || event.button === 1 || Boolean(frame)
        // The surface rect is captured once per gesture: the mapping from client
        // pixels to normalized source coordinates must not change mid-stroke.
        const bounds = svg.current!.getBoundingClientRect()
        const p = point(event, bounds)
        gesture.current = { id: event.pointerId, start: p, points: [p], pan, offset, client: { x: event.clientX, y: event.clientY }, bounds }
        event.currentTarget.setPointerCapture(event.pointerId)
        if (!pan) setDraft(makeShape([p]))
        event.preventDefault()
      }}
      onPointerMove={event => {
        const current = gesture.current
        if (!current || current.id !== event.pointerId) return
        if (current.pan) { setOffset({ x: current.offset.x + event.clientX - current.client.x, y: current.offset.y + event.clientY - current.client.y }); return }
        const p = point(event, current.bounds), last = current.points[current.points.length - 1]
        if (Math.hypot((p.x - last.x) * source.width, (p.y - last.y) * source.height) < 1) return
        if (tool === 'rect') current.points = [current.start, p]
        else if (current.points.length < 2000) current.points.push(p)
        setDraft(makeShape([...current.points]))
      }}
      onPointerUp={event => {
        const current = gesture.current
        if (!current || current.id !== event.pointerId) return
        if (!current.pan) {
          const shape = makeShape(current.points)
          if ((shape.kind === 'polygon' && shape.points.length >= 3) || shape.kind === 'brush' || (shape.kind === 'rect' && shape.width > 0.001 && shape.height > 0.001)) onShape(shape)
        }
        gesture.current = null; setDraft(null)
      }}
      onDoubleClick={event => {
        // Double click fits the source; it never creates a region.
        event.preventDefault()
        setScale(1); setOffset({ x: 0, y: 0 })
      }}
      onPointerCancel={() => { gesture.current = null; setDraft(null) }}>
      <div className="ie-surface-stack" style={{ transform }}>
        {size && <>
        <svg ref={svg} data-testid="editor-image-surface" className="ie-surface" width={displayWidth} height={displayHeight} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${source.width} × ${source.height}`}>
          {frame && frame.background !== 'transparent' && <rect width={width} height={height} fill={frame.background} />}
          <image href={source.url} width={drawnWidth} height={drawnHeight} x={frame?.offsetX ?? 0} y={frame?.offsetY ?? 0} />
        </svg>
        {overlay && !frame && <svg className="ie-overlay" data-testid="editor-overlay" width={displayWidth} height={displayHeight} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
          {regions.map((region, index) => {
            const shapes = region.id === selectedId && draft ? [...region.shapes, draft] : region.shapes
            const id = `${unique}-${index}`
            /**
             * The server applies the shapes of a region SEQUENTIALLY on one plane:
             * a draw adds, an eraser removes only where it covers, and a draw
             * after an eraser adds the area back. Painting the shapes in order
             * into one mask reproduces that exactly, because a later shape
             * overwrites the earlier one where they overlap.
             */
            return <g key={region.id} data-region-id={region.id} opacity={region.id === selectedId ? 0.55 : 0.3}>
              <defs>
                <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width={width} height={height} style={{ maskType: 'luminance' }}>
                  <rect width={width} height={height} fill="#000000" />
                  {shapes.map((shape, i) => <Shape key={i} shape={shape} width={width} height={height} color={shape.erase ? '#000000' : '#ffffff'} />)}
                </mask>
              </defs>
              <rect width={width} height={height} fill={colors[index % colors.length]} mask={`url(#${id})`} />
            </g>
          })}
        </svg>}
        </>}
      </div>
    </div>
    <div className="ie-zoom"><button type="button" aria-label={zoomLabel.out} onClick={() => { const c = centrePoint(); zoomAt(scale / 1.25, c.x, c.y) }}>−</button><output>{Math.round(scale * 100)}%</output><button type="button" aria-label={zoomLabel.in} onClick={() => { const c = centrePoint(); zoomAt(scale * 1.25, c.x, c.y) }}>+</button><button type="button" onClick={() => { setScale(1); setOffset({ x: 0, y: 0 }) }}>{zoomLabel.fit}</button></div>
  </div>
}
