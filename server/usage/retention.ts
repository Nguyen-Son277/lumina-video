import type { Database } from '../db/index'
import { logger } from '../lib/logger'
import { purgeExpiredUsageLogs } from './service'

/** Log LLM được giữ 90 ngày; ảnh/video là nội dung thật nên không bị dọn. */
export const RETENTION_DAYS = 90
/** Chạy tối đa một lần mỗi giờ dù worker tick mỗi vài giây. */
const INTERVAL_MS = 60 * 60 * 1000

let lastRunAt = 0

/**
 * Dọn log LLM cũ.
 *
 * Gọi từ vòng tick của worker; tự giới hạn tần suất và không bao giờ ném lỗi để
 * một sự cố dọn dẹp không làm dừng hàng đợi tạo nội dung.
 */
export function maintainUsageRetention(options: { db: Database; now?: number; force?: boolean }): number {
  const now = options.now ?? Date.now()
  if (!options.force && now - lastRunAt < INTERVAL_MS) return 0
  lastRunAt = now
  try {
    return purgeExpiredUsageLogs(options.db, { days: RETENTION_DAYS, now })
  } catch (error) {
    logger.warn('Không dọn được nhật ký sử dụng cũ', { error })
    return 0
  }
}

/** Chỉ dùng trong test: đặt lại mốc giới hạn tần suất. */
export function resetUsageRetentionClock(): void {
  lastRunAt = 0
}
