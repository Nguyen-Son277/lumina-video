import type { CanvasGraph, CanvasNode } from '../../shared/canvas'
import type { Database } from '../db/index'
import { badRequest } from '../lib/errors'
import type { SourceImage } from '../generations/adapters/image'

export type CanvasVideoInput = SourceImage & { nodeId: string; uploadId?: string; assetId?: string; runId?: string }

/** Resolve only direct image edges. Never substitute the latest run for a user's selection. */
export function resolveCanvasVideoInput(db: Database, userId: string, projectId: string, graph: CanvasGraph, node: CanvasNode): CanvasVideoInput | null {
  const candidates = [...new Set(graph.edges.filter(edge => edge.target === node.id && edge.targetPort === 'image').map(edge => edge.source))]
  const selected = node.data.videoInputNodeId
  if (selected && !candidates.includes(selected)) throw badRequest('Ảnh video đã chọn không còn nối vào node này')
  if (!selected && candidates.length > 1) throw badRequest('Có nhiều ảnh đầu vào. Hãy chọn một ảnh cho video.')
  const sourceId = selected ?? candidates[0]
  if (!sourceId) return null
  const source = graph.nodes.find(item => item.id === sourceId)
  if (!source || !['upload', 'image', 'sheet'].includes(source.kind)) throw badRequest('Nguồn ảnh video không hợp lệ')
  // A selected run takes precedence over an older upload retained on an image node.
  if (source.kind !== 'upload' && source.data.selectedRunId) {
    const row = db.prepare(`SELECT a.id AS assetId, a.relative_path AS path, a.mime_type AS mime
      FROM project_canvas_runs r JOIN generations g ON g.id = r.generation_id JOIN assets a ON a.generation_id = g.id
      WHERE r.id = ? AND r.project_id = ? AND r.node_id = ? AND r.kind = 'image'
        AND g.user_id = ? AND g.status = 'succeeded' AND g.kind = 'image' AND g.deleted_at IS NULL
        AND a.user_id = ? AND a.mime_type LIKE 'image/%' ORDER BY a.created_at, a.id LIMIT 1`)
      .get(source.data.selectedRunId, projectId, source.id, userId, userId) as { assetId: string; path: string; mime: string } | undefined
    if (!row) throw badRequest('Ảnh đầu ra đã chọn chưa thành công hoặc không thuộc node/dự án này')
    return { ...row, nodeId: source.id, runId: source.data.selectedRunId }
  }
  if (!source.data.uploadId) throw badRequest('Node ảnh đầu vào chưa có ảnh đã chọn')
  const row = db.prepare("SELECT relative_path AS path, mime_type AS mime FROM uploads WHERE id = ? AND user_id = ? AND mime_type LIKE 'image/%'")
    .get(source.data.uploadId, userId) as SourceImage | undefined
  if (!row) throw badRequest('Ảnh đầu vào không tồn tại hoặc không thuộc tài khoản của bạn')
  return { ...row, nodeId: source.id, uploadId: source.data.uploadId }
}

/** Graph stamps include the frozen source identity, not merely a run/upload ID. */
export function canvasVideoInputStamp(db: Database, userId: string, projectId: string, graph: CanvasGraph, node: CanvasNode): unknown {
  try { return resolveCanvasVideoInput(db, userId, projectId, graph, node) }
  catch (error) { return { invalid: error instanceof Error ? error.message : String(error) } }
}
