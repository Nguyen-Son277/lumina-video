import { randomUUID } from 'node:crypto'
import type { Database } from '../db/index'
import type { AppEnv } from '../env'
import type { MediaStore } from '../media/store'
import type { CharacterRow } from '../projects/service'
import { transaction } from '../projects/service'
import { insufficientStorage } from '../lib/errors'

type ReferenceMedia = { relativePath: string; mimeType: string; byteSize: number }

/** Register a physical version once; the current character pointer is not its lifetime. */
export function retainCharacterMedia(db: Database, character: Pick<CharacterRow, 'user_id' | 'reference_path' | 'reference_mime' | 'reference_bytes'>): void {
  if (!character.reference_path || !character.reference_mime || character.reference_bytes == null) return
  db.prepare(`INSERT INTO immutable_media_versions (id,user_id,path,mime_type,byte_size,created_at)
    VALUES (?,?,?,?,?,?) ON CONFLICT(path) DO NOTHING`).run(randomUUID(), character.user_id,
    character.reference_path, character.reference_mime, character.reference_bytes, Date.now())
}

/** Keep retained versions in quota; replacing a pointer does not free snapshot bytes. */
export function assertCharacterMediaQuota(db: Database, mediaStore: MediaStore, env: AppEnv, character: CharacterRow, byteSize: number): void {
  retainCharacterMedia(db, character)
  if (mediaStore.userUsageBytes(db, character.user_id) + byteSize > env.MAX_USER_MEDIA_BYTES) {
    throw insufficientStorage('Đã vượt giới hạn dung lượng media của tài khoản')
  }
}

/** Update the current pointer atomically; old bytes can only be removed by guarded cleanup. */
export function setCharacterMedia(db: Database, character: CharacterRow, saved: ReferenceMedia | null): void {
  transaction(db, () => {
    retainCharacterMedia(db, character)
    if (saved) retainCharacterMedia(db, { user_id: character.user_id, reference_path: saved.relativePath,
      reference_mime: saved.mimeType, reference_bytes: saved.byteSize })
    db.prepare(`UPDATE characters SET reference_path=?,reference_mime=?,reference_bytes=?,updated_at=? WHERE id=? AND user_id=?`)
      .run(saved?.relativePath ?? null, saved?.mimeType ?? null, saved?.byteSize ?? null, Date.now(), character.id, character.user_id)
    if (character.reference_path && character.reference_path !== saved?.relativePath) {
      // Duplicate clear/replacement requests need only one pending cleanup per file.
      db.prepare(`INSERT INTO media_cleanup_jobs (id,user_id,kind,target_id,path,created_at)
        SELECT ?,?,'path',?,?,? WHERE NOT EXISTS (SELECT 1 FROM media_cleanup_jobs WHERE user_id=? AND path=?)`)
        .run(randomUUID(), character.user_id, character.id, character.reference_path, Date.now(), character.user_id, character.reference_path)
    }
  })
}
