-- Reference versions are accounted for independently of mutable character pointers.
CREATE TABLE immutable_media_versions (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 path TEXT NOT NULL UNIQUE,
 mime_type TEXT NOT NULL,
 byte_size INTEGER NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX idx_immutable_media_versions_user ON immutable_media_versions(user_id);
