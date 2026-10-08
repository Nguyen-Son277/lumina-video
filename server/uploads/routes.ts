import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import express from 'express'
import type { Database } from '../db/index'
import type { AppEnv } from '../env'
import type { MediaStore } from '../media/store'
import { requireUser } from '../auth/middleware'
import { badRequest, notFound } from '../lib/errors'

export type UploadPublic = {
  id: string
  mimeType: string
  byteSize: number
  url: string
}

/**
 * Ảnh nguồn do người dùng tải lên để tạo ảnh mới từ ảnh đó (image-to-image).
 *
 * Tải lên trước khi tạo tác vụ, sau đó truyền danh sách id vào yêu cầu tạo ảnh.
 * Nhờ vậy không cần phân tích multipart ở endpoint tạo tác vụ và ảnh có thể
 * được dùng lại cho nhiều lần tạo.
 */
export function uploadRoutes(db: Database, mediaStore: MediaStore, env: AppEnv): Router {
  const router = Router()

  const rawImage = express.raw({
    type: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    limit: env.MAX_SOURCE_IMAGE_BYTES,
  })

  function publicUpload(row: {
    id: string
    mime_type: string
    byte_size: number
  }): UploadPublic {
    return {
      id: row.id,
      mimeType: row.mime_type,
      byteSize: row.byte_size,
      url: `/api/uploads/${row.id}`,
    }
  }

  function ownedUpload(userId: string, id: string) {
    const row = db
      .prepare(
        'SELECT id, relative_path AS path, mime_type, byte_size FROM uploads WHERE id = ? AND user_id = ?',
      )
      .get(id, userId) as
      | { id: string; path: string; mime_type: string; byte_size: number }
      | undefined
    if (!row) throw notFound('Không tìm thấy ảnh nguồn')
    return row
  }

  router.post('/', rawImage, (req, res) => {
    const user = requireUser(req)

    const body = req.body as Buffer | undefined
    if (!body || body.byteLength === 0) {
      throw badRequest('Không nhận được nội dung ảnh nguồn')
    }

    const id = randomUUID()
    const saved = mediaStore.saveUpload({
      userId: user.id,
      uploadId: id,
      bytes: new Uint8Array(body),
      maxBytes: env.MAX_SOURCE_IMAGE_BYTES,
    })

    db.prepare(
      'INSERT INTO uploads (id, user_id, relative_path, mime_type, byte_size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, user.id, saved.relativePath, saved.mimeType, saved.byteSize, Date.now())

    res.status(201).json({
      upload: publicUpload({ id, mime_type: saved.mimeType, byte_size: saved.byteSize }),
    })
  })

  router.get('/:id', (req, res) => {
    const user = requireUser(req)
    const row = ownedUpload(user.id, req.params.id)

    if (!mediaStore.exists(row.path)) throw notFound('Ảnh nguồn không còn trên máy chủ')

    const { size } = mediaStore.stat(row.path)
    res.setHeader('Content-Type', row.mime_type)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate')
    res.setHeader('Content-Length', String(size))
    mediaStore.openReadStream(row.path).pipe(res)
  })

  router.delete('/:id', (req, res) => {
    const user = requireUser(req)
    const row = ownedUpload(user.id, req.params.id)

    mediaStore.removeUpload(user.id, row.id)
    db.prepare('DELETE FROM uploads WHERE id = ? AND user_id = ?').run(row.id, user.id)
    res.status(204).end()
  })

  return router
}
