export const HIGGSFIELD_MODEL = 'bytedance/seedance-2.5'
export const HIGGSFIELD_RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'] as const
export type HiggsfieldParams = {
  mode?: 'text' | 'image'
  duration?: number
  resolution?: '480p' | '720p' | '1080p'
  bitrateMode?: 'standard' | 'high'
  generateAudio?: boolean
  aspectRatio?: string
  outputFormat?: 'mp4' | 'mov'
  imageUrl?: string
  endImageUrl?: string
  imageUploadId?: string
  endImageUploadId?: string
  imageAssetId?: string
  endImageAssetId?: string
  [key: string]: unknown
}
export function normalizeHiggsfieldParams(params: HiggsfieldParams, prompt: string): HiggsfieldParams {
  const allowed = new Set(['mode','duration','resolution','bitrateMode','generateAudio','aspectRatio','outputFormat','imageUrl','endImageUrl','imageUploadId','endImageUploadId','imageAssetId','endImageAssetId','useCharacterReference','logoOverlays','allowTemporaryMedia'])
  const fail = (message: string): never => { throw new Error(message) }
  for (const key of Object.keys(params)) if (!allowed.has(key)) fail(`Unsupported Higgsfield parameter: ${key}`)
  const p = { ...params, mode: params.mode ?? 'text', duration: params.duration ?? 5, resolution: params.resolution ?? '720p', bitrateMode: params.bitrateMode ?? 'high', generateAudio: params.generateAudio ?? true }
  if (!['text','image'].includes(p.mode)) fail('Invalid Higgsfield mode')
  if (!Number.isInteger(p.duration) || p.duration < 4 || p.duration > 30) fail('Duration must be an integer from 4 to 30')
  if (!['480p','720p','1080p'].includes(p.resolution)) fail('Invalid resolution')
  if (!['standard','high'].includes(p.bitrateMode)) fail('Invalid bitrate mode')
  if (typeof p.generateAudio !== 'boolean') fail('Audio must be boolean')
  const frame = (fields: string[], required: boolean) => {
    const present = fields.filter(key => params[key] !== undefined)
    if (present.length > 1 || required && present.length !== 1) fail('Choose exactly one source for each required frame')
    for (const key of present) {
      const value = params[key]
      if (typeof value !== 'string' || !value.trim()) fail('Invalid frame source')
      if (key.endsWith('Url')) {
        let url: URL; try { url = new URL(value as string) } catch { return fail('Invalid frame URL') }
        if (url.protocol !== 'https:' || url.username || url.password) fail('Frames require public HTTPS URLs')
      }
    }
  }
  frame(['imageUrl','imageUploadId','imageAssetId'], p.mode === 'image')
  frame(['endImageUrl','endImageUploadId','endImageAssetId'], false)
  if (p.mode === 'text') {
    if (!prompt.trim()) fail('Text-to-video requires a nonblank prompt')
    if (['imageUrl','imageUploadId','imageAssetId','endImageUrl','endImageUploadId','endImageAssetId'].some(key => params[key] !== undefined)) fail('Text-to-video does not accept images')
    p.aspectRatio = params.aspectRatio ?? '16:9'; p.outputFormat = params.outputFormat ?? 'mp4'
    if (!(HIGGSFIELD_RATIOS as readonly string[]).includes(p.aspectRatio)) fail('Invalid aspect ratio')
    if (!['mp4','mov'].includes(p.outputFormat)) fail('Invalid output format')
  } else if (params.aspectRatio !== undefined || params.outputFormat !== undefined) fail('Image-to-video does not accept aspect ratio or output format')
  return { ...p, useCharacterReference: false }
}
