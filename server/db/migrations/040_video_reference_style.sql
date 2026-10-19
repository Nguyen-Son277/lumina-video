-- Kiểu gửi ảnh tham chiếu trong yêu cầu tạo video, theo từng provider.
--
--   image_url_object : input_reference = { "image_url": "..." } (chuẩn OpenAI/Sora).
--                     Đây là hành vi cũ, giữ làm mặc định.
--   image_url_string : input_reference = "..." (chuẩn của các gateway new-api
--                     như NexusMMO). Gateway này khai báo input_reference là
--                     CHUỖI, nên gửi object khiến provider từ chối yêu cầu
--                     ("Video request failed").
--
-- Ảnh tham chiếu này được ghi kèm tác vụ để đổi cấu hình sau không làm thay
-- đổi cách xử lý của tác vụ đang chạy.
ALTER TABLE provider_connections ADD COLUMN video_reference_style TEXT NOT NULL DEFAULT 'image_url_object';

ALTER TABLE generations ADD COLUMN snap_video_reference_style TEXT;
