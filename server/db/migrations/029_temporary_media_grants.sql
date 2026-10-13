-- Opt-in, per-generation bearer capabilities for a single immutable raster input.
-- Never store the raw token: token_hash is the SHA-256 digest of 32 random bytes.
CREATE TABLE temporary_media_grants (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  generation_id  TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
  token_hash     TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  relative_path  TEXT NOT NULL,
  mime_type      TEXT NOT NULL CHECK (mime_type IN ('image/png','image/jpeg','image/webp','image/gif')),
  -- Optional at issuance when a MediaStore is available; detects later replacement.
  content_sha256 TEXT CHECK (content_sha256 IS NULL OR length(content_sha256) = 64),
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + 86400000),
  revoked_at     INTEGER
);
CREATE INDEX idx_temporary_media_grants_generation ON temporary_media_grants(user_id, generation_id);
CREATE INDEX idx_temporary_media_grants_expiry ON temporary_media_grants(expires_at);
