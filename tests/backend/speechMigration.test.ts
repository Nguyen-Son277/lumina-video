import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { openDatabase } from '../../server/db/index'

it('upgrades the model kind without losing columns, custom indexes or existing foreign keys', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lumina-speech-migration-'))
  let db: DatabaseSync | undefined
  try {
    const path = join(directory, 'legacy.db')
    db = new DatabaseSync(path)
    db.exec('CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,applied_at INTEGER NOT NULL)')
    const migrations = new URL('../../server/db/migrations/', import.meta.url)
    for (const name of readdirSync(migrations).filter(name => name.endsWith('.sql') && name < '053_').sort()) {
      db.exec(readFileSync(new URL(name, migrations), 'utf8'))
      db.prepare('INSERT INTO schema_migrations VALUES (?,1)').run(name)
    }
    db.exec("ALTER TABLE models ADD COLUMN custom_metadata TEXT NOT NULL DEFAULT 'keep me'")
    db.exec('CREATE INDEX model_custom_index ON models(custom_metadata)')
    db.exec("INSERT INTO users(id,email,password_hash,password_salt,created_at) VALUES('owner','speech-migration@test.invalid','hash','salt',1)")
    db.exec("INSERT INTO provider_connections(id,user_id,name,base_url,api_key_ciphertext,api_key_iv,api_key_tag,created_at,updated_at) VALUES('provider','owner','Old provider','https://example.invalid/v1',X'01',X'02',X'03',1,1)")
    db.exec("INSERT INTO models(id,user_id,provider_id,model_id,display_name,kind,created_at,updated_at,price_unit,image_size) VALUES('model','owner','provider','old-image','Image model','image',1,1,0.5,'1024x1024')")
    db.exec("INSERT INTO generations(id,user_id,model_pk,provider_id,kind,prompt,snap_provider,snap_base_url,snap_model_id,status,created_at,updated_at) VALUES('generation','owner','model','provider','image','original prompt','Old provider','https://example.invalid/v1','old-image','succeeded',1,1)")
    const original = db.prepare("SELECT * FROM models WHERE id='model'").get()
    db.close()
    db = openDatabase(path)
    expect(db.prepare("SELECT * FROM models WHERE id='model'").get()).toEqual(original)
    expect(db.prepare("SELECT model_pk FROM generations WHERE id='generation'").get()!.model_pk).toBe('model')
    expect(db.prepare('PRAGMA index_list(models)').all().map(row => row.name)).toContain('model_custom_index')
    expect(() => db!.exec("INSERT INTO models(id,user_id,provider_id,model_id,display_name,kind,created_at,updated_at) VALUES('tts','owner','provider','edge-tts/vi-VN-NamMinhNeural','Nam Minh','tts',1,1)")).not.toThrow()
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    db.close()
    db = openDatabase(path)
    expect(db.prepare("SELECT kind FROM models WHERE id='tts'").get()!.kind).toBe('tts')
    expect(db.prepare("SELECT custom_metadata FROM models WHERE id='model'").get()!.custom_metadata).toBe('keep me')
  } finally {
    db?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
