import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { Database } from '../db/index'
import type { AppEnv } from '../env'
import type { GenerationRow } from '../generations/types'
import type { MediaStore } from '../media/store'
import { resolveFfmpeg } from '../exports/ffmpeg'
import { logger } from '../lib/logger'
import { compositeLogoImage, overlayLogoVideo, type ResolvedLogoOverlay } from './overlay'

export type LogoPostprocessResult = {
  status: 'skipped' | 'running' | 'succeeded' | 'failed'
  derivedAssetIds: string[]
  error?: string
}
type OriginalAsset = { id: string; relative_path: string; mime_type: string }
const EXTENSIONS = ['png', 'jpg', 'webp', 'gif', 'mp4', 'webm', 'mov']

/** Only account-owned local snapshot files may be decoded; never resolve entities again. */
async function ownedFile(mediaStore: MediaStore, userId: string, path: string): Promise<string> {
  if (typeof path !== 'string' || path.includes('\\') || path.includes(':') ||
    path.split('/').some(segment => !segment || segment === '.' || segment === '..') ||
    !path.startsWith(`${userId}/`)) throw new Error('Invalid snapshot media path')
  const root = await realpath(join(mediaStore.root, userId))
  const absolute = await realpath(mediaStore.absolutePath(path))
  if (!absolute.startsWith(`${root}${sep}`)) throw new Error('Snapshot media escapes account directory')
  return absolute
}

/** Pick beyond every existing output (including orphan files from an interrupted save). */
function unusedOutputIndex(db: Database, mediaStore: MediaStore, generation: GenerationRow): number {
  const paths = db.prepare('SELECT relative_path FROM assets WHERE generation_id = ?').all(generation.id) as Array<{ relative_path: string }>
  let index = paths.reduce((max, asset) => {
    const match = /^output(?:-(\d+))?\.[a-z]+$/.exec(basename(asset.relative_path))
    return Math.max(max, match ? Number(match[1] ?? 0) : 0)
  }, 0) + 1
  while (EXTENSIONS.some(ext => mediaStore.exists(join(generation.user_id, generation.id, `output-${index}.${ext}`)))) index++
  if (!Number.isSafeInteger(index)) throw new Error('Invalid output index')
  return index
}

/**
 * Local-only postprocessing. Preserve provider outputs and their immutable snapshot.
 * Failure is independent from provider success; partial derived outputs are reusable
 * on retry. A DB claim plus the unique source-asset index prevents duplicate variants.
 */
