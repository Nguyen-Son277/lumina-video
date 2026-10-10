-- Preserve legacy idempotency keys for attempt zero; explicit retries get a new key.
ALTER TABLE plan_image_batch_items ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
