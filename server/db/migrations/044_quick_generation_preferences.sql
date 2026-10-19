CREATE TABLE IF NOT EXISTS quick_generation_preferences (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode          TEXT NOT NULL CHECK (mode IN ('image', 'video')),
  version       INTEGER NOT NULL CHECK (version = 1),
  settings_json TEXT NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, mode)
);
CREATE INDEX IF NOT EXISTS idx_quick_generation_preferences_user
  ON quick_generation_preferences(user_id);
