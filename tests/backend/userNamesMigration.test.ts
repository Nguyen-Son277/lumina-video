import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../server/db/index'

const migrationsDir = fileURLToPath(new URL('../../server/db/migrations/', import.meta.url))

describe('user name migration', () => {
  it('backfills legacy email local-parts and preserves explicit names across reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lumina-user-names-migration-'))
    const path = join(dir, 'legacy-users.db')
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(path)
      db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)')
      for (const name of readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort()) {
        if (Number(name.slice(0, 3)) > 44) continue
        db.exec('BEGIN')
        try {
          db.exec(readFileSync(join(migrationsDir, name), 'utf8'))
          db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, 1)
          db.exec('COMMIT')
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      }
      db.prepare('INSERT INTO users (id,email,password_hash,password_salt,created_at) VALUES (?,?,?,?,?)')
        .run('legacy-user', 'legacy.person@gigone.com', 'hash', 'salt', 1)
      db.close()
      db = openDatabase(path)
      expect(db.prepare('SELECT name FROM users WHERE id=?').get('legacy-user')).toMatchObject({ name: 'legacy.person' })
      db.prepare('UPDATE users SET name=? WHERE id=?').run('Chosen Display Name', 'legacy-user')
      db.close()
      db = openDatabase(path)
      expect(db.prepare('SELECT name FROM users WHERE id=?').get('legacy-user')).toMatchObject({ name: 'Chosen Display Name' })
      expect(db.prepare('SELECT name FROM schema_migrations WHERE name=?').get('045_user_names.sql')).toBeTruthy()
    } finally {
      db?.close()
      if (resolve(dir) !== dir || !dir.startsWith(join(tmpdir(), 'lumina-user-names-migration-'))) throw new Error('Unexpected test cleanup path')
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
