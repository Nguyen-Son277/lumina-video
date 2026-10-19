/** Image resolution uses the LONG edge, unlike the video controls. */
export const IMAGE_RATIOS = ['1:1', '16:9', '9:16', '3:2', '2:3'] as const
export const IMAGE_RESOLUTIONS = ['1K', '2K', '4K'] as const
export type ImageRatio = typeof IMAGE_RATIOS[number]
export type ImageResolution = typeof IMAGE_RESOLUTIONS[number]
const edges: Record<ImageResolution, number> = { '1K': 1024, '2K': 2048, '4K': 4096 }
export function imageSizeFor(ratio: ImageRatio, resolution: ImageResolution): string {
  const [w = 1, h = 1] = ratio.split(':').map(Number)
  const edge = edges[resolution]
  const even = (n: number) => Math.round(n / 2) * 2
  return w >= h ? `${edge}x${even(edge * h / w)}` : `${even(edge * w / h)}x${edge}`
}
export function imageSizeSelection(size: string): { ratio: ImageRatio; resolution: ImageResolution; legacy: boolean } {
  for (const ratio of IMAGE_RATIOS) for (const resolution of IMAGE_RESOLUTIONS) {
    if (imageSizeFor(ratio, resolution) === size) return { ratio, resolution, legacy: false }
  }
  // Preserve the closest supported ratio when a user explicitly changes resolution.
  const [w = 1, h = 1] = size.split('x').map(Number)
  const ratio = w > 0 && h > 0
    ? IMAGE_RATIOS.reduce((best, next) => {
      const value = (r: ImageRatio) => { const [a = 1, b = 1] = r.split(':').map(Number); return Math.abs(Math.log(w / h / (a / b))) }
      return value(next) < value(best) ? next : best
    }, IMAGE_RATIOS[0] as ImageRatio) : '1:1'
  return { ratio, resolution: '1K', legacy: true }
}
