-- Durable, user-scoped image generation task records shared by planner and project routes.
CREATE TABLE image_tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('planner', 'project')),
  scope_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('location', 'frame')),
  target_id TEXT NOT NULL,
  revision,
  fingerprint TEXT NOT NULL,
  generation_id TEXT REFERENCES generations(id) ON DELETE SET NULL,
  request_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'unknown', 'succeeded', 'failed', 'abandoned')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  attached_at INTEGER,
  attached_revision
);

-- Request keys are unique inside a user's scope, while NULL means no idempotency key.
CREATE UNIQUE INDEX idx_image_tasks_request_key
  ON image_tasks(user_id, scope, scope_id, request_key)
  WHERE request_key IS NOT NULL;

-- Cross-route invariant: only one possibly-active operation per scoped target.
CREATE UNIQUE INDEX idx_image_tasks_active_target
  ON image_tasks(user_id, scope, scope_id, target_type, target_id)
  WHERE status IN ('queued', 'running', 'unknown');

CREATE INDEX idx_image_tasks_target_latest
  ON image_tasks(user_id, scope, scope_id, target_type, target_id, created_at DESC);
CREATE INDEX idx_image_tasks_scope_latest
  ON image_tasks(user_id, scope, scope_id, created_at DESC);
CREATE INDEX idx_image_tasks_generation ON image_tasks(generation_id);

-- JSON scalar revision values are stored textually so numeric and string revisions round-trip.
-- (The API currently passes integer or string revisions; callers should compare captured/current values.)
-- SQLite's dynamic typing preserves inserted values, so this comment documents intent only.

-- The scope owner is validated by the route's project/session ownership check;
-- user_id on every task ensures reads cannot cross ownership boundaries.
