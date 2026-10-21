-- Logical identity survives moves between characters and library_assets. No entity FK:
-- a conversion inserts its target and removes its source within one transaction.
CREATE TABLE entity_conversion_data (
  entity_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  voice_json TEXT NOT NULL DEFAULT '{}',
  continuity_notes TEXT NOT NULL DEFAULT '',
  reference_views_json TEXT NOT NULL DEFAULT '[]',
  retained_media_json TEXT NOT NULL DEFAULT '[]',
  last_request_json TEXT,
  last_source_kind TEXT,
  last_target_kind TEXT,
  last_target_revision INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_entity_conversion_data_user ON entity_conversion_data(user_id,entity_id);

-- A move has already inserted its target. A real purge has no surviving target,
-- so discard archived form data; already queued media cleanup can then proceed.
CREATE TRIGGER entity_conversion_character_purge AFTER DELETE ON characters
WHEN NOT EXISTS (SELECT 1 FROM library_assets WHERE id=OLD.id AND user_id=OLD.user_id)
BEGIN
  DELETE FROM entity_conversion_data WHERE entity_id=OLD.id AND user_id=OLD.user_id;
END;
CREATE TRIGGER entity_conversion_asset_purge AFTER DELETE ON library_assets
WHEN NOT EXISTS (SELECT 1 FROM characters WHERE id=OLD.id AND user_id=OLD.user_id)
BEGIN
  DELETE FROM entity_conversion_data WHERE entity_id=OLD.id AND user_id=OLD.user_id;
END;
