import { z } from 'zod'

/** Independent publication metadata; never appended to a generation prompt. */
export const imagePurposeSchema = z.object({
  kind: z.enum(['item', 'logo', 'location']),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5000).optional(),
  continuityNotes: z.string().max(5000).optional(),
}).strict()
export type ImagePurpose = z.infer<typeof imagePurposeSchema>
export type LibraryPublishStatus = 'queued' | 'succeeded' | 'failed'
export type ImagePublication = { sourceAssetId: string; assetId: string; targetKind: ImagePurpose['kind']; targetId: string }
