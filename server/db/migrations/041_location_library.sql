-- Extend stable library identities without changing existing IDs or inbound FKs.
CREATE TABLE library_assets_location (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK (kind IN ('item','logo','location')),
 name TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 continuity_notes TEXT NOT NULL DEFAULT '',
 reference_upload_id TEXT REFERENCES uploads(id) ON DELETE SET NULL,
 revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 deleted_at INTEGER,
 purge_after INTEGER,
 reference_views_json TEXT NOT NULL DEFAULT '[]',
 source_kind TEXT CHECK (source_kind IN ('timeline','project')),
 source_scope_id TEXT,
 source_entity_id TEXT,
 source_deleted INTEGER NOT NULL DEFAULT 0 CHECK (source_deleted IN (0,1))
);
INSERT INTO library_assets_location (id,user_id,kind,name,description,continuity_notes,reference_upload_id,revision,created_at,updated_at,deleted_at,purge_after)
 SELECT id,user_id,kind,name,description,continuity_notes,reference_upload_id,revision,created_at,updated_at,deleted_at,purge_after FROM library_assets;
DROP TABLE library_assets;
ALTER TABLE library_assets_location RENAME TO library_assets;
CREATE INDEX idx_library_assets_user ON library_assets(user_id,kind,deleted_at,updated_at DESC,id);
CREATE INDEX idx_library_assets_purge ON library_assets(deleted_at,purge_after);
CREATE INDEX idx_library_assets_reference ON library_assets(reference_upload_id);
CREATE UNIQUE INDEX idx_library_assets_source ON library_assets(user_id,source_kind,source_scope_id,source_entity_id) WHERE source_kind IS NOT NULL;
CREATE TABLE entity_handles_location (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK (kind IN ('character','item','logo','location')),
 entity_id TEXT NOT NULL,
 handle TEXT NOT NULL,
 handle_key TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
 created_at INTEGER NOT NULL,
 UNIQUE(kind,entity_id)
);
INSERT INTO entity_handles_location SELECT * FROM entity_handles;
DROP TABLE entity_handles;
ALTER TABLE entity_handles_location RENAME TO entity_handles;
CREATE UNIQUE INDEX idx_entity_handles_active ON entity_handles(user_id,handle_key) WHERE active=1;
CREATE INDEX idx_entity_handles_user ON entity_handles(user_id,active,kind,entity_id);
