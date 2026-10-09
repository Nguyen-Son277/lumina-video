-- Nền tảng đa API key (multi-key) cho provider.
--
-- Mô hình:
--   * `provider_connections` giữ URL dùng chung cho cả nhóm key + chế độ chọn key.
--   * `provider_credentials` là pool key (tối đa 10 key/provider). KHÔNG có cột
--     base_url: URL nằm ở provider để mọi key trong pool dùng chung một đích.
--   * Mỗi key được mã hóa AES-256-GCM như cột cũ; `fingerprint` là HMAC-SHA256
--     của key gốc (khóa chủ làm khóa HMAC) để phát hiện trùng lặp mà không lưu
--     hay so sánh key thô. Bản ghi backfill từ dữ liệu cũ để fingerprint NULL vì
--     migration không có khóa chủ để giải mã.
--   * Cột legacy (api_key_ciphertext/api_key_iv/api_key_tag/key_hint) được GIỮ
--     LẠI để rollback nhưng KHÔNG bao giờ được dùng làm fallback lúc chạy: pool
--     rỗng thì tác vụ thất bại rõ ràng, không âm thầm dùng key cũ.
--
-- Tác vụ đã ghim key: `generations.credential_id` + `snap_credential_hint` +
-- `snap_credential_base_url` được chụp ngay lần gửi provider đầu tiên để các
-- lần poll/tải sau không đổi key hay đích khi người dùng sửa cấu hình.

-- ── Pool key ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS provider_credentials (
  id                TEXT PRIMARY KEY,
  provider_id       TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  label             TEXT NOT NULL DEFAULT '',
  ciphertext        BLOB NOT NULL,
  iv                BLOB NOT NULL,
  tag               BLOB NOT NULL,
  hint              TEXT NOT NULL DEFAULT '',          -- 4 ký tự cuối, chỉ để hiển thị
  fingerprint       TEXT,                              -- HMAC-SHA256 hex; NULL với dữ liệu backfill
  position          INTEGER NOT NULL DEFAULT 0,        -- thứ tự ưu tiên (0 = cao nhất)
  enabled           INTEGER NOT NULL DEFAULT 1,
  health_status     TEXT NOT NULL DEFAULT 'unknown'
                      CHECK (health_status IN ('ok','auth_failed','cooldown','unknown')),
  cooldown_until    INTEGER,
  last_used_at      INTEGER,
  last_error        TEXT,
  last_error_key    TEXT,
  last_error_params TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- Thứ tự chọn key (failover theo `position`, round-robin theo thứ tự này).
CREATE INDEX IF NOT EXISTS idx_provider_credentials_provider
  ON provider_credentials(provider_id, position, created_at);

-- Một key chỉ được có mặt một lần trong cùng một provider. NULL (dữ liệu
-- backfill) không bị coi là trùng nhau.
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_credentials_fingerprint
  ON provider_credentials(provider_id, fingerprint) WHERE fingerprint IS NOT NULL;

-- ── Provider: URL dùng chung + chế độ chọn key ──────────────────────────────
ALTER TABLE provider_connections ADD COLUMN selection_mode TEXT NOT NULL DEFAULT 'failover'
  CHECK (selection_mode IN ('failover','round_robin'));
-- Con trỏ round-robin đã lưu: `position` của key dùng gần nhất.
ALTER TABLE provider_connections ADD COLUMN rr_cursor INTEGER;

-- ── Generation: ghim key cho tác vụ đã gửi provider ─────────────────────────
ALTER TABLE generations ADD COLUMN credential_id TEXT
  REFERENCES provider_credentials(id) ON DELETE SET NULL;
ALTER TABLE generations ADD COLUMN snap_credential_hint TEXT;
ALTER TABLE generations ADD COLUMN snap_credential_base_url TEXT;

CREATE INDEX IF NOT EXISTS idx_generations_credential
  ON generations(credential_id, status);

-- ── Backfill: mỗi provider cũ trở thành một key "mặc định" ──────────────────
-- id tất định `cred_<provider_id>` để backfill generation trỏ đúng bản ghi này.
INSERT INTO provider_credentials
  (id, provider_id, label, ciphertext, iv, tag, hint, fingerprint, position, enabled,
   health_status, cooldown_until, last_used_at, last_error, last_error_key, last_error_params,
   created_at, updated_at)
SELECT
  'cred_' || p.id, p.id, 'Key mặc định', p.api_key_ciphertext, p.api_key_iv, p.api_key_tag,
  p.key_hint, NULL, 0, 1, 'unknown', NULL, NULL, p.last_error, p.last_error_key, p.last_error_params,
  p.created_at, p.updated_at
FROM provider_connections p
WHERE NOT EXISTS (SELECT 1 FROM provider_credentials c WHERE c.provider_id = p.id);

-- ── Backfill: generation cũ ghim vào key mặc định của provider ───────────────
UPDATE generations
SET credential_id = 'cred_' || provider_id,
    snap_credential_hint = (SELECT p.key_hint FROM provider_connections p WHERE p.id = generations.provider_id),
    snap_credential_base_url = snap_base_url
WHERE provider_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM provider_credentials c WHERE c.id = 'cred_' || generations.provider_id)
  AND credential_id IS NULL;
