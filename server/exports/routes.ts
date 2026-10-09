import { Router } from 'express'
import { z } from 'zod'
import type { Database } from '../db/index'
import type { AppEnv } from '../env'
import type { MediaStore } from '../media/store'
import { requireUser } from '../auth/middleware'
import { badRequest, validationError } from '../lib/errors'
import { ownedProject } from '../projects/service'
import type { Worker } from '../generations/worker'
import {
  activeExportCount,
  buildSpec,
  createExport,
  exportPublic,
  listExports,
  ownedExport,
} from './service'

/** Một người chỉ ghép một video tại một thời điểm để không nghẽn CPU. */
const MAX_ACTIVE_EXPORTS_PER_USER = 1

const createSchema = z
  .object({
    /**
     * Danh sách cảnh cần ghép theo thứ tự. Bỏ trống thì lấy mọi cảnh của dự án,
     * mỗi cảnh dùng bản đã chọn hoặc bản thành công mới nhất.
     */
    items: z
      .array(z.object({ sceneId: z.string().min(1), generationId: z.string().min(1) }).strict())
      .min(1)
      .optional(),
  })
  .strict()

/**
 * Xuất video: ghép các cảnh đã tạo thành một tệp hoàn chỉnh.
 *
 * Công việc chạy nền trong worker vì ghép video tốn thời gian; nhờ vậy đóng tab
 * vẫn chạy tiếp và không giữ kết nối HTTP trong nhiều phút.
 */
export function exportRoutes(
  db: Database,
  env: AppEnv,
  mediaStore: MediaStore,
  worker: Worker,
): Router {
  const router = Router()

  router.post('/projects/:id/exports', (req, res) => {
    const user = requireUser(req)
    const project = ownedProject(db, user.id, req.params.id, true)

    if (activeExportCount(db, user.id) >= MAX_ACTIVE_EXPORTS_PER_USER) {
      throw badRequest('Đang có bản xuất video chạy. Hãy đợi hoàn tất rồi xuất bản mới.')
    }

    const parsed = createSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      throw validationError(parsed.error)
    }

    const spec = buildSpec(db, user.id, project.id, parsed.data.items, env.EXPORT_MAX_SCENES)
    const created = createExport({ db, userId: user.id, projectId: project.id, spec })

    worker.wake()
    res.status(202).json({ export: exportPublic(created) })
  })

  router.get('/projects/:id/exports', (req, res) => {
    const user = requireUser(req)
    const project = ownedProject(db, user.id, req.params.id)
    res.json({ exports: listExports(db, user.id, project.id).map(exportPublic) })
  })

  router.get('/exports/:id', (req, res) => {
    const user = requireUser(req)
    res.json({ export: exportPublic(ownedExport(db, user.id, req.params.id)) })
  })

  router.get('/exports/:id/file', (req, res) => {
    const user = requireUser(req)
    const row = ownedExport(db, user.id, req.params.id)

    if (row.status !== 'succeeded' || !row.relative_path) {
      throw badRequest('Bản xuất này chưa có tệp video')
    }
    if (!mediaStore.exists(row.relative_path)) {
      throw badRequest('Tệp video đã xuất không còn trên máy chủ')
    }

    res.setHeader('Content-Type', row.mime_type ?? 'video/mp4')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate')
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader(
      'Content-Disposition',
      `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${row.id}.mp4"`,
    )

    const size = mediaStore.stat(row.relative_path).size
    res.setHeader('Content-Length', String(size))
    mediaStore.openReadStream(row.relative_path).pipe(res)
  })

  router.delete('/exports/:id', (req, res) => {
    const user = requireUser(req)
    const row = ownedExport(db, user.id, req.params.id)

    if (row.status === 'queued' || row.status === 'running') {
      throw badRequest('Bản xuất đang chạy, chưa xoá được. Hãy đợi hoàn tất.')
    }

    mediaStore.removeExport(row.user_id, row.id)
    db.prepare('DELETE FROM exports WHERE id = ? AND user_id = ?').run(row.id, user.id)
    res.status(204).end()
  })

  return router
}
