import { randomUUID } from 'node:crypto'
import express, { Router } from 'express'
import { z } from 'zod'
import type { AppEnv } from '../env'
import type { Database } from '../db/index'
import type { MediaStore } from '../media/store'
import type { Worker } from '../generations/worker'
import { AppError, badRequest, notFound, validationError } from '../lib/errors'
import { requireUser } from '../auth/middleware'
import { ownedProject, sceneGenerationContext } from '../projects/service'
import { adoptGenerationImage } from '../planner/storyboard'
import { enqueueGeneration } from '../generations/enqueue'
import type { CanvasGraph, CanvasNode } from '../../shared/canvas'
import { CANVAS_LIMITS } from '../../shared/canvas'
import {
  canvasStamp,
  createItem,
  itemPublic,
  listItems,
  listRuns,
  ownedItem,
  readCanvas,
  recordRun,
  removeItem,
  updateItem,
  writeCanvas,
} from './service'
import { assertMentionsResolved, compileCanvasPrompt } from './compiler'
import { renderComposite, type CompositeSource } from './composite'
import { canvasAliases, contextObjectsFor, planCanvasInputs, resolveCanvasObjects } from './resolve'

/** Số vật phẩm tối đa của một dự án, đủ rộng cho một bộ sản phẩm/đạo cụ. */
const MAX_ITEMS = 60

const itemSchema = z.object({
  kind: z.enum(['product', 'prop']),
  name: z.string().trim().min(1, 'Vui lòng nhập tên sản phẩm hoặc đạo cụ').max(200),
  description: z.string().max(4000).optional(),
  continuityNotes: z.string().max(4000).optional(),
  imagePrompt: z.string().max(4000).optional(),
  referenceUploadId: z.string().min(1).nullable().optional(),
})

const itemPatchSchema = itemSchema.partial()

const canvasSchema = z.object({
  graph: z.unknown(),
  baseRevision: z.number().int().nonnegative(),
  scenePatch: z.object({
    sceneId: z.string().min(1),
    prompt: z.string().max(8000).optional(),
    dialogue: z.string().max(4000).optional(),
  }).optional(),
})

const previewSchema = z.object({ kind: z.enum(['image', 'video']) })

const runSchema = z.object({
  kind: z.enum(['image', 'video']),
  modelId: z.string().min(1).optional(),
  sceneId: z.string().min(1).nullable().optional(),
  stamp: z.string().min(1),
  idempotencyKey: z.string().max(100).optional(),
})

const itemIllustrationSchema = z.object({
  modelId: z.string().trim().min(1, 'Vui lòng chọn model tạo ảnh'),
})

/** Prompt ảnh cho sản phẩm/đạo cụ, dựng ở server để mọi lối vào dùng một chuẩn. */
export function buildItemSheetPrompt(item: { name: string; description: string; imagePrompt: string }): string {
  const parts: string[] = []
  if (item.description.trim()) parts.push(`Ngoại hình: ${item.description.trim()}`)
  if (item.imagePrompt.trim()) parts.push(`Yêu cầu riêng: ${item.imagePrompt.trim()}`)
  parts.push(
    'Một vật thể duy nhất ở chính giữa khung, góc nhìn 3/4 rõ ràng, nền trung tính sáng, ánh sáng mềm và đều, chi tiết cao, ảnh chụp sản phẩm chân thực',
    'Không có chữ, nhãn hiệu, watermark hay người trong ảnh; không thêm vật thể khác',
  )
  return [`Ảnh sản phẩm/đạo cụ "${item.name.trim()}"`, ...parts].join('. ') + '.'
}

/** Express 5 có thể trả mảng cho tham số lặp; chỉ nhận một id. */
function single(value: unknown, label: string): string {
  const id = Array.isArray(value) ? value[0] : value
  if (typeof id !== 'string' || !id) throw badRequest(`Thiếu ${label}`)
  return id
}

