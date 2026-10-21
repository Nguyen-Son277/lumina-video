import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { conversionVoiceSchema, entityConversionSchema, type EntityConversionData, type EntityConversionInput } from '../../shared/entityConversion'
import type { Database } from '../db/index'
import type { AppEnv } from '../env'
import type { MediaStore } from '../media/store'
import type { CharacterRow } from '../projects/service'
import { badRequest, conflict, insufficientStorage, notFound, validationError } from '../lib/errors'
import { logger } from '../lib/logger'
import { retainCharacterMedia } from './characterMedia'
import { assertEntityConvertible } from './conversionUsage'
import { entityLibraryUsageBytes, resolveEntity, type CatalogEntity, type EntityRef, type LibraryAssetRow } from './service'

type Archive = {
  entity_id: string; user_id: string; voice_json: string; continuity_notes: string; reference_views_json: string
  retained_media_json: string; last_request_json: string | null; last_source_kind: string | null
  last_target_kind: string | null; last_target_revision: number | null
}
type RetainedMedia = { path: string; uploadId?: string }
type Source = { entity: CatalogEntity; character?: CharacterRow; asset?: LibraryAssetRow }
function archiveFor(db: Database, userId: string, id: string): Archive | undefined {
  return db.prepare('SELECT * FROM entity_conversion_data WHERE entity_id=? AND user_id=?').get(id, userId) as Archive | undefined
}
function sourceFor(db: Database, userId: string, ref: EntityRef): Source {
  const entity = resolveEntity(db, userId, ref)
  const character = ref.kind === 'character' ? db.prepare('SELECT * FROM characters WHERE id=? AND user_id=? AND deleted_at IS NULL').get(ref.id, userId) as CharacterRow : undefined
  const asset = ref.kind !== 'character' ? db.prepare('SELECT * FROM library_assets WHERE id=? AND user_id=? AND kind=? AND deleted_at IS NULL AND source_deleted=0').get(ref.id, userId, ref.kind) as LibraryAssetRow : undefined
  return { entity, character, asset }
}
function parsedArray(raw?: string): unknown[] {
  try { const value: unknown = JSON.parse(raw ?? '[]'); return Array.isArray(value) ? value : [] } catch { return [] }
}
function safeVoice(raw?: string): EntityConversionData['voice'] {
  try {
    const value = JSON.parse(raw ?? '{}') as Record<string, unknown>
    const safe = Object.fromEntries(Object.keys(conversionVoiceSchema.shape).filter(key => typeof value?.[key] === 'string').map(key => [key, value[key]]))
    return conversionVoiceSchema.parse(safe)
  } catch { return {} }
}
function safeViews(db: Database, userId: string, raw?: string): EntityConversionData['referenceViews'] {
  return parsedArray(raw).flatMap(value => {
    if (!value || typeof value !== 'object') return []
    const view = value as Record<string, unknown>
    if (typeof view.uploadId !== 'string' || !db.prepare("SELECT 1 FROM uploads WHERE id=? AND user_id=? AND mime_type IN ('image/png','image/jpeg','image/webp','image/gif')").get(view.uploadId, userId)) return []
    return [{ id: typeof view.id === 'string' ? view.id : view.uploadId, label: typeof view.label === 'string' ? view.label : '', uploadId: view.uploadId, sheet: view.sheet === true }]
  })
}
function conversionData(db: Database, userId: string, source: Source, archive?: Archive): EntityConversionData {
  return {
    revision: source.entity.revision,
    voice: safeVoice(source.character?.voice_json ?? archive?.voice_json),
    continuityNotes: source.asset?.continuity_notes ?? archive?.continuity_notes ?? '',
    referenceViews: safeViews(db, userId, source.asset?.kind === 'location' ? source.asset.reference_views_json : archive?.reference_views_json),
  }
}
/** Safe form hydration: never expose raw storage paths or unvalidated archived JSON. */
export function getEntityConversionData(db: Database, userId: string, ref: EntityRef): EntityConversionData {
  const source = sourceFor(db, userId, ref)
  const archive = archiveFor(db, userId, ref.id)
  // A sanitized empty voice could otherwise be submitted through a native PATCH,
  // silently replacing damaged legacy/archive fields before conversion validation.
  try {
    if (!conversionVoiceSchema.safeParse(JSON.parse(source.character?.voice_json ?? archive?.voice_json ?? '{}')).success) throw new Error('Invalid voice')
  } catch { throw conflict('Dữ liệu giọng nói không hợp lệ, cần sửa dữ liệu trước khi chỉnh sửa tài nguyên') }
  return conversionData(db, userId, source, archive)
}
function retainedMedia(archive?: Archive): RetainedMedia[] {
  return parsedArray(archive?.retained_media_json).flatMap(value => {
    if (!value || typeof value !== 'object' || typeof (value as RetainedMedia).path !== 'string') return []
    const media = value as RetainedMedia
    return [{ path: media.path, ...(typeof media.uploadId === 'string' ? { uploadId: media.uploadId } : {}) }]
  })
}
/** Validate lexical account scope AND real filesystem scope, including symlink escapes. */
function checkedMediaPath(mediaStore: MediaStore, userId: string, path: string): void {
  const parts = path.split('/')
  if (parts[0] !== userId || parts.length < 3 || path.includes('\\') || parts.some(part => !part || part === '.' || part === '..') || path.includes('\0')) throw notFound('Ảnh tham chiếu không hợp lệ')
  try {
    const root = realpathSync(mediaStore.root), accountRoot = resolve(root, userId)
    const actual = realpathSync(mediaStore.absolutePath(path))
    if (!actual.startsWith(`${accountRoot}${sep}`)) throw notFound('Ảnh tham chiếu không hợp lệ')
  } catch { throw notFound('Ảnh tham chiếu không còn trên máy chủ hoặc không hợp lệ') }
}
function queueRetainedMedia(db: Database, userId: string, id: string, media: RetainedMedia): void {
  db.prepare(`INSERT INTO media_cleanup_jobs(id,user_id,kind,target_id,path,created_at)
    SELECT ?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM media_cleanup_jobs WHERE user_id=? AND path=?)`)
    .run(randomUUID(), userId, media.uploadId ? 'orphan_upload' : 'path', id, media.path, Date.now(), userId, media.path)
}

