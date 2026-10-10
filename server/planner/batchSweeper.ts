import type { AppEnv } from '../env'
import type { Database } from '../db/index'
import { logger } from '../lib/logger'
import type { MediaStore } from '../media/store'
import type { Worker } from '../generations/worker'
import { advanceImageBatch, type ImageBatchDeps } from './imageBatch'

/**
 * Bộ quét batch sinh ảnh storyboard.
 *
 * Trước đây batch chỉ tiến khi giao diện poll (`GET /plans/:id/image-batch`). Nếu
 * người dùng đóng tab — hoặc một item kẹt ở hàng đợi vì trần tác vụ đồng thời —
 * batch mãi ở trạng thái `running`, và vì mỗi phiên chỉ có một batch chạy nên
 * người dùng không tạo lại được. Bộ quét này chạy nền: mỗi vòng tiến các batch
 * đang chạy (và batch đã dừng còn item đang chạy), nhờ đó kết quả được đối soát
 * mà không cần poll.
 *
 * Chỉ gọi `advanceImageBatch`; không xếp hàng gì khác và không tạo tác vụ trùng vì
 * item giữ khoá idempotency ổn định theo id item.
 */

/** Trần số batch xử lý mỗi vòng, mới nhất trước, để một vòng không chạy quá lâu. */
export const BATCH_SWEEP_LIMIT = 20

export type BatchSweeper = {
  start: () => void
  stop: () => Promise<void>
  /** Chạy một vòng quét; trả về số batch đã tiến. Dùng trong test để không chờ timer. */
  runOnce: () => number
}

export function createBatchSweeper(options: {
  db: Database
  env: AppEnv
  mediaStore: MediaStore
  worker: Worker
  intervalMs?: number
}): BatchSweeper {
  const { db, env, mediaStore, worker } = options
  const intervalMs = options.intervalMs ?? 3_000
  const deps: ImageBatchDeps = { db, env, mediaStore, worker }

  let timer: NodeJS.Timeout | null = null
  let running = false
  let stopped = false

  function runOnce(): number {
    if (running) return 0
    running = true
    let advanced = 0
    try {
      const batches = db
        .prepare(
          `SELECT id, user_id AS userId, session_id AS sessionId
             FROM plan_image_batches
            WHERE status = 'running' OR (status = 'stopped' AND EXISTS (
               SELECT 1 FROM plan_image_batch_items i WHERE i.batch_id = plan_image_batches.id AND i.status = 'running'
             ))
            ORDER BY created_at DESC
            LIMIT ?`,
        )
        .all(BATCH_SWEEP_LIMIT) as unknown as Array<{
        id: string
        userId: string
        sessionId: string
      }>

      for (const batch of batches) {
        try {
          advanceImageBatch(deps, batch.userId, batch.sessionId, batch.id)
          advanced += 1
        } catch (error) {
          // Một batch lỗi không được chặn các batch khác; trạng thái còn nguyên để
          // vòng sau (hoặc lần đối soát tiếp theo) xử lý.
          logger.warn('Không tiến được batch sinh ảnh', {
            batchId: batch.id,
            message: error instanceof Error ? error.message : 'lỗi không xác định',
          })
        }
      }
    } finally {
      running = false
    }
    return advanced
  }

  return {
    start() {
      if (timer) return
      stopped = false
      timer = setInterval(() => {
        if (stopped) return
        runOnce()
      }, intervalMs)
      // Chạy ngay một vòng để batch kẹt từ trước được xử lý không phải chờ chu kỳ đầu.
      runOnce()
    },

    async stop() {
      stopped = true
      if (timer) clearInterval(timer)
      timer = null
    },

    runOnce,
  }
}