/**
 * Canvas của dự án Studio: vật phẩm/đạo cụ, đồ thị node và chạy ảnh/video.
 *
 * Trả hai router để gắn vào `/api/projects/:id/items` và `/api/projects/:id/canvas`.
 * Preview và run đọc lại graph đã lưu nên không có đường nào để client tự đặt prompt
 * hiệu lực, đường dẫn media hay nguồn ngoài dự án.
 */
export function canvasRoutes(
  db: Database,
  env: AppEnv,
  mediaStore: MediaStore,
  worker: Worker,
): { items: Router; board: Router } {
  const items = Router({ mergeParams: true })
  const board = Router({ mergeParams: true })
  const rawImage = express.raw({
    type: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    limit: env.MAX_REFERENCE_BYTES,
  })

  const projectIdOf = (req: express.Request): string => single(req.params.id, 'dự án')

  /** Tải ảnh thô vào kho uploads của tài khoản (ảnh tham chiếu vật phẩm). */
  function saveUploadBytes(userId: string, bytes: Uint8Array): string {
    const uploadId = randomUUID()
    const saved = mediaStore.saveUpload({ userId, uploadId, bytes, maxBytes: env.MAX_REFERENCE_BYTES })
    db.prepare(
      'INSERT INTO uploads (id, user_id, relative_path, mime_type, byte_size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(uploadId, userId, saved.relativePath, saved.mimeType, saved.byteSize, Date.now())
    return uploadId
  }

  function requireNode(userId: string, projectId: string, nodeId: string): { graph: CanvasGraph; node: CanvasNode } {
    const canvas = readCanvas(db, userId, projectId)
    const node = canvas.graph.nodes.find((item) => item.id === nodeId)
    if (!node) throw notFound('Không tìm thấy node trong bảng Canvas')
    return { graph: canvas.graph, node }
  }

  function compile(userId: string, projectId: string, graph: CanvasGraph, node: CanvasNode, strict: boolean) {
    const objects = contextObjectsFor(db, userId, projectId, graph, node.id)
    const project = ownedProject(db, userId, projectId)
    const compiled = compileCanvasPrompt({
      graph,
      node,
      objects,
      projectStyle: project.style,
      aspectRatio: node.data?.layout?.aspectRatio,
    })
    if (!compiled.prompt.trim()) throw badRequest('Node chưa có nội dung để gửi', undefined, { messageKey: 'canvas.prompt_empty' })
    const planned = planCanvasInputs(compiled, env.MAX_SOURCE_IMAGES, strict)
    return { compiled, planned }
  }

  /* ------------------------------- vật phẩm ------------------------------- */

  items.get('/', (req, res) => {
    const user = requireUser(req)
    res.json({ items: listItems(db, user.id, projectIdOf(req)).map(itemPublic) })
  })

  items.post('/', (req, res) => {
    const user = requireUser(req)
    const projectId = projectIdOf(req)
    const parsed = itemSchema.safeParse(req.body)
    if (!parsed.success) throw validationError(parsed.error)
    if (listItems(db, user.id, projectId).length >= MAX_ITEMS) {
      throw badRequest(`Mỗi dự án tối đa ${MAX_ITEMS} sản phẩm/đạo cụ`, undefined, {
        messageKey: 'canvas.items_limit',
        messageParams: { max: MAX_ITEMS },
      })
    }
    res.status(201).json({ item: itemPublic(createItem(db, user.id, projectId, parsed.data)) })
  })

  items.patch('/:itemId', (req, res) => {
    const user = requireUser(req)
    const parsed = itemPatchSchema.safeParse(req.body)
    if (!parsed.success) throw validationError(parsed.error)
    if (Object.keys(parsed.data).length === 0) throw badRequest('Không có thay đổi nào để lưu')
    const projectId = projectIdOf(req)
    res.json({ item: itemPublic(updateItem(db, user.id, projectId, single(req.params.itemId, 'vật phẩm'), parsed.data)) })
  })

  items.delete('/:itemId', (req, res) => {
    const user = requireUser(req)
    removeItem(db, user.id, projectIdOf(req), single(req.params.itemId, 'vật phẩm'))
    res.status(204).end()
  })

  /** Tải ảnh tham chiếu lên; nhận dạng bằng magic bytes như ảnh nhân vật. */
  items.post('/:itemId/reference', rawImage, (req, res) => {
    const user = requireUser(req)
    const projectId = projectIdOf(req)
    const item = ownedItem(db, user.id, projectId, single(req.params.itemId, 'vật phẩm'))
    const body = req.body as Buffer | undefined
    if (!body || body.byteLength === 0) throw badRequest('Không nhận được nội dung ảnh tham chiếu')
    const uploadId = saveUploadBytes(user.id, new Uint8Array(body))
    res.status(201).json({ item: itemPublic(updateItem(db, user.id, projectId, item.id, { referenceUploadId: uploadId })) })
  })

  items.delete('/:itemId/reference', (req, res) => {
    const user = requireUser(req)
    const projectId = projectIdOf(req)
    const item = ownedItem(db, user.id, projectId, single(req.params.itemId, 'vật phẩm'))
    // Ảnh đang được Canvas dùng thì phải gỡ khỏi bảng trước, tránh node trỏ vào tệp đã xoá.
    if (item.reference_upload_id) {
      const linked = db.prepare('SELECT node_id FROM project_canvas_links WHERE upload_id = ? LIMIT 1').get(item.reference_upload_id)
      if (linked) throw badRequest('Ảnh này đang được Canvas sử dụng. Gỡ khỏi bảng Canvas trước khi bỏ ảnh.')
    }
    res.json({ item: itemPublic(updateItem(db, user.id, projectId, item.id, { referenceUploadId: null })) })
  })

  /** Gắn một ảnh đã tạo thành ảnh tham chiếu của vật phẩm. */
  items.post('/:itemId/reference/from-generation', (req, res) => {
    const user = requireUser(req)
    const projectId = projectIdOf(req)
    const item = ownedItem(db, user.id, projectId, single(req.params.itemId, 'vật phẩm'))
    const parsed = z.object({ generationId: z.string().min(1), assetId: z.string().min(1).optional() }).safeParse(req.body)
    if (!parsed.success) throw validationError(parsed.error)
    const uploadId = adoptGenerationImage({ db, env, mediaStore }, user.id, parsed.data.generationId, parsed.data.assetId)
    res.status(201).json({ item: itemPublic(updateItem(db, user.id, projectId, item.id, { referenceUploadId: uploadId })) })
  })

  /** Sinh ảnh tham chiếu cho vật phẩm; giao diện poll rồi gọi `from-generation`. */
  items.post('/:itemId/reference/generate', (req, res) => {
    const user = requireUser(req)
    const projectId = projectIdOf(req)
    const item = ownedItem(db, user.id, projectId, single(req.params.itemId, 'vật phẩm'))
    const parsed = itemIllustrationSchema.safeParse(req.body)
    if (!parsed.success) throw validationError(parsed.error)
    const model = db
      .prepare("SELECT id FROM models WHERE id = ? AND user_id = ? AND kind = 'image' AND enabled = 1")
      .get(parsed.data.modelId, user.id)
    if (!model) throw badRequest('Model đã chọn không hợp lệ hoặc chưa được phân loại thành "Tạo ảnh".')

    const outcome = enqueueGeneration({
      db, env, worker, userId: user.id,
      request: {
        data: {
          modelId: parsed.data.modelId,
          prompt: buildItemSheetPrompt({ name: item.name, description: item.description, imagePrompt: item.image_prompt }),
          params: { size: '1024x1024', n: 1, useCharacterReference: false },
          projectId,
        },
        scene: null,
        canvas: { projectId, nodeId: null, kind: 'item', itemId: item.id, revision: item.revision },
      },
    })
    res.status(201).json({ generation: outcome.generation })
  })

  /* -------------------------------- bảng ---------------------------------- */

  board.get('/', (req, res) => {
    const user = requireUser(req)
    const projectId = projectIdOf(req)
    const canvas = readCanvas(db, user.id, projectId)
    res.json({
      canvas: {
        ...canvas,
        aliases: canvasAliases(resolveCanvasObjects(db, user.id, projectId, canvas.graph)),
        limits: CANVAS_LIMITS,
      },
    })
  })

  board.put('/', (req, res) => {
    const user = requireUser(req)
    const parsed = canvasSchema.safeParse(req.body)
    if (!parsed.success) throw validationError(parsed.error)
    res.json({ canvas: writeCanvas(db, user.id, projectIdOf(req), parsed.data).canvas })
  })

  board.get('/runs', (req, res) => {
    const user = requireUser(req)
    const projectId = projectIdOf(req)
    ownedProject(db, user.id, projectId)
    res.json({ runs: listRuns(db, projectId) })
  })

  board.post('/nodes/:nodeId/preview', (req, res) => {
    const user = requireUser(req)
    const projectId = projectIdOf(req)
    const parsed = previewSchema.safeParse(req.body)
    if (!parsed.success) throw validationError(parsed.error)
    const { graph, node } = requireNode(user.id, projectId, single(req.params.nodeId, 'node'))
    if (parsed.data.kind !== node.kind || (node.kind !== 'image' && node.kind !== 'video')) {
      throw badRequest('Node này không tạo nội dung ảnh hoặc video')
    }

    // Preview không chặn khi vượt giới hạn ảnh: người dùng cần thấy cảnh báo trước.
    const { compiled, planned } = compile(user.id, projectId, graph, node, false)
    const modelId = node.data?.modelId ?? null
    const model = modelId
      ? (db.prepare('SELECT m.id, m.display_name AS displayName, m.kind, m.model_id AS modelId FROM models m WHERE m.id = ? AND m.user_id = ? AND m.enabled = 1')
          .get(modelId, user.id) as { id: string; displayName: string; kind: string; modelId: string } | undefined)
      : undefined

    const sentUploads = new Set(planned.uploadIds)
    const sentCharacters = new Set(planned.characterIds)
    const inputs = compiled.inputRefs.map((ref) => ({
      kind: ref.kind,
      label: ref.label,
      reason: ref.reason,
      nodeId: ref.nodeId,
      url: ref.kind === 'upload'
        ? `/api/uploads/${encodeURIComponent(ref.uploadId ?? '')}`
        : ref.characterId ? `/api/characters/${encodeURIComponent(ref.characterId)}/reference` : '',
      sent: ref.kind === 'upload' ? sentUploads.has(ref.uploadId ?? '') : sentCharacters.has(ref.characterId ?? ''),
    }))

    res.json({
      preview: {
        nodeId: node.id,
        kind: node.kind,
        stamp: canvasStamp(graph, node.id),
        prompt: compiled.prompt,
        userText: compiled.userText,
        mentions: compiled.mentions.map((entry) => ({
          nodeId: entry.nodeId, alias: entry.alias, kind: entry.kind, name: entry.name, hasReference: Boolean(entry.reference),
        })),
        unresolved: compiled.unresolved,
        inputs,
        warnings: [...compiled.warnings, ...planned.warnings],
        limits: { maxImages: env.MAX_SOURCE_IMAGES, sentImages: planned.uploadIds.length + planned.characterIds.length },
        model: model ? { id: model.id, displayName: model.displayName, kind: model.kind, modelId: model.modelId } : null,
      },
    })
  })

  /**
   * Ghép nền + các lớp thành một ảnh PNG và lưu vào kho uploads.
   *
   * Giao diện dùng kết quả này làm ảnh nguồn cho node tạo ảnh; mọi tệp đều được
   * phân giải từ graph đã lưu và kiểm tra thuộc tài khoản.
   */
  board.post('/nodes/:nodeId/composite', async (req, res) => {
    const user = requireUser(req)
    const projectId = projectIdOf(req)
    const { node } = requireNode(user.id, projectId, single(req.params.nodeId, 'node'))
    if (node.kind !== 'image') throw badRequest('Chỉ node tạo ảnh mới dùng được bản bố trí')
    const layout = node.data?.layout
    if (!layout || !layout.instances?.length) throw badRequest('Chưa có đối tượng nào trong khung hình')

    const uploadPath = (uploadId: string): string => {
      const row = db.prepare('SELECT relative_path AS path FROM uploads WHERE id = ? AND user_id = ?')
        .get(uploadId, user.id) as { path: string } | undefined
      if (!row) throw badRequest('Ảnh tham chiếu không tồn tại hoặc không thuộc tài khoản của bạn')
      return row.path
    }
    /** Đường dẫn media của một node đối tượng, đã kiểm tra quyền sở hữu. */
    const objectSource = (nodeId: string): CompositeSource | null => {
      const source = readCanvas(db, user.id, projectId).graph.nodes.find((item) => item.id === nodeId)
      if (!source) return null
      const sourceId = source.data?.sourceId
      if (!sourceId) return null
      if (source.kind === 'character') {
        const row = db.prepare('SELECT reference_path AS path FROM characters WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
          .get(sourceId, user.id) as { path: string | null } | undefined
        return row?.path ? { nodeId, path: row.path } : null
      }
      if (source.kind === 'location') {
        const row = db.prepare('SELECT reference_upload_id AS id FROM project_locations WHERE id = ? AND project_id = ?')
          .get(sourceId, projectId) as { id: string | null } | undefined
        return row?.id ? { nodeId, path: uploadPath(row.id) } : null
      }
      if (source.kind === 'item') {
        const row = db.prepare('SELECT reference_upload_id AS id FROM project_items WHERE id = ? AND project_id = ? AND user_id = ?')
          .get(sourceId, projectId, user.id) as { id: string | null } | undefined
        return row?.id ? { nodeId, path: uploadPath(row.id) } : null
      }
      return null
    }

    let result: Awaited<ReturnType<typeof renderComposite>>
    try {
      result = await renderComposite({
        db, env, mediaStore, userId: user.id, node,
        background: layout.backgroundNodeId ? objectSource(layout.backgroundNodeId) : null,
        instances: layout.instances.map((placement) => ({
          placement,
          source: placement.imageUploadId
            ? { nodeId: placement.sourceNodeId, path: uploadPath(placement.imageUploadId) }
            : objectSource(placement.sourceNodeId),
        })),
      })
    } catch (cause) {
      // Ảnh hỏng hoặc định dạng lạ: trả lỗi rõ ràng thay vì lỗi máy chủ chung.
      if (cause instanceof AppError) throw cause
      throw badRequest('Không ghép được ảnh từ bố trí. Hãy kiểm tra ảnh tham chiếu của đối tượng.', undefined, { messageKey: 'canvas.composite_failed' })
    }
    res.status(201).json({ upload: { id: result.uploadId, url: `/api/uploads/${result.uploadId}`, width: result.width, height: result.height } })
  })

  board.post('/nodes/:nodeId/run', (req, res) => {
    const user = requireUser(req)
    const projectId = projectIdOf(req)
    const parsed = runSchema.safeParse(req.body)
    if (!parsed.success) throw validationError(parsed.error)
    const { graph, node } = requireNode(user.id, projectId, single(req.params.nodeId, 'node'))
    if (parsed.data.kind !== node.kind || (node.kind !== 'image' && node.kind !== 'video')) {
      throw badRequest('Node này không tạo nội dung ảnh hoặc video')
    }
    // Preview cũ không được dùng để chạy: đầu vào có thể đã đổi sau khi xem trước.
    const stamp = canvasStamp(graph, node.id)
    if (stamp !== parsed.data.stamp) {
      throw badRequest('Bảng Canvas đã thay đổi sau khi xem trước. Hãy xem trước lại.', undefined, { messageKey: 'canvas.preview_stale' })
    }

    const { compiled, planned } = compile(user.id, projectId, graph, node, true)
    assertMentionsResolved(compiled)

    const modelId = parsed.data.modelId ?? node.data?.modelId ?? null
    if (!modelId) throw badRequest('Vui lòng chọn model cho node này')
    const model = db
      .prepare('SELECT id, kind FROM models WHERE id = ? AND user_id = ? AND enabled = 1')
      .get(modelId, user.id) as { id: string; kind: string } | undefined
    if (!model) throw badRequest('Model không tồn tại hoặc đang bị tắt')

    const snapshot = {
      projectId,
      nodeId: node.id,
      nodeKind: node.kind,
      kind: parsed.data.kind,
      stamp,
      mentions: compiled.mentions.map((entry) => ({ nodeId: entry.nodeId, alias: entry.alias, kind: entry.kind, name: entry.name })),
      unresolved: compiled.unresolved,
      inputs: compiled.inputRefs.map((ref) => ({ kind: ref.kind, reason: ref.reason, nodeId: ref.nodeId, label: ref.label })),
      layout: node.data?.layout ?? null,
      warnings: planned.warnings,
    }

    if (parsed.data.kind === 'image') {
      if (model.kind !== 'image') throw badRequest('Node tạo ảnh cần model tạo ảnh')
      const outcome = enqueueGeneration({
        db, env, worker, userId: user.id,
        request: {
          data: {
            modelId,
            prompt: compiled.prompt,
            params: {
              size: '1024x1024',
              n: 1,
              // Ảnh vật phẩm và đầu ra node trước đi qua ảnh nguồn; ảnh nhân vật đi qua
              // danh sách nhân vật, nên không bật thêm tham chiếu cho nhân vật chính.
              useCharacterReference: planned.characterIds.length > 0,
            },
            projectId,
            ...(compiled.primaryCharacterId ? { characterId: compiled.primaryCharacterId } : {}),
            ...(planned.characterIds.length ? { characterIds: planned.characterIds } : {}),
            ...(planned.uploadIds.length ? { sourceUploadIds: planned.uploadIds } : {}),
            ...(parsed.data.idempotencyKey ? { idempotencyKey: parsed.data.idempotencyKey } : {}),
          },
          scene: null,
          canvas: snapshot,
        },
      })
      const run = recordRun(db, projectId, node.id, 'image', outcome.generation.id, stamp)
      res.status(202).json({ generation: outcome.generation, run })
      return
    }

    // Video: cảnh Studio là nguồn sự thật cho lời thoại, người nói và phiên bản.
    const sceneId = parsed.data.sceneId ?? node.data?.sceneId ?? null
    if (!sceneId) throw badRequest('Node video cần một cảnh Studio', undefined, { messageKey: 'canvas.scene_required' })
    if (model.kind !== 'video') throw badRequest('Node tạo video cần model video')
    const sceneContext = sceneGenerationContext(db, user.id, sceneId)
    if (sceneContext.projectId !== projectId) throw badRequest('Cảnh không thuộc dự án này')
    const outcome = enqueueGeneration({
      db, env, worker, userId: user.id,
      request: {
        data: {
          modelId,
          prompt: compiled.prompt,
          params: sceneContext.params,
          projectId,
          ...(parsed.data.idempotencyKey ? { idempotencyKey: parsed.data.idempotencyKey } : {}),
        },
        scene: {
          id: sceneContext.scene.id,
          projectId: sceneContext.projectId,
          dialogue: sceneContext.dialogue,
          speakerId: sceneContext.characterId,
          castIds: sceneContext.castIds,
          background: sceneContext.background,
        },
        canvas: snapshot,
      },
    })
    const run = recordRun(db, projectId, node.id, 'video', outcome.generation.id, stamp)
    res.status(202).json({ generation: outcome.generation, run })
  })

  return { items, board }
}
