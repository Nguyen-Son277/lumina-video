import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openDatabase } from '../../server/db/index'

it('migration 023 backfills exact model ids and preserves legacy generation routing on reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-migration-'))
  try {
    const path = join(dir, 'fixture.db')
    const old = new DatabaseSync(path)
    old.exec('CREATE TABLE schema_migrations(name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)')
    for (const file of readdirSync('server/db/migrations').filter(f => f.endsWith('.sql') && f < '023').sort()) {
      old.exec(readFileSync(join('server/db/migrations', file), 'utf8'))
      old.prepare('INSERT INTO schema_migrations VALUES (?, 1)').run(file)
    }
    old.prepare('INSERT INTO users(id,email,password_hash,password_salt,created_at) VALUES (?,?,?,?,?)').run('u', 'migration@gigone.com', 'hash', 'salt', 1)
    old.prepare('INSERT INTO provider_connections(id,user_id,name,base_url,api_key_ciphertext,api_key_iv,api_key_tag,key_hint,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run('p', 'u', 'P', 'https://example.com/v1', Buffer.from('x'), Buffer.from('x'), Buffer.from('x'), 'hint', 1, 1)
    for (const [i, model] of ['agnes-video-2.5', 'agnes-video-2.5-flash', 'agnes-video-2.5-other', 'openai-video'].entries()) {
      old.prepare('INSERT INTO models(id,user_id,provider_id,model_id,display_name,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(`m${i}`, 'u', 'p', model, model, 'video', 1, 1)
    }
    old.prepare("INSERT INTO generations(id,user_id,model_pk,provider_id,kind,prompt,params_json,snap_provider,snap_base_url,snap_model_id,status,provider_job_id,created_at,updated_at) VALUES ('g','u','m0','p','video','prompt','{}','P','https://example.com/v1','agnes-video-2.5','running','legacy-job',1,1)").run()
    old.close()
    const db = openDatabase(path)
    expect(db.prepare('SELECT video_api_style FROM models ORDER BY id').all().map(r => r.video_api_style)).toEqual(['agnes', 'agnes', 'openai', 'openai'])
    const generation = db.prepare('SELECT * FROM generations WHERE id = ?').get('g')!
    expect(generation.snap_video_style).toBe('openai')
    expect(generation.provider_result_url).toBeNull()
    expect(generation.provider_job_id).toBe('legacy-job')
    expect(generation.model_pk).toBe('m0')
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    db.close()
    const reopened = openDatabase(path)
    expect(reopened.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE name = ?').get('023_video_api_style.sql')!.n).toBe(1)
    reopened.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
