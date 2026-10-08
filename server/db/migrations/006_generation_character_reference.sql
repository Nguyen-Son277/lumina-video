-- Ảnh tham chiếu nhân vật đã dùng cho một tác vụ, lưu dạng snapshot ngay lúc tạo.
--
-- Nhờ vậy tác vụ đang xếp hàng không đổi đầu vào khi người dùng thay hoặc xóa
-- ảnh tham chiếu của nhân vật sau đó. Chỉ áp dụng cho tác vụ tạo ảnh trong dự án.
ALTER TABLE generations ADD COLUMN character_reference_json TEXT;
