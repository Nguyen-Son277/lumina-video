import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openDatabase } from '../../server/db/index'

/**
 * Lỗi gốc của batch timeline bị kẹt: hai cột `error_message_key`/`error_message_params`
 * của `plan_image_batch_items` được thêm vào migration 015 SAU khi migration đó đã
 * được đánh dấu áp dụng trên database đang chạy. Bộ chạy migration không lưu checksum,
 * nên các database đó thiếu cột, mọi lần ghi trạng thái item ném "no such column", và
 * batch nằm mãi ở `running` khiến không tạo được batch mới.
 *
 * Migration 018 dựng lại bảng để sửa; test này mô phỏng đúng database "đã áp dụng 015
 * nhưng thiếu cột" và xác nhận 018 chạy được, giữ dữ liệu và không vi phạm khoá ngoại.
 */

const dirs: string[] = []

function legacyDatabase(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lumina-migration-test-'))
  dirs.push(dir)
  const path = join(dir, 'legacy.db')

  const raw = new DatabaseSync(path)
  raw.exec(`
    CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);

    CREATE TABLE plan_image_batches (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'running'
    );

    -- Đúng hình dạng trước khi hai cột metadata lỗi được thêm vào migration 015.
    CREATE TABLE plan_image_batch_items (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES plan_image_batches(id) ON DELETE CASCADE,
      frame_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      generation_id TEXT,
      error TEXT,
      snapshot_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_plan_image_batch_items_batch ON plan_image_batch_items(batch_id, position ASC);

    INSERT INTO plan_image_batches (id, status) VALUES ('batch-legacy', 'running');
    INSERT INTO plan_image_batch_items
      (id, batch_id, frame_id, position, status, error, snapshot_json, created_at, updated_at)
    VALUES ('item-legacy', 'batch-legacy', 'frame-1', 0, 'pending', 'lỗi cũ', '{"title":"Frame 1"}', 1, 1);
  `)

  // Mọi migration đã được áp dụng trước 018, giống database thật đang chạy.
  const migrationsDir = join(process.cwd(), 'server', 'db', 'migrations')
  const applied = readdirSync(migrationsDir).filter((file) => file < '018_')
  // 020 chỉ sửa bảng `users` — fixture legacy này cố ý không có bảng đó, nên đánh
  // dấu đã áp dụng. 018 và 019 vẫn chạy thật vì chúng tác động bảng item đang kiểm.
  applied.push('020_account_approval.sql')
  const insert = raw.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
  for (const name of applied) insert.run(name, Date.now())
  raw.close()

  return path
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('Migration 018 sửa cột metadata lỗi của item batch', () => {
  it('thêm hai cột còn thiếu, giữ dữ liệu item cũ và khoá ngoại hợp lệ', () => {
    const path = legacyDatabase()
    const db = openDatabase(path)
    try {
      const columns = (db.prepare('PRAGMA table_info(plan_image_batch_items)').all() as Array<{ name: string }>)
        .map((column) => column.name)
      expect(columns).toContain('error_message_key')
      expect(columns).toContain('error_message_params')
      // Cột cũ vẫn còn nguyên.
      for (const name of ['id', 'batch_id', 'frame_id', 'position', 'status', 'generation_id', 'error', 'snapshot_json', 'created_at', 'updated_at']) {
        expect(columns).toContain(name)
      }

      // Dữ liệu cũ được giữ nguyên, cột mới rỗng.
      const row = db
        .prepare('SELECT id, status, error, error_message_key, snapshot_json FROM plan_image_batch_items WHERE id = ?')
        .get('item-legacy') as Record<string, unknown>
      expect(row).toMatchObject({ id: 'item-legacy', status: 'pending', error: 'lỗi cũ' })
      expect(row.error_message_key).toBeNull()
      expect(row.snapshot_json).toBe('{"title":"Frame 1"}')
      expect(db.prepare('SELECT retry_count FROM plan_image_batch_items WHERE id = ?').get('item-legacy')?.retry_count).toBe(0)

      // Ghi trạng thái item (đường gây "no such column" trước đây) phải chạy được.
      db.prepare(
        `UPDATE plan_image_batch_items
            SET status = 'error', error_message_key = 'planner.batch_stalled', updated_at = ?
          WHERE id = ?`,
      ).run(Date.now(), 'item-legacy')
      expect(
        (db.prepare('SELECT error_message_key AS key FROM plan_image_batch_items WHERE id = ?').get('item-legacy') as { key: string }).key,
      ).toBe('planner.batch_stalled')

      // Index cũ được tạo lại và không có vi phạm khoá ngoại sau khi dựng lại bảng.
      const indexes = (db.prepare('PRAGMA index_list(plan_image_batch_items)').all() as Array<{ name: string }>)
        .map((index) => index.name)
      expect(indexes).toContain('idx_plan_image_batch_items_batch')
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0)
      expect(
        (db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get('018_batch_item_error_metadata.sql') as { name: string } | undefined)?.name,
      ).toBe('018_batch_item_error_metadata.sql')
    } finally {
      db.close()
    }
  })

  it('database mới chạy đủ migration vẫn có hai cột và bảng dùng được', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lumina-migration-fresh-'))
    dirs.push(dir)
    const db = openDatabase(join(dir, 'fresh.db'))
    try {
      const columns = (db.prepare('PRAGMA table_info(plan_image_batch_items)').all() as Array<{ name: string }>)
        .map((column) => column.name)
      expect(columns).toContain('error_message_key')
      expect(columns).toContain('error_message_params')
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0)
    } finally {
      db.close()
    }
  })
})
