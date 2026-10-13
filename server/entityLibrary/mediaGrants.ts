import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { Router } from 'express'
import type { Database } from '../db/index'
import type { GenerationRow } from '../generations/types'
import { badRequest, notFound } from '../lib/errors'
import { sniffMime, type MediaStore } from '../media/store'
import { isBlockedAddress } from '../providers/urlGuard'

export const DEFAULT_MEDIA_GRANT_TTL_MS = 2 * 60 * 60 * 1000
export const MAX_MEDIA_GRANT_TTL_MS = 24 * 60 * 60 * 1000
const TOKEN_PATTERN = /^[a-f0-9]{64}$/
const RASTER_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const ALLOWED_STATUSES = new Set(['queued', 'running', 'downloading', 'succeeded'])
type RasterReader = Pick<MediaStore, 'readFile'>
type GrantRow = {
  id: string; user_id: string; generation_id: string; token_hash: string
  relative_path: string; mime_type: string; content_sha256: string | null
  created_at: number; expires_at: number; revoked_at: number | null
}
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')

/** Pure origin validation: never resolve DNS or connect to the configured origin.
 * A domain's public DNS/reachability must be validated by deployment separately.
 * Private-provider development overrides never relax this public-media policy.
 */
export function validateMediaGrantOrigin(appOrigin: string): string {
  let url: URL
  try { url = new URL(appOrigin) } catch { throw badRequest('URL media tạm cần APP_ORIGIN HTTPS công khai') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw badRequest('URL media tạm cần APP_ORIGIN HTTPS công khai, không chứa đường dẫn hoặc thông tin đăng nhập')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw badRequest('URL media tạm không được dùng địa chỉ nội bộ')
  } else {
    // Reject local/special-use names even if a private-provider override is enabled.
    const labels = host.split('.')
    const privateSuffixes = ['localhost', 'local', 'internal', 'lan', 'home', 'test', 'invalid', 'example', 'onion', 'arpa']
    if (labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      privateSuffixes.some(suffix => host === suffix || host.endsWith(`.${suffix}`))) {
      throw badRequest('URL media tạm không được dùng tên miền nội bộ')
    }
  }
  return url.origin
}

