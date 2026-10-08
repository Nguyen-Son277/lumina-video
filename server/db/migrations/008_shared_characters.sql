-- Nhân vật dùng chung cho cả tài khoản, không buộc thuộc một dự án.
--
-- SQLite không sửa được ràng buộc NOT NULL bằng ALTER, nên bảng characters được
-- dựng lại: thêm user_id và cho project_id nhận NULL (NULL = nhân vật thư viện).
--
-- Hai điểm cần lưu ý:
--  1. Trước migration này, mọi nhân vật đều thuộc một dự án, nên user_id suy ra
--     từ projects.user_id.
--  2. DROP TABLE characters kích hoạt ON DELETE SET NULL của scenes.character_id,
--     nên liên kết cảnh → nhân vật phải được sao lưu tạm và khôi phục lại.

DROP TABLE IF EXISTS shared_characters;

CREATE TEMP TABLE scene_character_backup AS
  SELECT id, character_id FROM scenes WHERE character_id IS NOT NULL;

CREATE TABLE characters_next (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  appearance      TEXT NOT NULL DEFAULT '',
  voice_json      TEXT NOT NULL DEFAULT '{}',
  reference_path  TEXT,
  reference_mime  TEXT,
  reference_bytes INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

INSERT INTO characters_next
  (id, user_id, project_id, name, appearance, voice_json,
   reference_path, reference_mime, reference_bytes, created_at, updated_at)
SELECT c.id, p.user_id, c.project_id, c.name, c.appearance, c.voice_json,
       c.reference_path, c.reference_mime, c.reference_bytes, c.created_at, c.updated_at
FROM characters c
JOIN projects p ON p.id = c.project_id;

DROP TABLE characters;
ALTER TABLE characters_next RENAME TO characters;

CREATE INDEX IF NOT EXISTS idx_characters_user ON characters(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_characters_project ON characters(project_id, created_at);

UPDATE scenes
SET character_id = (
  SELECT b.character_id FROM scene_character_backup b WHERE b.id = scenes.id
)
WHERE id IN (SELECT id FROM scene_character_backup);

DROP TABLE scene_character_backup;
