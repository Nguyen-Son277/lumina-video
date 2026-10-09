import { randomUUID } from 'node:crypto'
import type { Database } from '../db/index'
import { badRequest, errorMeta, notFound } from '../lib/errors'
import {
  genericMessageKeyForCode,
  isErrorMessageKey,
  type ErrorMessageKey,
  type ErrorMessageParams,
} from '../../shared/errorCatalog'

export type ExportStatus = 'queued' | 'running' | 'succeeded' | 'failed'

export type ExportRow = {
  id: string
  user_id: string
  project_id: string
  status: ExportStatus
  spec_json: string
  relative_path: string | null
  mime_type: string | null
  byte_size: number | null
  progress: number | null
  error_code: string | null
  error_message: string | null
  /** Khoá ngữ nghĩa của lỗi (nullable với dữ liệu cũ). */
  error_message_key?: string | null
  /** Tham số JSON cho khoá ngữ nghĩa. */
  error_message_params?: string | null
  created_at: number
  updated_at: number
  completed_at: number | null
}

export type ExportSpecItem = { sceneId: string; generationId: string }
export type ExportSpec = { items: ExportSpecItem[] }

/** Khoá ngữ nghĩa đã lưu hoặc suy ra từ `error_code` cho dữ liệu cũ. */
function storedErrorKey(row: ExportRow): ErrorMessageKey {
  if (row.error_message_key && isErrorMessageKey(row.error_message_key)) return row.error_message_key
  return genericMessageKeyForCode(row.error_code)
}

function storedErrorParams(row: ExportRow): ErrorMessageParams {
  if (!row.error_message_params) return {}
  try {
    const parsed: unknown = JSON.parse(row.error_message_params)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ErrorMessageParams
    }
  } catch {
    // Dữ liệu cũ hoặc hỏng: bỏ qua tham số.
  }
  return {}
}

