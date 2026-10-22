-- Frozen editor inputs live with history; original sources are never overwritten.
ALTER TABLE generations ADD COLUMN image_editor_json TEXT;
ALTER TABLE models ADD COLUMN image_mask_support TEXT NOT NULL DEFAULT 'unknown' CHECK (image_mask_support IN ('unknown','yes','no'));
ALTER TABLE models ADD COLUMN image_transparent_background_support TEXT NOT NULL DEFAULT 'unknown' CHECK (image_transparent_background_support IN ('unknown','yes','no'));
CREATE TABLE image_editor_sources (
  upload_id TEXT PRIMARY KEY REFERENCES uploads(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_json TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_image_editor_sources_user ON image_editor_sources(user_id);
