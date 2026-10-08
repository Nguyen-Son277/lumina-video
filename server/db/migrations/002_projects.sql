CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_projects_user ON projects(user_id, archived, created_at DESC);
CREATE TABLE characters (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  appearance TEXT NOT NULL DEFAULT '',
  voice_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_characters_project ON characters(project_id, created_at);
CREATE TABLE scenes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  character_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
  dialogue TEXT NOT NULL DEFAULT '',
  model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
  params_json TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL CHECK (position >= 0),
  selected_generation_id TEXT REFERENCES generations(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_scenes_project ON scenes(project_id, position, id);
ALTER TABLE generations ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE generations ADD COLUMN scene_id TEXT REFERENCES scenes(id) ON DELETE SET NULL;
ALTER TABLE generations ADD COLUMN prompt_snapshot_json TEXT;
ALTER TABLE generations ADD COLUMN effective_prompt TEXT;
CREATE INDEX idx_generations_scene ON generations(scene_id, created_at DESC);
