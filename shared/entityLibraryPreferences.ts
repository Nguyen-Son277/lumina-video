import { z } from 'zod'
import { illustrationQualitySchema, illustrationSizeSchema } from './entityCreation'

/** Only stable account settings belong here; never prompts, sources or media. */
export const entityLibraryPreferencesSettingsSchema = z.object({
  kind: z.enum(['character', 'item', 'logo', 'location']),
  count: z.number().int().min(1).max(6),
  modelId: z.string().trim().max(200),
  imageModelId: z.string().trim().max(200),
  includeImages: z.boolean(),
  autoSave: z.boolean(),
  size: illustrationSizeSchema,
  quality: illustrationQualitySchema,
}).strict()

export type EntityLibraryPreferences = z.infer<typeof entityLibraryPreferencesSettingsSchema>

export const entityLibraryPreferencesDefaults: Readonly<EntityLibraryPreferences> = Object.freeze({
  kind: 'character',
  count: 1,
  modelId: '',
  imageModelId: '',
  includeImages: false,
  autoSave: false,
  size: '1024x1024',
  quality: '',
})

const clearableModelIdSchema = z.string().trim().max(200).nullable().transform(value => value ?? '')

/** Null or empty model ids explicitly clear a selection; omitted fields stay unchanged. */
export const entityLibraryPreferencesPatchSchema = entityLibraryPreferencesSettingsSchema.partial().extend({
  modelId: clearableModelIdSchema.optional(),
  imageModelId: clearableModelIdSchema.optional(),
}).strict()

export type EntityLibraryPreferencesPatch = z.input<typeof entityLibraryPreferencesPatchSchema>

export const entityLibraryPreferencesRequestSchema = z.object({
  version: z.literal(1),
  expectedUserId: z.string().trim().min(1).max(200).optional(),
  settings: entityLibraryPreferencesPatchSchema,
}).strict()
