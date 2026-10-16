import sharp, { type OverlayOptions } from 'sharp'

export type ReferenceSource = { bytes: Uint8Array; mimeType: string }

/** Bounded, ordered contain-fit grid. Never discard or crop a source. */
export async function composeReferenceSheet(sources: ReferenceSource[]): Promise<Uint8Array> {
  if (!sources.length || sources.length > 16) throw new Error('Reference sheet requires 1–16 source images')
  const columns = Math.ceil(Math.sqrt(sources.length))
  const rows = Math.ceil(sources.length / columns)
  const tileSize = 768
  const layers: OverlayOptions[] = []
  for (let index = 0; index < sources.length; index++) {
    const tile = await sharp(Buffer.from(sources[index]!.bytes), { limitInputPixels: 40_000_000, animated: false, failOn: 'error' })
      .rotate().resize(tileSize, tileSize, { fit: 'contain', background: '#ffffff' }).png().toBuffer()
    layers.push({ input: tile, left: index % columns * tileSize, top: Math.floor(index / columns) * tileSize })
  }
  const output = await sharp({ create: { width: columns * tileSize, height: rows * tileSize, channels: 3, background: '#ffffff' } })
    .composite(layers).png().toBuffer()
  if (output.byteLength > 20 * 1024 * 1024) throw new Error('Reference sheet exceeds 20 MB')
  return new Uint8Array(output)
}

export function referenceSheetPrompt(prompt: string, sourceCount: number): string {
  const columns = Math.ceil(Math.sqrt(sourceCount))
  const positions = Array.from({ length: sourceCount }, (_, index) => `source ${index + 1}: row ${Math.floor(index / columns) + 1}, column ${index % columns + 1}`).join('; ')
  return `${prompt}\n\nThe input is one contact sheet containing ${sourceCount} separate reference images. Read the source numbering in the original instructions as these tiles: ${positions}. Use every tile for its described role. Generate one unified scene, not a grid or collage. Do not reproduce tile boundaries or whitespace.`
}
