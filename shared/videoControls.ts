/** UI-only mappings: providers still receive their original size/seconds fields. */
export const VIDEO_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] as const
export const VIDEO_RESOLUTIONS = ['480', '720', '1080', '1440', '2160'] as const
/** K labels use consumer-video conventions, not DCI cinema dimensions. */
export function videoResolutionLabel(resolution: string): string {
  const pixels = resolution.replace(/[pP]$/, '')
  return ({ '1080': '1K (1080p)', '1440': '2K (1440p)', '2160': '4K (2160p)' } as Record<string, string>)[pixels] ?? `${pixels}p`
}
export type VideoRatio = typeof VIDEO_RATIOS[number]
export type VideoResolution = typeof VIDEO_RESOLUTIONS[number]

export function videoSizeFor(ratio: VideoRatio, resolution: VideoResolution): string {
  const [w = 16, h = 9] = ratio.split(':').map(Number)
  const short = Number(resolution)
  // Video encoders require even dimensions. Keep the short edge at the chosen resolution.
  const even = (value: number) => Math.round(value / 2) * 2
  return w >= h ? `${even(short * w / h)}x${short}` : `${short}x${even(short * h / w)}`
}

/** Unknown historical dimensions remain selectable and are never silently rewritten. */
export function videoSizeSelection(size: string): { ratio: VideoRatio; resolution: VideoResolution; legacy: boolean } {
  for (const ratio of VIDEO_RATIOS) for (const resolution of VIDEO_RESOLUTIONS) {
    if (videoSizeFor(ratio, resolution) === size) return { ratio, resolution, legacy: false }
  }
  return { ratio: '16:9', resolution: '720', legacy: true }
}

export function validVideoSeconds(value: unknown, max = 30): boolean {
  return (typeof value === 'string' || typeof value === 'number')
    && /^(?:[4-9]|[12][0-9]|30)$/.test(String(value)) && Number(value) <= max
}

export const AGNES_RESOLUTIONS = ['480P', '720P', '1080P', '1440P', '2160P'] as const