export function exportPublic(row: ExportRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    status: row.status,
    progress: row.progress,
    itemCount: (JSON.parse(row.spec_json) as ExportSpec).items.length,
    /** Tệp chỉ có khi xuất đã thành công. */
    url: row.relative_path ? `/api/exports/${row.id}/file` : null,
    downloadUrl: row.relative_path ? `/api/exports/${row.id}/file?download=1` : null,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    errorMessageKey: storedErrorKey(row),
    errorMessageParams: storedErrorParams(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

export function ownedExport(db: Database, userId: string, id: string): ExportRow {
  const row = db
    .prepare('SELECT * FROM exports WHERE id = ? AND user_id = ?')
    .get(id, userId) as ExportRow | undefined
  if (!row) throw notFound('Không tìm thấy bản xuất video')
  return row
}

export function listExports(db: Database, userId: string, projectId: string): ExportRow[] {
  return db
    .prepare('SELECT * FROM exports WHERE user_id = ? AND project_id = ? ORDER BY created_at DESC, id')
    .all(userId, projectId) as unknown as ExportRow[]
}

/** Tác vụ xuất đang chạy của người dùng, dùng để giới hạn số lần ghép đồng thời. */
export function activeExportCount(db: Database, userId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS total FROM exports WHERE user_id = ? AND status IN ('queued','running')")
    .get(userId) as { total: number }
  return Number(row.total)
}

/** Asset video của một tác vụ đã thành công, kèm kiểm tra quyền sở hữu và cảnh. */
export function videoAssetFor(
  db: Database,
  userId: string,
  sceneId: string,
  generationId: string,
): { path: string; mime: string } {
  const generation = db
    .prepare(
      "SELECT id FROM generations WHERE id = ? AND user_id = ? AND scene_id = ? AND status = 'succeeded' AND kind = 'video'",
    )
    .get(generationId, userId, sceneId)
  if (!generation) {
    throw badRequest(
      'Chỉ ghép được video đã tạo thành công thuộc đúng cảnh. Hãy kiểm tra lại các cảnh đã chọn.',
    )
  }

  const asset = db
    .prepare(
      'SELECT relative_path AS path, mime_type AS mime FROM assets WHERE generation_id = ? ORDER BY created_at ASC, id LIMIT 1',
    )
    .get(generationId) as { path: string; mime: string } | undefined
  if (!asset) throw badRequest('Tác vụ đã chọn không có tệp video để ghép')
  return asset
}

/**
 * Dựng danh sách cảnh cần ghép, theo đúng thứ tự timeline của dự án.
 *
 * Không truyền `items` thì lấy mọi cảnh của dự án, mỗi cảnh dùng bản đã chọn
 * (`selected_generation_id`) hoặc bản video thành công mới nhất.
 */
export function buildSpec(
  db: Database,
  userId: string,
  projectId: string,
  items: ExportSpecItem[] | undefined,
  maxScenes: number,
): ExportSpec {
  const scenes = db
    .prepare('SELECT id, title, selected_generation_id FROM scenes WHERE project_id = ? ORDER BY position, id')
    .all(projectId) as unknown as Array<{ id: string; title: string; selected_generation_id: string | null }>

  if (!scenes.length) throw badRequest('Dự án chưa có cảnh nào để xuất video')

  if (items && items.length) {
    const sceneIds = new Set(scenes.map((scene) => scene.id))
    if (items.length > maxScenes) {
      throw badRequest(
        `Một lần xuất tối đa ${maxScenes} cảnh`,
        undefined,
        errorMeta('exports.too_many_scenes', { max: maxScenes }),
      )
    }
    for (const item of items) {
      if (!sceneIds.has(item.sceneId)) {
        throw badRequest('Danh sách xuất có cảnh không thuộc dự án này')
      }
      // Xác thực ngay khi tạo để lỗi hiện ra sớm, không đợi tới lúc chạy ffmpeg.
      videoAssetFor(db, userId, item.sceneId, item.generationId)
    }
    return { items }
  }

  const resolved: ExportSpecItem[] = []
  for (const scene of scenes) {
    if (resolved.length >= maxScenes) {
      throw badRequest(
        `Một lần xuất tối đa ${maxScenes} cảnh`,
        undefined,
        errorMeta('exports.too_many_scenes', { max: maxScenes }),
      )
    }

    const generation = scene.selected_generation_id
      ? { id: scene.selected_generation_id }
      : (db
          .prepare(
            "SELECT id FROM generations WHERE user_id = ? AND scene_id = ? AND status = 'succeeded' AND kind = 'video' ORDER BY completed_at DESC, created_at DESC LIMIT 1",
          )
          .get(userId, scene.id) as { id: string } | undefined)

    if (!generation) {
      throw badRequest(
        `Cảnh "${scene.title}" chưa có video thành công để ghép`,
        undefined,
        errorMeta('exports.scene_has_no_video', { scene: scene.title }),
      )
    }
    resolved.push({ sceneId: scene.id, generationId: generation.id })
  }

  return { items: resolved }
}

export function createExport(options: {
  db: Database
  userId: string
  projectId: string
  spec: ExportSpec
}): ExportRow {
  const { db, userId, projectId, spec } = options
  const id = randomUUID()
  const now = Date.now()

  db.prepare(
    `INSERT INTO exports (id, user_id, project_id, status, spec_json, progress, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', ?, 0, ?, ?)`,
  ).run(id, userId, projectId, JSON.stringify(spec), now, now)

  return db.prepare('SELECT * FROM exports WHERE id = ?').get(id) as ExportRow
}

export function updateExport(
  db: Database,
  id: string,
  patch: {
    status?: ExportStatus
    progress?: number | null
    relativePath?: string | null
    mimeType?: string | null
    byteSize?: number | null
    errorCode?: string | null
    errorMessage?: string | null
    errorMessageKey?: string | null
    errorMessageParams?: string | null
    completedAt?: number | null
  },
): void {
  const fields: string[] = []
  const values: Array<string | number | null> = []

  const map: Record<string, unknown> = {
    status: patch.status,
    progress: patch.progress,
    relative_path: patch.relativePath,
    mime_type: patch.mimeType,
    byte_size: patch.byteSize,
    error_code: patch.errorCode,
    error_message: patch.errorMessage,
    error_message_key: patch.errorMessageKey,
    error_message_params: patch.errorMessageParams,
    completed_at: patch.completedAt,
  }
  for (const [column, value] of Object.entries(map)) {
    if (value === undefined) continue
    fields.push(`${column} = ?`)
    values.push(value as string | number | null)
  }

  fields.push('updated_at = ?')
  values.push(Date.now())
  db.prepare(`UPDATE exports SET ${fields.join(', ')} WHERE id = ?`).run(...values, id)
}

/** Mọi đường dẫn media của một spec, theo đúng thứ tự ghép. */
export function specAssetPaths(
  db: Database,
  userId: string,
  spec: ExportSpec,
): string[] {
  return spec.items.map((item) => videoAssetFor(db, userId, item.sceneId, item.generationId).path)
}
