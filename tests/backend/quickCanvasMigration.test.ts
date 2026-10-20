import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { openDatabase } from '../../server/db/index'
import { readQuickCanvas, syncQuickCanvas } from '../../server/quickCanvas/service'

it('repairs the recorded early 046 schema without losing sessions, canvas or run history', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'quick-canvas-upgrade-')), 'legacy.db')
  const legacy = new DatabaseSync(path)
  legacy.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)')
  const migrations = new URL('../../server/db/migrations/', import.meta.url)
  for (const name of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
    if (Number(name.slice(0, 3)) > 46) continue
    let sql = readFileSync(new URL(name, migrations), 'utf8')
    if (name.startsWith('046_')) sql = sql
      .replace('  asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,\n', '')
      .replace("  conflicts_json TEXT NOT NULL DEFAULT '[]',\n", '')
    legacy.exec(sql)
    legacy.prepare('INSERT INTO schema_migrations VALUES (?,1)').run(name)
  }
  legacy.prepare("INSERT INTO users(id,email,password_hash,password_salt,created_at) VALUES ('owner','repair@example.test','hash','salt',1)").run()
  legacy.prepare("INSERT INTO quick_sessions(id,user_id,title,created_at,updated_at) VALUES ('session','owner','Existing session',1,1)").run()
  const graph = JSON.stringify({ schemaVersion: 1, nodes: [{ id: 'note', kind: 'note', x: 10, y: 20, data: { text: 'Keep me' } }], edges: [] })
  legacy.prepare("INSERT INTO quick_canvases VALUES ('session','owner',?,7,1,1)").run(graph)
  legacy.prepare("INSERT INTO quick_canvas_runs(id,session_id,node_id,kind,input_stamp,created_at) VALUES ('run','session','note','image','old-stamp',1)").run()
  legacy.prepare("INSERT INTO quick_canvas_sources(session_id,source_key,node_id,snapshot_json) VALUES ('session','draft-note','note',?)").run(JSON.stringify({ id: 'note', kind: 'note', x: 10, y: 20, data: { text: 'Keep me' } }))
  // Simulate a watcher that observed the SQL marker before the runner hook.
  legacy.prepare("INSERT INTO schema_migrations VALUES ('047_quick_canvas_schema_repair.sql',1)").run()
  legacy.close()

  const db = openDatabase(path)
  try {
    const canvas = readQuickCanvas(db, 'owner', 'session')
    expect(canvas.graph).toEqual(JSON.parse(graph))
    expect(canvas.revision).toBe(7)
    expect(canvas.runs).toMatchObject([{ id: 'run', assetId: null }])
    expect(canvas.provenance).toMatchObject([{ nodeId: 'note', conflicts: [] }])
    expect(syncQuickCanvas(db, 'owner', 'session', { baseRevision: 7 }).graph).toEqual(JSON.parse(graph))
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.prepare("SELECT name FROM schema_migrations WHERE name='047_quick_canvas_schema_repair.sql'").get()).toBeTruthy()
  } finally { db.close() }
  // Reopening must not replay ALTER TABLE or lose the imported graph.
  const reopened = openDatabase(path)
  try { expect(readQuickCanvas(reopened, 'owner', 'session').revision).toBe(7) } finally { reopened.close() }
})

it('accepts the complete 046 schema on fresh databases', () => {
  const db = openDatabase(':memory:')
  try {
    expect(db.prepare('PRAGMA table_info(quick_canvas_runs)').all().filter(row => row.name === 'asset_id')).toHaveLength(1)
    expect(db.prepare('PRAGMA table_info(quick_canvas_sources)').all().filter(row => row.name === 'conflicts_json')).toHaveLength(1)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  } finally { db.close() }
})
