import { inferVideoApiStyle, isAgnesFlash, type VideoApiStyle } from './videoApi'
import { AGNES_ASPECT_RATIOS } from './videoApi'
import { HIGGSFIELD_RATIOS } from './higgsfield'
import { validVideoSeconds } from './videoControls'

export type QuickImageSettings = { modelId: string; size: string; quality: string; count: number }
export type QuickVideoSettings = { modelId: string; params: Record<string, unknown> }
export type QuickSettings = QuickImageSettings | QuickVideoSettings
export type QuickPreferences = { image: QuickImageSettings | null; video: QuickVideoSettings | null }
export type QuickModel = { id?: string; modelId: string; videoApiStyle?: VideoApiStyle }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = (message: string): never => { throw new Error(message) }
const modelIdOf = (input: Record<string, unknown>, model?: QuickModel): string => {
  const id = input.modelId ?? model?.id ?? model?.modelId
  if (typeof id !== 'string' || !id.trim()) return fail('A model is required')
  if (model?.id !== undefined && id !== model.id) return fail('Settings model does not match selected model')
  return id
}

/** Sanitize only stable, account-persistable generation preferences. */
export function sanitizeQuickSettings(mode: 'image' | 'video', input: unknown, model?: QuickModel): QuickSettings {
  if (!isRecord(input)) return fail('Settings must be an object')
  if (mode === 'image') {
    const allowed = new Set(['modelId', 'size', 'quality', 'count'])
    for (const key of Object.keys(input)) if (!allowed.has(key)) fail(`Unsupported image setting: ${key}`)
    const modelId = modelIdOf(input, model)
    const size = input.size ?? '1024x1024'
    const quality = input.quality ?? ''
    const count = input.count ?? 1
    if (typeof size !== 'string' || !/^\d{2,5}x\d{2,5}$/.test(size)) fail('Invalid image size')
    if (typeof quality !== 'string' || !['', 'low', 'medium', 'high'].includes(quality)) fail('Invalid image quality')
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 4) fail('Image count must be from 1 to 4')
    return { modelId, size: size as string, quality: quality as string, count: count as number }
  }

  const allowed = new Set(['modelId', 'params'])
  for (const key of Object.keys(input)) if (!allowed.has(key)) fail(`Unsupported video setting: ${key}`)
  const modelId = modelIdOf(input, model)
  const source = input.params === undefined ? {} : input.params
  if (!isRecord(source)) return fail('Video params must be an object')
  const providerModelId = model?.modelId ?? modelId
  const style = model?.videoApiStyle ?? inferVideoApiStyle(providerModelId)
  let params: Record<string, unknown>
  if (style === 'openai') {
    const allowedParams = new Set(['size', 'seconds'])
    rejectUnknown(source, allowedParams)
    params = { size: source.size ?? '1280x720', seconds: source.seconds ?? '4' }
    if (typeof params.size !== 'string' || !/^\d{2,5}x\d{2,5}$/.test(params.size)) fail('Invalid video size')
    if (!validVideoSeconds(params.seconds)) fail('Invalid video duration')
  } else if (style === 'agnes') {
    const allowedParams = new Set(['mode', 'size', 'seconds', 'n', 'aspectRatio', 'seed'])
    rejectUnknown(source, allowedParams)
    params = { mode: source.mode ?? 'text' }
    if (!['text', 'keyframe', 'reference'].includes(String(params.mode))) fail('Invalid Agnes mode')
    const flash = isAgnesFlash(providerModelId)
    if (flash) {
      params.size = source.size ?? '720P'
      params.seconds = String(source.seconds ?? '5')
      params.n = source.n ?? 1
      if (params.size !== '720P') fail('Agnes Flash size must be 720P')
      if (!validVideoSeconds(params.seconds, 12)) fail('Invalid Agnes duration')
      if (params.n !== 1) fail('Invalid Agnes count')
    } else {
      if (source.size !== undefined) {
        if (typeof source.size !== 'string' || !['480P', '720P', '1080P', '1440P', '2160P'].includes(source.size)) fail('Invalid Agnes size')
        params.size = source.size
      }
      if (source.seconds !== undefined) {
        if (!validVideoSeconds(source.seconds)) fail('Invalid Agnes duration')
        params.seconds = String(source.seconds)
      }
      if (source.n !== undefined) {
        if (!Number.isInteger(source.n) || Number(source.n) < 1 || Number(source.n) > 4) fail('Invalid Agnes count')
        params.n = Number(source.n)
      }
    }
    if (source.aspectRatio !== undefined) {
      if (!(AGNES_ASPECT_RATIOS as readonly unknown[]).includes(source.aspectRatio)) fail('Invalid Agnes aspect ratio')
      params.aspectRatio = source.aspectRatio
    }
    if (source.seed !== undefined) {
      if (!Number.isSafeInteger(source.seed)) fail('Invalid Agnes seed')
      params.seed = source.seed
    }
  } else {
    const allowedParams = new Set(['mode', 'duration', 'resolution', 'bitrateMode', 'generateAudio', 'aspectRatio', 'outputFormat'])
    rejectUnknown(source, allowedParams)
    params = {
      mode: source.mode ?? 'text', duration: source.duration ?? 5,
      resolution: source.resolution ?? '720p', bitrateMode: source.bitrateMode ?? 'high',
      generateAudio: source.generateAudio ?? true,
    }
    if (!['text', 'image'].includes(String(params.mode))) fail('Invalid Higgsfield mode')
    if (!Number.isInteger(params.duration) || Number(params.duration) < 4 || Number(params.duration) > 30) fail('Invalid Higgsfield duration')
    if (!['480p', '720p', '1080p'].includes(String(params.resolution))) fail('Invalid Higgsfield resolution')
    if (!['standard', 'high'].includes(String(params.bitrateMode))) fail('Invalid Higgsfield bitrate mode')
    if (typeof params.generateAudio !== 'boolean') fail('Invalid Higgsfield audio setting')
    if (params.mode === 'text') {
      if (source.aspectRatio !== undefined) {
        if (!(HIGGSFIELD_RATIOS as readonly unknown[]).includes(source.aspectRatio)) fail('Invalid Higgsfield aspect ratio')
        params.aspectRatio = source.aspectRatio
      }
      if (source.outputFormat !== undefined) {
        if (!['mp4', 'mov'].includes(String(source.outputFormat))) fail('Invalid Higgsfield output format')
        params.outputFormat = source.outputFormat
      }
      params.aspectRatio ??= '16:9'
      params.outputFormat ??= 'mp4'
    }
  }
  return { modelId, params }
}

function rejectUnknown(source: Record<string, unknown>, allowed: Set<string>): void {
  for (const key of Object.keys(source)) if (!allowed.has(key)) fail(`Unsupported video parameter: ${key}`)
}

export function isQuickImageSettings(value: unknown): value is QuickImageSettings {
  return isRecord(value) && typeof value.modelId === 'string' && typeof value.size === 'string'
    && typeof value.quality === 'string' && typeof value.count === 'number'
}
export function isQuickVideoSettings(value: unknown): value is QuickVideoSettings {
  return isRecord(value) && typeof value.modelId === 'string' && isRecord(value.params)
}
export function isQuickSettings(mode: 'image' | 'video', value: unknown): value is QuickSettings {
  return mode === 'image' ? isQuickImageSettings(value) : isQuickVideoSettings(value)
}
export function emptyQuickPreferences(): QuickPreferences { return { image: null, video: null } }
