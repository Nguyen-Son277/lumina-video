-- Keep original generated outputs and derived exact-logo composites separately.
ALTER TABLE assets ADD COLUMN source_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL;
ALTER TABLE assets ADD COLUMN variant TEXT NOT NULL DEFAULT 'original';
CREATE INDEX idx_assets_source_variant ON assets(source_asset_id, variant);
CREATE UNIQUE INDEX idx_assets_logo_derived ON assets(source_asset_id) WHERE variant='logo_overlay' AND source_asset_id IS NOT NULL;
ALTER TABLE generations ADD COLUMN postprocess_status TEXT;
ALTER TABLE generations ADD COLUMN postprocess_error TEXT;