export async function postprocessGenerationLogos(options: {
  db: Database
  mediaStore: MediaStore
  env: AppEnv
  generation: GenerationRow
}): Promise<LogoPostprocessResult> {
  const { db, mediaStore, env } = options
  // Re-read the persisted snapshot, not potentially stale client/worker input.
  const generation = db.prepare('SELECT * FROM generations WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(options.generation.id, options.generation.user_id) as GenerationRow | undefined
  if (!generation) return { status: 'skipped', derivedAssetIds: [] }
  const derivedIds = () => (db.prepare("SELECT id FROM assets WHERE generation_id = ? AND user_id = ? AND variant = 'logo_overlay' ORDER BY created_at, id")
    .all(generation.id, generation.user_id) as Array<{ id: string }>).map(asset => asset.id)
  if (!generation.logo_overlays_json || generation.logo_overlays_json === '[]') return { status: 'skipped', derivedAssetIds: [] }
  const state = (generation as GenerationRow & { postprocess_status?: string | null }).postprocess_status
  if (state === 'succeeded' || state === 'running') return { status: state, derivedAssetIds: derivedIds() }
  const claim = db.prepare(`UPDATE generations SET postprocess_status = 'running', postprocess_error = NULL, updated_at = ?
    WHERE id = ? AND deleted_at IS NULL AND (postprocess_status IS NULL OR postprocess_status IN ('queued','failed'))`)
    .run(Date.now(), generation.id)
  if (Number(claim.changes) !== 1) return { status: 'running', derivedAssetIds: derivedIds() }

  try {
    const overlays = JSON.parse(generation.logo_overlays_json) as ResolvedLogoOverlay[]
    if (!Array.isArray(overlays) || overlays.length === 0) throw new Error('Invalid logo snapshot')
    const originals = db.prepare("SELECT id, relative_path, mime_type FROM assets WHERE generation_id = ? AND user_id = ? AND variant = 'original' ORDER BY created_at, id")
      .all(generation.id, generation.user_id) as OriginalAsset[]
    if (!originals.length) throw new Error('No original outputs')
    for (const original of originals) {
      if (db.prepare("SELECT 1 FROM assets WHERE source_asset_id = ? AND variant = 'logo_overlay'").get(original.id)) continue
      for (const overlay of overlays) await ownedFile(mediaStore, generation.user_id, overlay.path)
      const input = await ownedFile(mediaStore, generation.user_id, original.relative_path)
      const inputInfo = await stat(input)
      const limit = generation.kind === 'video' ? env.MAX_VIDEO_BYTES : env.MAX_IMAGE_BYTES
      if (!inputInfo.isFile() || inputInfo.size > limit) throw new Error('Original output exceeds size limit')
      let bytes: Uint8Array
      if (generation.kind === 'image') {
        if (!original.mime_type.startsWith('image/')) throw new Error('Wrong original output kind')
        bytes = await compositeLogoImage(mediaStore.readFile(original.relative_path), overlays, mediaStore)
      } else {
        if (!original.mime_type.startsWith('video/')) throw new Error('Wrong original output kind')
        const timeoutMs = Math.min(env.EXPORT_TIMEOUT_MS, 3_600_000)
        const tooling = await resolveFfmpeg(env.FFMPEG_PATH, Math.min(timeoutMs, 10_000))
        if (!tooling) throw new Error('ffmpeg unavailable')
        const temporary = await mkdtemp(join(tmpdir(), 'lumina-logo-'))
        // Keep the exact resolved directory for guarded cleanup, never a request path.
        const trustedTemporary = resolve(temporary)
        try {
          const output = join(trustedTemporary, 'composited.mp4')
          await overlayLogoVideo({ input, output, overlays, mediaStore, tooling, timeoutMs })
          const info = await stat(output)
          // Bound before loading into memory, not just at mediaStore.save.
          if (!info.isFile() || info.size > env.MAX_VIDEO_BYTES) throw new Error('Derived video exceeds size limit')
          bytes = await readFile(output)
        } finally {
          if (dirname(trustedTemporary) === resolve(tmpdir()) && basename(trustedTemporary).startsWith('lumina-logo-')) {
            await rm(trustedTemporary, { recursive: true, force: true })
          }
        }
      }
      if (bytes.byteLength > limit) throw new Error('Derived output exceeds size limit')
      // Transaction covers quota + filename choice + synchronous save + insert. No
      // await here: parallel accounts/jobs cannot slip between the quota and save.
      db.exec('BEGIN IMMEDIATE')
      try {
        if (mediaStore.userUsageBytes(db, generation.user_id) + bytes.byteLength > env.MAX_USER_MEDIA_BYTES) {
          throw new Error('Derived output exceeds account quota')
        }
        const index = unusedOutputIndex(db, mediaStore, generation)
        const saved = mediaStore.save({ userId: generation.user_id, generationId: generation.id, bytes, index })
        db.prepare(`INSERT INTO assets (id, generation_id, user_id, relative_path, mime_type, byte_size, created_at, source_asset_id, variant)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'logo_overlay')`)
          .run(randomUUID(), generation.id, generation.user_id, saved.relativePath, saved.mimeType, saved.byteSize, Date.now(), original.id)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        // Never delete/overwrite originals. Interrupted/orphan derived files are
        // skipped by the next index allocation rather than reused as originals.
        throw error
      }
    }
    db.prepare("UPDATE generations SET postprocess_status = 'succeeded', postprocess_error = NULL, updated_at = ? WHERE id = ?")
      .run(Date.now(), generation.id)
    return { status: 'succeeded', derivedAssetIds: derivedIds() }
  } catch {
    // Do not leak private filesystem paths/ffmpeg stderr through the API.
    const error = 'Không thể ghép logo vào kết quả. Bản gốc vẫn được giữ; hãy kiểm tra logo, ffmpeg và dung lượng rồi thử ghép lại.'
    db.prepare("UPDATE generations SET postprocess_status = 'failed', postprocess_error = ?, updated_at = ? WHERE id = ?")
      .run(error, Date.now(), generation.id)
    logger.warn('Ghép logo thất bại; giữ kết quả provider', { id: generation.id })
    return { status: 'failed', derivedAssetIds: derivedIds(), error }
  }
}
