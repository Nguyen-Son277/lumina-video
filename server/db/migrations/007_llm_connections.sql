-- Kết nối LLM cho tính năng văn bản (chat, tạo kịch bản).
-- API key mã hóa AES-256-GCM bằng cùng khóa chủ với provider ảnh/video.
CREATE TABLE IF NOT EXISTS llm_connections (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  base_url              TEXT NOT NULL,
  model_id              TEXT NOT NULL,
  api_key_ciphertext    BLOB NOT NULL,
  api_key_iv            BLOB NOT NULL,
  api_key_tag           BLOB NOT NULL,
  key_hint              TEXT NOT NULL DEFAULT '',
  status                TEXT NOT NULL DEFAULT 'untested'
                        CHECK (status IN ('untested','connected','error')),
  last_error            TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_connections_user
  ON llm_connections(user_id, created_at ASC);
