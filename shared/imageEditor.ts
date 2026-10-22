/** Canonical image editor wire contract. Coordinates are normalized in the EXIF-oriented source PNG.
 * Frame dimensions/offsets are integer output pixels; reframing preserves source pixels unless scale<1 explicitly requests shrink-to-fit. */
export const IMAGE_EDITOR_LIMITS = {
  maxDimension: 8192, maxPixels: 25_000_000, maxRegions: 20, maxShapesPerRegion: 100,
  maxPointsPerShape: 2000, maxTotalPoints: 10000, maxCommentLength: 1000,
  maxTotalCommentLength: 8000, maxPromptLength: 2000,
} as const
export type ImageEditorSupport = 'unknown' | 'yes' | 'no'
export type ImageEditorSource =
  | { kind: 'upload' | 'asset'; id: string }
  | { kind: 'entity'; entityKind: 'character' | 'item' | 'logo' | 'location'; id: string; revision: number; viewId?: string }
export type ImageEditorPoint = { x: number; y: number }
export type ImageEditorShape = (
  | { kind: 'rect' | 'ellipse'; x: number; y: number; width: number; height: number }
  | { kind: 'polygon'; points: ImageEditorPoint[] }
  | { kind: 'brush'; points: ImageEditorPoint[]; radius: number }
) & { erase?: boolean }
export type ImageEditorRegion = { id: string; comment: string; shapes: ImageEditorShape[] }
export type ImageEditorOperation = 'region' | 'reframe' | 'background'
export type ImageEditorRequest = {
  source: ImageEditorSource
  operation: ImageEditorOperation
  engine: 'local' | 'provider'
  modelId?: string
  prompt?: string
  regions?: ImageEditorRegion[]
  /** Output canvas in integer pixels; `scale < 1` explicitly shrinks the source once. */
  frame?: { width: number; height: number; offsetX: number; offsetY: number; background: string; scale?: number }
  background?: { mode: 'remove' | 'replace'; color?: string; prompt?: string }
  idempotencyKey?: string
}
export type ImageEditorPreparedSource = {
  uploadId: string; url: string; width: number; height: number; mimeType: 'image/png'; lineage: ImageEditorSource
  /** True when the source was an animation and only the first frame was kept. */
  firstFrameOnly?: boolean
}
export type ImageEditorModelCapability = {
  id: string; label: string; maskSupport: ImageEditorSupport; transparentBackgroundSupport: ImageEditorSupport
  /** Precise inpainting: the model is verified to honour the mask. */
  region: boolean
  /**
   * Prompt-directed region editing: the model can carry the source image but its
   * mask support is unverified, so the whole image may change and the region
   * boundaries are advisory. Never implies a mask was sent.
   */
  regionPromptOnly: boolean
  /** Outpaint: the original rectangle is restored from the source pixels. */
  reframe: boolean
  /** Background replacement from the source image. */
  background: boolean
  /** Background removal needs a verified transparent-background model. */
  backgroundRemoval: boolean
}
export type ImageEditorCapabilities = {
  limits: typeof IMAGE_EDITOR_LIMITS
  local: { pad: true; backgroundRemoval: boolean }
  models: ImageEditorModelCapability[]
  operations: ImageEditorOperation[]
}
export type ImageEditorPreview = {
  prompt: string; warnings: string[]; width: number; height: number; maskUrl?: string
  /** True when the region edit is prompt-directed and NOT a precise inpainting. */
  promptDirected?: boolean
}
/** Internal paths/sidecar URLs/provider credentials are NEVER part of this public snapshot. */
export type ImageEditorSnapshot = {
  source: ImageEditorSource; preparedUploadId: string; width: number; height: number
  operation: ImageEditorOperation; engine: 'local' | 'provider'; regions?: ImageEditorRegion[]
  frame?: ImageEditorRequest['frame']; background?: ImageEditorRequest['background']
  /** True when the provider cannot honour a mask: the whole image may change. */
  promptDirected?: boolean
  /** True when the source was an animation and only the first frame was kept. */
  firstFrameOnly?: boolean
}
