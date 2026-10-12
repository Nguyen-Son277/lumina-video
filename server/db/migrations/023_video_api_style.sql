ALTER TABLE models ADD COLUMN video_api_style TEXT NOT NULL DEFAULT 'openai' CHECK (video_api_style IN ('openai', 'agnes'));
UPDATE models SET video_api_style = 'agnes' WHERE model_id IN ('agnes-video-2.5', 'agnes-video-2.5-flash');
ALTER TABLE generations ADD COLUMN snap_video_style TEXT NOT NULL DEFAULT 'openai' CHECK (snap_video_style IN ('openai', 'agnes'));
ALTER TABLE generations ADD COLUMN provider_result_url TEXT;
