import { randomUUID } from 'node:crypto'
import { imagePurposeSchema, type ImagePublication } from '../../shared/imagePurpose'
import type { Database } from '../db/index'
import type { AppEnv } from '../env'
import type { MediaStore } from '../media/store'
import type { GenerationRow } from '../generations/types'
import { attachLibraryAssetFromGeneration, createLibraryAsset } from './service'

export function libraryPublications(db: Database, generationId: string): ImagePublication[] {
  return db.prepare(`SELECT source_asset_id AS sourceAssetId,asset_id AS assetId,target_kind AS targetKind,target_id AS targetId
    FROM generation_library_publications WHERE generation_id=? ORDER BY created_at,rowid`).all(generationId) as ImagePublication[]
}

/** Local-only, synchronous savepoints serialize each output, including its idempotency mapping. */
export function publishGenerationImages({ db, env, mediaStore, generationId }: {
  db: Database; env: AppEnv; mediaStore: MediaStore; generationId: string
}): void {
  const row = db.prepare('SELECT * FROM generations WHERE id=? AND deleted_at IS NULL').get(generationId) as GenerationRow | undefined
  if (!row?.image_purpose_json || row.kind !== 'image' || row.status !== 'succeeded' || row.library_publish_status === 'succeeded') return
  try {
    const overlays: unknown = JSON.parse(row.logo_overlays_json ?? '[]')
    const hasOverlays = Array.isArray(overlays) && overlays.length > 0
    if (hasOverlays && row.postprocess_status !== 'succeeded') return
    const purpose = imagePurposeSchema.parse(JSON.parse(row.image_purpose_json))
    const outputs = db.prepare(`SELECT id,relative_path,mime_type,byte_size,source_asset_id FROM assets
      WHERE generation_id=? AND user_id=? AND ${hasOverlays ? "variant='logo_overlay'" : "COALESCE(variant,'original')='original'"} ORDER BY created_at,id`)
      .all(row.id, row.user_id) as Array<{ id: string; relative_path: string; mime_type: string; byte_size: number; source_asset_id: string | null }>
    if (!outputs.length) throw new Error('No final image outputs available')
    if (hasOverlays) {
      const originals = db.prepare("SELECT COUNT(*) AS n FROM assets WHERE generation_id=? AND user_id=? AND COALESCE(variant,'original')='original'").get(row.id, row.user_id) as { n: number }
      if (outputs.length !== Number(originals.n)) throw new Error('Final overlay outputs are incomplete')
    }
    for (const [index, output] of outputs.entries()) {
      const sourceId = output.source_asset_id ?? output.id
      if (db.prepare('SELECT 1 FROM generation_library_publications WHERE generation_id=? AND source_asset_id=?').get(row.id, sourceId)) continue
      const savepoint = `publication_${randomUUID().replace(/-/g, '')}`
      const copied: string[] = []
      const trackedStore: MediaStore = { ...mediaStore,
        saveUpload: input => { const saved = mediaStore.saveUpload(input); copied.push(saved.relativePath); return saved },
      }
      db.exec(`SAVEPOINT ${savepoint}`)
      try {
        // Check again under the write transaction for concurrent retry callers.
        if (db.prepare('SELECT 1 FROM generation_library_publications WHERE generation_id=? AND source_asset_id=?').get(row.id, sourceId)) { db.exec(`RELEASE ${savepoint}`); continue }
        // Stable output ordering keeps the same suffix on recovery after a partial save.
        // Existing mappings above are never renamed or recreated.
        const suffix = outputs.length > 1 ? ` · ${index + 1}` : ''
        const name = `${purpose.name.slice(0, 200 - suffix.length)}${suffix}`
        const entity = createLibraryAsset(db, row.user_id, { ...purpose, name, handle: `image-${randomUUID()}` })
        const targetId = entity.id
        const reference = attachLibraryAssetFromGeneration(db, env, trackedStore, row.user_id, targetId, { generationId: row.id, assetId: output.id }).reference
        db.prepare(`INSERT INTO generation_library_publications(generation_id,source_asset_id,target_kind,target_id,asset_id,snapshot_json,created_at) VALUES(?,?,?,?,?,?,?)`)
          .run(row.id, sourceId, purpose.kind, targetId, output.id, JSON.stringify({ targetKind: purpose.kind, targetId, sourceAssetId: sourceId, assetId: output.id, purpose, reference, sourceAsset: { id: sourceId }, finalAsset: { id: output.id, path: output.relative_path, mime: output.mime_type } }), Date.now())
        // Existing owner-scoped retention scanners inspect generation *_json columns.
        const snapshots = db.prepare('SELECT snapshot_json FROM generation_library_publications WHERE generation_id=? ORDER BY created_at,source_asset_id').all(row.id) as { snapshot_json: string }[]
        db.prepare('UPDATE generations SET library_publications_json=? WHERE id=?').run(JSON.stringify(snapshots.map(item => JSON.parse(item.snapshot_json))), row.id)
        db.exec(`RELEASE ${savepoint}`)
      } catch (error) {
        db.exec(`ROLLBACK TO ${savepoint}`); db.exec(`RELEASE ${savepoint}`)
        for (const path of copied) {
          try { mediaStore.removeByPath(path) }
          catch { db.prepare("INSERT INTO media_cleanup_jobs(id,user_id,kind,target_id,path,created_at) VALUES(?,?,'path',?,?,?)").run(randomUUID(), row.user_id, row.id, path, Date.now()) }
        }
        throw error
      }
    }
    db.prepare("UPDATE generations SET library_publish_status='succeeded',library_publish_error=NULL,updated_at=? WHERE id=?").run(Date.now(), row.id)
  } catch {
    // Never expose file paths or provider details and never turn successful generation into failure.
    db.prepare("UPDATE generations SET library_publish_status='failed',library_publish_error=?,updated_at=? WHERE id=?")
      .run('Không thể lưu kết quả vào thư viện. Có thể thử lại mà không tạo ảnh mới.', Date.now(), row.id)
  }
}

/** Bounded recovery, retried no more than once per minute after local errors. */
export function recoverImagePublications(db: Database, env: AppEnv, mediaStore: MediaStore): void {
  const rows = db.prepare(`SELECT id FROM generations WHERE kind='image' AND status='succeeded' AND deleted_at IS NULL
    AND image_purpose_json IS NOT NULL AND (library_publish_status='queued' OR (library_publish_status='failed' AND updated_at<?))
    AND (COALESCE(logo_overlays_json,'[]')='[]' OR postprocess_status='succeeded') ORDER BY updated_at LIMIT 10`).all(Date.now() - 60_000) as { id: string }[]
  for (const row of rows) publishGenerationImages({ db, env, mediaStore, generationId: row.id })
}
