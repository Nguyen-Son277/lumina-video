import type { ImageEditorPoint, ImageEditorPreparedSource, ImageEditorRegion, ImageEditorShape } from '../../../shared/imageEditor'

/** Normalized source coordinates of a client point inside the editor surface. */
export function imagePoint(clientX: number, clientY: number, bounds: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>): ImageEditorPoint {
  return { x: Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (clientY - bounds.top) / bounds.height)) }
}
export function rectangle(start: ImageEditorPoint, end: ImageEditorPoint): ImageEditorShape {
  return { kind: 'rect', x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }
}
export function shapePoints(shape: ImageEditorShape): number {
  return shape.kind === 'brush' || shape.kind === 'polygon' ? shape.points.length : 0
}
export function totalPoints(regions: ImageEditorRegion[]): number {
  return regions.reduce((sum, region) => sum + region.shapes.reduce((n, shape) => n + shapePoints(shape), 0), 0)
}
/** Keep zoom anchored under the cursor, with offsets measured in screen pixels. */
export function anchoredZoom(offset: ImageEditorPoint, anchor: ImageEditorPoint, scale: number, nextScale: number): ImageEditorPoint {
  const ratio = nextScale / scale
  return { x: anchor.x - (anchor.x - offset.x) * ratio, y: anchor.y - (anchor.y - offset.y) * ratio }
}

export type RegionBounds = { x: number; y: number; width: number; height: number }

/**
 * Pixel bounds of a region in the intrinsic source image.
 *
 * The shapes are applied SEQUENTIALLY on one coverage plane, exactly like the
 * server: a draw adds, an eraser removes only where it covers, and a draw
 * after an eraser adds the area back. The reported bounds follow the area that
 * is still covered, so a fully erased region has no bounds at all.
 */
export function regionPixelBounds(region: ImageEditorRegion, source: ImageEditorPreparedSource): RegionBounds | null {
  // Bound CPU before allocating/rasterizing, and never construct an array of
  // [x,y] pairs (a large selection could otherwise allocate millions of objects).
  let work = 0
  for (const shape of region.shapes) {
    const b = shapeBounds(shape, source)
    work += (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1) * ('points' in shape ? Math.max(1, shape.points.length) : 1)
    if (work > 200_000_000) return null // Server supplies the simplify-selection error on review.
  }
  const coverage = new Uint8Array(source.width * source.height)
  for (const shape of region.shapes) rasterizeShape(shape, source, coverage)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      if (!coverage[y * source.width + x]) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (!Number.isFinite(minX)) return null
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

function shapeBounds(shape: ImageEditorShape, source: ImageEditorPreparedSource) {
  const radius = shape.kind === 'brush' ? shape.radius * Math.min(source.width, source.height) : 0
  const points = 'points' in shape ? shape.points : null
  const left = points ? Math.min(...points.map(p => p.x * source.width)) - radius : 'x' in shape ? shape.x * source.width : 0
  const top = points ? Math.min(...points.map(p => p.y * source.height)) - radius : 'y' in shape ? shape.y * source.height : 0
  const right = points ? Math.max(...points.map(p => p.x * source.width)) + radius : 'x' in shape ? (shape.x + shape.width) * source.width : 0
  const bottom = points ? Math.max(...points.map(p => p.y * source.height)) + radius : 'y' in shape ? (shape.y + shape.height) * source.height : 0
  return { x0: Math.max(0, Math.floor(left)), y0: Math.max(0, Math.floor(top)), x1: Math.min(source.width - 1, Math.ceil(right)), y1: Math.min(source.height - 1, Math.ceil(bottom)) }
}

/** Rasterize only the shape's bounding box, in source pixel-center coordinates. */
function rasterizeShape(shape: ImageEditorShape, source: ImageEditorPreparedSource, coverage: Uint8Array): void {
  const bounds = shapeBounds(shape, source)
  const points = 'points' in shape ? shape.points.map(p => ({ x: p.x * source.width, y: p.y * source.height })) : []
  const radius = shape.kind === 'brush' ? shape.radius * Math.min(source.width, source.height) : 0
  for (let y = bounds.y0; y <= bounds.y1; y++) for (let x = bounds.x0; x <= bounds.x1; x++) {
    const px = x + .5, py = y + .5
    let inside = false
    if (shape.kind === 'rect') inside = px >= shape.x * source.width && px < (shape.x + shape.width) * source.width && py >= shape.y * source.height && py < (shape.y + shape.height) * source.height
    else if (shape.kind === 'ellipse') inside = ((px - (shape.x + shape.width / 2) * source.width) / (shape.width * source.width / 2)) ** 2 + ((py - (shape.y + shape.height / 2) * source.height) / (shape.height * source.height / 2)) ** 2 <= 1
    else if (shape.kind === 'polygon') {
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const a = points[i]!, b = points[j]!
        if ((a.y > py) !== (b.y > py) && px < (b.x - a.x) * (py - a.y) / (b.y - a.y) + a.x) inside = !inside
      }
    } else {
      for (let i = 0; i < points.length; i++) {
        const a = points[Math.max(0, i - 1)]!, b = points[i]!, dx = b.x - a.x, dy = b.y - a.y
        const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / (dx * dx + dy * dy || 1)))
        if ((px - a.x - t * dx) ** 2 + (py - a.y - t * dy) ** 2 <= radius * radius) { inside = true; break }
      }
    }
    if (inside) coverage[y * source.width + x] = shape.erase ? 0 : 1
  }
}
