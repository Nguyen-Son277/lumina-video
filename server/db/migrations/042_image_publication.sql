ALTER TABLE generations ADD COLUMN image_purpose_json TEXT;
ALTER TABLE generations ADD COLUMN library_publish_status TEXT CHECK(library_publish_status IN ('queued','succeeded','failed'));
ALTER TABLE generations ADD COLUMN library_publish_error TEXT;
ALTER TABLE generations ADD COLUMN library_publications_json TEXT;
CREATE TABLE generation_library_publications (
  generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
  source_asset_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('character','item','logo','location')),
  target_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(generation_id, source_asset_id)
);
CREATE INDEX generations_library_publication_recovery ON generations(library_publish_status,updated_at) WHERE image_purpose_json IS NOT NULL;
