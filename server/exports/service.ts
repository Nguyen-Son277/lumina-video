import { randomUUID } from 'node:crypto'
import type { Database } from '../db/index'
import type { CanvasChainExportSpec } from '../../shared/canvasExport'
import type { ExportStage, NarrationSnapshot } from '../../shared/speech'
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
  project_id: string | null
  quick_session_id: string | null
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
  speech_job_id?: string | null
  stage?: ExportStage
}

export type ExportSpecItem = { sceneId: string; generationId: string; assetId?: string }
export type SceneExportSpec = { source?: 'project-scenes'; items: ExportSpecItem[] }
export type ExportSpec = (SceneExportSpec | CanvasChainExportSpec) & { narration?: NarrationSnapshot }

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
    quickSessionId: row.quick_session_id ?? null,
    source: (JSON.parse(row.spec_json) as ExportSpec).source ?? 'project-scenes',
    status: row.status,
    stage: row.stage ?? row.status,
    speechJobId: row.speech_job_id ?? null,
    narration: (JSON.parse(row.spec_json) as ExportSpec).narration ?? null,
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
  assetId?: string,
): { id: string; path: string; mime: string } {
  const generation = db
    .prepare(
      "SELECT id, postprocess_status FROM generations WHERE id = ? AND user_id = ? AND scene_id = ? AND status = 'succeeded' AND kind = 'video' AND deleted_at IS NULL",
    )
    .get(generationId, userId, sceneId)
  if (!generation) {
    throw badRequest(
      'Chỉ ghép được video đã tạo thành công thuộc đúng cảnh. Hãy kiểm tra lại các cảnh đã chọn.',
    )
  }

  if (['queued', 'running'].includes(String(generation.postprocess_status))) throw badRequest('Hãy đợi bước chèn logo hoàn tất trước khi xuất video.')
  const asset = db
    .prepare(
      "SELECT id, relative_path AS path, mime_type AS mime FROM assets WHERE generation_id = ? AND (? IS NULL OR id=?) ORDER BY CASE variant WHEN 'logo_overlay' THEN 0 ELSE 1 END, created_at ASC, id LIMIT 1",
    )
    .get(generationId, assetId ?? null, assetId ?? null) as { id: string; path: string; mime: string } | undefined
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
): SceneExportSpec {
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
    const frozenItems: ExportSpecItem[] = []
    for (const item of items) {
      if (!sceneIds.has(item.sceneId)) {
        throw badRequest('Danh sách xuất có cảnh không thuộc dự án này')
      }
      // Xác thực ngay khi tạo để lỗi hiện ra sớm, không đợi tới lúc chạy ffmpeg.
      const asset = videoAssetFor(db, userId, item.sceneId, item.generationId, item.assetId)
      frozenItems.push({ sceneId: item.sceneId, generationId: item.generationId, assetId: asset.id })
    }
    return { source: 'project-scenes', items: frozenItems }
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

    // A selected tombstone (or unusable result) must not hide another valid video.
    const generation = db
      .prepare(
        `SELECT g.id FROM generations g
          WHERE g.user_id = ? AND g.scene_id = ? AND g.status = 'succeeded' AND g.kind = 'video'
            AND g.deleted_at IS NULL AND EXISTS (SELECT 1 FROM assets a WHERE a.generation_id = g.id)
          ORDER BY CASE WHEN g.id = ? THEN 0 ELSE 1 END, g.completed_at DESC, g.created_at DESC, g.id
          LIMIT 1`,
      )
      .get(userId, scene.id, scene.selected_generation_id) as { id: string } | undefined

    if (!generation) {
      throw badRequest(
        `Cảnh "${scene.title}" chưa có video thành công để ghép`,
        undefined,
        errorMeta('exports.scene_has_no_video', { scene: scene.title }),
      )
    }
    const asset = videoAssetFor(db, userId, scene.id, generation.id)
    resolved.push({ sceneId: scene.id, generationId: generation.id, assetId: asset.id })
  }

  return { source: 'project-scenes', items: resolved }
}

export function createExport(options: {
  db: Database
  userId: string
  projectId?: string | null
  quickSessionId?: string | null
  spec: ExportSpec
}): ExportRow {
  const { db, userId, projectId, quickSessionId, spec } = options
  const id = randomUUID()
  const now = Date.now()

  db.prepare(
    `INSERT INTO exports (id, user_id, project_id, quick_session_id, status, spec_json, progress, created_at, updated_at,speech_job_id,stage)
     VALUES (?, ?, ?, ?, 'queued', ?, 0, ?, ?, ?, ?)`,
  ).run(id, userId, projectId ?? null, quickSessionId ?? null, JSON.stringify(spec), now, now, spec.narration?.speechJobId ?? null, spec.narration ? 'speech' : 'queued')

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
    stage?: ExportStage
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
    stage: patch.stage ?? (patch.status === 'succeeded' || patch.status === 'failed' ? patch.status : undefined),
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
  if (spec.source === 'canvas-chain') {
    return spec.items.map(item => canvasVideoAssetFor(db, userId, item.generationId, item.assetId).path)
  }
  return spec.items.map((item) => videoAssetFor(db, userId, item.sceneId, item.generationId, item.assetId).path)
}

/** Recheck the frozen asset at execution time, independently of current canvas nodes. */
export function canvasVideoAssetFor(db: Database, userId: string, generationId: string, assetId?: string | null) {
  const row = db.prepare(`SELECT a.id, a.relative_path AS path, a.mime_type AS mime FROM assets a
    JOIN generations g ON g.id=a.generation_id
    WHERE g.id=? AND g.user_id=? AND a.user_id=? AND g.kind='video' AND g.status='succeeded' AND g.deleted_at IS NULL
      AND COALESCE(g.postprocess_status,'') NOT IN ('queued','running') AND a.mime_type LIKE 'video/%' AND (? IS NULL OR a.id=?)
    ORDER BY CASE a.variant WHEN 'logo_overlay' THEN 0 ELSE 1 END,a.created_at,a.id LIMIT 1`)
    .get(generationId,userId,userId,assetId ?? null,assetId ?? null) as { id: string; path: string; mime: string } | undefined
  if (!row) throw badRequest('Video trong chuỗi không còn khả dụng. Hãy kiểm tra node rồi xuất lại.', undefined, { messageKey: 'exports.chain_not_ready' })
  return row
}
