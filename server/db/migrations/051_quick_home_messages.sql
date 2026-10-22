-- Tin nhắn ở trang Tạo nội dung đơn lẻ, độc lập với quick_sessions.
-- Chỉ ghi lời người dùng; không giả lập câu trả lời AI khi chưa cấu hình chat.
CREATE TABLE quick_home_messages (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 8000),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_quick_home_messages_user ON quick_home_messages(user_id, created_at DESC, id DESC);
