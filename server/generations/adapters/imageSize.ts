import { IMAGE_RATIOS, IMAGE_RESOLUTIONS, imageSizeFor } from '../../../shared/imageControls'
import { providerIncompatible } from '../../lib/errors'

/**
 * 9Router's Antigravity adapter treats `size` as an aspect-ratio token, not an
 * output pixel size. Its sizeToAspectRatio helper recognizes only these exact
 * strings; every other string silently becomes 1:1. Encode our UI selections
 * using that contract without resizing the resulting image or claiming 2K/4K.
 * Do not apply this workaround to OpenAI, Codex, Agnes or other Gemini routes.
 */
const antigravitySizes = {
  '1:1': '1024x1024',
  '16:9': '1792x1024',
  '9:16': '1024x1792',
  '3:2': '1536x1024',
  '2:3': '1024x1536',
} as const

const antigravitySizeTokens = new Set<string>(Object.values(antigravitySizes))
const uiSizeTokens = new Map<string, string>(IMAGE_RATIOS.flatMap(ratio =>
  IMAGE_RESOLUTIONS.map(resolution => [imageSizeFor(ratio, resolution), antigravitySizes[ratio]] as const),
))

export function imageSizeForModel(modelId: string, size: string): string {
  if (!/^(?:ag|antigravity)\/gemini-[^/]*image(?:-preview)?$/i.test(modelId)) return size
  if (antigravitySizeTokens.has(size)) return size
  const token = uiSizeTokens.get(size)
  if (token) return token
  // Fail before submitting a potentially paid request rather than silently
  // returning a square for a custom ratio we cannot represent through 9Router.
  throw providerIncompatible(
    'Model ảnh Antigravity qua 9Router chỉ nhận tỉ lệ 1:1, 16:9, 9:16, 3:2 hoặc 2:3. Hãy chọn một tỉ lệ được hỗ trợ; kích thước pixel đầu ra do model quyết định.',
  )
}
