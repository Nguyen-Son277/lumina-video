-- Account-wide item/logo library and stable, account-wide entity aliases.
CREATE TABLE library_assets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('item', 'logo')),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  continuity_notes TEXT NOT NULL DEFAULT '',
  reference_upload_id TEXT REFERENCES uploads(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  purge_after INTEGER
);
CREATE INDEX idx_library_assets_user ON library_assets(user_id, kind, deleted_at, updated_at DESC, id);
CREATE INDEX idx_library_assets_purge ON library_assets(deleted_at, purge_after);
CREATE INDEX idx_library_assets_reference ON library_assets(reference_upload_id);

-- Polymorphic IDs deliberately have no FK: tombstones preserve identity after purge.
CREATE TABLE entity_handles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('character', 'item', 'logo')),
  entity_id TEXT NOT NULL,
  handle TEXT NOT NULL,
  handle_key TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at INTEGER NOT NULL,
  UNIQUE (kind, entity_id)
);
CREATE UNIQUE INDEX idx_entity_handles_active ON entity_handles(user_id, handle_key) WHERE active = 1;
CREATE INDEX idx_entity_handles_user ON entity_handles(user_id, active, kind, entity_id);
