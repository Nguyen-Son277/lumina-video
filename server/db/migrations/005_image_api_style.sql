-- Kiểu gọi API tạo ảnh của từng provider.
--
--   openai     : POST /images/generations (JSON) và POST /images/edits (multipart)
--                khi có ảnh nguồn. Đây là hành vi cũ, giữ làm mặc định.
--   extra_body : POST /images/generations (JSON) với ảnh nguồn và response_format
--                đặt trong extra_body (dùng cho Agnes Image và các gateway tương tự).
ALTER TABLE provider_connections ADD COLUMN image_api_style TEXT NOT NULL DEFAULT 'openai';

-- Snapshot kiểu API tại thời điểm tạo tác vụ, để đổi cấu hình sau không làm
-- thay đổi cách xử lý của tác vụ đang chạy.
ALTER TABLE generations ADD COLUMN snap_image_style TEXT;
