-- Canvas của dự án Studio: đồ thị node, vật phẩm/đạo cụ và lịch sử chạy.
--
-- Ba nhóm:
--   1. `project_items`  — sản phẩm/đạo cụ thuộc dự án, có ảnh tham chiếu riêng.
--   2. `project_canvases` — một bảng Canvas/dự án: graph JSON + revision chống ghi đè.
--   3. `project_canvas_links` / `project_canvas_runs` — liên kết nguồn có khoá ngoại
--      (để chặn xoá đối tượng đang dùng) và lịch sử tác vụ của từng node.
--
-- `graph_json` giữ vị trí node, cạnh nối và bố trí trong khung hình; bảng liên kết
-- giữ quan hệ tới bản ghi thật để server kiểm tra quyền sở hữu và tính toàn vẹn.

CREATE TABLE project_items (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN ('product', 'prop')),
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  continuity_notes   TEXT NOT NULL DEFAULT '',
  image_prompt       TEXT NOT NULL DEFAULT '',
  reference_upload_id TEXT REFERENCES uploads(id) ON DELETE SET NULL,
  revision           INTEGER NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX idx_project_items_project ON project_items(project_id, created_at, id);

CREATE TABLE project_canvases (
  project_id  TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  graph_json  TEXT NOT NULL DEFAULT '{}',
  revision    INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Mỗi dòng là một nguồn của một node. Cột `target_id` dùng cho ràng buộc duy nhất
-- (kể cả khi các cột khoá ngoại khác NULL), các cột còn lại giữ toàn vẹn tham chiếu.
CREATE TABLE project_canvas_links (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  node_id       TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('character', 'location', 'item', 'scene', 'upload', 'output')),
  target_id     TEXT NOT NULL,
  character_id  TEXT REFERENCES characters(id) ON DELETE CASCADE,
  location_id   TEXT REFERENCES project_locations(id) ON DELETE CASCADE,
  item_id       TEXT REFERENCES project_items(id) ON DELETE CASCADE,
  scene_id      TEXT REFERENCES scenes(id) ON DELETE CASCADE,
  upload_id     TEXT REFERENCES uploads(id) ON DELETE CASCADE,
  generation_id TEXT REFERENCES generations(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_project_canvas_links_unique
  ON project_canvas_links(project_id, node_id, role, target_id);
CREATE INDEX idx_project_canvas_links_target
  ON project_canvas_links(character_id, location_id, item_id, scene_id, upload_id);

-- Lịch sử chạy của từng node; giữ lại sau restart để giao diện khôi phục tiến trình.
CREATE TABLE project_canvas_runs (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  node_id       TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  generation_id TEXT REFERENCES generations(id) ON DELETE SET NULL,
  input_stamp   TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_project_canvas_runs_node ON project_canvas_runs(project_id, node_id, created_at DESC, id);
