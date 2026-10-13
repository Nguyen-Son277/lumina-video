import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MEDIA_GRANT_TTL_MS, MAX_MEDIA_GRANT_TTL_MS, deleteMediaGrant,
  issueMediaGrant, providerMediaRoutes, revokeGenerationMediaGrants,
  revokeMediaGrant, validateMediaGrantOrigin,
} from '../../server/entityLibrary/mediaGrants'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])
const path = 'alice/pinned/job/input.png'
const origin = 'https://studio.lumina.app'
let db: DatabaseSync
let files: Map<string, Uint8Array>
let server: Server | undefined
let baseUrl: string
const readFile = vi.fn((p: string): Uint8Array => {
  const bytes = files.get(p)
  if (!bytes) throw new Error('Missing file')
  return bytes
})
const store = { readFile }
function generation(id = 'job', userId = 'alice', sourcePath = path) {
  db.prepare(`INSERT INTO generations (id,user_id,status,params_json,source_images_json)
    VALUES (?,?,'queued',?,?)`).run(id, userId, JSON.stringify({ allowTemporaryMedia: true }), JSON.stringify([{ path: sourcePath, mime: 'image/png' }]))
}
function issue(overrides: Partial<Parameters<typeof issueMediaGrant>[0]> = {}) {
  return issueMediaGrant({ db, appOrigin: origin, userId: 'alice', generationId: 'job', path, mime: 'image/png', ...overrides })
}
function tokenOf(url: string) { return new URL(url).pathname.split('/').at(-1)! }
async function startRouter() {
  const app = express()
  app.use('/api/provider-media', providerMediaRoutes(db, store))
  // Proves successful public fetches do not fall through to a session gate.
  app.use((_req, res) => res.status(401).end())
  server = await new Promise<Server>(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
function fetchGrant(url: string, init?: RequestInit) {
  return fetch(`${baseUrl}${new URL(url).pathname}`, init)
}

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE generations (
      id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),status TEXT,deleted_at INTEGER,
      params_json TEXT,entity_references_json TEXT,source_images_json TEXT,
      character_reference_json TEXT,character_references_json TEXT,logo_overlays_json TEXT
    );
    INSERT INTO users VALUES ('alice'),('bob');`)
  db.exec(readFileSync(new URL('../../server/db/migrations/029_temporary_media_grants.sql', import.meta.url), 'utf8'))
  files = new Map([[path, PNG]])
  readFile.mockClear()
  generation()
})
afterEach(async () => {
  if (server) { await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined }
  db.close()
})

describe('temporary media grant issuance', () => {
  it('returns a random 256-bit URL, stores only its SHA-256 and defaults to two hours', () => {
    const now = 1_000_000
    const first = issue({ now })
    const second = issue({ now })
    const token = tokenOf(first.url)
    expect(first.url).toMatch(/^https:\/\/studio\.lumina\.app\/api\/provider-media\/[a-f0-9]{64}$/)
    expect(tokenOf(second.url)).not.toBe(token)
    expect(first.expiresAt).toBe(now + DEFAULT_MEDIA_GRANT_TTL_MS)
    const row = db.prepare('SELECT * FROM temporary_media_grants WHERE id=?').get(first.id)!
    expect(row.token_hash).toBe(createHash('sha256').update(token).digest('hex'))
    expect(JSON.stringify(row)).not.toContain(token)
    expect(Object.keys(row)).not.toContain('token')
    expect(row.relative_path).toBe(path)
    expect(row.revoked_at).toBeNull()
    expect(readFile).not.toHaveBeenCalled()
  })
  it('enforces configured TTL and absolute 24-hour maximum', () => {
    expect(issue({ now: 10, ttlMs: MAX_MEDIA_GRANT_TTL_MS }).expiresAt).toBe(10 + MAX_MEDIA_GRANT_TTL_MS)
    expect(issue({ now: 10, maxTtlMs: 30_000 }).expiresAt).toBe(30_010)
    for (const ttlMs of [0, -1, 0.5, NaN, Infinity, MAX_MEDIA_GRANT_TTL_MS + 1]) expect(() => issue({ ttlMs })).toThrow()
    expect(() => issue({ ttlMs: 31_000, maxTtlMs: 30_000 })).toThrow()
    expect(() => issue({ ttlMs: MAX_MEDIA_GRANT_TTL_MS + 1, maxTtlMs: MAX_MEDIA_GRANT_TTL_MS * 2 })).toThrow()
    expect(() => issue({ maxTtlMs: 0 })).toThrow()
    expect(() => issue({ now: -1 })).toThrow()
    expect(() => issue({ now: Number.MAX_SAFE_INTEGER })).toThrow()
  })
  it.each([
    'http://studio.lumina.app', 'https://localhost', 'https://a.localhost', 'https://localhost.',
    'https://127.0.0.1', 'https://127.1', 'https://2130706433', 'https://10.0.0.1',
    'https://169.254.169.254', 'https://100.64.0.1', 'https://[::1]', 'https://[fd00::1]',
    'https://[::ffff:127.0.0.1]', 'https://my.internal', 'https://a.local', 'https://my-server',
    'https://a.test', 'https://user:pass@studio.lumina.app', 'https://studio.lumina.app/path',
    'https://studio.lumina.app?token=x', 'https://studio.lumina.app#fragment', 'not-url',
  ])('rejects unsafe origin %s without any DNS or network calls', appOrigin => {
    expect(() => issue({ appOrigin })).toThrow()
    expect(db.prepare('SELECT count(*) AS n FROM temporary_media_grants').get()!.n).toBe(0)
  })
  it('accepts HTTPS public IP literals and normal public domain origin', () => {
    expect(validateMediaGrantOrigin('https://8.8.8.8')).toBe('https://8.8.8.8')
    expect(validateMediaGrantOrigin('https://[2606:4700:4700::1111]')).toBe('https://[2606:4700:4700::1111]')
    expect(validateMediaGrantOrigin(`${origin}/`)).toBe(origin)
  })
  it('requires an existing owned generation with per-generation explicit opt-in', () => {
    expect(() => issue({ generationId: 'not-enqueued' })).toThrow()
    expect(() => issue({ userId: 'bob', path: 'bob/input.png' })).toThrow()
    for (const params of ['{}', '{"allowTemporaryMedia":"true"}', 'broken', '[]']) {
      db.prepare('UPDATE generations SET params_json=?').run(params)
      expect(() => issue()).toThrow()
    }
    expect(db.prepare('SELECT count(*) AS n FROM temporary_media_grants').get()!.n).toBe(0)
  })
  it.each(['failed', 'unknown'])('rejects %s generations', status => {
    db.prepare('UPDATE generations SET status=?').run(status)
    expect(() => issue()).toThrow()
  })
  it('rejects soft-deleted generations', () => {
    db.exec('UPDATE generations SET deleted_at=1')
    expect(() => issue()).toThrow()
  })
  it.each(['bob/pinned/a.png', 'alice2/pinned/a.png', '/alice/a.png', 'alice/../bob/a.png',
    'alice/./a.png', 'alice//a.png', 'alice/a\\b.png', 'alice/%2e%2e/a.png', 'alice/a\0.png', 'alice/https:a.png'])('rejects unsafe/unowned path %s even in the snapshot', invalidPath => {
    db.prepare('UPDATE generations SET source_images_json=?').run(JSON.stringify([{ path: invalidPath, mime: 'image/png' }]))
    expect(() => issue({ path: invalidPath })).toThrow()
  })
  it('requires exact path and MIME in a recognized server snapshot, not arbitrary fields', () => {
    expect(() => issue({ path: 'alice/unlisted.png' })).toThrow()
    expect(() => issue({ mime: 'image/jpeg' })).toThrow()
    db.exec('UPDATE generations SET source_images_json=NULL')
    db.prepare('UPDATE generations SET entity_references_json=?').run(JSON.stringify([{ path, mime: 'image/png' }]))
    expect(() => issue()).toThrow()
    db.prepare('UPDATE generations SET entity_references_json=?').run(JSON.stringify([{ reference: { path, mime: 'image/png' } }]))
    expect(issue().id).toBeTruthy()
  })
  it.each(['source_images_json', 'character_references_json', 'logo_overlays_json', 'character_reference_json'])('accepts the exact %s source manifest', column => {
    db.exec('UPDATE generations SET source_images_json=NULL')
    const ref = { path, mime: 'image/png' }
    db.prepare(`UPDATE generations SET ${column}=?`).run(JSON.stringify(column === 'character_reference_json' ? ref : [ref]))
    expect(issue().id).toBeTruthy()
  })
  it('validates raster magic on issuance when a store is supplied and pins its content digest', () => {
    const grant = issue({ mediaStore: store })
    expect(db.prepare('SELECT content_sha256 FROM temporary_media_grants WHERE id=?').get(grant.id)!.content_sha256)
      .toBe(createHash('sha256').update(PNG).digest('hex'))
    for (const bytes of [JPEG, new TextEncoder().encode('<svg/>'), new TextEncoder().encode('<html/>')]) {
      files.set(path, bytes)
      expect(() => issue({ mediaStore: store })).toThrow()
    }
    files.delete(path)
    expect(() => issue({ mediaStore: store })).toThrow()
    expect(() => issue({ mime: 'image/svg+xml' })).toThrow()
    expect(() => issue({ mime: 'video/mp4' })).toThrow()
  })
})

describe('public read-only provider media router', () => {
  it.each(['queued', 'running', 'downloading', 'succeeded'])('serves exact raster bytes without session for %s until TTL', async status => {
    db.prepare('UPDATE generations SET status=?').run(status)
    const grant = issue({ mediaStore: store })
    await startRouter()
    const response = await fetchGrant(grant.url)
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('etag')).toBeNull()
    expect(response.headers.get('set-cookie')).toBeNull()
    // Query strings cannot choose another user's file.
    expect((await fetch(`${baseUrl}${new URL(grant.url).pathname}?path=bob/secret.png&userId=bob`)).status).toBe(200)
    expect(readFile.mock.calls.every(([p]) => p === path)).toBe(true)
  })
  it('rejects malformed and unknown tokens before reading files', async () => {
    await startRouter()
    for (const token of ['short', 'g'.repeat(64), 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'a'.repeat(64)]) {
      expect((await fetch(`${baseUrl}/api/provider-media/${token}`)).status).toBe(404)
    }
    expect(readFile).not.toHaveBeenCalled()
  })
  it('does not support HEAD, POST, PUT, PATCH or DELETE', async () => {
    const grant = issue()
    await startRouter()
    for (const method of ['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await fetchGrant(grant.url, { method })
      expect(response.status).toBe(405)
      expect(response.headers.get('allow')).toBe('GET')
    }
    expect(readFile).not.toHaveBeenCalled()
  })
  it('rejects expired and revoked grants identically without reads', async () => {
    const expired = issue({ now: Date.now() - 10_000, ttlMs: 1 })
    const revoked = issue()
    revokeMediaGrant(db, 'alice', revoked.id)
    await startRouter()
    expect((await fetchGrant(expired.url)).status).toBe(404)
    expect((await fetchGrant(revoked.url)).status).toBe(404)
    expect(readFile).not.toHaveBeenCalled()
  })
  it.each(['failed', 'unknown', 'deleted', 'removed', 'opt-out', 'changed-manifest'])('blocks fetch when generation is %s', async change => {
    const grant = issue()
    if (change === 'deleted') db.exec('UPDATE generations SET deleted_at=1')
    else if (change === 'removed') db.exec('DELETE FROM generations')
    else if (change === 'opt-out') db.exec("UPDATE generations SET params_json='{}'")
    else if (change === 'changed-manifest') db.exec('UPDATE generations SET source_images_json=NULL')
    else db.prepare('UPDATE generations SET status=?').run(change)
    await startRouter()
    expect((await fetchGrant(grant.url)).status).toBe(404)
    expect(readFile).not.toHaveBeenCalled()
    if (change === 'removed') expect(db.prepare('SELECT count(*) AS n FROM temporary_media_grants').get()!.n).toBe(0)
  })
  it('rejects replaced, SVG, MIME-mismatched and missing sources on every GET', async () => {
    const grant = issue({ mediaStore: store })
    await startRouter()
    for (const bytes of [Uint8Array.from([...PNG, 2]), JPEG, new TextEncoder().encode('<svg/>')]) {
      files.set(path, bytes)
      expect((await fetchGrant(grant.url)).status).toBe(404)
    }
    files.delete(path)
    expect((await fetchGrant(grant.url)).status).toBe(404)
  })
  it('checks magic at GET even when no MediaStore was available during issuance', async () => {
    const grant = issue()
    files.set(path, new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))
    await startRouter()
    expect((await fetchGrant(grant.url)).status).toBe(404)
  })
})

describe('owned revocation/deletion', () => {
  it('scopes single-grant revocation and deletion by user; idempotent revocation preserves original time', () => {
    const grant = issue()
    expect(() => revokeMediaGrant(db, 'bob', grant.id)).toThrow()
    expect(() => deleteMediaGrant(db, 'bob', grant.id)).toThrow()
    revokeMediaGrant(db, 'alice', grant.id, 100)
    revokeMediaGrant(db, 'alice', grant.id, 200)
    expect(db.prepare('SELECT revoked_at FROM temporary_media_grants WHERE id=?').get(grant.id)!.revoked_at).toBe(100)
    deleteMediaGrant(db, 'alice', grant.id)
    expect(db.prepare('SELECT count(*) AS n FROM temporary_media_grants').get()!.n).toBe(0)
    expect(files.get(path)).toEqual(PNG)
  })
  it('revokes only grants for the owned generation, including terminal jobs', () => {
    const first = issue()
    issue()
    generation('other', 'alice')
    const other = issue({ generationId: 'other' })
    generation('bob-job', 'bob', 'bob/pinned/input.png')
    const bobGrant = issue({ userId: 'bob', generationId: 'bob-job', path: 'bob/pinned/input.png' })
    expect(() => revokeGenerationMediaGrants(db, 'bob', 'job')).toThrow()
    db.prepare("UPDATE generations SET status='failed' WHERE id='job'").run()
    expect(revokeGenerationMediaGrants(db, 'alice', 'job', 123)).toBe(2)
    expect(revokeGenerationMediaGrants(db, 'alice', 'job', 456)).toBe(0)
    expect(db.prepare('SELECT revoked_at FROM temporary_media_grants WHERE id=?').get(first.id)!.revoked_at).toBe(123)
    expect(db.prepare('SELECT revoked_at FROM temporary_media_grants WHERE id=?').get(other.id)!.revoked_at).toBeNull()
    expect(db.prepare('SELECT revoked_at FROM temporary_media_grants WHERE id=?').get(bobGrant.id)!.revoked_at).toBeNull()
  })
  it('migration enforces FK cascade and hard 24-hour TTL even for raw SQL inserts', () => {
    issue()
    expect(() => db.prepare(`INSERT INTO temporary_media_grants
      (id,user_id,generation_id,token_hash,relative_path,mime_type,created_at,expires_at)
      VALUES ('bad','alice','missing',?,'alice/input.png','image/png',0,1)`).run('f'.repeat(64))).toThrow()
    expect(() => db.prepare(`INSERT INTO temporary_media_grants
      (id,user_id,generation_id,token_hash,relative_path,mime_type,created_at,expires_at)
      VALUES ('bad','alice','job',?,'alice/input.png','image/png',0,86400001)`).run('f'.repeat(64))).toThrow()
    db.exec("DELETE FROM generations WHERE id='job'")
    expect(db.prepare('SELECT count(*) AS n FROM temporary_media_grants').get()!.n).toBe(0)
  })
})
