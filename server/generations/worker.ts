import type { AppEnv } from '../env'
import type { Database } from '../db/index'
import type { MediaStore } from '../media/store'
import { isUncertain } from '../lib/errors'
import { logger } from '../lib/logger'
import { decryptSecret, decodeMasterKey } from '../crypto/providerKey'
import type { ProviderTarget } from '../providers/client'
import {
  downloadVideoContent,
  pollVideoGeneration,
  saveVideoAsset,
  startVideoGeneration,
} from './adapters/video'
import { runImageGeneration } from './adapters/image'
import { sweepAutoGenerate } from './sweeper'
import { maintainProjectTrash } from '../projectsTrash/service'
import { processExportQueue } from '../exports/worker'
import type { GenerationContext, GenerationRow } from './types'

const BASE_BACKOFF_MS = 3_000
const MAX_BACKOFF_MS = 60_000
const MAX_ATTEMPTS = 60

export type Worker = {
  start: () => void
  stop: () => Promise<void>
  /** Chạy một vòng xử lý; dùng trong test để không phải chờ timer. */
  tick: () => Promise<void>
  wake: () => void
}

export function createWorker(options: {
  db: Database
  mediaStore: MediaStore
  env: AppEnv
  intervalMs?: number
}): Worker {
  const { db, mediaStore, env } = options
  const intervalMs = options.intervalMs ?? 2_000
  const masterKey = decodeMasterKey(env.APP_ENCRYPTION_KEY)

  let timer: NodeJS.Timeout | null = null
  let running = false
  let stopped = false
  const stopWaiters: Array<() => void> = []

  function wake(): void {
    if (stopped || running) return
    void tick()
  }

  /**
   * Lấy API key đã mã hóa của provider để dùng cho tác vụ.
   * Trả null nếu provider đã bị xóa — khi đó dùng snapshot để báo lỗi rõ ràng.
   */
  function resolveProviderTarget(row: GenerationRow): ProviderTarget | null {
    if (!row.provider_id) return null

    const provider = db
      .prepare(
        'SELECT base_url AS baseUrl, api_key_ciphertext AS ciphertext, api_key_iv AS iv, api_key_tag AS tag FROM provider_connections WHERE id = ?',
      )
      .get(row.provider_id) as
      | { baseUrl: string; ciphertext: Uint8Array; iv: Uint8Array; tag: Uint8Array }
      | undefined

    if (!provider) return null

    const apiKey = decryptSecret(
      {
        ciphertext: Buffer.from(provider.ciphertext),
        iv: Buffer.from(provider.iv),
        tag: Buffer.from(provider.tag),
      },
      masterKey,
    )

    return {
      // Dùng snapshot để tác vụ đang chạy không đổi đích nếu người dùng sửa Base URL.
      baseUrl: row.snap_base_url,
      apiKey,
      allowPrivate: env.ALLOW_PRIVATE_PROVIDER_URLS,
    }
  }

  function buildContext(row: GenerationRow): GenerationContext | null {
    const provider = resolveProviderTarget(row)
    if (!provider) return null
    return { generation: row, provider, db, mediaStore, env }
  }

  function updateRow(
    id: string,
    patch: Partial<Pick<GenerationRow, 'status' | 'progress' | 'provider_job_id' | 'error_code' | 'error_message' | 'attempt_count' | 'next_poll_at' | 'poll_started_at' | 'completed_at'>>,
  ): void {
    const fields: string[] = []
    const values: Array<string | number | null> = []

    for (const [key, value] of Object.entries(patch)) {
      fields.push(`${key} = ?`)
      values.push(value as string | number | null)
    }
    fields.push('updated_at = ?')
    values.push(Date.now())

    db.prepare(`UPDATE generations SET ${fields.join(', ')} WHERE id = ?`).run(...values, id)
  }

  function failRow(row: GenerationRow, code: string, message: string): void {
    updateRow(row.id, {
      status: 'failed',
      error_code: code,
      error_message: message.slice(0, 500),
      completed_at: Date.now(),
      next_poll_at: null,
    })
    logger.warn('Tác vụ thất bại', { id: row.id, code })
  }

  /** Đếm số tác vụ đang chạy của một người để giới hạn đồng thời. */
  function activeJobsForUser(userId: string): number {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS total FROM generations WHERE user_id = ? AND status IN ('queued','running','downloading')",
      )
      .get(userId) as { total: number }
    return Number(row.total)
  }

  function backoffFor(attempt: number): number {
    return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_MS)
  }

  /** Bắt đầu các tác vụ mới trong hàng đợi. */
  async function startQueued(): Promise<void> {
    const rows = db
      .prepare("SELECT g.* FROM generations g WHERE g.status = 'queued' AND (g.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id = g.project_id AND p.deleted_at IS NULL)) ORDER BY g.created_at ASC LIMIT 10")
      .all() as unknown as GenerationRow[]

    for (const row of rows) {
      if (stopped) return

      // Tác vụ đang 'queued' đã được tính trong activeJobsForUser, nên nhận nó
      // không làm tăng số tác vụ hoạt động. Chỉ bỏ qua khi đã vượt trần.
      if (activeJobsForUser(row.user_id) > env.MAX_CONCURRENT_JOBS_PER_USER) {
        continue
      }

      // Nhận tác vụ bằng một câu UPDATE có điều kiện status: hai vòng xử lý (hoặc
      // hai tiến trình) không thể cùng nhận một hàng, nên không gửi trùng provider
      // và không bị tính phí hai lần. Không bọc trong transaction vì phía sau là
      // lời gọi mạng dài, giữ khóa ghi suốt thời gian đó sẽ chặn mọi request khác.
      const claimedAt = Date.now()
      const claimed = db
        .prepare(
          `UPDATE generations
              SET status = 'running', attempt_count = attempt_count + 1,
                  poll_started_at = ?, updated_at = ?
            WHERE id = ? AND status = 'queued'`,
        )
        .run(claimedAt, claimedAt, row.id)

      if (Number(claimed.changes) !== 1) continue

      // Dùng bản đã cập nhật để phần còn lại thấy đúng trạng thái vừa nhận.
      const claimedRow: GenerationRow = {
        ...row,
        status: 'running',
        attempt_count: row.attempt_count + 1,
        poll_started_at: claimedAt,
      }

      const context = buildContext(claimedRow)
      if (!context) {
        failRow(
          claimedRow,
          'PROVIDER_MISSING',
          'Provider của tác vụ này đã bị xóa. Hãy thêm lại provider rồi thử tạo mới.',
        )
        continue
      }

      try {
        if (claimedRow.kind === 'image') {
          await runImageGeneration(context)
          updateRow(claimedRow.id, {
            status: 'succeeded',
            progress: 100,
            completed_at: Date.now(),
            error_code: null,
            error_message: null,
          })
          logger.info('Tạo ảnh thành công', { id: claimedRow.id })
        } else {
          const started = await startVideoGeneration(context)
          updateRow(claimedRow.id, {
            status: 'running',
            provider_job_id: started.providerJobId,
            progress: started.progress ?? 0,
            next_poll_at: Date.now() + BASE_BACKOFF_MS,
          })
          logger.info('Đã tạo job video', { id: claimedRow.id, providerJobId: started.providerJobId })
        }
      } catch (error) {
        handleStartFailure(claimedRow, error)
      }
    }
  }

  function handleStartFailure(row: GenerationRow, error: unknown): void {
    const message = error instanceof Error ? error.message : 'Lỗi không xác định'
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code: unknown }).code)
        : 'PROVIDER_ERROR'

    if (isUncertain(error)) {
      // Không tự gửi lại: provider có thể đã nhận và đang xử lý.
      updateRow(row.id, {
        status: 'unknown',
        error_code: 'OUTCOME_UNKNOWN',
        error_message: message,
        next_poll_at: null,
      })
      logger.warn('Kết quả không xác định, không tự gửi lại', { id: row.id })
      return
    }

    failRow(row, code, message)
  }

  /** Theo dõi các job video đang chạy. */
  async function pollRunning(): Promise<void> {
    const now = Date.now()
    const rows = db
      .prepare(
        `SELECT * FROM generations
         WHERE kind = 'video' AND status = 'running' AND provider_job_id IS NOT NULL
           AND (next_poll_at IS NULL OR next_poll_at <= ?)
         ORDER BY next_poll_at ASC LIMIT 10`,
      )
      .all(now) as unknown as GenerationRow[]

    for (const row of rows) {
      if (stopped) return

      const startedAt = row.poll_started_at ?? row.created_at
      if (now - startedAt > env.VIDEO_POLL_TIMEOUT_MS) {
        updateRow(row.id, {
          status: 'unknown',
          error_code: 'POLL_TIMEOUT',
          error_message:
            'Đã dừng theo dõi tự động sau thời gian chờ. Bạn có thể kiểm tra lại bằng ID job mà không tạo video mới.',
          next_poll_at: null,
        })
        logger.warn('Dừng theo dõi video do quá hạn', { id: row.id })
        continue
      }

      const context = buildContext(row)
      if (!context) {
        failRow(row, 'PROVIDER_MISSING', 'Provider của tác vụ này đã bị xóa.')
        continue
      }

      try {
        const snapshot = await pollVideoGeneration(context)

        if (snapshot.state === 'completed') {
          updateRow(row.id, { status: 'downloading', progress: 100, next_poll_at: null })
          await downloadAndStore(row, context)
          continue
        }

        if (snapshot.state === 'failed') {
          failRow(row, 'PROVIDER_FAILED', snapshot.errorMessage ?? 'Provider báo tác vụ thất bại')
          continue
        }

        updateRow(row.id, {
          status: 'running',
          progress: snapshot.progress ?? row.progress ?? 0,
          attempt_count: row.attempt_count + 1,
          next_poll_at: Date.now() + BASE_BACKOFF_MS,
        })
      } catch (error) {
        const attempt = row.attempt_count + 1
        updateRow(row.id, {
          attempt_count: attempt,
          next_poll_at: Date.now() + backoffFor(attempt),
          error_message: error instanceof Error ? error.message.slice(0, 500) : null,
        })
        logger.warn('Lỗi tạm thời khi theo dõi video, sẽ thử lại', { id: row.id, attempt })
      }
    }
  }

  /** Tải nội dung video và lưu vào kho media. */
  async function downloadAndStore(row: GenerationRow, context: GenerationContext): Promise<void> {
    try {
      const bytes = await downloadVideoContent(context)
      saveVideoAsset(context, bytes)
      updateRow(row.id, {
        status: 'succeeded',
        progress: 100,
        completed_at: Date.now(),
        error_code: null,
        error_message: null,
      })
      logger.info('Tải video thành công', { id: row.id })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Lỗi không xác định'
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code: unknown }).code)
          : 'DOWNLOAD_FAILED'

      // Giữ lại provider_job_id để người dùng có thể thử tải lại mà không tạo mới.
      updateRow(row.id, {
        status: 'failed',
        error_code: code,
        error_message: `Không tải được video: ${message}`.slice(0, 500),
        completed_at: Date.now(),
      })
      logger.warn('Tải video thất bại, giữ job ID để thử lại', { id: row.id })
    }
  }

  /**
   * Khôi phục sau khi khởi động lại backend.
   * - Tác vụ 'running' có provider_job_id: tiếp tục theo dõi.
   * - Tác vụ 'running' không có ID: không rõ provider đã nhận hay chưa → đánh dấu unknown.
   * - Tác vụ 'downloading': thử tải lại nội dung đã có.
   */
  function recoverOnBoot(): void {
    const orphaned = db
      .prepare(
        "SELECT id FROM generations WHERE status = 'running' AND provider_job_id IS NULL",
      )
      .all() as Array<{ id: string }>

    for (const row of orphaned) {
      updateRow(row.id, {
        status: 'unknown',
        error_code: 'INTERRUPTED',
        error_message:
          'Backend khởi động lại khi tác vụ đang chạy và chưa có ID job. Không tự gửi lại để tránh tính phí hai lần — hãy kiểm tra ở provider trước khi thử lại.',
      })
    }

    // Đưa các tác vụ đang tải về hàng đợi để thử tải lại.
    db.prepare(
      "UPDATE generations SET status = 'running', next_poll_at = NULL WHERE status = 'downloading'",
    ).run()

    if (orphaned.length > 0) {
      logger.warn('Đánh dấu tác vụ không xác định sau khi khởi động lại', { count: orphaned.length })
    }
  }

  async function tick(): Promise<void> {
    if (running || stopped) return
    running = true
    try {
      maintainProjectTrash({ db, mediaStore })
      // Nạp trước các cảnh đã duyệt còn chờ, rồi mới xử lý hàng đợi trong cùng vòng.
      sweepAutoGenerate({ db, env, worker: instance })
      await startQueued()
      await pollRunning()
      // Xuất video chạy sau cùng: đây là việc nặng CPU, không được chặn tác vụ tạo.
      await processExportQueue({ db, env, mediaStore })
    } catch (error) {
      logger.error('Lỗi trong vòng xử lý worker', error)
    } finally {
      running = false
      for (const resolve of stopWaiters.splice(0)) resolve()
    }
  }

  const instance: Worker = {
    start() {
      stopped = false
      recoverOnBoot()
      timer = setInterval(() => void tick(), intervalMs)
      // Chạy ngay một vòng để không phải chờ hết chu kỳ đầu.
      void tick()
      logger.info('Worker đã khởi động', { intervalMs })
    },

    async stop() {
      stopped = true
      if (timer) clearInterval(timer)
      timer = null
      if (running) await new Promise<void>(resolve => stopWaiters.push(resolve))
    },

    tick,
    wake,
  }

  return instance
}
