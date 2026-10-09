-- Hai cột metadata lỗi của item batch từng được thêm vào migration 015 SAU khi
-- migration đó đã được đánh dấu áp dụng trên một số database (bộ chạy migration
-- không lưu checksum). Trên các database đó, `plan_image_batch_items` thiếu
-- `error_message_key`/`error_message_params`, khiến mọi lần ghi trạng thái item
-- ném "no such column" và batch kẹt ở `running`.
--
-- Dựng lại bảng để bảo đảm cột tồn tại trên CẢ database cũ lẫn database mới
-- (idempotent: chạy lại vẫn đúng), giữ nguyên dữ liệu item hiện có.
--
-- Lưu ý: không thể đọc hai cột metadata khi chúng chưa tồn tại, nên phần dựng lại
-- chỉ sao chép các cột cũ. Văn bản `error` vẫn được giữ và giao diện suy ra khoá
-- ngữ nghĩa từ nó, nên chỉ mất nhãn dịch của lỗi item cũ, không mất thông tin lỗi.
CREATE TABLE plan_image_batch_items_new (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES plan_image_batches(id) ON DELETE CASCADE,
  frame_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  -- pending | running | done | error | stopped
  status TEXT NOT NULL DEFAULT 'pending',
  generation_id TEXT,
  error TEXT,
  error_message_key TEXT,
  error_message_params TEXT,
  -- Prompt và ảnh nguồn đã chốt lúc tạo batch: sửa frame giữa chừng không đổi nội dung item.
  snapshot_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO plan_image_batch_items_new
  (id, batch_id, frame_id, position, status, generation_id, error, snapshot_json, created_at, updated_at)
SELECT id, batch_id, frame_id, position, status, generation_id, error, snapshot_json, created_at, updated_at
FROM plan_image_batch_items;

DROP TABLE plan_image_batch_items;

ALTER TABLE plan_image_batch_items_new RENAME TO plan_image_batch_items;

CREATE INDEX idx_plan_image_batch_items_batch ON plan_image_batch_items(batch_id, position ASC);
