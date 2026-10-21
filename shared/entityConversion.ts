import { z } from 'zod'

export const conversionVoiceSchema = z.object({
  language: z.string().trim().max(200).optional(), accent: z.string().trim().max(200).optional(),
  pitch: z.string().trim().max(200).optional(), timbre: z.string().trim().max(500).optional(),
  pace: z.string().trim().max(200).optional(), articulation: z.string().trim().max(500).optional(),
  habits: z.string().trim().max(1000).optional(),
}).strict()
export const entityConversionSchema = z.object({
  targetKind: z.enum(['character', 'item', 'logo', 'location']),
  expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5000),
  continuityNotes: z.string().max(5000).optional(),
  voice: conversionVoiceSchema.optional(),
}).strict().refine(input => input.targetKind !== 'character' || input.description.length <= 4000, {
  path: ['description'], message: 'Mô tả ngoại hình nhân vật tối đa 4000 ký tự',
})
export type EntityConversionInput = z.infer<typeof entityConversionSchema>
export type EntityConversionData = {
  revision: number
  voice: z.infer<typeof conversionVoiceSchema>
  continuityNotes: string
  referenceViews: Array<{ id: string; label: string; uploadId: string; sheet: boolean }>
}
