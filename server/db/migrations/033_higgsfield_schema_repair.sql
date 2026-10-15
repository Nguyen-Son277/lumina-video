-- Conditional CHECK repair runs in the migration runner before this SQL.
-- Complete providers left behind by the old post-commit preset insertion.
INSERT INTO models (id,user_id,provider_id,model_id,display_name,kind,enabled,created_at,updated_at,video_api_style)
SELECT lower(hex(randomblob(16))),p.user_id,p.id,'bytedance/seedance-2.5','Seedance 2.5','video',1,p.created_at,p.updated_at,'higgsfield'
FROM provider_connections p
WHERE p.auth_scheme = 'higgsfield'
  AND NOT EXISTS (SELECT 1 FROM models m WHERE m.provider_id = p.id AND m.model_id = 'bytedance/seedance-2.5');
