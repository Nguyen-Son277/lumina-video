-- Metadata ngữ nghĩa cho lỗi do ứng dụng tạo ra (khoá + tham số JSON).
-- Tất cả cột đều nullable để tương thích dữ liệu cũ; khi đọc, khoá được suy ra
-- từ `error_code` bằng danh mục chung (shared/errorCatalog.ts).
ALTER TABLE generations ADD COLUMN error_message_key TEXT;
ALTER TABLE generations ADD COLUMN error_message_params TEXT;

ALTER TABLE exports ADD COLUMN error_message_key TEXT;
ALTER TABLE exports ADD COLUMN error_message_params TEXT;

ALTER TABLE provider_connections ADD COLUMN last_error_key TEXT;
ALTER TABLE provider_connections ADD COLUMN last_error_params TEXT;

-- Lỗi từng item của batch sinh ảnh storyboard.
ALTER TABLE plan_image_batch_items ADD COLUMN error_message_key TEXT;
ALTER TABLE plan_image_batch_items ADD COLUMN error_message_params TEXT;
