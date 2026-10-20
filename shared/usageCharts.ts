/** Pure UTC count-chart helpers; no browser or server dependencies. */
export const USAGE_CHART_KINDS = ['image', 'video', 'llm'] as const
export type UsageChartKind = (typeof USAGE_CHART_KINDS)[number]
export type UsageChartCounts = Record<UsageChartKind, number>
export type UsageChartDaily = { date: string; kind: UsageChartKind; count: number }
export type UsageChartGranularity = 'day' | 'week' | 'month'
export type UsageChartBucket = {
  /** Inclusive UTC day boundaries (end is midnight of the last included day). */
  start: number
  end: number
  counts: UsageChartCounts
  total: number
}
export type UsageChartTimeline = {
  granularity: UsageChartGranularity
  /** Number of days/weeks/months represented by each bucket. */
  step: number
  buckets: UsageChartBucket[]
}
export type UsageChartOptions = { from?: number; to?: number; now?: number }
export type UsageChartBreakdown = { kind: UsageChartKind; count: number; percent: number }
const DAY = 86_400_000
const emptyCounts = (): UsageChartCounts => ({ image: 0, video: 0, llm: 0 })
const day = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime())
    ? Math.floor(value / DAY) * DAY : undefined

function parseDay(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const result = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(result) && new Date(result).toISOString().slice(0, 10) === value ? result : undefined
}

/** Invalid/negative counts cannot produce NaN, negative SVG heights or percentages. */
export function usageChartCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/**
 * Fill missing UTC days, including both boundary days. Daily rows are already
 * aggregated by the API, so sub-day bounds select their intersecting UTC days.
 * Unbounded history starts at its earliest valid row and ends today (not at the
 * last row). Month groups expand automatically so even decades use <=60 bars.
 */
export function buildUsageTimeline(daily: readonly UsageChartDaily[], options: UsageChartOptions = {}): UsageChartTimeline {
  const rows = daily.flatMap(row => {
    const date = parseDay(row.date)
    return date !== undefined && USAGE_CHART_KINDS.includes(row.kind)
      ? [{ date, kind: row.kind, count: usageChartCount(row.count) }] : []
  })
  const finish = day(options.to) ?? day(options.now) ?? day(Date.now())!
  const earliest = rows.reduce((min, row) => Math.min(min, row.date), finish)
  const start = day(options.from) ?? earliest
  const length = Math.round((finish - start) / DAY) + 1
  const granularity: UsageChartGranularity = length <= 31 ? 'day' : length <= 180 ? 'week' : 'month'
  if (length <= 0) return { granularity, step: 1, buckets: [] }
  const startDate = new Date(start)
  const endDate = new Date(finish)
  const firstMonth = startDate.getUTCFullYear() * 12 + startDate.getUTCMonth()
  const lastMonth = endDate.getUTCFullYear() * 12 + endDate.getUTCMonth()
  const step = granularity === 'month' ? Math.max(1, Math.ceil((lastMonth - firstMonth + 1) / 60)) : 1
  const buckets: UsageChartBucket[] = []
  if (granularity === 'month') {
    for (let month = firstMonth; month <= lastMonth; month += step) {
      // setUTCFullYear handles years 0–99 without Date.UTC's 1900 offset.
      const next = new Date(0)
      next.setUTCFullYear(Math.floor((month + step) / 12), (month + step) % 12, 1)
      const nextStart = next.getTime()
      const previous = buckets[buckets.length - 1]
      buckets.push({ start: previous ? previous.end + DAY : start, end: Math.min(finish, nextStart - DAY), counts: emptyCounts(), total: 0 })
    }
  } else {
    const width = (granularity === 'week' ? 7 : 1) * DAY
    for (let cursor = start; cursor <= finish; cursor += width) {
      buckets.push({ start: cursor, end: Math.min(finish, cursor + width - DAY), counts: emptyCounts(), total: 0 })
    }
  }
  for (const row of rows) {
    if (row.date < start || row.date > finish) continue
    const index = granularity === 'month'
      ? Math.floor((new Date(row.date).getUTCFullYear() * 12 + new Date(row.date).getUTCMonth() - firstMonth) / step)
      : Math.floor((row.date - start) / ((granularity === 'week' ? 7 : 1) * DAY))
    const bucket = buckets[index]
    if (bucket) {
      bucket.counts[row.kind] += row.count
      bucket.total += row.count
    }
  }
  return { granularity, step, buckets }
}

/** Percentages use kind totals, not cost or potentially unrelated overall totals. */
export function buildUsageBreakdown(totals: Record<UsageChartKind, { count: number }>): UsageChartBreakdown[] {
  const counts = USAGE_CHART_KINDS.map(kind => ({ kind, count: usageChartCount(totals[kind].count) }))
  const total = counts.reduce((sum, entry) => sum + entry.count, 0)
  return counts.map(entry => ({ ...entry, percent: total > 0 ? entry.count / total * 100 : 0 }))
}
