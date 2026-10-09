-- Trợ lý AI: chat lập kế hoạch, duyệt cảnh, nhiều nhân vật mỗi cảnh, xuất video.
--
-- Ba nhóm thay đổi:
--   1. Nhiều nhân vật trong một cảnh (scene_characters) + bối cảnh + cổng duyệt.
--   2. Giới hạn thời lượng thật của từng model video (timeline bám theo).
--   3. Phiên chat (plan_sessions/plan_messages) và tác vụ xuất video (exports).

-- 1. Nhiều nhân vật trong một cảnh.
--
-- scenes.character_id VẪN là NGƯỜI NÓI CHÍNH (sở hữu lời thoại và hồ sơ giọng)
-- nên promptComposer và adapter video giữ nguyên ngữ nghĩa. Bảng này bổ sung
-- danh sách nhân vật XUẤT HIỆN trong cảnh, thứ tự theo position; người nói nằm
-- ở position 0.
CREATE TABLE scene_characters (
  scene_id     TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  position     INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (scene_id, character_id)
);
CREATE INDEX idx_scene_characters_character ON scene_characters(character_id);

-- Bối cảnh của cảnh (khác params.background vốn là tham số API tạo ảnh).
ALTER TABLE scenes ADD COLUMN background TEXT NOT NULL DEFAULT '';
-- 1 = cần xếp hàng tạo nội dung; sweeper đặt lại 0 sau khi đã enqueue.
ALTER TABLE scenes ADD COLUMN auto_generate INTEGER NOT NULL DEFAULT 0;
-- Cổng duyệt: chỉ cảnh approved = 1 mới được xếp hàng tạo nội dung.
ALTER TABLE scenes ADD COLUMN approved INTEGER NOT NULL DEFAULT 0;

-- 2. Giới hạn thời lượng của từng model video (NULL = không ràng buộc).
ALTER TABLE models ADD COLUMN min_seconds INTEGER;
ALTER TABLE models ADD COLUMN max_seconds INTEGER;

-- Ảnh tham chiếu nhân vật dạng MẢNG theo thứ tự; phần tử [0] là người nói chính.
--
-- Cột cũ character_reference_json (một đối tượng đơn) được giữ nguyên để có thể
-- rollback; mã mới chỉ đọc cột mảng này. Backfill bằng cách bọc đối tượng cũ
-- trong một mảng JSON.
ALTER TABLE generations ADD COLUMN character_references_json TEXT;
UPDATE generations
   SET character_references_json = '[' || character_reference_json || ']'
 WHERE character_reference_json IS NOT NULL;

-- 3. Phiên chat của Trợ lý AI.
--
-- kind = 'planner': project_id NULL, chốt kế hoạch thì tạo dự án mới.
-- kind = 'copilot': project_id NOT NULL, vá thay đổi vào dự án đang mở.
CREATE TABLE plan_sessions (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL DEFAULT 'planner' CHECK (kind IN ('planner', 'copilot')),
  llm_connection_id TEXT REFERENCES llm_connections(id) ON DELETE SET NULL,
  project_id        TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title             TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'chatting'
                      CHECK (status IN ('chatting', 'ideas_ready', 'ideas_approved', 'plan_ready', 'applied')),
  ideas_json        TEXT,
  plan_json         TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_plan_sessions_user ON plan_sessions(user_id, created_at DESC);
CREATE INDEX idx_plan_sessions_project ON plan_sessions(project_id, created_at DESC);

CREATE TABLE plan_messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES plan_sessions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_plan_messages_session ON plan_messages(session_id, created_at, id);

-- Tác vụ xuất video: chạy nền trong worker hiện có, giống mô hình trạng thái của
-- generations. spec_json giữ danh sách cảnh theo thứ tự đã chốt tại thời điểm
-- tạo, nên sửa cảnh sau đó không làm đổi bản đang xuất.
CREATE TABLE exports (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  spec_json     TEXT NOT NULL,
  relative_path TEXT,
  mime_type     TEXT,
  byte_size     INTEGER,
  progress      INTEGER,
  error_message TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  completed_at  INTEGER
);
CREATE INDEX idx_exports_user ON exports(user_id, created_at DESC);
CREATE INDEX idx_exports_project ON exports(project_id, created_at DESC);
