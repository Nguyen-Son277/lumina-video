import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { openDatabase } from '../../server/db/index'

it('preserves existing export IDs, specs, metadata and files while allowing exactly one project or quick session owner', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lumina-export-migration-'))
  let db: DatabaseSync | undefined
  try {
    const path = join(directory, 'legacy.db')
    db = new DatabaseSync(path)
    db.exec('CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,applied_at INTEGER NOT NULL)')
    const migrations = new URL('../../server/db/migrations/', import.meta.url)
    for (const name of readdirSync(migrations).filter(name => name.endsWith('.sql') && name < '052_').sort()) {
      db.exec(readFileSync(new URL(name, migrations), 'utf8'))
      db.prepare('INSERT INTO schema_migrations VALUES (?,1)').run(name)
    }
    db.prepare("INSERT INTO users(id,email,password_hash,password_salt,created_at) VALUES ('owner','migration@test.invalid','hash','salt',1)").run()
    db.prepare("INSERT INTO projects(id,user_id,name,created_at,updated_at) VALUES ('project','owner','Legacy project',1,1)").run()
    db.prepare("INSERT INTO quick_sessions(id,user_id,title,created_at,updated_at) VALUES ('session','owner','Quick session',1,1)").run()
    const relativePath = 'owner/exports/legacy-export/video.mp4'
    const original = Buffer.from('existing export bytes')
    const mediaPath = join(directory, 'existing-video.mp4')
    writeFileSync(mediaPath, original)
    db.prepare(`INSERT INTO exports(id,user_id,project_id,status,spec_json,relative_path,mime_type,byte_size,progress,created_at,updated_at,completed_at)
      VALUES ('legacy-export','owner','project','succeeded',?,?, 'video/mp4',?,100,1,2,3)`)
      .run(JSON.stringify({ items: [{ sceneId: 'scene', generationId: 'generation', assetId: 'asset' }] }), relativePath, original.length)
    const before = db.prepare('SELECT * FROM exports WHERE id=?').get('legacy-export')!
    db.close()
    db = openDatabase(path)
    expect(db.prepare('SELECT * FROM exports WHERE id=?').get('legacy-export')).toEqual({ ...before, quick_session_id: null, speech_job_id: null, stage: 'succeeded' })
    expect(readFileSync(mediaPath)).toEqual(original)
    const insert = db.prepare("INSERT INTO exports(id,user_id,project_id,quick_session_id,spec_json,created_at,updated_at) VALUES (?,'owner',?,?,'{}',1,1)")
    expect(() => insert.run('neither', null, null)).toThrow(/CHECK/)
    expect(() => insert.run('both', 'project', 'session')).toThrow(/CHECK/)
    expect(() => insert.run('quick', null, 'session')).not.toThrow()
    expect(() => insert.run('project-new', 'project', null)).not.toThrow()
    expect(db.prepare('PRAGMA index_list(exports)').all().map(row => row.name)).toEqual(expect.arrayContaining(['idx_exports_user', 'idx_exports_project', 'idx_exports_quick_session']))
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    db.close()
    db = openDatabase(path)
    expect(db.prepare('SELECT relative_path FROM exports WHERE id=?').get('legacy-export')!.relative_path).toBe(relativePath)
    expect(readFileSync(mediaPath)).toEqual(original)
  } finally {
    db?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
