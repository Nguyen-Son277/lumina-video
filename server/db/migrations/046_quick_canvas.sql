-- Quick canvases are session-scoped; no synthetic projects or scenes.
CREATE TABLE quick_canvases (
  session_id TEXT PRIMARY KEY REFERENCES quick_sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  graph_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE quick_canvas_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES quick_sessions(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('image','video')),
  generation_id TEXT REFERENCES generations(id) ON DELETE SET NULL,
  asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
  input_stamp TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE(session_id,node_id,generation_id,input_stamp)
);
CREATE INDEX idx_quick_canvas_runs_session ON quick_canvas_runs(session_id,created_at DESC,id);
-- Immutable import identities and tombstones survive removal from graph JSON.
CREATE TABLE quick_canvas_sources (
  session_id TEXT NOT NULL REFERENCES quick_sessions(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  node_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  conflicts_json TEXT NOT NULL DEFAULT '[]',
  tombstoned INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(session_id,source_key)
);
