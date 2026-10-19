import { publishGenerationImages, recoverImagePublications } from '../entityLibrary/publication'
import type { AppEnv } from '../env'
import type { Database } from '../db/index'
import type { MediaStore } from '../media/store'
import { AppError, errorMetadataOf, isUncertain, type ErrorMessageKey, type ErrorMessageParams } from '../lib/errors'
import { genericMessageKeyForCode } from '../../shared/errorCatalog'
import { logger } from '../lib/logger'
import { pinGenerationTarget, pinnedTargetForRow, selectPoolTarget } from '../providers/pool'
import {
  downloadVideoContent,
  pollVideoGeneration,
  saveVideoAsset,
  startVideoGeneration,
} from './adapters/video'
import { runImageGeneration } from './adapters/image'
import { sweepAutoGenerate } from './sweeper'
import { maintainTrash } from '../trash/service'
import { processExportQueue } from '../exports/worker'
import { maintainUsageRetention } from '../usage/retention'
import { postprocessGenerationLogos } from '../entityLibrary/postprocess'
import { revokeGenerationMediaGrants } from '../entityLibrary/mediaGrants'
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

  let timer: NodeJS.Timeout | null = null
  let running = false
  let stopped = false
  const stopWaiters: Array<() => void> = []

  function wake(): void {
    if (stopped || running) return
    void tick()
  }

  /** Provider còn tồn tại hay không (không lộ chi tiết cấu hình). */
  function providerExists(providerId: string): boolean {
    return Boolean(db.prepare('SELECT 1 AS ok FROM provider_connections WHERE id = ?').get(providerId))
  }

  /**
   * Chuẩn bị context cho lần GỬI ĐẦU TIÊN: chọn key khả dụng từ pool và GHIM
   * key + URL vào hàng tác vụ TRƯỚC khi gọi provider. Nhờ vậy nếu tiến trình
   * chết giữa lúc gửi, tác vụ vẫn biết chính xác key nào có thể đã nhận yêu cầu.
   *
   * Trả null khi provider không còn tồn tại. Ném lỗi (AppError) khi pool rỗng,
   * mọi key bị tắt/đang nghỉ, hoặc key không giải mã được — worker sẽ đánh dấu
   * thất bại thay vì để hàng tác vụ mắc kẹt ở trạng thái chạy.
   */
  function prepareSubmitContext(row: GenerationRow): GenerationContext | null {
    if (!row.provider_id) return null
    if (!providerExists(row.provider_id)) return null

    const target = row.snap_video_style === 'higgsfield' && row.credential_id
      ? pinnedTargetForRow(db, env, row)!
      : selectPoolTarget(db, env, row.provider_id)
    if (row.snap_video_style === 'higgsfield') target.authScheme = 'higgsfield'
    pinGenerationTarget(db, row.id, target)

    return {
      generation: {
        ...row,
        credential_id: target.credentialId,
        snap_credential_hint: target.keyHint,
        snap_credential_base_url: target.baseUrl,
      },
      provider: target,
      db,
      mediaStore,
      env,
    }
  }

  /**
   * Context cho tác vụ ĐÃ GỬI provider (poll/tải lại): luôn dùng đúng key và URL
   * đã ghim, kể cả khi key đã bị tắt hay provider đã đổi URL. Không bao giờ nhảy
   * sang key khác — các key có thể thuộc tài khoản upstream khác nhau.
   *
   * Trả null khi provider không còn tồn tại.
   */
  function pinnedContext(row: GenerationRow): GenerationContext | null {
    const target = pinnedTargetForRow(db, env, row)
    if (!target) return null
    if (row.snap_video_style === 'higgsfield') target.authScheme = 'higgsfield'

    if (row.credential_id === target.credentialId) {
      return { generation: row, provider: target, db, mediaStore, env }
    }

    return {
      generation: {
        ...row,
        credential_id: target.credentialId,
        snap_credential_hint: target.keyHint,
        snap_credential_base_url: target.baseUrl,
      },
      provider: target,
      db,
      mediaStore,
      env,
    }
  }

  function updateRow(
    id: string,
    patch: Partial<Pick<GenerationRow, 'status' | 'progress' | 'provider_job_id' | 'provider_result_url' | 'error_code' | 'error_message' | 'error_message_key' | 'error_message_params' | 'attempt_count' | 'next_poll_at' | 'poll_started_at' | 'completed_at' | 'credential_id' | 'snap_credential_hint' | 'snap_credential_base_url'>>,
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

  /** Tham số rỗng thì lưu NULL để cột sạch và dễ phân biệt với dữ liệu cũ. */
  function serializeParams(params: ErrorMessageParams | undefined): string | null {
    if (!params || Object.keys(params).length === 0) return null
    return JSON.stringify(params)
  }

  type ErrorMeta = { messageKey: ErrorMessageKey; messageParams: ErrorMessageParams }

  function failRow(row: GenerationRow, code: string, message: string, meta?: ErrorMeta): void {
    // Revoke media grants so a stopped job cannot keep serving its inputs.
    if (code === 'CANCELLED') revokeGenerationMediaGrants(db, row.user_id, row.id)
    updateRow(row.id, {
      status: 'failed',
      error_code: code,
      error_message: message.slice(0, 500),
      error_message_key: meta?.messageKey ?? genericMessageKeyForCode(code),
      error_message_params: serializeParams(meta?.messageParams),
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

  /** Local failures must never reach provider submit/download failure handlers. */
  async function postprocessLogos(row: GenerationRow): Promise<void> {
    try {
      await postprocessGenerationLogos({ db, mediaStore, env, generation: row })
      publishGenerationImages({ db, mediaStore, env, generationId: row.id })
    } catch (error) {
      logger.error('Lỗi xử lý logo cục bộ; giữ kết quả provider', error)
      try {
        db.prepare("UPDATE generations SET postprocess_status = 'failed', postprocess_error = ?, updated_at = ? WHERE id = ?")
          .run('Không thể ghép logo; bản gốc vẫn được giữ.', Date.now(), row.id)
      } catch (persistError) {
        logger.error('Không lưu được trạng thái logo cục bộ', persistError)
      }
    }
  }

  /** Retry only local composites; no provider/key lookup or adapter call. */
  async function retryQueuedLogos(): Promise<void> {
    const rows = db.prepare(`SELECT * FROM generations WHERE status = 'succeeded'
      AND postprocess_status = 'queued' AND deleted_at IS NULL ORDER BY updated_at LIMIT 10`)
      .all() as unknown as GenerationRow[]
    for (const row of rows) {
      if (stopped) return
      await postprocessLogos(row)
    }
  }

  /** Bắt đầu các tác vụ mới trong hàng đợi. */
  async function startQueued(): Promise<void> {
    const rows = db
      .prepare("SELECT g.* FROM generations g WHERE g.status = 'queued' AND (g.next_poll_at IS NULL OR g.next_poll_at <= ?) AND (g.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id = g.project_id AND p.deleted_at IS NULL)) ORDER BY g.created_at ASC LIMIT 10")
      .all(Date.now()) as unknown as GenerationRow[]

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
            WHERE id = ? AND status = 'queued'
              AND (next_poll_at IS NULL OR next_poll_at <= ?)`,
        )
        .run(claimedAt, claimedAt, row.id, claimedAt)

      if (Number(claimed.changes) !== 1) continue

      // Dùng bản đã cập nhật để phần còn lại thấy đúng trạng thái vừa nhận.
      const claimedRow: GenerationRow = {
        ...row,
        status: 'running',
        attempt_count: row.attempt_count + 1,
        poll_started_at: claimedAt,
      }

      // Chọn key + ghim vào hàng tác vụ TRƯỚC khi gửi provider. Lỗi chọn key
      // (pool rỗng, mọi key bị tắt/đang nghỉ, không giải mã được) được xử lý
      // trong try để hàng không bị mắc kẹt ở trạng thái 'running'.
      let context: GenerationContext | null
      try {
        context = prepareSubmitContext(claimedRow)
      } catch (error) {
        handleStartFailure(claimedRow, error)
        continue
      }

      if (!context) {
        failRow(
          claimedRow,
          'PROVIDER_MISSING',
          'Provider của tác vụ này đã bị xóa. Hãy thêm lại provider rồi thử tạo mới.',
          { messageKey: 'generations.provider_missing', messageParams: {} },
        )
        continue
      }

      try {
        if (claimedRow.kind === 'image') {
          await runImageGeneration(context)
          await postprocessLogos(context.generation)
          updateRow(claimedRow.id, {
            status: 'succeeded',
            progress: 100,
            completed_at: Date.now(),
            error_code: null,
            error_message: null,
            error_message_key: null,
            error_message_params: null,
          })
          logger.info('Tạo ảnh thành công', { id: claimedRow.id })
        } else {
          const started = await startVideoGeneration(context)
          updateRow(claimedRow.id, {
            status: 'running',
            provider_job_id: started.providerJobId,
            error_code: null,
            error_message: null,
            error_message_key: null,
            error_message_params: null,
            progress: started.progress ?? 0,
            next_poll_at: Date.now() + (row.snap_video_style === 'higgsfield' ? Math.min(10_000, 2000 * 1.5 ** ((JSON.parse(context.generation.higgsfield_json ?? '{}').pollAttempts ?? 0))) + Math.random() * 500 : row.snap_video_style === 'agnes' ? 2_000 : BASE_BACKOFF_MS),
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

    const meta = errorMetadataOf(error)

    if (error instanceof AppError && error.code === 'HIGGSFIELD_REPLAY' && row.snap_video_style === 'higgsfield') {
      const retryAfter = Number(error.messageParams.retryAfter) || 2
      updateRow(row.id, { status: 'queued', poll_started_at: null,
        next_poll_at: Date.now() + retryAfter * 1000,
        error_code: error.code, error_message: error.message,
        error_message_key: meta.messageKey,
        error_message_params: serializeParams({ ...meta.messageParams, retryAfter: Math.round(retryAfter) }) })
      return
    }

    if (error instanceof AppError && error.code === 'AGNES_QUEUE_FULL' && row.kind === 'video' && row.snap_video_style === 'agnes' && !row.provider_job_id) {
      // Bounded retries only after an explicit rejection, never an ambiguous POST.
      if (row.attempt_count >= 6) {
        failRow(row, code, 'Agnes video queue remained full; automatic retries stopped.', {
          messageKey: 'agnes.queue_full_exhausted', messageParams: {},
        })
        return
      }
      const requested = Number(error.messageParams.retryAfter)
      const retryAfter = Math.min(900, Math.max(30, Number.isFinite(requested) ? requested : 60, 30 * 2 ** (row.attempt_count - 1)))
      updateRow(row.id, {
        status: 'queued',
        progress: 0,
        poll_started_at: null,
        next_poll_at: Date.now() + retryAfter * 1000,
        error_code: code,
        error_message: error.message,
        error_message_key: meta.messageKey,
        error_message_params: serializeParams({ ...meta.messageParams, retryAfter }),
      })
      logger.warn('Hàng đợi Agnes đầy, chờ trước khi thử lại', { id: row.id, retryAfter })
      return
    }

    if (isUncertain(error)) {
      // Không tự gửi lại: provider có thể đã nhận và đang xử lý.
      updateRow(row.id, {
        status: 'unknown',
        error_code: 'OUTCOME_UNKNOWN',
        error_message: message,
        error_message_key: meta.messageKey,
        error_message_params: serializeParams(meta.messageParams),
        next_poll_at: null,
      })
      logger.warn('Kết quả không xác định, không tự gửi lại', { id: row.id })
      return
    }

    failRow(row, code, message, meta)
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

      const startedAt = row.poll_started_at ?? now
      if (!row.provider_result_url && now - startedAt > env.VIDEO_POLL_TIMEOUT_MS) {
        updateRow(row.id, {
          status: 'unknown',
          error_code: 'POLL_TIMEOUT',
          error_message:
            'Đã dừng theo dõi tự động sau thời gian chờ. Bạn có thể kiểm tra lại bằng ID job mà không tạo video mới.',
          error_message_key: 'generations.poll_timeout',
          error_message_params: null,
          next_poll_at: null,
        })
        logger.warn('Dừng theo dõi video do quá hạn', { id: row.id })
        continue
      }

      // Giải mã key đã ghim nằm TRONG try: key hỏng phải làm tác vụ thất bại rõ
      // ràng, không được để nó mắc kẹt ở trạng thái 'running'.
      let context: GenerationContext | null
      try {
        context = pinnedContext(row)
      } catch (error) {
        failRow(row, 'PROVIDER_KEY_UNAVAILABLE', error instanceof Error ? error.message : 'Không dùng được API key đã ghim', errorMetadataOf(error))
        continue
      }

      if (!context) {
        failRow(row, 'PROVIDER_MISSING', 'Provider của tác vụ này đã bị xóa.', {
          messageKey: 'generations.provider_missing_short',
          messageParams: {},
        })
        continue
      }

      try {
        const snapshot = await pollVideoGeneration(context)
        const latest = db.prepare('SELECT status, cancel_requested FROM generations WHERE id = ?').get(row.id)
        if (latest?.status !== 'running') continue
        if (row.snap_video_style === 'higgsfield' && latest.cancel_requested && snapshot.state !== 'queued') {
          db.prepare('UPDATE generations SET cancel_requested = 0 WHERE id = ?').run(row.id)
        }
        if (row.snap_video_style === 'higgsfield' && latest.cancel_requested && snapshot.state === 'queued') {
          const { cancelHiggsfieldVideo } = await import('./adapters/higgsfield')
          if (await cancelHiggsfieldVideo(context)) {
            failRow(row, 'CANCELLED', 'Video creation stopped.', { messageKey: 'generations.cancelled', messageParams: {} })
            continue
          }
        }

        if (snapshot.state === 'completed') {
          updateRow(row.id, { status: 'downloading', progress: 100, next_poll_at: null, ...(snapshot.resultUrl ? { provider_result_url: snapshot.resultUrl } : {}) })
          if (snapshot.resultUrl) context.generation.provider_result_url = snapshot.resultUrl
          await downloadAndStore(row, context)
          continue
        }

        if (snapshot.state === 'failed') {
          // Lỗi thô của provider không được dịch máy: bọc bằng khoá ngữ nghĩa
          // và đặt nguyên văn vào tham số `detail`.
          if (snapshot.errorMessage) {
            failRow(row, 'PROVIDER_FAILED', snapshot.errorMessage, {
              messageKey: 'generations.provider_job_failed',
              messageParams: { detail: snapshot.errorMessage },
            })
          } else {
            failRow(row, 'PROVIDER_FAILED', 'Provider báo tác vụ thất bại', {
              messageKey: 'generations.provider_failed',
              messageParams: {},
            })
          }
          continue
        }

        updateRow(row.id, {
          status: 'running',
          progress: snapshot.progress ?? row.progress ?? 0,
          attempt_count: row.attempt_count + 1,
          next_poll_at: Date.now() + (row.snap_video_style === 'higgsfield' ? Math.min(10_000, 2000 * 1.5 ** ((JSON.parse(context.generation.higgsfield_json ?? '{}').pollAttempts ?? 0))) + Math.random() * 500 : row.snap_video_style === 'agnes' ? 2_000 : BASE_BACKOFF_MS),
        })
      } catch (error) {
        if (db.prepare('SELECT status FROM generations WHERE id = ?').get(row.id)?.status !== 'running') continue
        if (error instanceof AppError && ['CANCELLED','HIGGSFIELD_NSFW'].includes(error.code)) {
          failRow(row, error.code, error.message, errorMetadataOf(error)); continue
        }
        if (error instanceof AppError && error.code === 'HIGGSFIELD_POLL_STOP') {
          const meta = errorMetadataOf(error)
          updateRow(row.id, { status: 'unknown', error_code: error.code, error_message: error.message,
            error_message_key: meta.messageKey, error_message_params: serializeParams(meta.messageParams), next_poll_at: null })
          continue
        }
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
      await postprocessLogos(context.generation)
      updateRow(row.id, {
        status: 'succeeded',
        progress: 100,
        completed_at: Date.now(),
        error_code: null,
        error_message: null,
        error_message_key: null,
        error_message_params: null,
      })
      logger.info('Tải video thành công', { id: row.id })
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : 'Lỗi không xác định'
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code: unknown }).code)
          : 'DOWNLOAD_FAILED'

      // Giữ lại provider_job_id để người dùng có thể thử tải lại mà không tạo mới.
      updateRow(row.id, {
        status: 'failed',
        error_code: code,
        error_message: `Không tải được video: ${rawMessage}`.slice(0, 500),
        error_message_key: 'generations.download_failed',
        error_message_params: serializeParams({ detail: rawMessage }),
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
    // A restart after adapter persistence must not re-download into output.* or
    // resubmit paid work. An overlay state proves the adapter finished first;
    // don't declare an interrupted partial n-image adapter run successful.
    db.prepare(`UPDATE generations SET status = 'succeeded', progress = 100,
      completed_at = COALESCE(completed_at, ?), next_poll_at = NULL,
      postprocess_status = CASE WHEN postprocess_status = 'succeeded' THEN 'succeeded'
        WHEN postprocess_status = 'failed' THEN 'failed' ELSE 'queued' END
      WHERE deleted_at IS NULL AND logo_overlays_json IS NOT NULL AND logo_overlays_json != '[]'
      AND postprocess_status IN ('running','queued','succeeded','failed')
      AND status IN ('running','downloading') AND EXISTS
        (SELECT 1 FROM assets a WHERE a.generation_id = generations.id AND a.variant = 'original')`)
      .run(Date.now())
    db.prepare("UPDATE generations SET postprocess_status = 'queued' WHERE status = 'succeeded' AND postprocess_status = 'running' AND deleted_at IS NULL").run()
    const orphaned = db
      .prepare(
        "SELECT id FROM generations WHERE status = 'running' AND provider_job_id IS NULL AND snap_video_style != 'higgsfield'",
      )
      .all() as Array<{ id: string }>

    for (const row of orphaned) {
      updateRow(row.id, {
        status: 'unknown',
        error_code: 'INTERRUPTED',
        error_message:
          'Backend khởi động lại khi tác vụ đang chạy và chưa có ID job. Không tự gửi lại để tránh tính phí hai lần — hãy kiểm tra ở provider trước khi thử lại.',
        error_message_key: 'generations.interrupted',
        error_message_params: null,
      })
    }

    db.prepare("UPDATE generations SET status = 'queued', next_poll_at = NULL WHERE status = 'running' AND provider_job_id IS NULL AND snap_video_style = 'higgsfield'").run()

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
      maintainTrash({ db, mediaStore })
      // Dọn log LLM cũ hơn 90 ngày (tự giới hạn một lần mỗi giờ).
      maintainUsageRetention({ db })
      // Nạp trước các cảnh đã duyệt còn chờ, rồi mới xử lý hàng đợi trong cùng vòng.
      sweepAutoGenerate({ db, env, worker: instance })
      await startQueued()
      await pollRunning()
      await retryQueuedLogos()
      recoverImagePublications(db, env, mediaStore)
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