function validTimestamp(now: number): boolean { return Number.isSafeInteger(now) && now >= 0 }
function assertOwnedPath(userId: string, path: string): void {
  if (!userId || userId.includes('/') || userId.includes('\\') || typeof path !== 'string' ||
    !path.startsWith(`${userId}/`) || path.includes('\\') || path.includes(':') || path.includes('%') ||
    /[\x00-\x1f\x7f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw badRequest('Đường dẫn media không thuộc tài khoản hoặc không hợp lệ')
  }
}
function parseSnapshot(raw: string | null | undefined): unknown {
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
/** Only recognized immutable generation manifests count; never recursively accept
 * arbitrary prompt text, URLs or client-supplied path-like properties.
 */
function hasSnapshotSource(generation: GenerationRow, path: string, mime: string): boolean {
  const matches = (value: unknown) => { const ref = object(value); return ref?.path === path && ref.mime === mime }
  const arrays = [generation.source_images_json, generation.character_references_json, generation.logo_overlays_json]
  for (const raw of arrays) {
    const refs = parseSnapshot(raw)
    if (Array.isArray(refs) && refs.some(matches)) return true
  }
  if (matches(parseSnapshot(generation.character_reference_json))) return true
  const entities = parseSnapshot(generation.entity_references_json)
  return Array.isArray(entities) && entities.some(value => matches(object(value)?.reference))
}
function enabledGeneration(db: Database, userId: string, generationId: string): GenerationRow {
  const row = db.prepare('SELECT * FROM generations WHERE id = ? AND user_id = ?').get(generationId, userId) as GenerationRow | undefined
  if (!row || row.deleted_at != null || !ALLOWED_STATUSES.has(row.status)) throw notFound('Tác vụ không còn khả dụng')
  if (object(parseSnapshot(row.params_json))?.allowTemporaryMedia !== true) {
    throw badRequest('Tác vụ chưa được cho phép chia sẻ media tạm')
  }
  return row
}
function rasterBytes(mediaStore: RasterReader, path: string, mime: string): Uint8Array {
  const bytes = mediaStore.readFile(path)
  if (!RASTER_MIMES.has(mime) || sniffMime(bytes) !== mime) throw badRequest('Media tạm chỉ hỗ trợ ảnh raster hợp lệ; không nhận SVG')
  return bytes
}

export type IssueMediaGrantOptions = {
  db: Database
  appOrigin: string
  userId: string
  generationId: string
  /** Exact server-resolved snapshot path. Caller MUST pin an immutable copy first. */
  path: string
  mime: string
  now?: number
  ttlMs?: number
  /** Deployment-configured ceiling; always capped at 24 hours. */
  maxTtlMs?: number
  /** Optional sync magic-byte check + content pinning, when available to caller. */
  mediaStore?: RasterReader
}
/** Internal service only. Create AFTER generation insertion and snapshot update.
 * No public issuance endpoint, client path parameters, DNS or provider calls.
 * With no store, the existing validated raster manifest is the issuance authority;
 * the public GET still sniffs bytes. Raw token exists only in the returned URL.
 */
export function issueMediaGrant(options: IssueMediaGrantOptions): { url: string; expiresAt: number; id: string } {
  const { db, userId, generationId, path, mime, mediaStore } = options
  const origin = validateMediaGrantOrigin(options.appOrigin)
  const now = options.now ?? Date.now()
  const configuredMax = options.maxTtlMs ?? MAX_MEDIA_GRANT_TTL_MS
  if (!validTimestamp(now) || !Number.isSafeInteger(configuredMax) || configuredMax <= 0) throw badRequest('Thời hạn media tạm không hợp lệ')
  const ceiling = Math.min(configuredMax, MAX_MEDIA_GRANT_TTL_MS)
  const ttl = options.ttlMs ?? Math.min(DEFAULT_MEDIA_GRANT_TTL_MS, ceiling)
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > ceiling || !Number.isSafeInteger(now + ttl)) throw badRequest('Thời hạn media tạm vượt giới hạn cho phép')
  assertOwnedPath(userId, path)
  if (!RASTER_MIMES.has(mime)) throw badRequest('Media tạm chỉ hỗ trợ PNG, JPEG, WebP hoặc GIF')
  const generation = enabledGeneration(db, userId, generationId)
  if (!hasSnapshotSource(generation, path, mime)) throw badRequest('Media không có trong snapshot đầu vào của tác vụ')
  let contentHash: string | null = null
  if (mediaStore) {
    try { contentHash = sha256(rasterBytes(mediaStore, path, mime)) }
    catch { throw badRequest('Không đọc được ảnh raster trong snapshot của tác vụ') }
  }
  const token = randomBytes(32).toString('hex')
  const id = randomUUID()
  const expiresAt = now + ttl
  db.prepare(`INSERT INTO temporary_media_grants
    (id,user_id,generation_id,token_hash,relative_path,mime_type,content_sha256,created_at,expires_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id, userId, generationId, sha256(token), path, mime, contentHash, now, expiresAt)
  return { id, expiresAt, url: `${origin}/api/provider-media/${token}` }
}

/** Revoke one capability, scoped by owner; repeated revocation is idempotent. */
export function revokeMediaGrant(db: Database, userId: string, id: string, now = Date.now()): void {
  if (!validTimestamp(now)) throw badRequest('Thời điểm thu hồi không hợp lệ')
  if (!db.prepare('SELECT id FROM temporary_media_grants WHERE id = ? AND user_id = ?').get(id, userId)) throw notFound()
  db.prepare('UPDATE temporary_media_grants SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND user_id = ?').run(now, id, userId)
}
/** Revoke all grants for an owned generation (including failed/trashed jobs). */
export function revokeGenerationMediaGrants(db: Database, userId: string, generationId: string, now = Date.now()): number {
  if (!validTimestamp(now)) throw badRequest('Thời điểm thu hồi không hợp lệ')
  if (!db.prepare('SELECT id FROM generations WHERE id = ? AND user_id = ?').get(generationId, userId)) throw notFound()
  return Number(db.prepare('UPDATE temporary_media_grants SET revoked_at = ? WHERE user_id = ? AND generation_id = ? AND revoked_at IS NULL').run(now, userId, generationId).changes)
}
/** Delete a grant record only, never its shared source file. */
export function deleteMediaGrant(db: Database, userId: string, id: string): void {
  if (!db.prepare('DELETE FROM temporary_media_grants WHERE id = ? AND user_id = ?').run(id, userId).changes) throw notFound()
}

/** Mount at /api/provider-media before session-required middleware. This router
 * never requires a session and exposes GET only. Do not log bearer URLs/tokens.
 * No caching: expiry/revocation must be checked on every fetch (no 304 responses).
 */
export function providerMediaRoutes(db: Database, mediaStore: RasterReader): Router {
  const router = Router()
  router.use((_req, res, next) => {
    res.set({ 'Cache-Control': 'private, no-store, max-age=0', 'Pragma': 'no-cache',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; sandbox" })
    if (_req.method !== 'GET') { res.set('Allow', 'GET').status(405).end(); return }
    next()
  })
  router.get('/:token', (req, res) => {
    const deny = () => { res.status(404).end() }
    const token = req.params.token
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) { deny(); return }
    const grant = db.prepare('SELECT * FROM temporary_media_grants WHERE token_hash = ?').get(sha256(token)) as GrantRow | undefined
    if (!grant || grant.revoked_at != null || grant.expires_at <= Date.now()) { deny(); return }
    let bytes: Uint8Array
    try {
      const generation = enabledGeneration(db, grant.user_id, grant.generation_id)
      assertOwnedPath(grant.user_id, grant.relative_path)
      if (!hasSnapshotSource(generation, grant.relative_path, grant.mime_type)) { deny(); return }
      bytes = rasterBytes(mediaStore, grant.relative_path, grant.mime_type)
      if (grant.content_sha256 && sha256(bytes) !== grant.content_sha256) { deny(); return }
    } catch { deny(); return }
    // end(), not send(), avoids Express freshness/ETag handling overriding no-store.
    res.status(200).set({ 'Content-Type': grant.mime_type, 'Content-Length': String(bytes.byteLength) }).end(Buffer.from(bytes))
  })
  return router
}
