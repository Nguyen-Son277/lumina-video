import { Router } from 'express'
import type { Database } from '../db/index'
import type { MediaStore } from '../media/store'
import { notFound } from '../lib/errors'
import { requireUser } from '../auth/middleware'

/**
 * Phục vụ media có kiểm tra quyền sở hữu.
 * Media nằm ngoài thư mục public và không có URL công khai.
 */
export function assetRoutes(db: Database, mediaStore: MediaStore): Router {
  const router = Router()

  router.get('/:id', (req, res) => {
    const user = requireUser(req)

    const asset = db
      .prepare(
        `SELECT a.id, a.relative_path AS relativePath, a.mime_type AS mimeType, a.byte_size AS byteSize
         FROM assets a
         JOIN generations g ON g.id = a.generation_id
         WHERE a.id = ? AND a.user_id = ? AND g.user_id = ?`,
      )
      .get(req.params.id, user.id, user.id) as
      | { id: string; relativePath: string; mimeType: string; byteSize: number }
      | undefined

    if (!asset) throw notFound('Không tìm thấy tệp')
    if (!mediaStore.exists(asset.relativePath)) {
      throw notFound('Tệp không còn tồn tại trên máy chủ')
    }

    const { size } = mediaStore.stat(asset.relativePath)
    const isDownload = req.query.download === '1'

    // Chỉ phục vụ định dạng đã whitelist; không bao giờ phục vụ HTML hoặc SVG.
    res.setHeader('Content-Type', asset.mimeType)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate')
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader(
      'Content-Disposition',
      `${isDownload ? 'attachment' : 'inline'}; filename="${asset.id}"`,
    )

    const range = req.headers.range
    if (range && /^bytes=\d*-\d*$/.test(range)) {
      const [startRaw, endRaw] = range.replace('bytes=', '').split('-')
      const start = startRaw ? Number(startRaw) : 0
      const end = endRaw ? Math.min(Number(endRaw), size - 1) : size - 1

      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
        res.status(416).setHeader('Content-Range', `bytes */${size}`).end()
        return
      }

      res.status(206)
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
      res.setHeader('Content-Length', String(end - start + 1))
      mediaStore.openReadStream(asset.relativePath).pipe(res)
      return
    }

    res.setHeader('Content-Length', String(size))
    mediaStore.openReadStream(asset.relativePath).pipe(res)
  })

  return router
}

/**
 * Phục vụ ảnh tham chiếu của nhân vật.
 * Chỉ chủ sở hữu dự án tải được; ảnh nằm ngoài thư mục public.
 */
export function characterAssetRoutes(db: Database, mediaStore: MediaStore): Router {
  const router = Router()

  router.get('/:id/reference', (req, res) => {
    const user = requireUser(req)

    const row = db
      .prepare(
        `SELECT c.reference_path AS path, c.reference_mime AS mime
         FROM characters c
         WHERE c.id = ? AND c.user_id = ?`,
      )
      .get(req.params.id, user.id) as { path: string | null; mime: string | null } | undefined

    if (!row?.path || !row.mime) throw notFound('Nhân vật chưa có ảnh tham chiếu')
    if (!mediaStore.exists(row.path)) throw notFound('Ảnh tham chiếu không còn trên máy chủ')

    const { size } = mediaStore.stat(row.path)
    res.setHeader('Content-Type', row.mime)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate')
    res.setHeader('Content-Length', String(size))
    mediaStore.openReadStream(row.path).pipe(res)
  })

  return router
}
