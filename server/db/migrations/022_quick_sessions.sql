-- Phiên tạo nội dung ở mục "Tạo nội dung đơn lẻ".
--
-- Một phiên gom nhiều nội dung (ảnh/video) và giữ danh sách nhân vật dùng chung
-- theo thứ tự, để mọi nội dung trong phiên bám đúng một bộ nhận diện.
--
-- Xoá phiên KHÔNG xoá kết quả: `generations.quick_session_id` đặt ON DELETE SET
-- NULL nên kết quả vẫn nằm trong Thư viện. Xoá nhân vật thì dòng liên kết tự
-- cascade, phiên vẫn còn nhưng bớt nhân vật.
CREATE TABLE quick_sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_quick_sessions_user ON quick_sessions(user_id, created_at DESC);

CREATE TABLE quick_session_characters (
  session_id   TEXT NOT NULL REFERENCES quick_sessions(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (session_id, character_id)
);
CREATE INDEX idx_quick_session_characters_character ON quick_session_characters(character_id);

ALTER TABLE generations
  ADD COLUMN quick_session_id TEXT REFERENCES quick_sessions(id) ON DELETE SET NULL;
CREATE INDEX idx_generations_quick_session ON generations(quick_session_id, created_at DESC);
