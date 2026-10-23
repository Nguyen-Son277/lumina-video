-- The runner extends the models.kind CHECK while preserving all columns/indexes.
CREATE TABLE speech_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  quick_session_id TEXT REFERENCES quick_sessions(id) ON DELETE CASCADE,
  model_pk TEXT REFERENCES models(id) ON DELETE SET NULL,
  provider_id TEXT REFERENCES provider_connections(id) ON DELETE SET NULL,
  input TEXT NOT NULL,
  snap_model_id TEXT NOT NULL,
  snap_provider TEXT NOT NULL,
  snap_base_url TEXT NOT NULL,
  credential_id TEXT REFERENCES provider_credentials(id) ON DELETE SET NULL,
  snap_credential_hint TEXT,
  snap_credential_base_url TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','unknown')),
  relative_path TEXT,
  mime_type TEXT,
  byte_size INTEGER,
  duration_seconds REAL,
  error_code TEXT,
  error_message TEXT,
  error_message_key TEXT,
  error_message_params TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  CHECK (project_id IS NULL OR quick_session_id IS NULL)
);
CREATE INDEX idx_speech_user ON speech_jobs(user_id, created_at DESC);
CREATE INDEX idx_speech_queue ON speech_jobs(status, created_at);
CREATE INDEX idx_speech_credential ON speech_jobs(credential_id, status);

CREATE TABLE narration_preferences (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  preferences_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, scope)
);

CREATE TABLE request_idempotency (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, operation, key)
);

ALTER TABLE exports ADD COLUMN speech_job_id TEXT REFERENCES speech_jobs(id) ON DELETE SET NULL;
ALTER TABLE exports ADD COLUMN stage TEXT NOT NULL DEFAULT 'queued'
  CHECK (stage IN ('queued','speech','stitching','succeeded','failed'));
CREATE INDEX idx_exports_speech ON exports(speech_job_id);
UPDATE exports SET stage = CASE status WHEN 'succeeded' THEN 'succeeded' WHEN 'failed' THEN 'failed' ELSE 'queued' END;
