import { randomUUID, createHash } from 'node:crypto'
import type { Database } from '../db/index'
import type { AppEnv } from '../env'
import type { MediaStore } from '../media/store'
import { badRequest, conflict, insufficientStorage, notFound } from '../lib/errors'
import { assertLibraryAssetIdle } from './lifecycle'
import { reconcileLocationLibrary } from './locationSync'

export type EntityKind = 'character' | 'item' | 'logo' | 'location'
export type LibraryAssetKind = Exclude<EntityKind, 'character'>
export type EntityRef = { kind: EntityKind; id: string }
export type CatalogEntity = {
  id: string; kind: EntityKind; name: string; handle: string; description: string
  continuityNotes: string; revision: number; createdAt: number
  reference: { path: string; mime: string; uploadId?: string } | null
  projectId?: string
  source?: { kind: 'timeline' | 'project'; scopeId: string; entityId: string; revision: number }
  referenceViews?: Array<{ id: string; label: string; uploadId: string; sheet: boolean }>
}
export type LibraryAssetRow = {
  id: string; user_id: string; kind: LibraryAssetKind; name: string; description: string
  continuity_notes: string; reference_upload_id: string | null; revision: number
  created_at: number; updated_at: number; deleted_at: number | null; purge_after: number | null
  reference_views_json: string; source_kind: 'timeline' | 'project' | null; source_scope_id: string | null; source_entity_id: string | null; source_deleted: number; source_revision: number | null
}
type HandleRow = { id: string; user_id: string; kind: EntityKind; entity_id: string; handle: string; handle_key: string; active: number }
type Character = { id: string; user_id: string; project_id: string | null; name: string; appearance: string; reference_path: string | null; reference_mime: string | null; created_at: number; updated_at: number }
export const LIBRARY_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/** Shared alias canonicalization: never includes @; case/accent equivalent names collide. */
export function normalizeEntityHandle(value: string): string {
  return value.trim().replace(/^@+/, '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '')
}

function atomic<T>(db: Database, fn: () => T): T {
  // SAVEPOINT also works when an adopter already opened a transaction.
  const name = `library_${randomUUID().replace(/-/g, '')}`
  db.exec(`SAVEPOINT ${name}`)
  try { const result = fn(); db.exec(`RELEASE ${name}`); return result }
  catch (error) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); throw error }
}
function validateProject(db: Database, userId: string, projectId?: string): void {
  if (projectId && !db.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(projectId, userId)) throw notFound('Không tìm thấy dự án')
}
function activeCharacters(db: Database, userId: string): Character[] {
  return db.prepare(`SELECT c.* FROM characters c WHERE c.user_id = ? AND c.deleted_at IS NULL
    AND (c.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id = c.project_id AND p.user_id = c.user_id AND p.deleted_at IS NULL))
    ORDER BY c.created_at, c.id`).all(userId) as unknown as Character[]
}
function activeAssets(db: Database, userId: string): LibraryAssetRow[] {
  return db.prepare('SELECT * FROM library_assets WHERE user_id = ? AND deleted_at IS NULL AND source_deleted=0 ORDER BY created_at, id').all(userId) as unknown as LibraryAssetRow[]
}
function handleFor(db: Database, userId: string, ref: EntityRef): HandleRow | undefined {
  return db.prepare('SELECT * FROM entity_handles WHERE user_id = ? AND kind = ? AND entity_id = ?').get(userId, ref.kind, ref.id) as HandleRow | undefined
}
function occupied(db: Database, userId: string, handle: string, except?: EntityRef): boolean {
  const row = db.prepare('SELECT kind, entity_id FROM entity_handles WHERE user_id = ? AND handle_key = ? AND active = 1').get(userId, handle) as { kind: string; entity_id: string } | undefined
  return !!row && (!except || row.kind !== except.kind || row.entity_id !== except.id)
}
function register(db: Database, userId: string, ref: EntityRef, handle: string): void {
  if (!handle) throw badRequest('Handle phải chứa ít nhất một chữ cái hoặc chữ số')
  if (occupied(db, userId, handle, ref)) throw conflict('Handle đã được một đối tượng khác sử dụng')
  const existing = handleFor(db, userId, ref)
  if (existing) db.prepare('UPDATE entity_handles SET handle = ?, handle_key = ?, active = 1 WHERE id = ?').run(handle, handle, existing.id)
  else db.prepare('INSERT INTO entity_handles (id,user_id,kind,entity_id,handle,handle_key,active,created_at) VALUES (?,?,?,?,?,?,1,?)').run(randomUUID(), userId, ref.kind, ref.id, handle, handle, Date.now())
}
function legacyHandle(db: Database, userId: string, ref: EntityRef, name: string): string {
  const base = normalizeEntityHandle(name) || ref.kind
  if (!occupied(db, userId, base, ref)) return base
  // ID based suffix, never an order-dependent counter. Extend on fragment collision.
  const fragment = ref.id.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || createHash('sha256').update(ref.id).digest('hex')
  for (let length = 8; length <= Math.max(8, fragment.length); length += 4) {
    const suffix = fragment.slice(-length)
    const candidate = `${base.slice(0, 63 - suffix.length)}-${suffix}`
    if (!occupied(db, userId, candidate, ref)) return candidate
  }
  const suffix = createHash('sha256').update(`${ref.kind}:${ref.id}`).digest('hex').slice(0, 32)
  const candidate = `${base.slice(0, 31)}-${suffix}`
  if (occupied(db, userId, candidate, ref)) throw conflict('Không thể đăng ký handle cho đối tượng')
  return candidate
}

