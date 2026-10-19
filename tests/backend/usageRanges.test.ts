import { describe, expect, it } from 'vitest'
import { usageDateInputValue, usageRangeBounds } from '../../shared/usageRanges'

describe('usageRangeBounds', () => {
  const local = (year: number, month: number, day: number, hour = 12) =>
    new Date(year, month - 1, day, hour, 0, 0, 0).getTime()
  const end = (year: number, month: number, day: number) => new Date(year, month - 1, day, 23, 59, 59, 999).getTime()

  it('uses the prior local Monday–Sunday week and calendar month', () => {
    const now = local(2025, 3, 12)
    expect(usageRangeBounds('previousWeek', '', '', now)).toEqual({ from: local(2025, 3, 3, 0), to: end(2025, 3, 9) })
    expect(usageRangeBounds('previousMonth', '', '', now)).toEqual({ from: local(2025, 2, 1, 0), to: end(2025, 2, 28) })
  })

  it('uses local calendar boundaries and caps current periods at now', () => {
    const now = local(2025, 3, 12, 14)
    expect(usageRangeBounds('thisMonth', '', '', now)).toEqual({ from: local(2025, 3, 1, 0), to: now })
    expect(usageRangeBounds('today', '', '', now)).toEqual({ from: local(2025, 3, 12, 0), to: now })
    expect(usageRangeBounds('yesterday', '', '', now)).toEqual({ from: local(2025, 3, 11, 0), to: end(2025, 3, 11) })
  })

  it('supports rolling windows and caps all-time at now', () => {
    const now = local(2025, 3, 12, 14)
    expect(usageRangeBounds('7d', '', '', now)).toEqual({ from: now - 7 * 86_400_000, to: now })
    expect(usageRangeBounds('30d', '', '', now)).toEqual({ from: now - 30 * 86_400_000, to: now })
    expect(usageRangeBounds('all', '', '', now)).toEqual({ to: now })
  })

  it('requires complete, valid custom dates and rejects rollover or reversed intervals', () => {
    expect(() => usageRangeBounds('custom', '', '2025-03-01')).toThrow()
    expect(() => usageRangeBounds('custom', '2025-02-30', '2025-03-01')).toThrow()
    expect(() => usageRangeBounds('custom', '2025-03-02', '2025-03-01')).toThrow()
    expect(usageRangeBounds('custom', '2025-03-02', '2025-03-04')).toEqual({ from: local(2025, 3, 2, 0), to: end(2025, 3, 4) })
  })

  it('handles leap years and the previous year at January boundaries', () => {
    expect(usageRangeBounds('previousMonth', '', '', local(2024, 3, 1))).toEqual({ from: local(2024, 2, 1, 0), to: end(2024, 2, 29) })
    expect(usageRangeBounds('previousMonth', '', '', local(2025, 1, 1))).toEqual({ from: local(2024, 12, 1, 0), to: end(2024, 12, 31) })
    expect(usageDateInputValue(local(2025, 3, 9))).toBe('2025-03-09')
  })
})
