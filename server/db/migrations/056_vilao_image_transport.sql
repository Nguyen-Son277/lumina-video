-- Vilao documents standard generations and multipart edits, not JSON images.
-- Exact authority or authority followed by a path avoids lookalike hosts.
UPDATE models
   SET image_reference_transport = 'provider_default'
 WHERE kind = 'image' AND provider_id IN (
   SELECT id FROM provider_connections
    WHERE lower(base_url) IN ('https://api.vilao.ai', 'http://api.vilao.ai')
       OR lower(base_url) LIKE 'https://api.vilao.ai/%'
       OR lower(base_url) LIKE 'http://api.vilao.ai/%'
 );

UPDATE provider_connections
   SET image_api_style = 'openai'
 WHERE lower(base_url) IN ('https://api.vilao.ai', 'http://api.vilao.ai')
    OR lower(base_url) LIKE 'https://api.vilao.ai/%'
    OR lower(base_url) LIKE 'http://api.vilao.ai/%';
