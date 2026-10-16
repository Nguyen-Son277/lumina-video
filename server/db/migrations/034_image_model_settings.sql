-- Optional per-model image generation configuration.
ALTER TABLE models ADD COLUMN image_size TEXT;
ALTER TABLE models ADD COLUMN image_reference_support TEXT NOT NULL DEFAULT 'unknown'
  CHECK (image_reference_support IN ('unknown', 'yes', 'no'));
