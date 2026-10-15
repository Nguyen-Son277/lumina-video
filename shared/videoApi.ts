export type VideoApiStyle = 'openai' | 'agnes' | 'higgsfield'
export type AgnesVideoMode = 'text' | 'keyframe' | 'reference'
export const AGNES_ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] as const
export type AgnesAspectRatio = (typeof AGNES_ASPECT_RATIOS)[number]
export type AgnesVideoParams = {
  mode?: AgnesVideoMode
  size?: string
  seconds?: string | number
  n?: number
  aspectRatio?: AgnesAspectRatio
  seed?: number
  firstFrame?: string
  lastFrame?: string
  referenceImages?: string[]
  referenceAudios?: string[]
  useCharacterReference?: boolean
  [key: string]: unknown
}

export function inferVideoApiStyle(modelId: string): VideoApiStyle {
  if (['bytedance/seedance-2.5', 'bytedance/seedance-2.5/image-to-video', 'bytedance/seedance-2.5/text-to-video'].includes(modelId)) return 'higgsfield'
  return modelId === 'agnes-video-2.5' || modelId === 'agnes-video-2.5-flash' ? 'agnes' : 'openai'
}
export function isAgnesFlash(modelId: string): boolean {
  return modelId === 'agnes-video-2.5-flash'
}

/** Pure shared validation. DNS/private-address checks belong to the backend. */
export function normalizeAgnesParams(modelId: string, params: AgnesVideoParams): AgnesVideoParams {
  const result = { ...params, mode: params.mode ?? 'text' }
  const fail = (message: string): never => { throw new Error(message) }
  if (!['text', 'keyframe', 'reference'].includes(result.mode)) fail('Agnes mode must be text, keyframe or reference')
  if (params.seed !== undefined && !Number.isSafeInteger(params.seed)) fail('Agnes seed must be an integer')
  if (params.aspectRatio !== undefined && !(AGNES_ASPECT_RATIOS as readonly string[]).includes(params.aspectRatio)) fail('Invalid Agnes aspect ratio')
  if (isAgnesFlash(modelId)) {
    result.size = params.size ?? '720P'
    result.seconds = params.seconds ?? '5'
    result.n = params.n ?? 1
    if (result.size !== '720P') fail('Agnes Flash size must be 720P')
    if (typeof result.seconds !== 'string' || !/^(?:[4-9]|1[0-2])$/.test(result.seconds)) fail('Agnes Flash seconds must be a string from 4 to 12')
    if (result.n !== 1) fail('Agnes Flash n must be 1')
  }
  // Reject foreign media fields instead of silently discarding them.
  for (const field of ['videos', 'referenceVideos', 'input_reference', 'first_frame', 'last_frame', 'images', 'audios']) {
    if (params[field] !== undefined) fail(`Unsupported Agnes media field: ${field}`)
  }
  const frames = [params.firstFrame, params.lastFrame].filter((v) => v !== undefined)
  const images = params.referenceImages ?? []
  const audios = params.referenceAudios ?? []
  if (!Array.isArray(images) || !Array.isArray(audios)) fail('Agnes references must be URL arrays')
  if (result.mode === 'text' && (frames.length || images.length || audios.length)) fail('Agnes text mode does not accept media')
  if (result.mode === 'keyframe' && (!frames.length || images.length || audios.length)) fail('Agnes keyframe mode requires a frame and forbids references')
  if (result.mode === 'reference' && (frames.length || !images.length && !audios.length)) fail('Agnes reference mode requires images or audios and forbids frames')
  if (isAgnesFlash(modelId) && (images.length > 5 || audios.length > 3)) fail('Agnes Flash accepts at most 5 images and 3 audios')
  for (const value of [...frames, ...images, ...audios]) {
    if (typeof value !== 'string' || value.length > 8192) fail('Agnes media must be public HTTP(S) URLs')
    let url: URL
    try { url = new URL(value as string) } catch { return fail('Invalid Agnes media URL') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('Agnes media must be public HTTP(S) URLs without credentials')
  }
  return result
}

export function agnesMediaUrls(params: AgnesVideoParams): string[] {
  return [params.firstFrame, params.lastFrame, ...(params.referenceImages ?? []), ...(params.referenceAudios ?? [])].filter((url): url is string => typeof url === 'string')
}
