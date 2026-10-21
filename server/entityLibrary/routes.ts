import express, { Router } from 'express'
import { z } from 'zod'
import { assetGenerateSchema, assetIllustrationSchema } from '../../shared/entityCreation'
import type { Worker } from '../generations/worker'
import { enqueueGeneration } from '../generations/enqueue'
import { generationPublic } from '../generations/routes'
import { prepareCharacterSourceImage } from '../characters/sourceImage'
import { buildLibraryIllustrationPrompt, generateLibraryCandidates } from './generate'
import type { Database } from '../db/index'
import type { AppEnv } from '../env'
import type { MediaStore } from '../media/store'
import { requireUser } from '../auth/middleware'
import { badRequest, notFound, tooManyRequests, validationError } from '../lib/errors'
import { createRateLimiter } from '../lib/rateLimit'
import { analyzeExistingLibraryReference, analyzeLibraryReference } from './analyze'
import { entityLibraryPreferencesRoutes } from './preferences'
import { entityConversionSchema } from '../../shared/entityConversion'
import { convertEntity, getEntityConversionData } from './conversion'
import {
  attachLibraryAssetFromGeneration, createLibraryAsset,
  listEntityCatalog, listLibraryAssets, ownedLibraryAsset,
  patchLibraryAsset, saveLibraryAssetReference, setLibraryAssetReference,
  softDeleteLibraryAsset, updateEntityHandle, resolveEntity,
  type EntityKind, type LibraryAssetKind,
} from './service'

const assetCreateSchema = z.object({
  kind: z.enum(['item', 'logo', 'location']), name: z.string().trim().min(1).max(200),
  description: z.string().max(5000).optional(), continuityNotes: z.string().max(5000).optional(),
  handle: z.string().trim().min(1).max(80).optional(), autoHandle: z.boolean().optional(),
}).strict()
const assetPatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(), description: z.string().max(5000).optional(),
  continuityNotes: z.string().max(5000).optional(), revision: z.number().int().positive().optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'Cần ít nhất một trường để cập nhật')
const handleSchema = z.object({ handle: z.string().trim().min(1).max(80) }).strict()
const generationSchema = z.object({ generationId: z.string().trim().min(1), assetId: z.string().trim().min(1).optional() }).strict()
const analyzeQuerySchema = z.object({ kind: z.enum(['item', 'logo', 'location']), modelId: z.string().trim().min(1).max(200) }).strict()
const analyzeBodySchema = z.object({ modelId: z.string().trim().min(1).max(200) }).strict()
const kinds = new Set<EntityKind>(['character', 'item', 'logo', 'location'])
const catalogQuerySchema = z.object({ projectId: z.string().trim().min(1).max(200).optional() }).strict()
const assetQuerySchema = z.object({
  kind: z.enum(['item','logo','location']).optional(), search: z.string().trim().max(500).optional(),
  limit: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().min(1).max(100)).optional(),
  offset: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)).optional(),
}).strict()
function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body)
  if (!result.success) throw validationError(result.error)
  return result.data
}

