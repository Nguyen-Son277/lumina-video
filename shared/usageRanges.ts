export type UsageRange = 'today' | 'yesterday' | 'previousWeek' | 'previousMonth' | 'thisMonth' | '7d' | '30d' | 'all' | 'custom'

function localMidnight(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function epoch(date: Date): number {
  return date.getTime()
}

/** Convert a local calendar date to an HTML date-input value. */
export function usageDateInputValue(value: number): string {
  const date = new Date(value)
  if (!Number.isFinite(value) || Number.isNaN(date.getTime())) return ''
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function parseDateInput(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('rangeInvalid')
  const [year, month, day] = value.split('-').map(Number)
  if (year === undefined || month === undefined || day === undefined || year < 1970) throw new Error('rangeInvalid')
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) throw new Error('rangeInvalid')
  return date
}

/** Bounds are local-time calendar boundaries; completed ranges include their entire last day. */
export function usageRangeBounds(range: UsageRange, from: string, to: string, now = Date.now()): { from?: number; to?: number } {
  const current = new Date(now)
  if (!Number.isFinite(now) || Number.isNaN(current.getTime())) throw new Error('rangeInvalid')
  const today = localMidnight(current)
  const endToday = now
  if (range === 'all') return { to: now }
  if (range === 'custom') {
    const start = parseDateInput(from)
    const finish = parseDateInput(to)
    if (epoch(start) > epoch(finish)) throw new Error('rangeInvalid')
    finish.setDate(finish.getDate() + 1)
    const exclusiveEnd = epoch(finish)
    return { from: epoch(start), to: exclusiveEnd - 1 }
  }
  if (range === 'today') return { from: epoch(today), to: endToday }
  if (range === 'yesterday') {
    const start = new Date(today)
    start.setDate(start.getDate() - 1)
    return { from: epoch(start), to: epoch(today) - 1 }
  }
  if (range === 'thisMonth') return { from: epoch(new Date(current.getFullYear(), current.getMonth(), 1)), to: now }
  if (range === 'previousMonth') {
    const end = new Date(current.getFullYear(), current.getMonth(), 1)
    const start = new Date(current.getFullYear(), current.getMonth() - 1, 1)
    return { from: epoch(start), to: epoch(end) - 1 }
  }
  if (range === 'previousWeek') {
    const end = new Date(today)
    const day = (today.getDay() + 6) % 7
    end.setDate(end.getDate() - day)
    const start = new Date(end)
    start.setDate(start.getDate() - 7)
    return { from: epoch(start), to: epoch(end) - 1 }
  }
  if (range === '7d' || range === '30d') {
    const days = range === '7d' ? 7 : 30
    return { from: Math.max(0, now - days * 24 * 60 * 60 * 1000), to: now }
  }
  throw new Error('rangeInvalid')
}
