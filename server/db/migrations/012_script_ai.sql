-- Tạo kịch bản AI: chọn model trước, rồi ba tab (kịch bản nháp / nhân vật / timeline).
--
-- Bảng `plan_sessions` được DỰNG LẠI vì CHECK của `status` đổi bộ giá trị (SQLite
-- không sửa được CHECK tại chỗ). Trình chạy migration tắt `PRAGMA foreign_keys`
-- trong lúc áp dụng nên `DROP TABLE` không kéo theo plan_messages.
--
-- Dữ liệu cũ ĐƯỢC GIỮ NGUYÊN: `ideas_json`, `plan_json`, `llm_connection_id` vẫn
-- còn để máy chủ suy ra kịch bản/nhân vật/timeline khi các cột mới còn NULL, nhờ
-- đó phiên cũ mở được ngay và vẫn rollback được.
--
-- `llm_model_id` (thêm ở 011) đổi tên thành `chat_model_id` cho đúng vai trò.

CREATE TABLE plan_sessions_next (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL DEFAULT 'planner' CHECK (kind IN ('planner', 'copilot')),
  -- Ba model người dùng chọn ở bước đầu; thiếu model chat thì phiên ở trạng thái setup.
  chat_model_id     TEXT REFERENCES models(id) ON DELETE SET NULL,
  image_model_id    TEXT REFERENCES models(id) ON DELETE SET NULL,
  video_model_id    TEXT REFERENCES models(id) ON DELETE SET NULL,
  -- Cột legacy từ 009/011, chỉ giữ để rollback.
  llm_connection_id TEXT REFERENCES llm_connections(id) ON DELETE SET NULL,
  project_id        TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title             TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'setup'
                      CHECK (status IN ('setup','scripting','script_ready','cast_ready','timeline_ready','applied')),
  -- Artifact của từng tab; NULL nghĩa là chưa sinh (phiên cũ suy ra từ cột legacy).
  script_json       TEXT,
  cast_json         TEXT,
  timeline_json     TEXT,
  ideas_json        TEXT,
  plan_json         TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

INSERT INTO plan_sessions_next
  (id, user_id, kind, chat_model_id, llm_connection_id, project_id, title, status,
   script_json, cast_json, timeline_json, ideas_json, plan_json, created_at, updated_at)
SELECT
  id, user_id, kind, llm_model_id, llm_connection_id, project_id, title,
  CASE status
    WHEN 'applied' THEN 'applied'
    WHEN 'plan_ready' THEN 'timeline_ready'
    WHEN 'ideas_ready' THEN 'script_ready'
    WHEN 'ideas_approved' THEN 'script_ready'
    ELSE 'scripting'
  END,
  NULL, NULL, NULL, ideas_json, plan_json, created_at, updated_at
FROM plan_sessions;

DROP TABLE plan_sessions;
ALTER TABLE plan_sessions_next RENAME TO plan_sessions;
CREATE INDEX idx_plan_sessions_user ON plan_sessions(user_id, created_at DESC);
CREATE INDEX idx_plan_sessions_project ON plan_sessions(project_id, created_at DESC);

-- Phiên chưa có model chat thì phải chọn model trước khi dùng được.
UPDATE plan_sessions SET status = 'setup' WHERE chat_model_id IS NULL AND status <> 'applied';

-- Ảnh nền của từng frame timeline, đi theo cảnh khi chốt vào Studio.
ALTER TABLE scenes ADD COLUMN background_upload_id TEXT REFERENCES uploads(id) ON DELETE SET NULL;
