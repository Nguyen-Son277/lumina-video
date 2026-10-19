import type { Database } from '../db/index'
import {
  emptyQuickPreferences,
  sanitizeQuickSettings,
  type QuickModel,
  type QuickPreferences,
  type QuickSettings,
} from '../../shared/quickGenerationPreferences'

export type QuickMode = 'image' | 'video'

export function getQuickPreferences(db: Database, userId: string): QuickPreferences {
  const rows = db.prepare(
    'SELECT mode, settings_json AS settingsJson FROM quick_generation_preferences WHERE user_id = ?',
  ).all(userId) as Array<{ mode: QuickMode; settingsJson: string }>
  // Include disabled models: provider identity and protocol metadata are still needed
  // to validate old preferences, while the saved account model id remains unchanged.
  const models = db.prepare(
    `SELECT id, model_id AS modelId, video_api_style AS videoApiStyle
       FROM models WHERE user_id = ?`,
  ).all(userId) as QuickModel[]
  const modelById = new Map(models.map(model => [model.id, model]))
  const preferences = emptyQuickPreferences()
  for (const row of rows) {
    try {
      const parsed: unknown = JSON.parse(row.settingsJson)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      const savedModelId = (parsed as Record<string, unknown>).modelId
      const model = typeof savedModelId === 'string' ? modelById.get(savedModelId) : undefined
      let settings: QuickSettings
      if (model) {
        settings = sanitizeQuickSettings(row.mode, parsed, model)
      } else if (row.mode === 'video') {
        // Removed model: infer the supported protocol family from distinctive
        // saved parameters, then still apply the strict protocol sanitizer.
        const params = (parsed as Record<string, unknown>).params
        if (!params || typeof params !== 'object' || Array.isArray(params)) continue
        const keys = Object.keys(params)
        const style = keys.includes('duration')
          ? 'higgsfield'
          : keys.some(key => ['mode', 'seed', 'aspectRatio', 'n'].includes(key))
            ? 'agnes'
            : 'openai'
        settings = sanitizeQuickSettings(row.mode, parsed, {
          id: typeof savedModelId === 'string' ? savedModelId : undefined,
          modelId: typeof savedModelId === 'string' ? savedModelId : '',
          videoApiStyle: style,
        })
      } else {
        settings = sanitizeQuickSettings(row.mode, parsed)
      }
      if (row.mode === 'image') preferences.image = settings as QuickPreferences['image']
      else preferences.video = settings as QuickPreferences['video']
    } catch {
      // A corrupt or pre-sanitizer row is omitted, never returned unsanitized.
    }
  }
  return preferences
}

export function saveQuickPreferences(
  db: Database,
  userId: string,
  mode: QuickMode,
  input: unknown,
): QuickSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Settings must be an object')
  const modelId = (input as Record<string, unknown>).modelId
  if (typeof modelId !== 'string' || !modelId.trim()) throw new Error('A model is required')
  const model = db.prepare(
    `SELECT model_id AS providerModelId, kind, enabled, video_api_style AS videoApiStyle
       FROM models WHERE id = ? AND user_id = ?`,
  ).get(modelId, userId) as ({ providerModelId: string; kind: string; enabled: number } & Pick<QuickModel, 'videoApiStyle'>) | undefined
  if (!model || model.enabled !== 1 || model.kind !== mode) throw new Error('Select an enabled model of the correct type')
  const settings = sanitizeQuickSettings(mode, input, {
    id: modelId,
    modelId: model.providerModelId,
    videoApiStyle: model.videoApiStyle,
  })
  const now = Date.now()
  db.prepare(
    `INSERT INTO quick_generation_preferences (user_id, mode, version, settings_json, updated_at)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(user_id, mode) DO UPDATE SET version = 1, settings_json = excluded.settings_json, updated_at = excluded.updated_at`,
  ).run(userId, mode, JSON.stringify(settings), now)
  return settings
}
