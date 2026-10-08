-- Ảnh tham chiếu của nhân vật.
-- Lưu đường dẫn tương đối trong kho media riêng tư; không có URL công khai.
ALTER TABLE characters ADD COLUMN reference_path TEXT;
ALTER TABLE characters ADD COLUMN reference_mime TEXT;
ALTER TABLE characters ADD COLUMN reference_bytes INTEGER;
