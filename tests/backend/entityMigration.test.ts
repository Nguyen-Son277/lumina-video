import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../server/db/index'

const migrationsDir = fileURLToPath(new URL('../../server/db/migrations/', import.meta.url))

/** Bootstrap the actual legacy schema, not a hand-written approximation of it. */
function legacyDatabase(path: string, lastMigration: 24 | 25): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = OFF')
  db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)')
  for (const name of readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort()) {
    if (Number(name.slice(0, 3)) > lastMigration) continue
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

function seedLegacy(db: DatabaseSync) {
  db.prepare('INSERT INTO users (id,email,password_hash,password_salt,created_at) VALUES (?,?,?,?,?)')
    .run('legacy-user', 'legacy@gigone.com', 'synthetic-hash', 'synthetic-salt', 1)
  db.prepare('INSERT INTO projects (id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run('legacy-project', 'legacy-user', 'Legacy project', 1, 1)
  db.prepare('INSERT INTO characters (id,user_id,project_id,name,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run('legacy-character', 'legacy-user', 'legacy-project', 'Legacy character', 1, 1)
  db.prepare('INSERT INTO uploads (id,user_id,relative_path,mime_type,byte_size,created_at) VALUES (?,?,?,?,?,?)')
    .run('legacy-upload', 'legacy-user', 'legacy-user/uploads/synthetic.png', 'image/png', 10, 1)
  db.prepare('INSERT INTO project_items (id,project_id,user_id,kind,name,reference_upload_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('legacy-item', 'legacy-project', 'legacy-user', 'prop', 'Legacy prop', 'legacy-upload', 1, 1)
  db.prepare('INSERT INTO project_locations (id,project_id,name,reference_upload_id,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run('legacy-location', 'legacy-project', 'Legacy location', 'legacy-upload', 1, 1)
  db.prepare('INSERT INTO scenes (id,project_id,title,character_id,location_id,position,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?)')
    .run('legacy-scene', 'legacy-project', 'Legacy scene', 'legacy-character', 'legacy-location', 1, 1)
  db.prepare(`INSERT INTO generations (id,user_id,project_id,scene_id,kind,prompt,snap_provider,snap_base_url,snap_model_id,status,created_at,updated_at)
    VALUES (?,?,?,?,'image','Synthetic legacy result','mock','https://mock.test/v1','mock','succeeded',?,?)`)
    .run('legacy-generation', 'legacy-user', 'legacy-project', 'legacy-scene', 1, 1)
  db.prepare('UPDATE scenes SET selected_generation_id=? WHERE id=?').run('legacy-generation', 'legacy-scene')
  db.prepare('INSERT INTO scene_characters (scene_id,character_id,position) VALUES (?,?,0)').run('legacy-scene', 'legacy-character')
  const graph = JSON.stringify({ schemaVersion: 1, nodes: [
    { id: 'character-node', kind: 'character', x: 0, y: 0, data: { characterId: 'legacy-character' } },
    { id: 'item-node', kind: 'item', x: 0, y: 100, data: { itemId: 'legacy-item' } },
  ], edges: [] })
  db.prepare('INSERT INTO project_canvases (project_id,user_id,graph_json,revision,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run('legacy-project', 'legacy-user', graph, 7, 1, 2)
  for (const [role, column, target] of [
    ['character', 'character_id', 'legacy-character'], ['location', 'location_id', 'legacy-location'],
    ['item', 'item_id', 'legacy-item'], ['scene', 'scene_id', 'legacy-scene'],
    ['upload', 'upload_id', 'legacy-upload'], ['output', 'generation_id', 'legacy-generation'],
  ]) {
    db.prepare(`INSERT INTO project_canvas_links (id,project_id,node_id,role,target_id,${column},created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(`legacy-link-${role}`, 'legacy-project', `${role}-node`, role!, target!, target!, 1)
  }
  db.prepare("INSERT INTO project_canvas_runs (id,project_id,node_id,kind,generation_id,input_stamp,created_at) VALUES (?,?,?,'image',?,?,?)")
    .run('legacy-run', 'legacy-project', 'image-node', 'legacy-generation', 'legacy-stamp', 1)
}

describe('entity migrations preserve a complete legacy Canvas database', () => {
  it.each([24, 25] as const)('upgrades legacy %i through migrations 026–031 with IDs, links and indexes intact', legacyVersion => {
    const dir = mkdtempSync(join(tmpdir(), 'lumina-entity-migration-'))
    const path = join(dir, 'synthetic-legacy.db')
    let db: DatabaseSync | undefined
    try {
      db = legacyDatabase(path, legacyVersion)
      seedLegacy(db)
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      const tables = ['users', 'projects', 'characters', 'uploads', 'project_items', 'project_locations', 'scenes', 'generations', 'scene_characters', 'project_canvases', 'project_canvas_runs']
      const before = Object.fromEntries(tables.map(table => [table, db!.prepare(`SELECT * FROM ${table}`).all()]))
      const links = db.prepare('SELECT * FROM project_canvas_links ORDER BY id').all()
      expect(links).toHaveLength(6)
      expect(db.prepare('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1').get()!.name)
        .toBe(legacyVersion === 24 ? '024_canvas.sql' : '025_unified_trash.sql')
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='library_assets'").get()).toBeUndefined()
      db.close()
      db = openDatabase(path)
      expect(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys).toBe(1)
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      for (const table of tables) {
        const rows = db.prepare(`SELECT * FROM ${table}`).all()
        expect(rows).toHaveLength(before[table]!.length)
        rows.forEach((row, index) => expect(row).toMatchObject(before[table]![index]!))
      }
      expect(db.prepare('SELECT * FROM project_canvas_links ORDER BY id').all())
        .toEqual(links.map(link => ({ ...link, library_asset_id: null })))
      expect(db.prepare("SELECT name FROM schema_migrations WHERE name >= '026_' ORDER BY name").all().map(row => row.name))
        .toEqual(['026_entity_library.sql', '027_prompt_documents.sql', '028_library_canvas_links.sql', '029_temporary_media_grants.sql', '030_logo_postprocess.sql', '031_immutable_media_versions.sql'])
      const indexes = db.prepare('PRAGMA index_list(project_canvas_links)').all()
      expect(indexes).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'idx_project_canvas_links_unique', unique: 1 }),
        expect.objectContaining({ name: 'idx_project_canvas_links_target', unique: 0 }),
        expect.objectContaining({ name: 'idx_project_canvas_library_source', unique: 0 }),
      ]))
      expect(db.prepare('PRAGMA index_info(idx_project_canvas_links_unique)').all().map(row => row.name))
        .toEqual(['project_id', 'node_id', 'role', 'target_id'])
      expect(db.prepare('PRAGMA index_info(idx_project_canvas_links_target)').all().map(row => row.name))
        .toEqual(['character_id', 'location_id', 'item_id', 'scene_id', 'upload_id'])
      expect(db.prepare('PRAGMA index_info(idx_project_canvas_library_source)').all().map(row => row.name)).toEqual(['library_asset_id'])
      db.prepare("INSERT INTO library_assets (id,user_id,kind,name,reference_upload_id,created_at,updated_at) VALUES (?,?,'item',?,?,?,?)")
        .run('new-library-item', 'legacy-user', 'New shared item', 'legacy-upload', 3, 3)
      db.prepare("INSERT INTO project_canvas_links (id,project_id,node_id,role,target_id,library_asset_id,created_at) VALUES (?,?,?,'library',?,?,?)")
        .run('new-library-link', 'legacy-project', 'library-node', 'new-library-item', 'new-library-item', 3)
      expect(db.prepare('SELECT * FROM project_canvas_links WHERE id=?').get('new-library-link'))
        .toMatchObject({ role: 'library', target_id: 'new-library-item', library_asset_id: 'new-library-item' })
      expect(() => db!.prepare("INSERT INTO project_canvas_links (id,project_id,node_id,role,target_id,library_asset_id,created_at) VALUES (?,?,?,'library',?,?,?)")
        .run('duplicate-link', 'legacy-project', 'library-node', 'new-library-item', 'new-library-item', 3)).toThrow(/UNIQUE/)
      expect(() => db!.prepare("INSERT INTO project_canvas_links (id,project_id,node_id,role,target_id,library_asset_id,created_at) VALUES (?,?,?,'library',?,?,?)")
        .run('dangling-link', 'legacy-project', 'missing-node', 'missing-item', 'missing-item', 3)).toThrow(/FOREIGN KEY/)
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally {
      db?.close()
      // Only this explicitly created synthetic temp directory may be removed.
      if (resolve(dir) !== dir || !dir.startsWith(join(tmpdir(), 'lumina-entity-migration-'))) throw new Error('Unexpected test cleanup path')
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