/** Account-wide catalog for reusable characters, items and logos. */
export function entityLibraryRoutes(db: Database, env: AppEnv, mediaStore: MediaStore, worker: Worker): Router {
  const router = Router()
  router.use('/preferences', entityLibraryPreferencesRoutes(db))
  const rawImage = express.raw({ type: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], limit: env.MAX_REFERENCE_BYTES })
  function publicEntity(entity: ReturnType<typeof createLibraryAsset>) {
    return { ...entity, reference: entity.reference ? { mime: entity.reference.mime, uploadId: entity.reference.uploadId, url: entity.kind === 'character' ? `/api/characters/${encodeURIComponent(entity.id)}/reference` : `/api/entity-library/assets/${encodeURIComponent(entity.id)}/reference` } : null }
  }

  const analysisLimiter = createRateLimiter({ windowMs: 60_000, max: env.RATE_LIMIT_LLM_CHAT_PER_MIN || Number.MAX_SAFE_INTEGER })
  const limitAnalysis: express.RequestHandler = (req, _res, next) => {
    const user = requireUser(req)
    if (!analysisLimiter.check(user.id)) throw tooManyRequests()
    next()
  }
  router.post('/generate', limitAnalysis, async (req, res) => {
    const user = requireUser(req)
    const input = parse(assetGenerateSchema, req.body)
    res.json(await generateLibraryCandidates({ db, env, mediaStore, userId: user.id, input }))
  })
  router.post('/illustrations', async (req, res) => {
    const user = requireUser(req)
    const input = parse(assetIllustrationSchema, req.body)
    if (!db.prepare("SELECT id FROM models WHERE id=? AND user_id=? AND kind='image' AND enabled=1").get(input.modelId, user.id)) {
      throw badRequest('Model đã chọn không hợp lệ hoặc chưa được phân loại thành tạo ảnh.')
    }
    if (input.sourceUploadId) await prepareCharacterSourceImage({ db, env, mediaStore, userId: user.id, sourceUploadId: input.sourceUploadId })
    const outcome = enqueueGeneration({ db, env, mediaStore, worker, userId: user.id, request: {
      data: {
        modelId: input.modelId, prompt: buildLibraryIllustrationPrompt(input),
        params: { n: 1, ...(input.size ? { size: input.size } : {}), ...(input.quality ? { quality: input.quality } : {}) },
        sourceUploadIds: input.sourceUploadId ? [input.sourceUploadId] : undefined,
        idempotencyKey: input.idempotencyKey,
        imagePurpose: input.autoSave ? { kind: input.kind, name: input.name, description: input.description, continuityNotes: input.continuityNotes } : undefined,
      }, scene: null,
    } })
    res.status(201).json({ generation: generationPublic(outcome.generation) })
  })
  router.post('/analyze-reference', limitAnalysis, rawImage, async (req, res) => {
    const user = requireUser(req)
    const input = parse(analyzeQuerySchema, req.query)
    if (!Buffer.isBuffer(req.body) || !req.body.byteLength) throw badRequest('Không nhận được ảnh tham chiếu')
    res.json(await analyzeLibraryReference({ db, env, userId: user.id, ...input, bytes: req.body }))
  })
  router.post('/assets/:id/analyze-reference', limitAnalysis, async (req, res) => {
    const user = requireUser(req)
    const input = parse(analyzeBodySchema, req.body)
    res.json(await analyzeExistingLibraryReference({ db, env, mediaStore, userId: user.id, assetId: String(req.params.id), ...input }))
  })

  router.get('/', (req, res) => {
    const user = requireUser(req)
    const query = parse(catalogQuerySchema, req.query)
    res.json({ entities: listEntityCatalog(db, user.id, query.projectId).map(publicEntity) })
  })

  router.post('/assets', (req, res) => {
    const user = requireUser(req)
    res.status(201).json({ asset: publicEntity(createLibraryAsset(db, user.id, parse(assetCreateSchema, req.body))) })
  })

  router.get('/assets', (req, res) => {
    const user = requireUser(req)
    const result = listLibraryAssets(db, user.id, parse(assetQuerySchema, req.query))
    res.json({ ...result, assets: result.assets.map(publicEntity) })
  })

  router.get('/assets/:id', (req, res) => {
    const user = requireUser(req)
    const row = ownedLibraryAsset(db, user.id, req.params.id)
    res.json({ asset: publicEntity(resolveEntity(db, user.id, { kind: row.kind, id: row.id })) })
  })
  router.patch('/assets/:id', (req, res) => {
    const user = requireUser(req)
    res.json({ asset: publicEntity(patchLibraryAsset(db, user.id, req.params.id, parse(assetPatchSchema, req.body))) })
  })
  router.delete('/assets/:id', (req, res) => {
    const user = requireUser(req)
    softDeleteLibraryAsset(db, user.id, req.params.id)
    res.status(204).end()
  })

  router.get('/assets/:id/reference', (req, res) => {
    const user = requireUser(req)
    const asset = ownedLibraryAsset(db, user.id, req.params.id)
    if (!asset.reference_upload_id) throw notFound('Vật phẩm chưa có ảnh tham chiếu')
    const upload = db.prepare('SELECT relative_path, mime_type FROM uploads WHERE id=? AND user_id=?').get(asset.reference_upload_id, user.id) as { relative_path: string; mime_type: string } | undefined
    if (!upload || !mediaStore.exists(upload.relative_path)) throw notFound('Ảnh tham chiếu không còn trên máy chủ')
    res.setHeader('Content-Type', upload.mime_type)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate')
    mediaStore.openReadStream(upload.relative_path).pipe(res)
  })
  router.post('/assets/:id/reference', rawImage, (req, res) => {
    const user = requireUser(req)
    const body = req.body as Buffer | undefined
    if (!body?.byteLength) throw badRequest('Không nhận được ảnh tham chiếu')
    res.status(201).json({ asset: publicEntity(saveLibraryAssetReference(db, env, mediaStore, user.id, req.params.id, new Uint8Array(body))) })
  })
  router.delete('/assets/:id/reference', (req, res) => {
    const user = requireUser(req)
    res.json({ asset: publicEntity(setLibraryAssetReference(db, user.id, req.params.id, null)) })
  })
  router.post('/assets/:id/reference/from-generation', (req, res) => {
    const user = requireUser(req)
    const input = parse(generationSchema, req.body)
    res.status(201).json({ asset: publicEntity(attachLibraryAssetFromGeneration(db, env, mediaStore, user.id, req.params.id, input)) })
  })

  router.get('/:kind/:id/conversion-data', (req, res) => {
    const user = requireUser(req)
    if (!kinds.has(req.params.kind as EntityKind)) throw badRequest('kind không hợp lệ')
    res.json(getEntityConversionData(db, user.id, { kind: req.params.kind as EntityKind, id: req.params.id }))
  })
  router.post('/:kind/:id/convert', (req, res) => {
    const user = requireUser(req)
    if (!kinds.has(req.params.kind as EntityKind)) throw badRequest('kind không hợp lệ')
    const entity = convertEntity(db, env, mediaStore, user.id, { kind: req.params.kind as EntityKind, id: req.params.id }, parse(entityConversionSchema, req.body))
    res.json({ entity: publicEntity(entity) })
  })

  router.patch('/:kind/:id/handle', (req, res) => {
    const user = requireUser(req)
    if (!kinds.has(req.params.kind as EntityKind)) throw badRequest('kind không hợp lệ')
    const input = parse(handleSchema, req.body)
    res.json({ entity: publicEntity(updateEntityHandle(db, user.id, { kind: req.params.kind as EntityKind, id: req.params.id }, input.handle)) })
  })

  return router
}
