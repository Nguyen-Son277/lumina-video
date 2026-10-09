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
        db.exec(sql)
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
