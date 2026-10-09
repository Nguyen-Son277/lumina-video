ALTER TABLE projects ADD COLUMN deleted_at INTEGER;
ALTER TABLE projects ADD COLUMN purge_after INTEGER;
ALTER TABLE projects ADD COLUMN delete_results INTEGER NOT NULL DEFAULT 0 CHECK (delete_results IN (0, 1));
CREATE INDEX idx_projects_trash ON projects(user_id, deleted_at, purge_after);

-- Durable file cleanup jobs survive deletion of their owning project/user.
CREATE TABLE media_cleanup_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_error TEXT
);
CREATE INDEX idx_media_cleanup_jobs_created ON media_cleanup_jobs(created_at, id);
