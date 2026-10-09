-- Batch sinh ảnh storyboard cho timeline: trạng thái bền vững để tải lại trang
-- hoặc khởi động lại server vẫn theo dõi tiếp được, và không gửi trùng tác vụ.
CREATE TABLE plan_image_batches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES plan_sessions(id) ON DELETE CASCADE,
  -- running | done | stopped
  status TEXT NOT NULL DEFAULT 'running',
  total INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_plan_image_batches_session ON plan_image_batches(session_id, created_at DESC);

CREATE TABLE plan_image_batch_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES plan_image_batches(id) ON DELETE CASCADE,
  frame_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  -- pending | running | done | error | stopped
  status TEXT NOT NULL DEFAULT 'pending',
  generation_id TEXT,
  error TEXT,
  -- Prompt và ảnh nguồn đã chốt lúc tạo batch: sửa frame giữa chừng không đổi nội dung item.
  snapshot_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_plan_image_batch_items_batch ON plan_image_batch_items(batch_id, position ASC);

-- Chỉ một batch đang chạy cho mỗi phiên tại một thời điểm.
CREATE UNIQUE INDEX idx_plan_image_batches_running
  ON plan_image_batches(session_id)
  WHERE status = 'running';
