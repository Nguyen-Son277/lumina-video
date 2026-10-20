import type { Database } from '../db/index'
import type { AppEnv } from '../env'
import type { MediaStore } from '../media/store'
import { badRequest, errorMeta, notFound } from '../lib/errors'
import { prepareAnalysisImage } from '../entityLibrary/analyze'

/** Validate the owned original before reading it; only the reduced JPEG goes to vision. */
export async function prepareCharacterSourceImage(options: {
  db: Database; env: AppEnv; mediaStore: MediaStore; userId: string; sourceUploadId: string
}): Promise<Buffer> {
  const { db, env, mediaStore, userId, sourceUploadId } = options
  const missing = () => notFound('Không tìm thấy ảnh nguồn hoặc ảnh không còn trên máy chủ.', errorMeta('characters.source_image_missing'))
  const row = db.prepare('SELECT relative_path, byte_size FROM uploads WHERE id = ? AND user_id = ?')
    .get(sourceUploadId, userId) as { relative_path: string; byte_size: number } | undefined
  if (!row) throw missing()
  let size: number
  try {
    if (!mediaStore.exists(row.relative_path)) throw missing()
    size = mediaStore.stat(row.relative_path).size
  } catch { throw missing() }
  if (size > env.MAX_SOURCE_IMAGE_BYTES || row.byte_size > env.MAX_SOURCE_IMAGE_BYTES) {
    throw badRequest('Ảnh nguồn vượt giới hạn ' + env.MAX_SOURCE_IMAGE_BYTES / 1024 / 1024 + ' MB.', undefined,
      errorMeta('characters.source_image_too_large', { maxMb: env.MAX_SOURCE_IMAGE_BYTES / 1024 / 1024 }))
  }
  let bytes: Uint8Array
  try { bytes = mediaStore.readFile(row.relative_path) } catch { throw missing() }
  try { return await prepareAnalysisImage(bytes, env.MAX_SOURCE_IMAGE_BYTES) }
  catch {
    throw badRequest('Ảnh nguồn không hợp lệ hoặc vượt giới hạn số điểm ảnh.', undefined, errorMeta('characters.source_image_invalid'))
  }
}
