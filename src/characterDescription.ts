/** Limit card copy only; never truncate the stored appearance or form value. */
export function shortenAppearance(text: string): string {
  const codepoints = Array.from(text)
  return codepoints.length <= 200 ? text : `${codepoints.slice(0, 197).join('')}...`
}
