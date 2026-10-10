-- Nhật ký sử dụng: log mọi lần gọi LLM + đơn giá model để ước tính chi phí.
--
-- Ảnh/video KHÔNG có bảng riêng: bảng `generations` đã là nguồn sự thật (prompt,
-- model, provider, trạng thái, thời gian, số lần thử) nên tầng đọc suy trực tiếp từ
-- đó, tránh hai nguồn dữ liệu lệch nhau.
--
-- `llm_usage` chỉ lưu preview 500 ký tự, không lưu toàn văn: nội dung đầy đủ vẫn
-- nằm ở `plan_messages`/`generations`, log chỉ phục vụ đối chiếu chi phí.
CREATE TABLE IF NOT EXISTS llm_usage (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_pk          TEXT REFERENCES models(id) ON DELETE SET NULL,
  provider_id       TEXT REFERENCES provider_connections(id) ON DELETE SET NULL,
  source            TEXT NOT NULL,
  plan_session_id   TEXT REFERENCES plan_sessions(id) ON DELETE SET NULL,
  project_id        TEXT REFERENCES projects(id) ON DELETE SET NULL,
  /** Tin nhắn chat phát sinh lần gọi này (nếu có), để nối log với nội dung. */
  message_id        TEXT,
  preview           TEXT NOT NULL DEFAULT '',
  response_preview  TEXT NOT NULL DEFAULT '',
  prompt_chars      INTEGER NOT NULL DEFAULT 0,
  response_chars    INTEGER NOT NULL DEFAULT 0,
  /** NULL khi provider không trả `usage`; khi đó chi phí được coi là chưa xác định. */
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  status            TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  error_code        TEXT,
  latency_ms        INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_user ON llm_usage(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_usage_session ON llm_usage(plan_session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_usage_created ON llm_usage(created_at);

-- Đơn giá do người dùng tự nhập; provider không trả giá trong API nên hệ thống
-- không đoán. Ảnh/video tính theo lượt, LLM tính theo 1K token vào/ra.
ALTER TABLE models ADD COLUMN price_unit REAL;
ALTER TABLE models ADD COLUMN price_input_1k REAL;
ALTER TABLE models ADD COLUMN price_output_1k REAL;
ALTER TABLE models ADD COLUMN price_currency TEXT NOT NULL DEFAULT 'USD';

-- Ngân sách tháng để so với chi phí ước tính (không chặn tạo nội dung).
CREATE TABLE IF NOT EXISTS usage_settings (
  user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  monthly_budget REAL,
  currency       TEXT NOT NULL DEFAULT 'USD',
  updated_at     INTEGER NOT NULL
);
