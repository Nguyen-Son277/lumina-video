-- Schema khởi tạo cho Lumina Studio.
-- Mọi bảng đều gắn user_id để tách biệt dữ liệu giữa các tài khoản.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,          -- SHA-256 của token, không lưu token gốc
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS provider_connections (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  base_url              TEXT NOT NULL,
  api_key_ciphertext    BLOB NOT NULL,
  api_key_iv            BLOB NOT NULL,
  api_key_tag           BLOB NOT NULL,
  key_hint              TEXT NOT NULL DEFAULT '',   -- 4 ký tự cuối, chỉ để hiển thị
  status                TEXT NOT NULL DEFAULT 'untested',
  last_error            TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_providers_user ON provider_connections(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS models (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id  TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  model_id     TEXT NOT NULL,
  display_name TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'unclassified'
                 CHECK (kind IN ('image','video','unclassified')),
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (provider_id, model_id)
);
CREATE INDEX IF NOT EXISTS idx_models_user ON models(user_id, kind);

CREATE TABLE IF NOT EXISTS generations (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_pk         TEXT REFERENCES models(id) ON DELETE SET NULL,
  provider_id      TEXT REFERENCES provider_connections(id) ON DELETE SET NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('image','video')),
  prompt           TEXT NOT NULL,
  params_json      TEXT NOT NULL DEFAULT '{}',
  -- Snapshot để tác vụ đang chạy không phụ thuộc cấu hình có thể bị sửa sau đó.
  snap_provider    TEXT NOT NULL,
  snap_base_url    TEXT NOT NULL,
  snap_model_id    TEXT NOT NULL,
  status           TEXT NOT NULL
                     CHECK (status IN ('queued','running','downloading','succeeded','failed','unknown')),
  provider_job_id  TEXT,
  progress         INTEGER,
  error_code       TEXT,
  error_message    TEXT,
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  next_poll_at     INTEGER,
  poll_started_at  INTEGER,
  idempotency_key  TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  completed_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_generations_user ON generations(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generations_queue ON generations(status, next_poll_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_generations_idempotency
  ON generations(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS assets (
  id            TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  byte_size     INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_generation ON assets(generation_id);
CREATE INDEX IF NOT EXISTS idx_assets_user ON assets(user_id);
