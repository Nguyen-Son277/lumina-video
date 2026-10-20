import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

// Run from any directory: node scripts/generateBrand.mjs
// The mark is the source of truth; lettering below is custom vector geometry.
const publicDir = new URL('../public/', import.meta.url)
const save = (name, data) => writeFile(new URL(name, publicDir), data)
const mark = await readFile(new URL('brand/lumina-mark.svg', publicDir), 'utf8')
const drawing = mark.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
const wordmark = `<g fill="none" stroke="#f2efe9" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
  <path d="M92 17v29q0 4 4 4"/>
  <path d="M109 29v13q0 9 9 9t9-9V29"/>
  <path d="M143 50V29m0 8q0-9 8-9t8 9v13m0-13q0-9 8-9t8 9v13"/>
  <path d="M191 30v20"/>
  <path d="M207 50V29m0 9q0-10 10-10t10 10v12"/>
  <path d="M261 30v20m0-11q0-11-10-11t-10 11q0 12 10 12t10-12"/>
</g><circle cx="191" cy="18" r="3.3" fill="#f2efe9"/><circle cx="279" cy="47" r="4" fill="#ba8cff"/>`
const logo = `<svg xmlns="http://www.w3.org/2000/svg" width="296" height="80" viewBox="-4 -8 296 80">${drawing}${wordmark}</svg>\n`
await save('brand/lumina-logo.svg', logo)
await save('brand/lumina-logo.png', await sharp(Buffer.from(logo)).resize(1184, 320).png().toBuffer())
await save('favicon.svg', mark)
await save('apple-touch-icon.png', await sharp(Buffer.from(mark)).resize(180, 180).flatten({ background: '#15121e' }).png().toBuffer())

// ICO directory with standard 32-bit DIB frames (including legacy browser support).
const sizes = [16, 32, 48]
const frames = []
for (const size of sizes) {
  const pixels = await sharp(Buffer.from(mark)).resize(size, size).ensureAlpha().raw().toBuffer()
  const maskStride = Math.ceil(size / 32) * 4
  const bitmap = Buffer.alloc(40 + size * size * 4 + maskStride * size)
  bitmap.writeUInt32LE(40, 0)
  bitmap.writeInt32LE(size, 4)
  bitmap.writeInt32LE(size * 2, 8)
  bitmap.writeUInt16LE(1, 12)
  bitmap.writeUInt16LE(32, 14)
  bitmap.writeUInt32LE(size * size * 4 + maskStride * size, 20)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const source = (y * size + x) * 4
      const target = 40 + ((size - 1 - y) * size + x) * 4
      bitmap[target] = pixels[source + 2]
      bitmap[target + 1] = pixels[source + 1]
      bitmap[target + 2] = pixels[source]
      bitmap[target + 3] = pixels[source + 3]
      if (pixels[source + 3] === 0) {
        bitmap[40 + size * size * 4 + (size - 1 - y) * maskStride + (x >> 3)] |= 0x80 >> (x % 8)
      }
    }
  }
  frames.push(bitmap)
}
const directory = Buffer.alloc(6 + sizes.length * 16)
directory.writeUInt16LE(1, 2)
directory.writeUInt16LE(sizes.length, 4)
let offset = directory.length
frames.forEach((frame, index) => {
  const entry = 6 + index * 16
  directory[entry] = sizes[index]
  directory[entry + 1] = sizes[index]
  directory.writeUInt16LE(1, entry + 4)
  directory.writeUInt16LE(32, entry + 6)
  directory.writeUInt32LE(frame.length, entry + 8)
  directory.writeUInt32LE(offset, entry + 12)
  offset += frame.length
})
await save('favicon.ico', Buffer.concat([directory, ...frames]))

// Presentation sheet; not loaded by the application.
const preview = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="680" viewBox="0 0 1200 680">
  <rect width="1200" height="680" fill="#0c0d10"/>
  <text x="64" y="66" fill="#85878d" font-family="sans-serif" font-size="14" letter-spacing="4">LUMINA STUDIO / BRAND IDENTITY</text>
  <g transform="translate(236 168) scale(2.5)">${drawing}${wordmark}</g>
  <path d="M64 410h1072" stroke="#262930"/>
  <text x="64" y="456" fill="#85878d" font-family="sans-serif" font-size="13" letter-spacing="2">L + PLAY / LIGHT IN MOTION</text>
  <g transform="translate(64 500)">${drawing}</g>
  <g transform="translate(160 516) scale(.5)">${drawing}</g>
  <g transform="translate(220 524) scale(.25)">${drawing}</g>
  <rect x="300" y="490" width="120" height="84" rx="16" fill="#f2efe9"/>
  <g transform="translate(344 516) scale(.5)">${drawing}</g>
  <circle cx="854" cy="532" r="20" fill="#ba8cff"/>
  <circle cx="926" cy="532" r="20" fill="#9f6ef0"/>
  <circle cx="998" cy="532" r="20" fill="#f2efe9"/>
  <circle cx="1070" cy="532" r="20" fill="#15121e" stroke="#383140"/>
  <text x="64" y="630" fill="#696c73" font-family="sans-serif" font-size="13">Custom vector mark · Lavender / Cream / Ink</text>
</svg>`
await save('brand/lumina-preview.png', await sharp(Buffer.from(preview)).png().toBuffer())
console.log(`Generated logo, favicon and preview in ${fileURLToPath(publicDir)}`)
