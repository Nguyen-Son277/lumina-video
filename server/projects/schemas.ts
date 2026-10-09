import { z } from 'zod'

const text = (max: number) => z.string().trim().max(max)
export const voiceSchema = z.object({
  language: text(200).optional(), accent: text(200).optional(), pitch: text(200).optional(),
  timbre: text(500).optional(), pace: text(200).optional(), articulation: text(500).optional(),
  habits: text(1000).optional(),
}).strict()
export type Voice = z.infer<typeof voiceSchema>
export const projectSchema = z.object({
  name: text(200).min(1), description: text(4000).default(''), style: text(2000).default(''),
  language: text(200).default('vi'), archived: z.boolean().default(false),
}).strict()
export const characterSchema = z.object({
  name: text(200).min(1), appearance: text(4000).default(''), voice: voiceSchema.default({}),
}).strict()
/** Số nhân vật tối đa xuất hiện trong một cảnh. */
const MAX_SCENE_CHARACTERS = 12

export const sceneSchema = z.object({
  title: text(200).min(1), prompt: text(8000).default(''), characterId: z.string().min(1).nullable().default(null),
  dialogue: z.string().max(4000).default(''), modelId: z.string().min(1).nullable().default(null),
  params: z.record(z.string(), z.unknown()).default({}), position: z.number().int().nonnegative().optional(),
  locationId: z.string().min(1).nullable().optional(),
  selectedGenerationId: z.string().min(1).nullable().optional(),
  /** Ảnh minh hoạ storyboard: null để bỏ, bỏ trống để giữ nguyên. */
  backgroundUploadId: z.string().min(1).nullable().optional(),
  /** Bối cảnh/không gian của cảnh, ghép vào prompt khi tạo nội dung. */
  background: text(2000).default(''),
  /**
   * Toàn bộ nhân vật xuất hiện trong cảnh, theo thứ tự.
   * Người nói chính (`characterId`) phải nằm trong danh sách này.
   */
  characterIds: z.array(z.string().min(1)).max(MAX_SCENE_CHARACTERS).optional(),
  /** Cổng duyệt: chỉ cảnh đã duyệt mới được xếp hàng tạo nội dung. */
  approved: z.boolean().optional(),
  /** Đánh dấu cảnh sẽ được xếp hàng tạo ngay khi được duyệt. */
  autoGenerate: z.boolean().optional(),
}).strict()
export const projectPatchSchema = z.object({ name: text(200).min(1).optional(), description: text(4000).optional(), style: text(2000).optional(), language: text(200).optional(), archived: z.boolean().optional() }).strict()
export const characterPatchSchema = z.object({ name: text(200).min(1).optional(), appearance: text(4000).optional(), voice: voiceSchema.optional() }).strict()
export const scenePatchSchema = z.object({
  title: text(200).min(1).optional(), prompt: text(8000).optional(), characterId: z.string().min(1).nullable().optional(),
  dialogue: z.string().max(4000).optional(), modelId: z.string().min(1).nullable().optional(), params: z.record(z.string(), z.unknown()).optional(),
  locationId: z.string().min(1).nullable().optional(),
  selectedGenerationId: z.string().min(1).nullable().optional(),
  backgroundUploadId: z.string().min(1).nullable().optional(),
  background: text(2000).optional(),
  characterIds: z.array(z.string().min(1)).max(MAX_SCENE_CHARACTERS).optional(),
  approved: z.boolean().optional(),
  autoGenerate: z.boolean().optional(),
}).strict()