/** Synchronize ALL owned entities before any scope filtering. Keeps tombstones, never rebinds IDs. */
export function syncEntityHandles(db: Database, userId: string, skipRegistration?: EntityRef): void {
  atomic(db, () => {
    reconcileLocationLibrary(db, userId)
    db.prepare(`UPDATE entity_handles SET active = 0 WHERE user_id = ? AND active = 1 AND (
      (kind = 'character' AND NOT EXISTS (SELECT 1 FROM characters c WHERE c.id = entity_handles.entity_id AND c.user_id = entity_handles.user_id AND c.deleted_at IS NULL
        AND (c.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id = c.project_id AND p.user_id = c.user_id AND p.deleted_at IS NULL))))
      OR (kind IN ('item','logo','location') AND NOT EXISTS (SELECT 1 FROM library_assets a WHERE a.id = entity_handles.entity_id AND a.user_id = entity_handles.user_id AND a.kind = entity_handles.kind AND a.deleted_at IS NULL AND a.source_deleted=0)))`).run(userId)
    for (const row of [...activeCharacters(db, userId).map(c => ({ id: c.id, kind: 'character' as const, name: c.name })), ...activeAssets(db, userId)]) {
      const ref = { id: row.id, kind: row.kind }
      if (skipRegistration?.kind === ref.kind && skipRegistration.id === ref.id) continue
      const existing = handleFor(db, userId, ref)
      // Restores keep their own alias or fail visibly when that alias was claimed meanwhile.
      if (!existing) register(db, userId, ref, legacyHandle(db, userId, ref, row.name))
      else if (!existing.active) register(db, userId, ref, existing.handle)
    }
  })
}
function catalogCharacter(db: Database, userId: string, row: Character): CatalogEntity {
  return { id: row.id, kind: 'character', name: row.name, handle: handleFor(db, userId, { kind: 'character', id: row.id })!.handle,
    description: row.appearance, continuityNotes: '', revision: row.updated_at, createdAt: row.created_at,
    reference: row.reference_path && row.reference_mime ? { path: row.reference_path, mime: row.reference_mime } : null,
    ...(row.project_id ? { projectId: row.project_id } : {}) }
}
function catalogViews(db: Database, userId: string, raw: string): NonNullable<CatalogEntity['referenceViews']> {
  try {
    const values: unknown = JSON.parse(raw || '[]')
    if (!Array.isArray(values)) return []
    return values.flatMap(view => {
      if (!view || typeof view.uploadId !== 'string' || !db.prepare("SELECT 1 FROM uploads WHERE id=? AND user_id=? AND mime_type IN ('image/png','image/jpeg','image/webp','image/gif')").get(view.uploadId,userId)) return []
      return [{ id: typeof view.id === 'string' ? view.id : view.uploadId, label: typeof view.label === 'string' ? view.label : '', uploadId: view.uploadId, sheet: view.sheet === true }]
    })
  } catch { return [] }
}
function catalogAsset(db: Database, userId: string, row: LibraryAssetRow): CatalogEntity {
  const upload = row.reference_upload_id ? db.prepare('SELECT id, relative_path, mime_type FROM uploads WHERE id = ? AND user_id = ?').get(row.reference_upload_id, userId) as { id: string; relative_path: string; mime_type: string } | undefined : undefined
  return { id: row.id, kind: row.kind, name: row.name, handle: handleFor(db, userId, { kind: row.kind, id: row.id })!.handle,
    description: row.description, continuityNotes: row.continuity_notes, revision: row.revision, createdAt: row.created_at,
    reference: upload ? { path: upload.relative_path, mime: upload.mime_type, uploadId: upload.id } : null,
    ...(row.source_kind ? { source: { kind: row.source_kind, scopeId: row.source_scope_id!, entityId: row.source_entity_id!, revision: row.source_revision ?? 0 } } : {}),
    ...(row.kind === 'location' ? { referenceViews: catalogViews(db, userId, row.reference_views_json) } : {}) }
}
export function listEntityCatalog(db: Database, userId: string, projectId?: string): CatalogEntity[] {
  syncEntityHandles(db, userId)
  validateProject(db, userId, projectId)
  return [...activeCharacters(db, userId).filter(c => !projectId || !c.project_id || c.project_id === projectId).map(c => catalogCharacter(db, userId, c)),
    ...activeAssets(db, userId).map(a => catalogAsset(db, userId, a))]
    .sort((a, b) => b.createdAt - a.createdAt || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
export function resolveEntity(db: Database, userId: string, ref: EntityRef, projectId?: string): CatalogEntity {
  syncEntityHandles(db, userId)
  validateProject(db, userId, projectId)
  if (ref.kind === 'character') {
    const row = activeCharacters(db, userId).find(c => c.id === ref.id && (!projectId || !c.project_id || c.project_id === projectId))
    if (row) return catalogCharacter(db, userId, row)
  } else {
    const row = db.prepare('SELECT * FROM library_assets WHERE id = ? AND user_id = ? AND kind = ? AND deleted_at IS NULL AND source_deleted=0').get(ref.id, userId, ref.kind) as LibraryAssetRow | undefined
    if (row) return catalogAsset(db, userId, row)
  }
  throw notFound('Không tìm thấy đối tượng thư viện')
}
export function ownedLibraryAsset(db: Database, userId: string, id: string): LibraryAssetRow {
  reconcileLocationLibrary(db, userId)
  const row = db.prepare('SELECT * FROM library_assets WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(id, userId) as LibraryAssetRow | undefined
  if (!row || row.source_deleted) throw notFound('Không tìm thấy vật phẩm thư viện')
  return row
}
export function createLibraryAsset(db: Database, userId: string, input: { kind: LibraryAssetKind; name: string; description?: string; continuityNotes?: string; handle?: string; autoHandle?: boolean }): CatalogEntity {
  syncEntityHandles(db, userId)
  return atomic(db, () => {
    const id = randomUUID(), now = Date.now()
    const base = normalizeEntityHandle(input.handle ?? input.name)
    // AI handles are suggestions, not reservations. Allocate under the same
    // transaction as registration; manually supplied handles still fail on collision.
    let handle = base
    if (input.autoHandle) {
      if (!base) handle = input.kind
      const stem = handle
      for (let suffix = 2; occupied(db, userId, handle); suffix++) {
        const ending = `-${suffix}`
        handle = `${stem.slice(0, 64 - ending.length).replace(/-+$/, '')}${ending}`
      }
    }
    register(db, userId, { kind: input.kind, id }, handle)
    db.prepare('INSERT INTO library_assets (id,user_id,kind,name,description,continuity_notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id, userId, input.kind, input.name, input.description ?? '', input.continuityNotes ?? '', now, now)
    return catalogAsset(db, userId, ownedLibraryAsset(db, userId, id))
  })
}
function assertEditableAsset(row: LibraryAssetRow): void {
  if (row.source_kind) throw badRequest('Bối cảnh liên kết chỉ được chỉnh sửa tại nguồn gốc.')
}
export function patchLibraryAsset(db: Database, userId: string, id: string, input: { name?: string; description?: string; continuityNotes?: string; revision?: number }): CatalogEntity {
  syncEntityHandles(db, userId)
  const row = ownedLibraryAsset(db, userId, id)
  assertEditableAsset(row)
  if (input.revision !== undefined && input.revision !== row.revision) throw conflict('Vật phẩm đã thay đổi, vui lòng tải lại')
  db.prepare('UPDATE library_assets SET name=?, description=?, continuity_notes=?, revision=revision+1, updated_at=? WHERE id=? AND user_id=?').run(input.name ?? row.name, input.description ?? row.description, input.continuityNotes ?? row.continuity_notes, Date.now(), id, userId)
  return catalogAsset(db, userId, ownedLibraryAsset(db, userId, id))
}
export function softDeleteLibraryAsset(db: Database, userId: string, id: string): void {
  atomic(db, () => {
    const row = db.prepare('SELECT * FROM library_assets WHERE id = ? AND user_id = ?').get(id, userId) as LibraryAssetRow | undefined
    if (!row) throw notFound('Không tìm thấy vật phẩm thư viện')
    assertEditableAsset(row)
    if (row.deleted_at === null) {
      assertLibraryAssetIdle(db, userId, id)
      const now = Date.now()
      db.prepare('UPDATE library_assets SET deleted_at=?, purge_after=?, updated_at=?, revision=revision+1 WHERE id=? AND user_id=?').run(now, now + LIBRARY_TRASH_RETENTION_MS, now, id, userId)
    }
    db.prepare('UPDATE entity_handles SET active=0 WHERE user_id=? AND kind=? AND entity_id=?').run(userId, row.kind, id)
  })
}
export function updateEntityHandle(db: Database, userId: string, ref: EntityRef, requested: string, projectId?: string): CatalogEntity {
  // Check identity without a full catalog sync: a restored conflicting alias must be
  // recoverable via this explicit rename endpoint instead of deadlocking on sync.
  validateProject(db, userId, projectId)
  const character = ref.kind === 'character' ? activeCharacters(db, userId).find(c => c.id === ref.id && (!projectId || !c.project_id || c.project_id === projectId)) : undefined
  if (ref.kind === 'character' && !character) throw notFound('Không tìm thấy đối tượng thư viện')
  if (ref.kind !== 'character') {
    const asset = ownedLibraryAsset(db, userId, ref.id)
    if (asset.kind !== ref.kind) throw notFound('Không tìm thấy đối tượng thư viện')
  }
  syncEntityHandles(db, userId, ref)
  atomic(db, () => {
    register(db, userId, ref, normalizeEntityHandle(requested))
    if (ref.kind === 'character') db.prepare('UPDATE characters SET updated_at=? WHERE id=? AND user_id=?').run(Math.max(Date.now(), character!.updated_at + 1), ref.id, userId)
    else db.prepare('UPDATE library_assets SET revision=revision+1, updated_at=? WHERE id=? AND user_id=?').run(Date.now(), ref.id, userId)
  })
  return resolveEntity(db, userId, ref, projectId)
}
export function listLibraryAssets(db: Database, userId: string, options: { kind?: LibraryAssetKind; search?: string; limit?: number; offset?: number } = {}): { assets: CatalogEntity[]; total: number; limit: number; offset: number } {
  syncEntityHandles(db, userId)
  const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 30))), offset = Math.max(0, Math.trunc(options.offset ?? 0))
  const query = (options.search ?? '').trim()
  const where = ['a.user_id = ?', 'a.deleted_at IS NULL', 'a.source_deleted=0']
  const params: (string | number)[] = [userId]
  if (options.kind) { where.push('a.kind = ?'); params.push(options.kind) }
  if (query) {
    where.push("(a.name LIKE ? ESCAPE '\\' OR a.description LIKE ? ESCAPE '\\' OR h.handle LIKE ? ESCAPE '\\')")
    const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`
    params.push(pattern, pattern, pattern)
  }
  const from = `FROM library_assets a JOIN entity_handles h ON h.kind=a.kind AND h.entity_id=a.id AND h.user_id=a.user_id AND h.active=1 WHERE ${where.join(' AND ')}`
  const total = Number((db.prepare(`SELECT COUNT(*) AS total ${from}`).get(...params) as { total: number }).total)
  const rows = db.prepare(`SELECT a.* ${from} ORDER BY a.updated_at DESC, a.id LIMIT ? OFFSET ?`).all(...params, limit, offset) as unknown as LibraryAssetRow[]
  return { assets: rows.map(a => catalogAsset(db, userId, a)), total, limit, offset }
}

/** Count retained references as well as outputs; no double-counting asset upload links. */
export function entityLibraryUsageBytes(db: Database, userId: string): number {
  const row = db.prepare(`SELECT (SELECT COALESCE(SUM(byte_size),0) FROM uploads WHERE user_id=?)
    + (SELECT COALESCE(SUM(byte_size),0) FROM assets WHERE user_id=?)
    + (SELECT COALESCE(SUM(reference_bytes),0) FROM characters WHERE user_id=? AND NOT EXISTS (SELECT 1 FROM immutable_media_versions v WHERE v.path=characters.reference_path))
    + (SELECT COALESCE(SUM(byte_size),0) FROM immutable_media_versions WHERE user_id=?)
    + (SELECT COALESCE(SUM(byte_size),0) FROM exports WHERE user_id=?) AS total`).get(userId, userId, userId, userId, userId) as { total: number }
  return Number(row.total)
}
export function setLibraryAssetReference(db: Database, userId: string, id: string, uploadId: string | null): CatalogEntity {
  syncEntityHandles(db, userId)
  const row = ownedLibraryAsset(db, userId, id)
  assertEditableAsset(row)
  if (uploadId && !db.prepare("SELECT id FROM uploads WHERE id=? AND user_id=? AND mime_type IN ('image/png','image/jpeg','image/webp','image/gif')").get(uploadId, userId)) throw notFound('Không tìm thấy ảnh tham chiếu')
  if (row.reference_upload_id !== uploadId) db.prepare('UPDATE library_assets SET reference_upload_id=?, revision=revision+1, updated_at=? WHERE id=? AND user_id=?').run(uploadId, Date.now(), id, userId)
  // Cleanup is asynchronous and retains uploads pinned by snapshots, batches or other entities.
  if (row.reference_upload_id && row.reference_upload_id !== uploadId) {
    const previous = db.prepare('SELECT relative_path FROM uploads WHERE id=? AND user_id=?').get(row.reference_upload_id, userId) as { relative_path: string } | undefined
    if (previous) db.prepare("INSERT INTO media_cleanup_jobs(id,user_id,kind,target_id,path,created_at) VALUES (?,?,'orphan_upload',?,?,?)").run(randomUUID(), userId, row.reference_upload_id, previous.relative_path, Date.now())
  }
  return catalogAsset(db, userId, ownedLibraryAsset(db, userId, id))
}
export function saveLibraryAssetReference(db: Database, env: AppEnv, mediaStore: MediaStore, userId: string, id: string, bytes: Uint8Array): CatalogEntity {
  syncEntityHandles(db, userId)
  assertEditableAsset(ownedLibraryAsset(db, userId, id))
  if (entityLibraryUsageBytes(db, userId) + bytes.byteLength > env.MAX_USER_MEDIA_BYTES) throw insufficientStorage('Đã vượt giới hạn dung lượng media của tài khoản')
  const uploadId = randomUUID()
  const saved = mediaStore.saveUpload({ userId, uploadId, bytes, maxBytes: env.MAX_REFERENCE_BYTES })
  return atomic(db, () => {
    db.prepare('INSERT INTO uploads (id,user_id,relative_path,mime_type,byte_size,created_at) VALUES (?,?,?,?,?,?)').run(uploadId, userId, saved.relativePath, saved.mimeType, saved.byteSize, Date.now())
    return setLibraryAssetReference(db, userId, id, uploadId)
  })
}
export function attachLibraryAssetFromGeneration(db: Database, env: AppEnv, mediaStore: MediaStore, userId: string, id: string, input: { generationId: string; assetId?: string }): CatalogEntity {
  ownedLibraryAsset(db, userId, id)
  const row = db.prepare(`SELECT a.relative_path, a.mime_type FROM assets a JOIN generations g ON g.id=a.generation_id
    WHERE a.user_id=? AND g.user_id=? AND g.id=? AND g.deleted_at IS NULL AND g.status='succeeded' AND g.kind='image'
      AND (? IS NULL OR a.id=?) ORDER BY a.created_at, a.id LIMIT 1`).get(userId, userId, input.generationId, input.assetId ?? null, input.assetId ?? null) as { relative_path: string; mime_type: string } | undefined
  if (!row || !row.mime_type.startsWith('image/') || !mediaStore.exists(row.relative_path)) throw notFound('Không tìm thấy kết quả ảnh')
  return saveLibraryAssetReference(db, env, mediaStore, userId, id, mediaStore.readFile(row.relative_path))
}
