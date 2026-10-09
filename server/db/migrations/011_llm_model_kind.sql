-- Gộp "LLM & Chat" vào Model catalog.
--
-- Trước đây LLM có bảng riêng (llm_connections) giữ base_url + key + model, nên
-- người dùng phải quản lý key ở hai nơi. Từ migration này:
--   * `models.kind` nhận thêm giá trị 'llm' — phân loại model chat ngay trong
--     Model catalog;
--   * URL + key của LLM dùng chung `provider_connections` như provider ảnh/video;
--   * dữ liệu llm_connections cũ được chuyển sang provider + model, KHÔNG mất key.
--
-- Bảng `llm_connections` và cột `plan_sessions.llm_connection_id` được giữ lại
-- làm dữ liệu legacy để có thể rollback (tiền lệ migration 009). Mã mới không đọc
-- hai cột/bảng này nữa.
--
-- Lưu ý: migration này DỰNG LẠI bảng `models`. Trình chạy migration tắt
-- `PRAGMA foreign_keys` trong lúc áp dụng để `DROP TABLE models` không kích hoạt
-- ON DELETE SET NULL trên `generations.model_pk`, và kiểm tra lại bằng
-- `PRAGMA foreign_key_check` sau khi chạy xong (xem server/db/index.ts).

-- 1. Cho phép kind = 'llm' (SQLite không sửa được CHECK nên phải dựng lại bảng).
CREATE TABLE models_next (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id  TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  model_id     TEXT NOT NULL,
  display_name TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'unclassified'
                 CHECK (kind IN ('image','video','llm','unclassified')),
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  min_seconds  INTEGER,
  max_seconds  INTEGER,
  UNIQUE (provider_id, model_id)
);

INSERT INTO models_next
  (id, user_id, provider_id, model_id, display_name, kind, enabled, created_at, updated_at, min_seconds, max_seconds)
SELECT
  id, user_id, provider_id, model_id, display_name, kind, enabled, created_at, updated_at, min_seconds, max_seconds
FROM models;

DROP TABLE models;
ALTER TABLE models_next RENAME TO models;
CREATE INDEX IF NOT EXISTS idx_models_user ON models(user_id, kind);

-- 2. Chuyển từng kết nối LLM thành provider (URL + key) và model kind='llm'.
--
-- Bảng ánh xạ tạm: mỗi kết nối cũ trỏ tới provider sẽ dùng. Tái dùng provider đã
-- có cùng (user_id, base_url) nếu có, nếu không thì sinh id mới.
CREATE TEMP TABLE IF NOT EXISTS _llm_migration_map (
  connection_id TEXT PRIMARY KEY,
  provider_id   TEXT NOT NULL
);

INSERT INTO _llm_migration_map (connection_id, provider_id)
SELECT
  lc.id,
  COALESCE(
    (SELECT pc.id FROM provider_connections pc
      WHERE pc.user_id = lc.user_id AND pc.base_url = lc.base_url
      ORDER BY pc.created_at ASC, pc.id ASC LIMIT 1),
    lower(hex(randomblob(16)))
  )
FROM llm_connections lc;

-- Chỉ tạo provider cho id mới; provider tái dùng đã tồn tại thì bỏ qua.
INSERT INTO provider_connections
  (id, user_id, name, base_url, api_key_ciphertext, api_key_iv, api_key_tag,
   key_hint, status, last_error, created_at, updated_at, image_api_style)
SELECT
  m.provider_id, lc.user_id, lc.name, lc.base_url, lc.api_key_ciphertext, lc.api_key_iv,
  lc.api_key_tag, lc.key_hint, lc.status, lc.last_error, lc.created_at, lc.updated_at, 'openai'
FROM llm_connections lc
JOIN _llm_migration_map m ON m.connection_id = lc.id
WHERE NOT EXISTS (SELECT 1 FROM provider_connections pc WHERE pc.id = m.provider_id);

-- Kết nối chưa chọn model vẫn được chuyển thành provider để không mất key; người
-- dùng chỉ cần Đồng bộ rồi phân loại một model thành LLM & Chat.
INSERT INTO models
  (id, user_id, provider_id, model_id, display_name, kind, enabled, created_at, updated_at)
SELECT
  lower(hex(randomblob(16))), lc.user_id, m.provider_id, trim(lc.model_id),
  lc.name || ' · ' || trim(lc.model_id), 'llm', 1, lc.created_at, lc.updated_at
FROM llm_connections lc
JOIN _llm_migration_map m ON m.connection_id = lc.id
WHERE trim(COALESCE(lc.model_id, '')) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM models x
     WHERE x.provider_id = m.provider_id AND x.model_id = trim(lc.model_id)
  );

-- 3. Phiên Trợ lý AI trỏ sang model LLM thay vì kết nối LLM.
--    Cột cũ giữ nguyên (không xoá) để rollback.
ALTER TABLE plan_sessions ADD COLUMN llm_model_id TEXT REFERENCES models(id) ON DELETE SET NULL;

UPDATE plan_sessions
   SET llm_model_id = (
     SELECT x.id
       FROM models x
       JOIN _llm_migration_map m ON m.provider_id = x.provider_id
      WHERE m.connection_id = plan_sessions.llm_connection_id
        AND x.kind = 'llm'
      LIMIT 1
   )
 WHERE llm_connection_id IS NOT NULL;

DROP TABLE _llm_migration_map;
