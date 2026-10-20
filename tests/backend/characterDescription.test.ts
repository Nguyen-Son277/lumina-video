import { describe, expect, it } from 'vitest'
import { shortenAppearance } from '../../src/characterDescription'

describe('character card description', () => {
  it('preserves empty, short and exactly 200-character descriptions', () => {
    for (const value of ['', 'Ngoại hình nhân vật', 'a'.repeat(200)]) expect(shortenAppearance(value)).toBe(value)
  })
  it('limits long descriptions to 197 code points plus an ellipsis', () => {
    const original = 'a'.repeat(250)
    expect(shortenAppearance(original)).toBe(`${'a'.repeat(197)}...`)
    expect(original).toHaveLength(250)
  })
  it('does not split Unicode surrogate pairs', () => {
    const result = shortenAppearance('😀'.repeat(201))
    expect(result).toBe(`${'😀'.repeat(197)}...`)
    expect(Array.from(result)).toHaveLength(200)
  })
})
