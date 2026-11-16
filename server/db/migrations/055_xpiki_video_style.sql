-- Extend video_api_style and snap_video_style CHECK constraints via extendXpikiVideoStyle in runner.
-- Update existing video models belonging to xpiki provider connections to use the xpiki video style.
UPDATE models
   SET video_api_style = 'xpiki'
 WHERE kind = 'video'
   AND provider_id IN (
     SELECT id FROM provider_connections
      WHERE lower(base_url) GLOB '*api.xpiki.com*'
         OR lower(base_url) GLOB '*xpiki.com*'
         OR lower(name) = 'xpiki'
   );
