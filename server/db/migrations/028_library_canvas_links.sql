-- Rebuild links to admit library roles while preserving every existing ID/FK.
CREATE TABLE project_canvas_links_next (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 node_id TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('character','location','item','scene','upload','output','library')),
 target_id TEXT NOT NULL,
 character_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
 location_id TEXT REFERENCES project_locations(id) ON DELETE CASCADE,
 item_id TEXT REFERENCES project_items(id) ON DELETE CASCADE,
 scene_id TEXT REFERENCES scenes(id) ON DELETE CASCADE,
 upload_id TEXT REFERENCES uploads(id) ON DELETE CASCADE,
 generation_id TEXT REFERENCES generations(id) ON DELETE SET NULL,
 created_at INTEGER NOT NULL,
 library_asset_id TEXT REFERENCES library_assets(id) ON DELETE RESTRICT
);
INSERT INTO project_canvas_links_next(id,project_id,node_id,role,target_id,character_id,location_id,item_id,scene_id,upload_id,generation_id,created_at)
SELECT id,project_id,node_id,role,target_id,character_id,location_id,item_id,scene_id,upload_id,generation_id,created_at FROM project_canvas_links;
DROP TABLE project_canvas_links;
ALTER TABLE project_canvas_links_next RENAME TO project_canvas_links;
CREATE UNIQUE INDEX idx_project_canvas_links_unique ON project_canvas_links(project_id,node_id,role,target_id);
CREATE INDEX idx_project_canvas_links_target ON project_canvas_links(character_id,location_id,item_id,scene_id,upload_id);
CREATE INDEX idx_project_canvas_library_source ON project_canvas_links(library_asset_id);
