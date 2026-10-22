import { z } from 'zod'
import { IMAGE_EDITOR_LIMITS as L, type ImageEditorRequest } from '../../shared/imageEditor'
import { badRequest, validationError } from '../lib/errors'
const id = z.string().min(1).max(200)
export const sourceSchema = z.union([
  z.object({ kind: z.enum(['upload','asset']), id }).strict(),
  z.object({ kind: z.literal('entity'), entityKind: z.enum(['character','item','logo','location']), id, revision: z.number().int().nonnegative(), viewId: id.optional() }).strict(),
])
const unit = z.number().finite().min(0).max(1)
const point = z.object({ x: unit, y: unit }).strict()
const erase = z.boolean().optional()
const shape = z.union([
  z.object({ kind: z.enum(['rect','ellipse']), x: unit, y: unit, width: unit.gt(0), height: unit.gt(0), erase }).strict().refine(s => s.x + s.width <= 1.00000001 && s.y + s.height <= 1.00000001, 'Shape must fit source'),
  z.object({ kind: z.literal('polygon'), points: z.array(point).min(3).max(L.maxPointsPerShape), erase }).strict(),
  z.object({ kind: z.literal('brush'), points: z.array(point).min(1).max(L.maxPointsPerShape), radius: unit.gt(0).max(.5), erase }).strict(),
])
const color = z.string().regex(/^#[a-fA-F0-9]{6}$/)
const dimension = z.number().int().min(1).max(L.maxDimension)
export const editorRequestSchema = z.object({
  source: sourceSchema, operation: z.enum(['region','reframe','background']), engine: z.enum(['local','provider']),
  modelId: id.optional(), prompt: z.string().max(L.maxPromptLength).optional(),
  regions: z.array(z.object({ id, comment: z.string().trim().min(1).max(L.maxCommentLength), shapes: z.array(shape).min(1).max(L.maxShapesPerRegion) }).strict()).max(L.maxRegions).optional(),
  frame: z.object({ width: dimension, height: dimension, offsetX: z.number().int().min(0).max(L.maxDimension), offsetY: z.number().int().min(0).max(L.maxDimension), background: z.union([color,z.literal('transparent')]), scale: z.number().finite().gt(0).max(1).optional() }).strict().optional(),
  background: z.object({ mode: z.enum(['remove','replace']), color: color.optional(), prompt: z.string().trim().max(L.maxPromptLength).optional() }).strict().optional(),
  idempotencyKey: z.string().min(1).max(100).optional(),
}).strict().superRefine((v, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message })
  if (v.engine === 'provider' && !v.modelId) issue('Choose an image model')
  if (v.operation === 'region' && (v.engine !== 'provider' || !v.regions?.length)) issue('Region edits require a provider and regions')
  if (v.operation === 'reframe' && !v.frame) issue('Reframe requires a frame')
  if (v.operation === 'background' && !v.background) issue('Background settings required')
  if (v.operation !== 'region' && v.regions?.length) issue('Regions only allowed for region edits')
  if (v.operation !== 'reframe' && v.frame) issue('Frame only allowed for reframe')
  if (v.operation !== 'background' && v.background) issue('Background settings only allowed for background edits')
  if (v.regions && new Set(v.regions.map(r=>r.id)).size !== v.regions.length) issue('Region IDs must be unique')
  if ((v.regions ?? []).reduce((n,r)=>n+r.comment.length,0)>L.maxTotalCommentLength) issue('Comments too long')
  if ((v.regions ?? []).flatMap(r=>r.shapes).reduce((n,s)=>n+('points' in s?s.points.length:0),0)>L.maxTotalPoints) issue('Too many points')
  if (v.frame && v.frame.width*v.frame.height>L.maxPixels) issue('Frame exceeds pixel limit')
  if (v.engine==='local' && v.background?.mode==='replace' && !v.background.color) issue('Local replacement requires a color')
})
export function parseEditorRequest(input: unknown): ImageEditorRequest {
  const result=editorRequestSchema.safeParse(input)
  if (!result.success) throw validationError(result.error)
  return result.data
}
export function validateFrame(request: ImageEditorRequest, width: number, height: number): void {
  const f=request.frame
  const sw=Math.max(1,Math.round(width*(f?.scale??1))),sh=Math.max(1,Math.round(height*(f?.scale??1)))
  if(f && (f.width<sw || f.height<sh || f.offsetX+sw>f.width || f.offsetY+sh>f.height)) throw badRequest('Frame must contain the whole source at the explicitly selected scale')
}
