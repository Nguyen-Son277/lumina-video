import { z } from 'zod'

export const SPEECH_MAX_INPUT = 20_000
export const speechScopeSchema = z.object({
  projectId: z.string().min(1).optional(),
  quickSessionId: z.string().min(1).optional(),
}).strict().refine(value => !(value.projectId && value.quickSessionId), 'Choose one speech scope')

export type SpeechScope = z.infer<typeof speechScopeSchema>
export const speechInputSchema = z.object({
  modelId: z.string().min(1),
  input: z.string().trim().min(1).max(SPEECH_MAX_INPUT),
  projectId: z.string().min(1).optional(),
  quickSessionId: z.string().min(1).optional(),
}).strict().refine(value => !(value.projectId && value.quickSessionId), 'Choose one speech scope')
export type SpeechInput = z.infer<typeof speechInputSchema>

const audioSettings = {
  mode: z.enum(['replace', 'mix']).default('replace'),
  originalVolume: z.number().min(0).max(1).default(0.15),
}
export const narrationSchema = z.union([
  z.object({ speechJobId: z.string().min(1), ...audioSettings }).strict(),
  z.object({ modelId: z.string().min(1), input: z.string().trim().min(1).max(SPEECH_MAX_INPUT), ...audioSettings }).strict(),
])
export type NarrationInput = z.input<typeof narrationSchema>
export type NarrationSnapshot = { speechJobId: string; mode: 'replace' | 'mix'; originalVolume: number }

export const narrationPreferencesSchema = z.object({
  enabled: z.boolean().default(false),
  modelId: z.string().min(1).nullable().default(null),
  input: z.string().max(SPEECH_MAX_INPUT).default(''),
  ...audioSettings,
}).strict()
export type NarrationPreferences = z.infer<typeof narrationPreferencesSchema>
export const defaultNarrationPreferences = (): NarrationPreferences => narrationPreferencesSchema.parse({})

export type SpeechStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'unknown'
export type ExportStage = 'queued' | 'speech' | 'stitching' | 'succeeded' | 'failed'
export type SpeechJob = {
  id: string
  projectId: string | null
  quickSessionId: string | null
  modelId: string | null
  model: string
  provider: string
  input: string
  status: SpeechStatus
  durationSeconds: number | null
  byteSize: number | null
  mimeType: string | null
  url: string | null
  downloadUrl: string | null
  errorCode: string | null
  errorMessage: string | null
  errorMessageKey: string | null
  errorMessageParams: Record<string, string | number> | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
}
