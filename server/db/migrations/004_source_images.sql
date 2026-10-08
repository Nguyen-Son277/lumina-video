-- Ảnh nguồn do người dùng tải lên để tạo ảnh mới từ ảnh đó (image-to-image).
-- Tệp nằm trong kho media riêng tư; bảng này giữ metadata và quyền sở hữu.
CREATE TABLE IF NOT EXISTS uploads (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  byte_size     INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uploads_user ON uploads(user_id, created_at DESC);

-- Ảnh nguồn đã dùng cho một tác vụ, lưu dạng snapshot để tác vụ đang chạy
-- không phụ thuộc việc người dùng có xóa ảnh nguồn hay không.
ALTER TABLE generations ADD COLUMN source_images_json TEXT;
