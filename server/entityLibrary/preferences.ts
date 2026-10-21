import { Router } from 'express'
import {
  entityLibraryPreferencesDefaults,
  entityLibraryPreferencesPatchSchema,
  entityLibraryPreferencesRequestSchema,
  type EntityLibraryPreferences,
} from '../../shared/entityLibraryPreferences'
import { requireUser } from '../auth/middleware'
import type { Database } from '../db/index'
import { badRequest, validationError } from '../lib/errors'

/** Reading never depends on the continued existence or enabled state of a model. */
export function getEntityLibraryPreferences(db: Database, userId: string): EntityLibraryPreferences {
  const row = db.prepare(
    'SELECT version, settings_json AS settingsJson FROM entity_library_preferences WHERE user_id = ?',
  ).get(userId) as { version: number; settingsJson: string } | undefined
  if (row?.version === 1) {
    try {
      const result = entityLibraryPreferencesPatchSchema.safeParse(JSON.parse(row.settingsJson))
      if (result.success) return { ...entityLibraryPreferencesDefaults, ...result.data }
    } catch {
      // Corrupt or pre-sanitizer rows must never expose transient/unknown fields.
    }
  }
  return { ...entityLibraryPreferencesDefaults }
}

export function patchEntityLibraryPreferences(
  db: Database,
  userId: string,
  input: unknown,
): EntityLibraryPreferences {
  const result = entityLibraryPreferencesPatchSchema.safeParse(input)
  if (!result.success) throw validationError(result.error)
  const patch = result.data
  const current = getEntityLibraryPreferences(db, userId)

  // Only a changed, nonempty selection must still be an owned enabled model.
  // An unrelated partial update must not discard or reject a stale saved model.
  for (const [key, kind] of [['modelId', 'llm'], ['imageModelId', 'image']] as const) {
    const modelId = patch[key]
    if (!modelId || modelId === current[key]) continue
    const model = db.prepare(
      'SELECT id FROM models WHERE id = ? AND user_id = ? AND kind = ? AND enabled = 1',
    ).get(modelId, userId, kind)
    if (!model) throw badRequest('Hãy chọn model đang bật, thuộc tài khoản và đúng loại')
  }

  const settings = { ...current, ...patch }
  db.prepare(
    `INSERT INTO entity_library_preferences (user_id, version, settings_json, updated_at)
     VALUES (?, 1, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET version = 1,
       settings_json = excluded.settings_json, updated_at = excluded.updated_at`,
  ).run(userId, JSON.stringify(settings), Date.now())
  return settings
}

/** Mount under /api/entity-library/preferences; authentication uses the parent app. */
export function entityLibraryPreferencesRoutes(db: Database): Router {
  const router = Router()
  router.get('/', (req, res) => {
    const user = requireUser(req)
    res.json({ userId: user.id, settings: getEntityLibraryPreferences(db, user.id) })
  })
  router.patch('/', (req, res) => {
    const user = requireUser(req)
    const result = entityLibraryPreferencesRequestSchema.safeParse(req.body)
    if (!result.success) throw validationError(result.error)
    if (result.data.expectedUserId && result.data.expectedUserId !== user.id) throw badRequest('Phiên tài khoản đã thay đổi. Hãy mở lại biểu mẫu.')
    if (Buffer.byteLength(JSON.stringify(req.body), 'utf8') > 16 * 1024) {
      throw badRequest('Dữ liệu cài đặt quá lớn')
    }
    res.json({ settings: patchEntityLibraryPreferences(db, user.id, result.data.settings) })
  })
  return router
}
