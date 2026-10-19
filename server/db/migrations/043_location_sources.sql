-- Keep provenance independently from source rows so hard deletion never loses deduplication identity.
ALTER TABLE library_assets ADD COLUMN source_revision INTEGER;
CREATE TABLE location_source_links (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 timeline_session_id TEXT NOT NULL,
 timeline_location_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 project_location_id TEXT NOT NULL,
 library_asset_id TEXT,
 PRIMARY KEY(user_id,timeline_session_id,timeline_location_id,project_id,project_location_id)
);
CREATE INDEX idx_location_source_project ON location_source_links(user_id,project_id,project_location_id);
INSERT INTO location_source_links(user_id,timeline_session_id,timeline_location_id,project_id,project_location_id)
 SELECT s.user_id,e.session_id,e.source_id,s.project_id,e.target_id
 FROM timeline_canvas_entities e JOIN timeline_canvas_sessions s ON s.session_id=e.session_id
 WHERE e.source_kind='location';
