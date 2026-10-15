import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations')

export type Database = DatabaseSync

/**
 * Mở database và áp dụng migration còn thiếu.
 * Dùng node:sqlite builtin nên không cần biên dịch native module.
 */
export function openDatabase(databasePath: string): Database {
  const absolute = databasePath === ':memory:' ? ':memory:' : resolve(databasePath)
  if (absolute !== ':memory:') {
    mkdirSync(dirname(absolute), { recursive: true })
  }

  const db = new DatabaseSync(absolute)
  // WAL cho phép đọc trong khi worker đang ghi; foreign_keys để cascade hoạt động.
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  if (absolute !== ':memory:') {
    db.exec('PRAGMA synchronous = NORMAL')
  }

  applyMigrations(db)
  return db
}

/** Repair the early, already-recorded 032 variant without rewriting migration history.
 * Reuse actual CREATE SQL so every existing column, FK and constraint survives.
 * Called only with foreign keys disabled and inside the migration transaction.
 */
function repairHiggsfieldChecks(db: Database): void {
  for (const [table, column] of [['models', 'video_api_style'], ['generations', 'snap_video_style']] as const) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined
    if (!row) throw new Error(`Missing table for Higgsfield repair: ${table}`)
    const check = new RegExp(`CHECK\\s*\\(\\s*["\\x60\\[]?${column}["\\x60\\]]?\\s+IN\\s*\\(([^)]*)\\)\\s*\\)`, 'i')
    const match = check.exec(row.sql)
    if (!match) throw new Error(`Missing routing CHECK for ${table}`)
    if (/'higgsfield'/i.test(match[1]!)) continue
    if (!/'openai'/i.test(match[1]!) || !/'agnes'/i.test(match[1]!)) throw new Error(`Unexpected routing CHECK for ${table}`)
    const temporary = `${table}_hf_repair`
    const objects = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL").all(table) as Array<{ sql: string }>
    const columns = (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(r => `"${r.name.replaceAll('"', '""')}"`).join(',')
    const create = row.sql.replace(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)/i, `CREATE TABLE "${temporary}"`)
      .replace(check, `CHECK (${column} IN (${match[1]}, 'higgsfield'))`)
    if (create === row.sql) throw new Error(`Could not rebuild ${table}`)
    db.exec(create)
    db.exec(`INSERT INTO "${temporary}" (${columns}) SELECT ${columns} FROM "${table}"`)
    db.exec(`DROP TABLE "${table}"`)
    db.exec(`ALTER TABLE "${temporary}" RENAME TO "${table}"`)
    for (const object of objects) db.exec(object.sql)
  }
}

function applyMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `)

  const applied = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  )

  const pending = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .filter((file) => !applied.has(file))

  if (pending.length === 0) return

  // Migration có thể dựng lại bảng bị khoá ngoại trỏ tới (ví dụ đổi CHECK của
  // `models`). Với `foreign_keys = ON`, `DROP TABLE` sẽ chạy ON DELETE SET NULL
  // và xoá liên kết của các bảng tham chiếu, nên phải tắt kiểm tra khoá ngoại
  // trong lúc chạy DDL. SQLite chỉ cho đổi pragma này NGOÀI transaction.
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    for (const file of pending) {
      const sql = readFileSync(join(migrationsDir, file), 'utf8')

      db.exec('BEGIN')
      try {
        if (file === '033_higgsfield_schema_repair.sql') repairHiggsfieldChecks(db)
        db.exec(sql)
        if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Migration would leave invalid foreign keys')
        db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(
          file,
          Date.now(),
        )
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw new Error(`Migration ${file} thất bại: ${(error as Error).message}`)
      }
    }

    // Bật lại khoá ngoại chỉ an toàn khi dữ liệu sau migration vẫn nhất quán.
    const violations = db.prepare('PRAGMA foreign_key_check').all()
    if (violations.length > 0) {
      throw new Error(
        `Migration để lại ${violations.length} vi phạm khoá ngoại. Kiểm tra foreign_key_check trước khi chạy tiếp.`,
      )
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
}
