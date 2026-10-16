-- Explicit provenance only: legacy graphs are deliberately not matched by names.
CREATE TABLE timeline_canvas_sessions (
 session_id TEXT PRIMARY KEY REFERENCES plan_sessions(id) ON DELETE CASCADE,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at INTEGER NOT NULL
);
CREATE TABLE timeline_canvas_entities (
 session_id TEXT NOT NULL REFERENCES timeline_canvas_sessions(session_id) ON DELETE CASCADE,
 source_kind TEXT NOT NULL CHECK(source_kind IN ('cast','location')),
 source_id TEXT NOT NULL,
 target_id TEXT NOT NULL,
 managed INTEGER NOT NULL DEFAULT 1,
 snapshot_json TEXT NOT NULL DEFAULT '{}',
 PRIMARY KEY(session_id,source_kind,source_id)
);
CREATE TABLE timeline_canvas_frames (
 session_id TEXT NOT NULL REFERENCES timeline_canvas_sessions(session_id) ON DELETE CASCADE,
 frame_id TEXT NOT NULL,
 scene_id TEXT,
 group_id TEXT NOT NULL,
 snapshot_json TEXT NOT NULL DEFAULT '{}',
 tombstones_json TEXT NOT NULL DEFAULT '[]',
 detached INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(session_id,frame_id)
);
CREATE INDEX timeline_canvas_project ON timeline_canvas_sessions(project_id);
