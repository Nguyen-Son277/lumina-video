import { randomUUID } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    .prepare("SELECT * FROM exports WHERE status = 'queued' ORDER BY created_at ASC, id LIMIT 1")
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
    if (!tooling) {
      updateExport(db, row.id, {
        status: 'failed',
        errorCode: FFMPEG_MISSING,
        errorMessage:
          'Chưa tìm thấy ffmpeg trên máy chủ. Hãy cài ffmpeg (ví dụ: apt install ffmpeg) hoặc đặt FFMPEG_PATH trong .env rồi thử lại.',
        completedAt: Date.now(),
      })
      logger.warn('Không xuất được video vì thiếu ffmpeg', { id: row.id })
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
    const message = error instanceof Error ? error.message : 'Lỗi không xác định'
    updateExport(db, row.id, {
      status: 'failed',
      errorCode: 'EXPORT_FAILED',
      errorMessage: message.slice(0, 500),
      completedAt: Date.now(),
    })
    logger.warn('Xuất video thất bại', { id: row.id, message: message.slice(0, 200) })
  } finally {
    // saveExport đã chuyển tệp đi; xoá phần còn lại của tệp tạm nếu có.
    rmSync(tempPath, { force: true })
  }
}
