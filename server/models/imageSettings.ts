import type { Database } from '../db/index'
import { badRequest } from '../lib/errors'
import type { ImageReferenceSupport } from './routes'

export type ResolvedImageSettings = {
  /** Omitted when unset so the provider applies its own default. */
  params: { size?: string }
  referenceSupport: ImageReferenceSupport
  transport: 'provider_default' | 'generations_images'
  maxReferences: number | null
  warning?: 'reference_support_unknown'
}

/** Ownership-scoped image configuration lookup, reusable by generation/planner routes. */
export function resolveImageSettings(
  db: Database,
  modelId: string,
  userId: string,
  options: { hasReferences?: boolean } = {},
): ResolvedImageSettings {
  const row = db.prepare(
    'SELECT image_size AS imageSize, image_reference_support AS referenceSupport, image_reference_transport AS transport, image_max_references AS maxReferences FROM models WHERE id = ? AND user_id = ?',
  ).get(modelId, userId) as { imageSize: string | null; referenceSupport: ImageReferenceSupport; transport: 'provider_default' | 'generations_images'; maxReferences: number | null } | undefined
  if (!row) throw badRequest('Model không tồn tại hoặc không thuộc tài khoản của bạn')
  if (options.hasReferences && row.referenceSupport === 'no') {
    throw badRequest('Model này không hỗ trợ ảnh tham chiếu. Hãy chọn model khác hoặc bỏ ảnh tham chiếu.')
  }
  return {
    params: row.imageSize ? { size: row.imageSize } : {},
    referenceSupport: row.referenceSupport,
    transport: row.transport,
    maxReferences: row.maxReferences,
    ...(options.hasReferences && row.referenceSupport === 'unknown' ? { warning: 'reference_support_unknown' as const } : {}),
  }
}

/** Helper for consumers that only need to reject unsupported references. */
export function validateImageReferences(
  db: Database,
  modelId: string,
  userId: string,
  hasReferences: boolean,
): ResolvedImageSettings {
  return resolveImageSettings(db, modelId, userId, { hasReferences })
}

export type { ImageReferenceSupport }
