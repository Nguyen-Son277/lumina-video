import { describe, expect, it } from 'vitest'
import { buildUsageBreakdown, buildUsageTimeline, usageChartCount, type UsageChartDaily } from '../../shared/usageCharts'

const utc = (date: string) => Date.parse(`${date}T00:00:00Z`)
const row = (date: string, count: number, kind: UsageChartDaily['kind'] = 'image'): UsageChartDaily => ({ date, kind, count })

describe('buildUsageTimeline', () => {
  it('fills missing inclusive UTC days and merges duplicate kind rows without costs', () => {
    const result = buildUsageTimeline([row('2025-01-01', 2), row('2025-01-01', 3), row('2025-01-03', 4, 'video')], { from: utc('2025-01-01'), to: utc('2025-01-03') })
    expect(result.granularity).toBe('day')
    expect(result.buckets.map(bucket => bucket.total)).toEqual([5, 0, 4])
    expect(result.buckets[0]!.counts).toEqual({ image: 5, video: 0, llm: 0 })
    expect(result.buckets[2]!.end).toBe(utc('2025-01-03'))
  })

  it('uses earliest data through now for unbounded history, not just the last data day', () => {
    const result = buildUsageTimeline([row('2025-01-02', 1)], { now: utc('2025-01-05') + 12345 })
    expect(result.buckets).toHaveLength(4)
    expect(result.buckets.map(bucket => bucket.total)).toEqual([1, 0, 0, 0])
  })

  it('normalizes millisecond bounds to UTC day labels and excludes rows outside the window', () => {
    const result = buildUsageTimeline([row('2025-01-01', 5), row('2025-01-02', 2), row('2025-01-03', 8)], { from: utc('2025-01-02') + 3600000, to: utc('2025-01-02') + 86399999 })
    expect(result.buckets).toEqual([{ start: utc('2025-01-02'), end: utc('2025-01-02'), counts: { image: 2, video: 0, llm: 0 }, total: 2 }])
  })

  it('chooses daily through 31 days and weekly from 32 through 180 days', () => {
    const from = utc('2025-01-01')
    expect(buildUsageTimeline([], { from, to: from + 30 * 86400000 }).granularity).toBe('day')
    const weekly = buildUsageTimeline([row('2025-01-08', 3, 'llm')], { from, to: from + 31 * 86400000 })
    expect(weekly.granularity).toBe('week')
    expect(weekly.buckets).toHaveLength(5)
    expect(weekly.buckets[1]!.counts.llm).toBe(3)
    expect(weekly.buckets[4]!.end).toBe(from + 31 * 86400000)
    expect(buildUsageTimeline([], { from, to: from + 179 * 86400000 }).granularity).toBe('week')
    expect(buildUsageTimeline([], { from, to: from + 180 * 86400000 }).granularity).toBe('month')
  })

  it('uses calendar months with clipped edges, leap days and year transitions', () => {
    const result = buildUsageTimeline([row('2023-12-31', 2), row('2024-02-29', 5, 'llm'), row('2024-06-03', 7, 'video')], { from: utc('2023-12-02'), to: utc('2024-06-03') })
    expect(result.granularity).toBe('month')
    expect(result.buckets).toHaveLength(7)
    expect(result.buckets[0]!.start).toBe(utc('2023-12-02'))
    expect(result.buckets[2]!.end).toBe(utc('2024-02-29'))
    expect(result.buckets[2]!.counts.llm).toBe(5)
    expect(result.buckets[6]!.end).toBe(utc('2024-06-03'))
    expect(result.buckets.reduce((sum, bucket) => sum + bucket.total, 0)).toBe(14)
  })

  it('adapts long history to at most 60 contiguous buckets without dropping counts', () => {
    const result = buildUsageTimeline([row('2000-01-01', 2), row('2025-12-31', 7, 'llm')], { from: utc('2000-01-01'), to: utc('2025-12-31') })
    expect(result.step).toBe(6)
    expect(result.buckets.length).toBeLessThanOrEqual(60)
    expect(result.buckets.reduce((sum, bucket) => sum + bucket.total, 0)).toBe(9)
    result.buckets.slice(1).forEach((bucket, index) => expect(bucket.start).toBe(result.buckets[index]!.end + 86400000))
  })

  it('ignores malformed dates and unsafe counts and safely handles empty/reversed ranges', () => {
    const result = buildUsageTimeline([row('2025-02-30', 10), row('bad', 3), row('2025-02-01', NaN), row('2025-02-01', -3), row('2025-02-01', Infinity)], { from: utc('2025-02-01'), to: utc('2025-02-01') })
    expect(result.buckets[0]!.total).toBe(0)
    expect(buildUsageTimeline([], { now: utc('2025-02-01') }).buckets).toHaveLength(1)
    expect(buildUsageTimeline([], { from: utc('2025-02-02'), to: utc('2025-02-01') }).buckets).toEqual([])
  })
})

describe('buildUsageBreakdown', () => {
  it('computes count shares using all three kinds with no cost input', () => {
    expect(buildUsageBreakdown({ image: { count: 3 }, video: { count: 1 }, llm: { count: 0 } })).toEqual([
      { kind: 'image', count: 3, percent: 75 }, { kind: 'video', count: 1, percent: 25 }, { kind: 'llm', count: 0, percent: 0 },
    ])
  })
  it('is safe for zero, nonfinite and negative totals', () => {
    expect(buildUsageBreakdown({ image: { count: 0 }, video: { count: -1 }, llm: { count: NaN } }).map(entry => entry.percent)).toEqual([0, 0, 0])
    expect(usageChartCount(Infinity)).toBe(0)
    expect(usageChartCount(2.9)).toBe(2)
  })
})
