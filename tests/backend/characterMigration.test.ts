import { expect, test } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../server/db/index'

const migrations = [
  '001_init.sql',
  '002_projects.sql',
  '003_character_reference.sql',
]

/**
 * Migration 008 dựng lại bảng characters để nhân vật có thể không thuộc dự án.
 * Bài test này dựng một database ở đúng trạng thái trước migration đó, có dự án,
 * nhân vật và cảnh gắn nhân vật, rồi kiểm tra dữ liệu và liên kết còn nguyên.
 */
test('shared-character migration keeps projects, characters and scene links', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumina-char-migration-'))
  try {
    const path = join(dir, 'old.db')
    const old = new DatabaseSync(path)
    for (const file of migrations) {
      old.exec(readFileSync(join('server/db/migrations', file), 'utf8'))
    }
    old.exec('CREATE TABLE schema_migrations(name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)')
    for (const file of migrations) {
      old.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(file, 1)
    }

    old.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run('u', 'legacy@gigone.com', 'hash', 'salt', 1)
    old.prepare(
      'INSERT INTO projects (id,user_id,name,description,style,language,archived,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run('p', 'u', 'Phim cũ', 'Mô tả', 'Điện ảnh', 'vi', 0, 1, 1)
    old.prepare(
      'INSERT INTO characters (id,project_id,name,appearance,voice_json,reference_path,reference_mime,reference_bytes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).run('c', 'p', 'An', 'Áo xanh', '{"timbre":"Ấm"}', 'u/characters/c/reference.png', 'image/png', 12, 1, 1)
    old.prepare(
      'INSERT INTO scenes (id,project_id,title,prompt,character_id,dialogue,model_id,params_json,position,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ).run('s', 'p', 'Cảnh 1', 'Rừng thông', 'c', 'Chào', null, '{}', 0, 1, 1)
    old.close()

    const migrated = openDatabase(path)

    // Nhân vật cũ giữ nguyên nội dung và được gán chủ sở hữu qua dự án.
    const character = migrated
      .prepare('SELECT * FROM characters WHERE id = ?')
      .get('c') as Record<string, unknown>
    expect(character.user_id).toBe('u')
    expect(character.project_id).toBe('p')
    expect(character.name).toBe('An')
    expect(character.reference_path).toBe('u/characters/c/reference.png')
    expect(character.reference_mime).toBe('image/png')

    // Liên kết cảnh → nhân vật không bị mất khi bảng được dựng lại.
    const scene = migrated.prepare('SELECT character_id FROM scenes WHERE id = ?').get('s') as {
      character_id: string | null
    }
    expect(scene.character_id).toBe('c')

    // Từ nay nhân vật thư viện là bản ghi có project_id NULL và bắt buộc có user_id.
    migrated
      .prepare(
        'INSERT INTO characters (id,user_id,project_id,name,appearance,voice_json,created_at,updated_at) VALUES (?,?,NULL,?,?,?,?,?)',
      )
      .run('c2', 'u', 'Bình', 'Tóc ngắn', '{}', 2, 2)
    const shared = migrated.prepare('SELECT * FROM characters WHERE id = ?').get('c2') as Record<
      string,
      unknown
    >
    expect(shared.project_id).toBeNull()
    expect(shared.user_id).toBe('u')

    migrated.close()

    // Mở lại lần nữa không được chạy lại migration đã áp dụng.
    const reopened = openDatabase(path)
    expect(reopened.prepare('SELECT COUNT(*) AS count FROM characters').get()!.count).toBe(2)
    expect(
      reopened.prepare('SELECT COUNT(*) AS count FROM llm_connections').get()!.count,
    ).toBe(0)
    reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * Database tạo mới khi bản nháp đầu của migration 007 đã chạy có thể đã có bảng
 * shared_characters nhưng characters vẫn chưa có user_id. Migration 008 phải chạy
 * được trên trạng thái đó: dọn bảng nháp và dựng lại characters.
 */
test('shared-character migration is safe when the draft schema was already applied', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumina-char-draft-'))
  try {
    const path = join(dir, 'draft.db')
    const old = new DatabaseSync(path)

    const applied = [
      '001_init.sql',
      '002_projects.sql',
      '003_character_reference.sql',
      '004_source_images.sql',
      '005_image_api_style.sql',
      '006_generation_character_reference.sql',
    ]
    for (const file of applied) {
      old.exec(readFileSync(join('server/db/migrations', file), 'utf8'))
    }
    old.exec('CREATE TABLE schema_migrations(name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)')
    for (const file of applied) {
      old.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(file, 1)
    }

    // Mô phỏng đúng bản nháp đầu của 007: shared_characters và llm_connections đã
    // tồn tại với schema đầy đủ, còn characters thì chưa được dựng lại.
    old.exec(`
      CREATE TABLE shared_characters (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name            TEXT NOT NULL,
        appearance      TEXT NOT NULL DEFAULT '',
        voice_json      TEXT NOT NULL DEFAULT '{}',
        reference_path  TEXT,
        reference_mime  TEXT,
        reference_bytes INTEGER,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      CREATE TABLE llm_connections (
        id                    TEXT PRIMARY KEY,
        user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name                  TEXT NOT NULL,
        base_url              TEXT NOT NULL,
        model_id              TEXT NOT NULL,
        api_key_ciphertext    BLOB NOT NULL,
        api_key_iv            BLOB NOT NULL,
        api_key_tag           BLOB NOT NULL,
        key_hint              TEXT NOT NULL DEFAULT '',
        status                TEXT NOT NULL DEFAULT 'untested',
        last_error            TEXT,
        created_at            INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL
      );
    `)
    old.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run('007_shared_characters_llm.sql', 1)

    old.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run('u', 'draft@gigone.com', 'hash', 'salt', 1)
    old.prepare(
      'INSERT INTO projects (id,user_id,name,description,style,language,archived,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run('p', 'u', 'Dự án nháp', '', '', 'vi', 0, 1, 1)
    old.prepare(
      'INSERT INTO characters (id,project_id,name,appearance,voice_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    ).run('c', 'p', 'An', 'Áo xanh', '{}', 1, 1)
    old.prepare(
      'INSERT INTO scenes (id,project_id,title,prompt,character_id,dialogue,model_id,params_json,position,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ).run('s', 'p', 'Cảnh', 'x', 'c', '', null, '{}', 0, 1, 1)
    old.close()

    const migrated = openDatabase(path)

    // Bảng nháp được dọn; characters có cột mới và giữ nguyên nhân vật + liên kết cảnh.
    expect(
      migrated
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='shared_characters'")
        .get()!.count,
    ).toBe(0)
    const columns = migrated.prepare('PRAGMA table_info(characters)').all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).toContain('user_id')

    const character = migrated.prepare('SELECT * FROM characters WHERE id = ?').get('c') as Record<
      string,
      unknown
    >
    expect(character.user_id).toBe('u')
    expect(character.project_id).toBe('p')

    const scene = migrated.prepare('SELECT character_id FROM scenes WHERE id = ?').get('s') as {
      character_id: string | null
    }
    expect(scene.character_id).toBe('c')

    migrated.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
