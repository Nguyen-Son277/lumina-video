import { z } from 'zod'

const libraryAssetKindSchema = z.enum(['item', 'location', 'logo'])
const requiredIdSchema = z.string().trim().min(1)

export const libraryCandidateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  handle: z.string().trim().min(1).max(80),
  description: z.string().max(5000),
  continuityNotes: z.string().max(5000),
}).strict()

export const assetGenerateSchema = z.object({
  kind: libraryAssetKindSchema,
  description: z.string().trim().max(2000).default(''),
  count: z.number().int().min(1).max(6).default(3),
  language: z.string().trim().min(1).max(50).default('vi'),
  modelId: requiredIdSchema,
  sourceUploadId: requiredIdSchema.optional(),
}).strict().superRefine((input, ctx) => {
  if (!input.description && !input.sourceUploadId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['description'],
      message: 'A description or source upload is required.',
    })
  }
  if (input.sourceUploadId && input.count !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['count'],
      message: 'Source-based generation requires a count of 1.',
    })
  }
})

export const assetIllustrationSchema = z.object({
  kind: libraryAssetKindSchema,
  modelId: requiredIdSchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5000),
  continuityNotes: z.string().max(5000).optional(),
  sourceUploadId: requiredIdSchema.optional(),
  autoSave: z.boolean().default(false),
  idempotencyKey: z.string().max(100).optional(),
}).strict()

export type LibraryCandidate = z.infer<typeof libraryCandidateSchema>
export type AssetGenerateInput = z.input<typeof assetGenerateSchema>
export type AssetIllustrationInput = z.input<typeof assetIllustrationSchema>
export type NormalizedAssetGenerateInput = z.output<typeof assetGenerateSchema>
export type NormalizedAssetIllustrationInput = z.output<typeof assetIllustrationSchema>

export interface AssetGenerateResult {
  candidates: LibraryCandidate[]
  modelId: string
  model: string
}
