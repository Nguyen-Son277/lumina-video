import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openDatabase } from '../../server/db/index'

it.each([true, false])('033 repairs old recorded 032=%s and preserves rows, references, index and trigger', oldVariant => {
  const dir = mkdtempSync(join(tmpdir(), 'hf-repair-'))
  try {
    const path = join(dir, 'fixture.db')
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE schema_migrations(name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)')
    for (const file of readdirSync('server/db/migrations').filter(f => f.endsWith('.sql') && f < '033').sort()) {
      const sql = file.startsWith('032') && oldVariant ? `
        ALTER TABLE provider_connections ADD COLUMN auth_scheme TEXT NOT NULL DEFAULT 'bearer';
        ALTER TABLE generations ADD COLUMN snap_auth_scheme TEXT NOT NULL DEFAULT 'bearer';
        ALTER TABLE generations ADD COLUMN higgsfield_json TEXT;
        ALTER TABLE generations ADD COLUMN provider_status TEXT;
        ALTER TABLE generations ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;
      ` : readFileSync(join('server/db/migrations', file), 'utf8')
      db.exec(sql)
      db.prepare('INSERT INTO schema_migrations VALUES (?,1)').run(file)
    }
    db.prepare("INSERT INTO users(id,email,password_hash,password_salt,created_at) VALUES ('u','repair@test.test','hash','salt',1)").run()
    db.prepare("INSERT INTO provider_connections(id,user_id,name,base_url,api_key_ciphertext,api_key_iv,api_key_tag,key_hint,created_at,updated_at,auth_scheme) VALUES ('p','u','HF','https://example.com',?,?,?,'hint',1,1,'higgsfield')").run(Buffer.from('cipher'),Buffer.from('iv'),Buffer.from('tag'))
    db.prepare("INSERT INTO models(id,user_id,provider_id,model_id,display_name,kind,created_at,updated_at,price_unit,video_api_style) VALUES ('m','u','p','agnes-video-2.5','Existing','video',1,1,7.5,'agnes')").run()
    db.prepare("INSERT INTO generations(id,user_id,model_pk,provider_id,kind,prompt,snap_provider,snap_base_url,snap_model_id,status,provider_job_id,created_at,updated_at,snap_video_style) VALUES ('g','u','m','p','video','p','HF','https://example.com','agnes-video-2.5','running','job-old',1,1,'agnes')").run()
    db.exec('CREATE INDEX custom_generation_idx ON generations(provider_job_id)')
    db.exec("CREATE TRIGGER keep_prompt BEFORE UPDATE OF prompt ON generations WHEN NEW.prompt = 'blocked' BEGIN SELECT RAISE(ABORT,'blocked prompt'); END")
    const beforeModel = db.prepare("SELECT * FROM models WHERE id='m'").get()
    const beforeJob = db.prepare("SELECT * FROM generations WHERE id='g'").get()
    db.close()
    const repaired = openDatabase(path)
    expect(repaired.prepare("SELECT * FROM models WHERE id='m'").get()).toEqual({ ...beforeModel, image_size: null, image_reference_support: 'unknown', image_reference_transport: 'provider_default', image_max_references: null })
    expect(repaired.prepare("SELECT * FROM generations WHERE id='g'").get()).toEqual({ ...beforeJob, snap_image_reference_transport: 'provider_default', snap_image_max_references: null, snap_video_reference_style: null })
    expect(repaired.prepare("SELECT api_key_ciphertext FROM provider_connections WHERE id='p'").get()?.api_key_ciphertext).toEqual(new Uint8Array(Buffer.from('cipher')))
    expect(repaired.prepare("SELECT count(*) n FROM models WHERE provider_id='p' AND model_id='bytedance/seedance-2.5' AND video_api_style='higgsfield'").get()?.n).toBe(1)
    repaired.prepare("UPDATE generations SET snap_video_style='higgsfield' WHERE id='g'").run()
    expect(() => repaired.prepare("UPDATE generations SET prompt='blocked' WHERE id='g'").run()).toThrow('blocked prompt')
    expect(repaired.prepare("SELECT 1 FROM sqlite_master WHERE name='custom_generation_idx'").get()).toBeTruthy()
    expect(repaired.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    repaired.close()
    const reopened = openDatabase(path)
    expect(reopened.prepare("SELECT count(*) n FROM models WHERE provider_id='p'").get()?.n).toBe(2)
    expect(reopened.prepare("SELECT count(*) n FROM schema_migrations WHERE name='033_higgsfield_schema_repair.sql'").get()?.n).toBe(1)
    reopened.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
