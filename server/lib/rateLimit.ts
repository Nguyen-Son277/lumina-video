/**
 * Rate limit trong bộ nhớ. Phù hợp mô hình chạy một tiến trình trên một máy.
 * Nếu sau này chạy nhiều replica, cần chuyển sang store dùng chung.
 */

type Bucket = {
  count: number
  resetAt: number
}

export type RateLimiter = {
  check: (key: string) => boolean
  remaining: (key: string) => number
  reset: (key: string) => void
}

export function createRateLimiter(options: {
  windowMs: number
  max: number
}): RateLimiter {
  const buckets = new Map<string, Bucket>()

  function sweep(now: number): void {
    if (buckets.size < 1000) return
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key)
    }
  }

  return {
    check(key: string): boolean {
      const now = Date.now()
      sweep(now)

      const existing = buckets.get(key)
      if (!existing || existing.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + options.windowMs })
        return true
      }
      if (existing.count >= options.max) return false
      existing.count += 1
      return true
    },

    remaining(key: string): number {
      const bucket = buckets.get(key)
      if (!bucket || bucket.resetAt <= Date.now()) return options.max
      return Math.max(0, options.max - bucket.count)
    },

    reset(key: string): void {
      buckets.delete(key)
    },
  }
}

/** Lấy IP client, ưu tiên header proxy khi có. */
export function clientIp(req: { ip?: string; socket?: { remoteAddress?: string }; headers: Record<string, unknown> }): string {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]!.trim()
  }
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown'
}
