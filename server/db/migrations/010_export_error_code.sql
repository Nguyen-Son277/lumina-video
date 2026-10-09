-- Mã lỗi riêng cho tác vụ xuất video.
--
-- Cần mã riêng để giao diện phân biệt "chưa cài ffmpeg" (kèm hướng dẫn cài) với
-- lỗi ghép video thông thường. Tách thành migration mới thay vì sửa 009 vì 009
-- có thể đã được áp dụng trên máy đang chạy.
ALTER TABLE exports ADD COLUMN error_code TEXT;
