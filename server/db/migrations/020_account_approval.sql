-- Duyệt tài khoản: tài khoản mới chờ super admin duyệt mới đăng nhập được.
--
-- DEFAULT 'approved' là chủ ý: mọi hàng đã tồn tại (tài khoản tạo trước tính
-- năng này) tự động được coi là đã duyệt, không cần backfill riêng. Đăng ký mới
-- ghi tường minh status = 'pending'.
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN approved_at INTEGER;
ALTER TABLE users ADD COLUMN approved_by TEXT;

CREATE INDEX IF NOT EXISTS idx_users_status ON users(status, created_at DESC);
