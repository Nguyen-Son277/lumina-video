import { randomUUID } from 'node:crypto'
import type { ImageEditorSource, ImageEditorPreparedSource } from '../../shared/imageEditor'
import type { Database } from '../db/index'
import type { MediaStore } from '../media/store'
import type { AppEnv } from '../env'
import { badRequest, conflict, insufficientStorage, notFound } from '../lib/errors'
import { resolveEntity } from '../entityLibrary/service'
import { normalizeImage } from './processing'

export type ResolvedEditorSource = {
  path: string
  mime: string
  lineage: ImageEditorSource
  uploadId?: string
  width?: number
  height?: number
  retained?: unknown
  /** True when the prepared source kept only the first frame of an animation. */
  firstFrameOnly?: boolean
}

export function resolveEditorSource(db: Database, userId: string, source: ImageEditorSource): ResolvedEditorSource {
  if (source.kind === 'entity') {
    const entity = resolveEntity(db, userId, { kind: source.entityKind, id: source.id })
    if (entity.revision !== source.revision) throw conflict('Đối tượng nguồn đã thay đổi; hãy mở lại trình chỉnh sửa ảnh')
    if (source.viewId) {
      const view = entity.referenceViews?.find((v) => v.id === source.viewId)
      if (!view) throw notFound('Không tìm thấy góc ảnh nguồn')
      const row = db.prepare('SELECT relative_path AS path,mime_type AS mime FROM uploads WHERE id=? AND user_id=?').get(view.uploadId, userId) as { path: string; mime: string } | undefined
      if (!row) throw notFound('Không tìm thấy ảnh nguồn')
      return { ...row, lineage: source }
    }
    if (!entity.reference) throw notFound('Đối tượng chưa có ảnh')
    return { path: entity.reference.path, mime: entity.reference.mime, lineage: source }
  }
  const row = (source.kind === 'upload'
    ? db.prepare('SELECT relative_path AS path,mime_type AS mime FROM uploads WHERE id=? AND user_id=?').get(source.id, userId)
    : db.prepare("SELECT a.relative_path AS path,a.mime_type AS mime FROM assets a JOIN generations g ON g.id=a.generation_id WHERE a.id=? AND a.user_id=? AND g.user_id=? AND g.status='succeeded' AND g.deleted_at IS NULL").get(source.id, userId, userId)) as { path: string; mime: string } | undefined
  if (!row || !row.mime.startsWith('image/')) throw notFound('Ảnh nguồn không còn khả dụng')
  if (source.kind === 'upload') {
    const frozen = db.prepare('SELECT * FROM image_editor_sources WHERE upload_id=? AND user_id=?').get(source.id, userId) as { source_json: string; width: number; height: number } | undefined
    if (frozen) {
      const retained = JSON.parse(frozen.source_json)
      return { ...row, uploadId: source.id, width: frozen.width, height: frozen.height, lineage: retained.lineage, retained, ...(retained.firstFrameOnly ? { firstFrameOnly: true } : {}) }
    }
  }
  return { ...row, lineage: source }
}

/**
 * Chuẩn hoá nguồn thành PNG tĩnh và giữ lại DÒNG DÕI nguồn gốc.
 *
 * Nguồn đã chuẩn hoá thì không chuẩn hoá lại (idempotent) và vẫn trả về đúng
 * kích thước đã ghi nhớ.
 */
export async function prepareEditorSource(db: Database, env: AppEnv, store: MediaStore, userId: string, source: ImageEditorSource): Promise<ImageEditorPreparedSource> {
  const resolved = resolveEditorSource(db, userId, source)
  if (!store.exists(resolved.path)) throw notFound('Ảnh nguồn không còn trên máy chủ')
  if (resolved.uploadId) {
    return {
      uploadId: resolved.uploadId,
      url: `/api/uploads/${resolved.uploadId}`,
      width: resolved.width!,
      height: resolved.height!,
      mimeType: 'image/png',
      lineage: resolved.lineage,
      ...(resolved.firstFrameOnly ? { firstFrameOnly: true } : {}),
    }
  }
  if (store.stat(resolved.path).size > env.MAX_SOURCE_IMAGE_BYTES) throw badRequest('Ảnh nguồn vượt giới hạn dung lượng của trình chỉnh sửa')
  const normalized = await normalizeImage(store.readFile(resolved.path))
  if (store.userUsageBytes(db, userId) + normalized.bytes.length > env.MAX_USER_MEDIA_BYTES) {
    throw insufficientStorage('Ảnh nguồn của trình chỉnh sửa vượt giới hạn dung lượng tài khoản')
  }
  const id = randomUUID()
  const now = Date.now()
  const saved = store.saveUpload({ userId, uploadId: id, bytes: normalized.bytes, maxBytes: env.MAX_SOURCE_IMAGE_BYTES })
  db.exec('SAVEPOINT editor_source')
  try {
    db.prepare('INSERT INTO uploads (id, user_id, relative_path, mime_type, byte_size, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, userId, saved.relativePath, saved.mimeType, saved.byteSize, now)
    db.prepare('INSERT INTO image_editor_sources (upload_id, user_id, source_json, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, userId, JSON.stringify({ lineage: resolved.lineage, originalPath: resolved.path, ...(normalized.firstFrameOnly ? { firstFrameOnly: true } : {}) }), normalized.width, normalized.height, now)
    db.exec('RELEASE editor_source')
  } catch (error) {
    db.exec('ROLLBACK TO editor_source')
    db.exec('RELEASE editor_source')
    store.removeUpload(userId, id)
    throw error
  }
  return {
    uploadId: id,
    url: `/api/uploads/${id}`,
    width: normalized.width,
    height: normalized.height,
    mimeType: 'image/png',
    lineage: resolved.lineage,
    ...(normalized.firstFrameOnly ? { firstFrameOnly: true } : {}),
  }
}
