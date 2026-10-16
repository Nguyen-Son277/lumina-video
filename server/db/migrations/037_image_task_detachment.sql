ALTER TABLE image_tasks ADD COLUMN detached_at INTEGER;

-- Recover already-removed planner images without resurrecting their successful results.
UPDATE image_tasks SET detached_at = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE scope = 'planner' AND target_type = 'frame' AND attached_at IS NOT NULL
  AND EXISTS (SELECT 1 FROM plan_sessions s, json_each(s.timeline_json, '$.frames') f
    WHERE s.id = image_tasks.scope_id AND s.user_id = image_tasks.user_id
      AND json_extract(f.value, '$.id') = image_tasks.target_id
      AND json_extract(f.value, '$.background') IS NULL);
