import { randomUUID } from 'node:crypto'
import sharp, { type OverlayOptions } from 'sharp'
import type { Database } from '../db/index'
import type { AppEnv } from '../env'
import type { MediaStore } from '../media/store'
import { badRequest, notFound } from '../lib/errors'
import type { CanvasLayout, CanvasNode } from '../../shared/canvas'
import { emptyCanvasLayout } from '../../shared/canvas'

/**
 * Ghép nền và các lớp đối tượng thành một ảnh PNG trên server.
 *
 * Bản ghép chỉ dùng tệp trong kho media của chính tài khoản: tên node trong graph
 * được phân giải thành upload/ảnh nhân vật đã kiểm tra quyền sở hữu, không bao giờ
 * tải URL do client cung cấp. Ảnh ghép là đầu vào tham chiếu cho lần tạo ảnh kế tiếp,
 * không phải cam kết model giữ nguyên từng pixel.
 */

const BASE_WIDTH = 1024
const MAX_SIDE = 1536

export type CompositeSource = {
  nodeId: string
  /** Đường dẫn tương đối trong kho media của người dùng. */
  path: string
}

function parseRatio(ratio: string | undefined): { width: number; height: number } {
  const [w, h] = (ratio ?? '16:9').split(':').map(Number)
  if (!w || !h) return { width: BASE_WIDTH, height: Math.round((BASE_WIDTH * 9) / 16) }
  const width = Math.min(BASE_WIDTH, MAX_SIDE)
  const height = Math.min(Math.round((width * h) / w), MAX_SIDE)
  return { width, height }
}

/** Kích thước khung ảnh cuối cùng theo tỷ lệ đã chọn. */
export function compositeSize(layout: CanvasLayout | undefined): { width: number; height: number } {
  return parseRatio((layout ?? emptyCanvasLayout()).aspectRatio)
}

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1)

/**
 * Ghép ảnh và lưu thành một upload mới của tài khoản.
 *
 * `resolve` do route cung cấp: nó đã kiểm tra quyền sở hữu và trả đường dẫn media,
 * nhờ vậy module này không tự truy vấn database.
 */
export async function renderComposite(options: {
  db: Database
  env: AppEnv
  mediaStore: MediaStore
  userId: string
  node: CanvasNode
  background: CompositeSource | null
  instances: Array<{ placement: { x: number; y: number; width: number; height: number; rotation: number; flipX: boolean; z: number }; source: CompositeSource | null }>
}): Promise<{ uploadId: string; width: number; height: number }> {
  const { db, env, mediaStore, userId, node, background, instances } = options
  const layout = node.data?.layout
  const { width, height } = compositeSize(layout)

  for (const item of [background, ...instances.map((entry) => entry.source)]) {
    if (item && !mediaStore.exists(item.path)) {
      throw notFound('Ảnh của đối tượng không còn trong kho media')
    }
  }

  const layers: OverlayOptions[] = []
  for (const entry of instances) {
    if (!entry.source) continue
    const targetWidth = Math.max(1, Math.round(clamp01(entry.placement.width) * width))
    const targetHeight = Math.max(1, Math.round(clamp01(entry.placement.height) * height))
    let pipeline = sharp(mediaStore.readFile(entry.source.path)).rotate(entry.placement.rotation, {
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    if (entry.placement.flipX) pipeline = pipeline.flop()
    const layer = await pipeline
      .resize({ width: targetWidth, height: targetHeight, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer()
    const meta = await sharp(layer).metadata()
    const layerWidth = meta.width ?? targetWidth
    const layerHeight = meta.height ?? targetHeight
    const left = Math.round(entry.placement.x * width + (targetWidth - layerWidth) / 2)
    const top = Math.round(entry.placement.y * height + (targetHeight - layerHeight) / 2)
    layers.push({ input: layer, left, top })
  }

  const base = background
    ? await sharp(mediaStore.readFile(background.path)).resize(width, height, { fit: 'cover' }).png().toBuffer()
    : await sharp({
        create: { width, height, channels: 4, background: { r: 20, g: 21, b: 26, alpha: 1 } },
      }).png().toBuffer()

  const composed = await sharp(base)
    .composite(layers.slice(0, 24))
    .png({ compressionLevel: 9 })
    .toBuffer()

  if (composed.byteLength > env.MAX_SOURCE_IMAGE_BYTES) {
    throw badRequest('Ảnh ghép vượt giới hạn dung lượng cho phép')
  }

  return { ...saveUpload(db, mediaStore, userId, new Uint8Array(composed), env.MAX_SOURCE_IMAGE_BYTES), width, height }
}

function saveUpload(
  db: Database,
  mediaStore: MediaStore,
  userId: string,
  bytes: Uint8Array,
  maxBytes: number,
): { uploadId: string } {
  const uploadId = randomUUID()
  const saved = mediaStore.saveUpload({ userId, uploadId, bytes, maxBytes })
  db.prepare(
    'INSERT INTO uploads (id, user_id, relative_path, mime_type, byte_size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(uploadId, userId, saved.relativePath, saved.mimeType, saved.byteSize, Date.now())
  return { uploadId }
}
