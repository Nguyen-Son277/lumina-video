-- Model-level transport and maximum reference-image configuration.
ALTER TABLE models ADD COLUMN image_reference_transport TEXT NOT NULL DEFAULT 'provider_default'
  CHECK (image_reference_transport IN ('provider_default', 'generations_images'));
ALTER TABLE models ADD COLUMN image_max_references INTEGER
  CHECK (image_max_references IS NULL OR (image_max_references > 0 AND image_max_references <= 16));

-- Freeze image reference handling on each generation, independent of later model edits.
ALTER TABLE generations ADD COLUMN snap_image_reference_transport TEXT NOT NULL DEFAULT 'provider_default'
  CHECK (snap_image_reference_transport IN ('provider_default', 'generations_images'));
ALTER TABLE generations ADD COLUMN snap_image_max_references INTEGER
  CHECK (snap_image_max_references IS NULL OR (snap_image_max_references > 0 AND snap_image_max_references <= 16));
