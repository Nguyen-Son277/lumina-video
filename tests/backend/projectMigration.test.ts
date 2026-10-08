import { expect, test } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../server/db/index'

test('project migration preserves legacy generations and is repeatable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumina-migration-'))
  try {
    const path = join(dir, 'old.db')
    const old = new DatabaseSync(path)
    old.exec(readFileSync('server/db/migrations/001_init.sql', 'utf8'))
    old.exec("CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,applied_at INTEGER NOT NULL)")
    old.prepare('INSERT INTO schema_migrations VALUES (?,?)').run('001_init.sql', 1)
    old.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run('u','legacy@gigone.com','hash','salt',1)
    old.prepare(`INSERT INTO generations(id,user_id,kind,prompt,params_json,snap_provider,snap_base_url,snap_model_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('g','u','image','Old prompt','{}','Provider','https://example.com','model','succeeded',1,1)
    old.close()
    const migrated = openDatabase(path)
    const row = migrated.prepare('SELECT * FROM generations WHERE id=?').get('g')!
    expect(row.prompt).toBe('Old prompt')
    expect(row.project_id).toBeNull()
    expect(row.effective_prompt).toBeNull()
    migrated.close()
    const reopened = openDatabase(path)
    expect(reopened.prepare('SELECT COUNT(*) AS count FROM generations').get()!.count).toBe(1)
    reopened.close()
  } finally { rmSync(dir, {recursive:true,force:true}) }
})
