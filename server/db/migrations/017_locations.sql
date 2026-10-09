ALTER TABLE plan_sessions ADD COLUMN locations_json TEXT NOT NULL DEFAULT '[]';
CREATE TABLE project_locations (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 stage TEXT NOT NULL DEFAULT '',
 description TEXT NOT NULL DEFAULT '',
 continuity_notes TEXT NOT NULL DEFAULT '',
 image_prompt TEXT NOT NULL DEFAULT '',
 reference_upload_id TEXT REFERENCES uploads(id) ON DELETE SET NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX idx_project_locations_project ON project_locations(project_id, created_at);
ALTER TABLE scenes ADD COLUMN location_id TEXT REFERENCES project_locations(id) ON DELETE SET NULL;
