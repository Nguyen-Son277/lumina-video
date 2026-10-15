-- Rebuild models to extend its video style CHECK, preserving IDs and pricing.
CREATE TABLE models_hf (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL, display_name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'unclassified' CHECK (kind IN ('image','video','llm','unclassified')),
  enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  min_seconds INTEGER, max_seconds INTEGER,
  price_unit REAL, price_input_1k REAL, price_output_1k REAL,
  price_currency TEXT NOT NULL DEFAULT 'USD',
  video_api_style TEXT NOT NULL DEFAULT 'openai' CHECK (video_api_style IN ('openai','agnes','higgsfield')),
  UNIQUE(provider_id, model_id)
);
INSERT INTO models_hf SELECT id,user_id,provider_id,model_id,display_name,kind,enabled,created_at,updated_at,min_seconds,max_seconds,price_unit,price_input_1k,price_output_1k,price_currency,video_api_style FROM models;
DROP TABLE models;
ALTER TABLE models_hf RENAME TO models;
CREATE INDEX idx_models_user ON models(user_id,kind);
ALTER TABLE provider_connections ADD COLUMN auth_scheme TEXT NOT NULL DEFAULT 'bearer';
-- Keep the old constrained snapshot as a legacy column; all runtime reads use
-- the extended column. This avoids rebuilding the large generations table.
ALTER TABLE generations RENAME COLUMN snap_video_style TO legacy_snap_video_style;
ALTER TABLE generations ADD COLUMN snap_video_style TEXT NOT NULL DEFAULT 'openai' CHECK (snap_video_style IN ('openai','agnes','higgsfield'));
UPDATE generations SET snap_video_style = legacy_snap_video_style;
ALTER TABLE generations ADD COLUMN snap_auth_scheme TEXT NOT NULL DEFAULT 'bearer';
ALTER TABLE generations ADD COLUMN higgsfield_json TEXT;
ALTER TABLE generations ADD COLUMN provider_status TEXT;
ALTER TABLE generations ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;
