-- Thùng rác chung: bản ghi và media được giữ 30 ngày trước khi dọn vĩnh viễn.
ALTER TABLE characters ADD COLUMN deleted_at INTEGER;
ALTER TABLE characters ADD COLUMN purge_after INTEGER;
CREATE INDEX idx_characters_trash ON characters(user_id, deleted_at, purge_after);
ALTER TABLE generations ADD COLUMN deleted_at INTEGER;
ALTER TABLE generations ADD COLUMN purge_after INTEGER;
CREATE INDEX idx_generations_trash ON generations(user_id, deleted_at, purge_after);
ALTER TABLE plan_sessions ADD COLUMN deleted_at INTEGER;
ALTER TABLE plan_sessions ADD COLUMN purge_after INTEGER;
CREATE INDEX idx_plan_sessions_trash ON plan_sessions(user_id, deleted_at, purge_after);
