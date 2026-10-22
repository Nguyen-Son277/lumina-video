import type { ImageEditorPreparedSource } from '../../../shared/imageEditor'
import type { ImageRatio } from '../../../shared/imageControls'

/** Frame state kept in the editor document; `fit` and `ratio` are UI-only and never sent to the server. */
export type FrameState = {
  width: number
  height: number
  offsetX: number
  offsetY: number
  background: string
  scale?: number
  fit: boolean
  /** Preset ratio chosen by the user; undefined means a custom size. */
  ratio?: ImageRatio
}

/** Shrink-to-fit keeps every source pixel, so the frame never scales source content up. */
export function fittedScale(frame: { width: number; height: number }, source: ImageEditorPreparedSource): number {
  return Math.min(1, frame.width / source.width, frame.height / source.height)
}

/** Centre the (possibly shrunk) source inside the frame with integer offsets. */
export function centerFrame(frame: FrameState, source: ImageEditorPreparedSource): FrameState {
  const scale = frame.scale ?? 1
  return {
    ...frame,
    offsetX: Math.max(0, Math.round((frame.width - source.width * scale) / 2)),
    offsetY: Math.max(0, Math.round((frame.height - source.height * scale) / 2)),
  }
}

/** The server rejects frames that do not contain the whole scaled source. */
export function frameContainsSource(frame: FrameState, source: ImageEditorPreparedSource): boolean {
  const scale = frame.scale ?? 1
  const placedWidth = Math.max(1, Math.round(source.width * scale))
  const placedHeight = Math.max(1, Math.round(source.height * scale))
  return frame.width >= placedWidth && frame.height >= placedHeight
    && frame.offsetX + placedWidth <= frame.width && frame.offsetY + placedHeight <= frame.height
}

/** Apply or clear shrink-to-fit, always re-centring the visible source. */
export function applyFit(frame: FrameState, source: ImageEditorPreparedSource, fit: boolean): FrameState {
  if (!fit) return centerFrame({ ...frame, scale: undefined }, source)
  const scale = Number(fittedScale(frame, source).toFixed(4))
  return centerFrame({ ...frame, scale }, source)
}

/** Public frame payload: the UI-only `fit` flag never reaches the wire. */
export function wireFrame(frame: FrameState): { width: number; height: number; offsetX: number; offsetY: number; background: string; scale?: number } {
  return frame.scale === undefined
    ? { width: frame.width, height: frame.height, offsetX: frame.offsetX, offsetY: frame.offsetY, background: frame.background }
    : { width: frame.width, height: frame.height, offsetX: frame.offsetX, offsetY: frame.offsetY, background: frame.background, scale: frame.scale }
}

/**
 * Smallest frame with the requested ratio that still contains the whole source.
 *
 * The frame never crops: one edge matches the source and the other grows, so
 * the original pixels are preserved and only padding is added.
 */
export function frameForRatio(ratio: ImageRatio, source: ImageEditorPreparedSource): { width: number; height: number } {
  const [rw = 1, rh = 1] = ratio.split(':').map(Number)
  const target = rw / rh
  const sourceRatio = source.width / source.height
  if (sourceRatio > target) return { width: source.width, height: Math.round(source.width / target) }
  return { width: Math.round(source.height * target), height: source.height }
}
