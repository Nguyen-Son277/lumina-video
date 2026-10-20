import { normalizeHiggsfieldParams } from './higgsfield'
import { completeSceneVideoParams, sceneApplicationParams, sceneVideoDurationValid, sceneVideoStyle } from './sceneVideoParams'
import { AGNES_ASPECT_RATIOS, isAgnesFlash, type VideoApiStyle } from './videoApi'
import { AGNES_RESOLUTIONS, validVideoSeconds } from './videoControls'

export type CanvasVideoSettings = { modelId: string; params: Record<string, unknown> }
export type CanvasVideoModel = { modelId: string; videoApiStyle?: VideoApiStyle }

const keys = {
  openai: ['size', 'seconds'],
  agnes: ['mode', 'size', 'seconds', 'aspectRatio', 'n', 'seed'],
  higgsfield: ['mode', 'duration', 'resolution', 'bitrateMode', 'generateAudio', 'aspectRatio', 'outputFormat'],
} as const
const stableKeys = new Set<string>(Object.values(keys).flat())
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const oneOf = (value: unknown, values: readonly unknown[]) => values.includes(value)
const integer = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
const dimensions = (value: unknown) => typeof value === 'string' && /^\d{1,5}x\d{1,5}$/.test(value)
  && value.split('x').every(part => Number(part) >= 1 && Number(part) <= 16384)

function validStableValue(key: string, value: unknown): boolean {
  switch (key) {
    case 'size': return dimensions(value) || oneOf(value, AGNES_RESOLUTIONS)
    case 'seconds': return validVideoSeconds(value)
    case 'mode': return oneOf(value, ['text', 'image', 'keyframe', 'reference'])
    case 'aspectRatio': return oneOf(value, AGNES_ASPECT_RATIOS)
    case 'n': return integer(value, 1, 4)
    case 'seed': return typeof value === 'number' && Number.isSafeInteger(value)
    case 'duration': return integer(value, 4, 30)
    case 'resolution': return oneOf(value, ['480p', '720p', '1080p'])
    case 'bitrateMode': return oneOf(value, ['standard', 'high'])
    case 'generateAudio': return typeof value === 'boolean'
    case 'outputFormat': return oneOf(value, ['mp4', 'mov'])
    default: return false
  }
}

/** Structural graph validation only; protocol checks require the resolved model metadata. */
export function isCanvasVideoSettings(value: unknown): value is CanvasVideoSettings {
  return record(value) && Object.keys(value).every(key => key === 'modelId' || key === 'params')
    && typeof value.modelId === 'string' && Boolean(value.modelId.trim()) && record(value.params)
    && Object.entries(value.params).every(([key, entry]) => stableKeys.has(key) && validStableValue(key, entry))
}

/**
 * Copy only stable provider controls. Media, consent, and scene application options
 * must never be persisted in node overrides. Invalid allowed values throw; foreign
 * fields are discarded defensively; graph validation rejects them before storage.
 * This returns sparse overrides, not defaults.
 */
export function sanitizeCanvasVideoSettings(settings: unknown, model: CanvasVideoModel): CanvasVideoSettings {
  if (!record(settings) || typeof settings.modelId !== 'string' || !settings.modelId.trim()
    || !record(settings.params)) {
    throw new Error('Invalid Canvas video settings or model mismatch')
  }
  const style = sceneVideoStyle(model)
  const params: Record<string, unknown> = {}
  for (const key of keys[style]) {
    if (!Object.prototype.hasOwnProperty.call(settings.params, key) || settings.params[key] === undefined) continue
    const value = settings.params[key]
    if (!validStableValue(key, value)) throw new Error(`Invalid Canvas video parameter: ${key}`)
    params[key] = value
  }
  const complete = completeSceneVideoParams(model, params)
  if (!sceneVideoDurationValid(model, params)) throw new Error('Invalid Canvas video duration')
  if (style === 'openai' && !dimensions(complete.size)) throw new Error('Invalid OpenAI video size')
  if (style === 'agnes') {
    if (!oneOf(complete.mode, ['text', 'keyframe', 'reference']) || !oneOf(complete.size, AGNES_RESOLUTIONS)) throw new Error('Invalid Agnes video settings')
    if (isAgnesFlash(model.modelId) && (complete.size !== '720P' || complete.n !== 1 || typeof complete.seconds !== 'string')) throw new Error('Invalid Agnes Flash video settings')
  }
  if (style === 'higgsfield') {
    // Frame references are execution inputs, never node settings. Supply a local
    // validation sentinel to exercise the shared normalizer's image-mode rules.
    normalizeHiggsfieldParams({ ...complete, ...(complete.mode === 'image' ? { imageUploadId: 'canvas-validation-frame' } : {}) }, 'Canvas validation')
  }
  return { modelId: settings.modelId, params }
}

/** Legacy nodes inherit unchanged; own overrides start from protocol defaults and retain only scene application options. */
export function effectiveCanvasVideoParams(
  model: CanvasVideoModel,
  inherited: Record<string, unknown>,
  settings?: CanvasVideoSettings | null,
): Record<string, unknown> {
  if (!settings) return { ...inherited }
  const overrides = sanitizeCanvasVideoSettings(settings, model).params
  const merged = { ...overrides }
  // Image mode intentionally has no aspect ratio/output format. These may have
  // been inherited from a text-mode scene, so only explicit overrides can fail.
  if (sceneVideoStyle(model) === 'higgsfield' && merged.mode === 'image') {
    if (!Object.prototype.hasOwnProperty.call(overrides, 'aspectRatio')) delete merged.aspectRatio
    if (!Object.prototype.hasOwnProperty.call(overrides, 'outputFormat')) delete merged.outputFormat
  }
  const stable = sanitizeCanvasVideoSettings({ modelId: model.modelId, params: merged }, model).params
  return { ...completeSceneVideoParams(model, stable), ...sceneApplicationParams(inherited) }
}
