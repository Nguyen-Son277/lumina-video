-- NexusMMO/new-api declares input_reference as a plain string and rejects
-- the legacy OpenAI object form. Backfill existing providers created before
-- automatic host inference was introduced; explicit overrides remain available
-- through the provider PATCH endpoint after this migration.
UPDATE provider_connections
   SET video_reference_style = 'image_url_string'
 WHERE lower(base_url) GLOB 'http://api.nexusmmo.store*'
    OR lower(base_url) GLOB 'https://api.nexusmmo.store*';
