import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../server/db/index'

const migrationsDir = fileURLToPath(new URL('../../server/db/migrations/', import.meta.url))

/** Use the actual deployed 040 schema and migration ledger before exercising the runner. */
function databaseAt040(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = OFF')
  db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)')
  for (const name of readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort()) {
    if (Number(name.slice(0, 3)) > 40) continue
    db.exec('BEGIN')
    try {
      db.exec(readFileSync(join(migrationsDir, name), 'utf8'))
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, 1)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      db.close()
      throw error
    }
  }
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

function seed040(db: DatabaseSync) {
  db.prepare('INSERT INTO users (id,email,password_hash,password_salt,created_at) VALUES (?,?,?,?,?)')
    .run('migration-owner', 'location-migration@example.test', 'synthetic-hash', 'synthetic-salt', 1)
  db.prepare('INSERT INTO projects (id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run('migration-project', 'migration-owner', 'Legacy canvas', 1, 2)
  db.prepare('INSERT INTO uploads (id,user_id,relative_path,mime_type,byte_size,created_at) VALUES (?,?,?,?,?,?)')
    .run('migration-upload', 'migration-owner', 'migration-owner/uploads/fixture.png', 'image/png', 10, 1)
  for (const [id, kind, deletedAt] of [
    ['item-live', 'item', null], ['logo-live', 'logo', null],
    ['item-deleted', 'item', 100], ['logo-deleted', 'logo', 101],
  ] as const) {
    db.prepare(`INSERT INTO library_assets
      (id,user_id,kind,name,description,continuity_notes,reference_upload_id,revision,created_at,updated_at,deleted_at,purge_after)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, 'migration-owner', kind, `Original ${id}`, `Description ${id}`, `Continuity ${id}`,
        'migration-upload', 7, 3, 9, deletedAt, deletedAt === null ? null : deletedAt + 1000)
    db.prepare(`INSERT INTO entity_handles (id,user_id,kind,entity_id,handle,handle_key,active,created_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(`handle-${id}`, 'migration-owner', kind, id, id, id, deletedAt === null ? 1 : 0, 4)
    // Include links to retained deleted rows: migration must not cascade away their identity.
    db.prepare(`INSERT INTO project_canvas_links
      (id,project_id,node_id,role,target_id,library_asset_id,created_at) VALUES (?,?,?,'library',?,?,?)`)
      .run(`link-${id}`, 'migration-project', `node-${id}`, id, id, 5)
  }
  // A purged entity deliberately has no library row: its inactive handle must survive forever.
  db.prepare(`INSERT INTO entity_handles (id,user_id,kind,entity_id,handle,handle_key,active,created_at)
    VALUES ('purged-handle','migration-owner','item','purged-item','Old handle','item-live',0,6)`).run()
  db.prepare(`INSERT INTO generations
    (id,user_id,project_id,kind,prompt,snap_provider,snap_base_url,snap_model_id,status,created_at,updated_at)
    VALUES ('legacy-image','migration-owner','migration-project','image','Old image','mock','https://mock.test/v1','mock','succeeded',1,2)`).run()
}

function assertIndexes(db: DatabaseSync) {
  const indexes = {
    library_assets: [
      ['idx_library_assets_user', 0, ['user_id', 'kind', 'deleted_at', 'updated_at', 'id']],
      ['idx_library_assets_purge', 0, ['deleted_at', 'purge_after']],
      ['idx_library_assets_reference', 0, ['reference_upload_id']],
      ['idx_library_assets_source', 1, ['user_id', 'source_kind', 'source_scope_id', 'source_entity_id']],
    ],
    entity_handles: [
      ['idx_entity_handles_active', 1, ['user_id', 'handle_key']],
      ['idx_entity_handles_user', 0, ['user_id', 'active', 'kind', 'entity_id']],
    ],
    project_canvas_links: [
      ['idx_project_canvas_links_unique', 1, ['project_id', 'node_id', 'role', 'target_id']],
      ['idx_project_canvas_links_target', 0, ['character_id', 'location_id', 'item_id', 'scene_id', 'upload_id']],
      ['idx_project_canvas_library_source', 0, ['library_asset_id']],
    ],
    generations: [
      ['generations_library_publication_recovery', 0, ['library_publish_status', 'updated_at']],
    ],
  } as const
  for (const [table, expected] of Object.entries(indexes)) {
    const actual = db.prepare(`PRAGMA index_list(${table})`).all()
    for (const [name, unique, columns] of expected) {
      expect(actual).toContainEqual(expect.objectContaining({ name, unique }))
      expect(db.prepare(`PRAGMA index_info(${name})`).all().map(row => row.name)).toEqual(columns)
    }
  }
  for (const [table, name] of [
    ['library_assets', 'idx_library_assets_source'], ['entity_handles', 'idx_entity_handles_active'],
    ['generations', 'generations_library_publication_recovery'],
  ]) {
    expect(db.prepare(`PRAGMA index_list(${table})`).all()).toContainEqual(expect.objectContaining({ name, partial: 1 }))
  }
  expect(db.prepare('PRAGMA index_xinfo(idx_library_assets_user)').all())
    .toContainEqual(expect.objectContaining({ name: 'updated_at', desc: 1 }))
}

describe('location library migration from deployed 040', () => {
  it('upgrades through 041/042 preserving item/logo identities, trash, tombstones and real Canvas RESTRICT FKs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lumina-location-migration-'))
    const path = join(dir, 'legacy040.db')
    let db: DatabaseSync | undefined
    try {
      db = databaseAt040(path)
      seed040(db)
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(db.prepare('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1').get()!.name)
        .toBe('040_video_reference_style.sql')
      const assets = db.prepare('SELECT * FROM library_assets ORDER BY id').all()
      const handles = db.prepare('SELECT * FROM entity_handles ORDER BY id').all()
      const links = db.prepare('SELECT * FROM project_canvas_links ORDER BY id').all()
      const generation = db.prepare("SELECT * FROM generations WHERE id='legacy-image'").get()!
      db.close()
      db = openDatabase(path)
      expect(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys).toBe(1)
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(db.prepare("SELECT name FROM schema_migrations WHERE name IN ('041_location_library.sql','042_image_publication.sql') ORDER BY name").all().map(row => row.name))
        .toEqual(['041_location_library.sql', '042_image_publication.sql'])
      const upgraded = db.prepare('SELECT * FROM library_assets ORDER BY id').all()
      expect(upgraded).toHaveLength(4)
      upgraded.forEach((row, index) => {
        expect(row).toMatchObject(assets[index]!)
        expect(row).toMatchObject({ reference_views_json: '[]', source_kind: null, source_scope_id: null, source_entity_id: null, source_deleted: 0, source_revision: null })
      })
      expect(db.prepare('SELECT * FROM entity_handles ORDER BY id').all()).toEqual(handles)
      expect(db.prepare('SELECT * FROM project_canvas_links ORDER BY id').all()).toEqual(links)
      expect(db.prepare("SELECT * FROM generations WHERE id='legacy-image'").get())
        .toMatchObject({ ...generation, image_purpose_json: null, library_publish_status: null, library_publish_error: null, library_publications_json: null })
      assertIndexes(db)
      expect(db.prepare('PRAGMA foreign_key_list(project_canvas_links)').all()).toContainEqual(expect.objectContaining({
        table: 'library_assets', from: 'library_asset_id', to: 'id', on_delete: 'RESTRICT',
      }))
      // Test actual enforcement, not just sqlite_master text or pragma metadata.
      for (const asset of assets) {
        expect(() => db!.prepare('DELETE FROM library_assets WHERE id=?').run(asset.id!)).toThrow(/FOREIGN KEY/)
      }
      expect(db.prepare('SELECT * FROM project_canvas_links ORDER BY id').all()).toEqual(links)
      expect(() => db!.prepare(`INSERT INTO project_canvas_links
        (id,project_id,node_id,role,target_id,library_asset_id,created_at)
        VALUES ('dangling-link','migration-project','missing-node','library','missing','missing',10)`).run()).toThrow(/FOREIGN KEY/)
      expect(() => db!.prepare(`INSERT INTO project_canvas_links
        (id,project_id,node_id,role,target_id,library_asset_id,created_at)
        VALUES ('duplicate-link','migration-project','node-item-live','library','item-live','item-live',10)`).run()).toThrow(/UNIQUE/)
      expect(() => db!.prepare(`INSERT INTO entity_handles (id,user_id,kind,entity_id,handle,handle_key,active,created_at)
        VALUES ('duplicate-active','migration-owner','logo','other-logo','Duplicate','item-live',1,10)`).run()).toThrow(/UNIQUE/)
      // New location kind is admitted in both rebuilt tables without disturbing tombstones.
      db.prepare(`INSERT INTO library_assets (id,user_id,kind,name,source_kind,source_scope_id,source_entity_id,created_at,updated_at)
        VALUES ('new-location','migration-owner','location','Shared location','project','migration-project','origin',10,10)`).run()
      db.prepare(`INSERT INTO entity_handles (id,user_id,kind,entity_id,handle,handle_key,active,created_at)
        VALUES ('location-handle','migration-owner','location','new-location','Location','location',1,10)`).run()
      expect(() => db!.prepare(`INSERT INTO library_assets (id,user_id,kind,name,source_kind,source_scope_id,source_entity_id,created_at,updated_at)
        VALUES ('duplicate-source','migration-owner','location','Duplicate','project','migration-project','origin',10,10)`).run()).toThrow(/UNIQUE/)
      // Once a real link is removed RESTRICT no longer prevents the hard delete.
      db.prepare("DELETE FROM project_canvas_links WHERE library_asset_id='item-deleted'").run()
      db.prepare("DELETE FROM library_assets WHERE id='item-deleted'").run()
      expect(db.prepare("SELECT * FROM entity_handles WHERE id='handle-item-deleted'").get()).toMatchObject({ entity_id: 'item-deleted', active: 0 })
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      const ledger = db.prepare('SELECT * FROM schema_migrations ORDER BY name').all()
      db.close()
      db = openDatabase(path)
      expect(db.prepare('SELECT * FROM schema_migrations ORDER BY name').all()).toEqual(ledger)
      expect(db.prepare("SELECT * FROM entity_handles WHERE id='purged-handle'").get()).toMatchObject({ entity_id: 'purged-item', active: 0 })
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      assertIndexes(db)
    } finally {
      db?.close()
      if (resolve(dir) !== dir || !dir.startsWith(join(tmpdir(), 'lumina-location-migration-'))) throw new Error('Unexpected test cleanup path')
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