/** No async gap: ownership, revision, usage, media adoption and identity move share one savepoint. */
export function convertEntity(db: Database, env: AppEnv, mediaStore: MediaStore, userId: string, ref: EntityRef, rawInput: EntityConversionInput): CatalogEntity {
  const parsed = entityConversionSchema.safeParse(rawInput)
  if (!parsed.success) throw validationError(parsed.error)
  const input = parsed.data
  if (input.targetKind === ref.kind) throw badRequest('Loại đích phải khác loại hiện tại')
  const request = JSON.stringify(input), savepoint = `conversion_${randomUUID().replaceAll('-', '')}`
  let saved: { relativePath: string; mimeType: string; byteSize: number } | undefined
  db.exec(`SAVEPOINT ${savepoint}`)
  try {
    const archiveOwner = db.prepare('SELECT user_id FROM entity_conversion_data WHERE entity_id=?').get(ref.id)
    if (archiveOwner && archiveOwner.user_id !== userId) throw conflict('ID loại đích đã tồn tại')
    const archive = archiveFor(db, userId, ref.id)
    // An exact retry after a lost response is read-only, never a second move or save.
    const sourceExists = ref.kind === 'character'
      ? db.prepare('SELECT 1 FROM characters WHERE id=? AND user_id=? AND deleted_at IS NULL').get(ref.id, userId)
      : db.prepare('SELECT 1 FROM library_assets WHERE id=? AND user_id=? AND kind=? AND deleted_at IS NULL AND source_deleted=0').get(ref.id, userId, ref.kind)
    if (!sourceExists && archive?.last_source_kind === ref.kind && archive.last_target_kind === input.targetKind && archive.last_request_json === request) {
      const target = resolveEntity(db, userId, { kind: input.targetKind, id: ref.id })
      if (target.revision !== archive.last_target_revision) throw conflict('Đối tượng đã thay đổi, vui lòng tải lại')
      db.exec(`RELEASE ${savepoint}`)
      return target
    }
    const source = sourceFor(db, userId, ref)
    if (source.character?.project_id || source.asset?.source_kind) throw conflict('Chỉ có thể chuyển loại tài nguyên độc lập trong thư viện')
    if (source.entity.revision !== input.expectedRevision) throw conflict('Đối tượng đã thay đổi, vui lòng tải lại')
    // Do not overwrite an unrelated target (including trash or another owner's row).
    if (ref.kind === 'character' && db.prepare('SELECT 1 FROM library_assets WHERE id=?').get(ref.id)
      || ref.kind !== 'character' && db.prepare('SELECT 1 FROM characters WHERE id=?').get(ref.id)) throw conflict('ID loại đích đã tồn tại')
    const foreignHandle = db.prepare('SELECT user_id FROM entity_handles WHERE kind=? AND entity_id=?').get(input.targetKind, ref.id)
    if (foreignHandle && foreignHandle.user_id !== userId) throw conflict('ID loại đích đã tồn tại')
    // Hydration may sanitize legacy JSON for display, but a write must not silently
    // discard damaged or foreign media/metadata while moving the physical source.
    try {
      const voice: unknown = JSON.parse(source.character?.voice_json ?? archive?.voice_json ?? '{}')
      if (!conversionVoiceSchema.safeParse(voice).success) throw new Error('Invalid voice')
      const views: unknown = JSON.parse(source.asset?.kind === 'location' ? source.asset.reference_views_json : archive?.reference_views_json ?? '[]')
      if (!Array.isArray(views) || views.length !== safeViews(db, userId, JSON.stringify(views)).length) throw new Error('Invalid views')
      if (archive && !Array.isArray(JSON.parse(archive.retained_media_json))) throw new Error('Invalid retained media')
    } catch { throw conflict('Dữ liệu riêng của loại tài nguyên không hợp lệ, vui lòng tải lại hoặc sửa trước khi chuyển loại') }
    if ((source.character?.reference_path || source.asset?.reference_upload_id) && !source.entity.reference) throw notFound('Không tìm thấy ảnh tham chiếu')
    const data = conversionData(db, userId, source, archive)
    if (input.voice !== undefined) data.voice = input.voice
    if (input.continuityNotes !== undefined) data.continuityNotes = input.continuityNotes
    const media = retainedMedia(archive)
    const addMedia = (value: RetainedMedia) => { if (!media.some(item => item.path === value.path)) media.push(value) }
    if (source.entity.reference) addMedia({ path: source.entity.reference.path, ...(source.entity.reference.uploadId ? { uploadId: source.entity.reference.uploadId } : {}) })
    for (const view of data.referenceViews) {
      const upload = db.prepare('SELECT relative_path FROM uploads WHERE id=? AND user_id=?').get(view.uploadId, userId)
      if (upload) addMedia({ path: String(upload.relative_path), uploadId: view.uploadId })
    }
    assertEntityConvertible(db, userId, ref, media.flatMap(item => [item.path, ...(item.uploadId ? [item.uploadId] : [])]))
    const now = Date.now(), revision = input.targetKind === 'character' ? Math.max(now, source.entity.revision + 1) : source.entity.revision + 1
    let uploadId = source.asset?.reference_upload_id ?? null
    const crossingCharacter = ref.kind === 'character' || input.targetKind === 'character'
    if (source.entity.reference) checkedMediaPath(mediaStore, userId, source.entity.reference.path)
    if (source.entity.reference && crossingCharacter) {
      const bytes = mediaStore.readFile(source.entity.reference.path)
      // Legacy pointers can predate byte accounting. Register actual retained bytes
      // before quota/adoption; rollback restores metadata if the move is rejected.
      if (source.character) retainCharacterMedia(db, { ...source.character, reference_bytes: bytes.byteLength })
      if (entityLibraryUsageBytes(db, userId) + bytes.byteLength > env.MAX_USER_MEDIA_BYTES) throw insufficientStorage('Đã vượt giới hạn dung lượng media của tài khoản')
      if (input.targetKind === 'character') {
        saved = mediaStore.saveCharacterReference({ userId, characterId: ref.id, bytes, maxBytes: env.MAX_REFERENCE_BYTES })
        retainCharacterMedia(db, { user_id: userId, reference_path: saved.relativePath, reference_mime: saved.mimeType, reference_bytes: saved.byteSize })
        addMedia({ path: saved.relativePath })
      } else {
        uploadId = randomUUID()
        saved = mediaStore.saveUpload({ userId, uploadId, bytes, maxBytes: env.MAX_REFERENCE_BYTES })
        db.prepare('INSERT INTO uploads(id,user_id,relative_path,mime_type,byte_size,created_at) VALUES(?,?,?,?,?,?)').run(uploadId, userId, saved.relativePath, saved.mimeType, saved.byteSize, now)
        addMedia({ path: saved.relativePath, uploadId })
      }
    }
    if (source.character) retainCharacterMedia(db, source.character)
    if (input.targetKind === 'character') {
      db.prepare(`INSERT INTO characters(id,user_id,project_id,name,appearance,voice_json,reference_path,reference_mime,reference_bytes,created_at,updated_at)
        VALUES(?,?,NULL,?,?,?,?,?,?,?,?)`).run(ref.id, userId, input.name, input.description, JSON.stringify(data.voice), saved?.relativePath ?? null, saved?.mimeType ?? null, saved?.byteSize ?? null, source.asset!.created_at, revision)
    } else if (source.character) {
      db.prepare(`INSERT INTO library_assets(id,user_id,kind,name,description,continuity_notes,reference_upload_id,revision,created_at,updated_at,reference_views_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(ref.id, userId, input.targetKind, input.name, input.description, data.continuityNotes, uploadId, revision, source.character.created_at, now, input.targetKind === 'location' ? JSON.stringify(data.referenceViews) : '[]')
    } else {
      db.prepare('UPDATE library_assets SET kind=?,name=?,description=?,continuity_notes=?,revision=?,updated_at=?,reference_views_json=? WHERE id=? AND user_id=?')
        .run(input.targetKind, input.name, input.description, data.continuityNotes, revision, now, input.targetKind === 'location' ? JSON.stringify(data.referenceViews) : '[]', ref.id, userId)
    }
    db.prepare(`INSERT INTO entity_conversion_data(entity_id,user_id,voice_json,continuity_notes,reference_views_json,retained_media_json,last_request_json,last_source_kind,last_target_kind,last_target_revision,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(entity_id) DO UPDATE SET voice_json=excluded.voice_json,continuity_notes=excluded.continuity_notes,
      reference_views_json=excluded.reference_views_json,retained_media_json=excluded.retained_media_json,last_request_json=excluded.last_request_json,
      last_source_kind=excluded.last_source_kind,last_target_kind=excluded.last_target_kind,last_target_revision=excluded.last_target_revision,updated_at=excluded.updated_at`)
      .run(ref.id, userId, JSON.stringify(data.voice), data.continuityNotes, JSON.stringify(data.referenceViews), JSON.stringify(media), request, ref.kind, input.targetKind, revision, now)
    // Keep source-kind aliases as inactive tombstones for historical documents.
    db.prepare('UPDATE entity_handles SET active=0 WHERE user_id=? AND entity_id=?').run(userId, ref.id)
    const handle = db.prepare('SELECT id FROM entity_handles WHERE kind=? AND entity_id=?').get(input.targetKind, ref.id)
    if (handle) db.prepare('UPDATE entity_handles SET handle=?,handle_key=?,active=1 WHERE id=? AND user_id=?').run(source.entity.handle, source.entity.handle, String(handle.id), userId)
    else db.prepare('INSERT INTO entity_handles(id,user_id,kind,entity_id,handle,handle_key,active,created_at) VALUES(?,?,?,?,?,?,1,?)').run(randomUUID(), userId, input.targetKind, ref.id, source.entity.handle, source.entity.handle, now)
    if (source.character) db.prepare('DELETE FROM characters WHERE id=? AND user_id=?').run(ref.id, userId)
    else if (input.targetKind === 'character') db.prepare('DELETE FROM library_assets WHERE id=? AND user_id=?').run(ref.id, userId)
    for (const item of media) queueRetainedMedia(db, userId, ref.id, item)
    const target = resolveEntity(db, userId, { kind: input.targetKind, id: ref.id })
    db.exec(`RELEASE ${savepoint}`)
    return target
  } catch (error) {
    db.exec(`ROLLBACK TO ${savepoint}`)
    db.exec(`RELEASE ${savepoint}`)
    if (saved) {
      try { checkedMediaPath(mediaStore, userId, saved.relativePath); mediaStore.removeByPath(saved.relativePath) }
      catch (cleanupError) {
        // Failed rollback cleanup is durable and quota-accounted, not silently orphaned.
        retainCharacterMedia(db, { user_id: userId, reference_path: saved.relativePath, reference_mime: saved.mimeType, reference_bytes: saved.byteSize })
        queueRetainedMedia(db, userId, ref.id, { path: saved.relativePath })
        logger.warn('Không thể dọn media chuyển loại sau rollback', { message: String(cleanupError) })
      }
    }
    throw error
  }
}
