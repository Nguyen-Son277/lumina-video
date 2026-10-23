-- Both real projects and quick sessions can export a frozen video chain.
CREATE TABLE exports_next (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  quick_session_id TEXT REFERENCES quick_sessions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
  spec_json TEXT NOT NULL,
  relative_path TEXT,
  mime_type TEXT,
  byte_size INTEGER,
  progress INTEGER,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  error_code TEXT,
  error_message_key TEXT,
  error_message_params TEXT,
  CHECK ((project_id IS NOT NULL AND quick_session_id IS NULL) OR (project_id IS NULL AND quick_session_id IS NOT NULL))
);
INSERT INTO exports_next (id,user_id,project_id,status,spec_json,relative_path,mime_type,byte_size,progress,error_message,created_at,updated_at,completed_at,error_code,error_message_key,error_message_params)
  SELECT id,user_id,project_id,status,spec_json,relative_path,mime_type,byte_size,progress,error_message,created_at,updated_at,completed_at,error_code,error_message_key,error_message_params FROM exports;
DROP TABLE exports;
ALTER TABLE exports_next RENAME TO exports;
CREATE INDEX idx_exports_user ON exports(user_id,created_at DESC);
CREATE INDEX idx_exports_project ON exports(project_id,created_at DESC);
CREATE INDEX idx_exports_quick_session ON exports(quick_session_id,created_at DESC);
