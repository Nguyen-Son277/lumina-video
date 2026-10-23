import { randomUUID } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppError } from '../lib/errors'
import type { Database } from '../db/index'
import type { AppEnv } from '../env'
import { logger } from '../lib/logger'
import type { MediaStore } from '../media/store'
import { FFMPEG_MISSING, resolveFfmpeg, stitchVideos } from './ffmpeg'
import { specAssetPaths, updateExport, type ExportRow, type ExportSpec } from './service'

/**
 * Xử lý hàng đợi xuất video.
 *
 * Chạy trong cùng vòng tick của worker nên đóng tab vẫn tiếp tục. Mỗi vòng chỉ
 * nhận một tác vụ: ghép video là việc nặng CPU, chạy song song sẽ làm chậm cả
 * backend lẫn các tác vụ tạo nội dung khác.
 */
export async function processExportQueue(options: {
  db: Database
  env: AppEnv
  mediaStore: MediaStore
}): Promise<number> {
  const { db, env, mediaStore } = options

  const rows = db
    .prepare(`SELECT e.* FROM exports e LEFT JOIN projects p ON p.id=e.project_id LEFT JOIN quick_sessions q ON q.id=e.quick_session_id
      WHERE e.status='queued' AND ((p.id IS NOT NULL AND p.deleted_at IS NULL) OR q.id IS NOT NULL)
      ORDER BY e.created_at,e.id LIMIT 1`)
    .all() as unknown as ExportRow[]

  let processed = 0

  for (const row of rows) {
    // Nhận tác vụ bằng UPDATE có điều kiện để không chạy trùng.
    const claimed = db
      .prepare(
        "UPDATE exports SET status = 'running', progress = 0, updated_at = ? WHERE id = ? AND status = 'queued'",
      )
      .run(Date.now(), row.id)
    if (Number(claimed.changes) !== 1) continue

    processed += 1
    await runExport({ db, env, mediaStore, row })
  }

  return processed
}

async function runExport(options: {
  db: Database
  env: AppEnv
  mediaStore: MediaStore
  row: ExportRow
}): Promise<void> {
  const { db, env, mediaStore, row } = options
  const tempPath = join(tmpdir(), `lumina-export-${row.id}-${randomUUID()}.mp4`)

  try {
    const tooling = await resolveFfmpeg(env.FFMPEG_PATH)
    if (!tooling?.ffprobe) {
      updateExport(db, row.id, {
        status: 'failed',
        errorCode: FFMPEG_MISSING,
        errorMessage:
          'Cần có cả ffmpeg và ffprobe trên máy chủ. Hãy cài ffmpeg hoặc kiểm tra FFMPEG_PATH rồi thử lại.',
        errorMessageKey: 'exports.ffmpeg_missing',
        errorMessageParams: null,
        completedAt: Date.now(),
      })
      logger.warn('Không xuất được video vì thiếu ffmpeg hoặc ffprobe', { id: row.id })
      return
    }

    const spec = JSON.parse(row.spec_json) as ExportSpec
    const relativePaths = specAssetPaths(db, row.user_id, spec)

    // Kiểm tra tệp còn tồn tại trước khi gọi ffmpeg để báo lỗi rõ ràng.
    for (const relativePath of relativePaths) {
      if (!mediaStore.exists(relativePath)) {
        updateExport(db, row.id, {
          status: 'failed',
          errorCode: 'MEDIA_MISSING',
          errorMessage:
            'Một video trong danh sách không còn trên máy chủ. Hãy tạo lại cảnh đó rồi xuất lại.',
          errorMessageKey: 'exports.media_missing',
          errorMessageParams: null,
          completedAt: Date.now(),
        })
        return
      }
    }

    const inputs = relativePaths.map((relativePath) => mediaStore.absolutePath(relativePath))

    updateExport(db, row.id, { status: 'running', progress: 30 })

    const result = await stitchVideos({
      tooling,
      inputs,
      output: tempPath,
      timeoutMs: env.EXPORT_TIMEOUT_MS,
    })

    if (!existsSync(tempPath)) {
      throw new Error('ffmpeg không tạo ra tệp kết quả')
    }

    updateExport(db, row.id, { status: 'running', progress: 80 })

    const saved = mediaStore.saveExport({
      userId: row.user_id,
      exportId: row.id,
      sourcePath: tempPath,
      maxBytes: env.MAX_VIDEO_BYTES,
    })

    updateExport(db, row.id, {
      status: 'succeeded',
      progress: 100,
      relativePath: saved.relativePath,
      mimeType: saved.mimeType,
      byteSize: saved.byteSize,
      errorCode: null,
      errorMessage: null,
      errorMessageKey: null,
      errorMessageParams: null,
      completedAt: Date.now(),
    })

    logger.info('Xuất video thành công', {
      id: row.id,
      scenes: inputs.length,
      width: result.width,
      height: result.height,
      hasAudio: result.hasAudio,
    })
  } catch (error) {
    const message = error instanceof AppError ? error.message : 'Không thể ghép video. Hãy thử xuất lại hoặc liên hệ người quản lý ứng dụng.'
    updateExport(db, row.id, {
      status: 'failed',
      errorCode: 'EXPORT_FAILED',
      errorMessage: message.slice(0, 500),
      errorMessageKey: error instanceof AppError ? error.messageKey : 'exports.stitch_failed',
      errorMessageParams: JSON.stringify(error instanceof AppError ? error.messageParams : {}),
      completedAt: Date.now(),
    })
    logger.warn('Xuất video thất bại', { id: row.id, message: error instanceof Error ? error.message : String(error) })
  } finally {
    // saveExport đã chuyển tệp đi; xoá phần còn lại của tệp tạm nếu có.
    rmSync(tempPath, { force: true })
  }
}
