CREATE TABLE IF NOT EXISTS entity_library_preferences (
  user_id       TEXT NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL CHECK (version = 1),
  settings_json TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);
