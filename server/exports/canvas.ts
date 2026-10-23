import { createHash } from 'node:crypto'
import type { CanvasChainExportSpec, CanvasExportItem, CanvasExportPreview, CanvasExportScope } from '../../shared/canvasExport'
import { canvasVideoChain, canvasVideoTitle } from '../../shared/canvasSequence'
import type { Database } from '../db/index'
import type { MediaStore } from '../media/store'
import { badRequest, conflict } from '../lib/errors'
import { readCanvas } from '../canvas/service'
import { readQuickCanvas } from '../quickCanvas/service'
import { ownedProject } from '../projects/service'
import { canvasVideoAssetFor, type ExportRow } from './service'

export function canvasExportPreview(options: {
  db: Database; mediaStore: MediaStore; userId: string; scope: CanvasExportScope
  nodeId: string; baseRevision: number; maxClips: number
}): CanvasExportPreview {
  const { db, mediaStore, userId, scope, nodeId, baseRevision, maxClips } = options
  const quick = !!scope.quickSessionId
  if (scope.projectId) ownedProject(db, userId, scope.projectId, true)
  const board = quick ? readQuickCanvas(db, userId, scope.quickSessionId!) : readCanvas(db, userId, scope.projectId!)
  if (baseRevision !== board.revision) throw conflict('Bảng Canvas đã thay đổi. Hãy tải lại trước khi xuất.', { messageKey: 'canvas.revision_conflict' })
  let chain
  try { chain = canvasVideoChain(board.graph, nodeId) }
  catch { throw badRequest('Hãy chọn một chuỗi video hợp lệ.', undefined, { messageKey: 'exports.chain_invalid' }) }
  if (chain.length > maxClips) throw badRequest(`Một lần xuất tối đa ${maxClips} video.`, undefined, { messageKey: 'exports.too_many_clips', messageParams: { max: maxClips } })

  const table = quick ? 'quick_canvas_runs' : 'project_canvas_runs'
  const column = quick ? 'session_id' : 'project_id'
  const scopeId = quick ? scope.quickSessionId! : scope.projectId!
  // Resolve all matching history in SQL; the UI's paginated run list is not authoritative.
  const candidates = db.prepare(`SELECT r.id AS runId,g.id AS generationId,${quick ? 'r.asset_id' : 'NULL'} AS assetId,g.postprocess_status AS postprocess
    FROM ${table} r JOIN generations g ON g.id=r.generation_id
    WHERE r.${column}=? AND r.node_id=? AND r.kind='video' AND g.user_id=? AND g.kind='video'
      AND g.status='succeeded' AND g.deleted_at IS NULL
      AND ${quick ? 'g.quick_session_id=?' : 'g.scene_id IN (SELECT id FROM scenes WHERE project_id=?)'}
    ORDER BY CASE WHEN r.id=? THEN 0 ELSE 1 END,g.completed_at DESC,g.created_at DESC,r.created_at DESC,r.id`)
  const items: CanvasExportItem[] = chain.map(node => {
    const item: CanvasExportItem = { nodeId: node.id, label: canvasVideoTitle(board.graph,node), runId: null, generationId: null, assetId: null, fallback: false, issue: 'missing_video' }
    const rows = candidates.all(scopeId,node.id,userId,scopeId,node.data.selectedRunId ?? null) as Array<{ runId: string; generationId: string; assetId: string | null; postprocess: string | null }>
    for (const row of rows) {
      if (row.postprocess === 'queued' || row.postprocess === 'running') {
        return { ...item, runId: row.runId, generationId: row.generationId, issue: 'logo_pending' }
      }
      try {
        const asset = canvasVideoAssetFor(db,userId,row.generationId,row.assetId)
        if (!mediaStore.exists(asset.path)) { item.issue = 'media_missing'; continue }
        return { ...item, runId: row.runId, generationId: row.generationId, assetId: asset.id,
          fallback: row.runId !== node.data.selectedRunId, issue: null }
      } catch { item.issue = 'media_missing' }
    }
    return item
  })
  const stamp = createHash('sha256').update(JSON.stringify({ userId,scope,revision:board.revision,items })).digest('hex')
  return { nodeId: chain[0]!.id, revision: board.revision, stamp, items, ready: items.every(item => !item.issue) }
}

export function canvasExportSpec(preview: CanvasExportPreview, stamp: string): CanvasChainExportSpec {
  if (stamp !== preview.stamp) throw conflict('Danh sách video đã thay đổi. Hãy xem lại trước khi xuất.', { messageKey: 'exports.chain_stale' })
  if (!preview.ready) throw badRequest('Một video trong chuỗi chưa sẵn sàng. Hãy kiểm tra các node được báo.', undefined, { messageKey: 'exports.chain_not_ready' })
  return { source: 'canvas-chain', nodeId: preview.nodeId, revision: preview.revision,
    items: preview.items.map(item => ({ nodeId:item.nodeId,label:item.label,runId:item.runId!,generationId:item.generationId!,assetId:item.assetId! })) }
}

export function listCanvasExports(db: Database, userId: string, scope: CanvasExportScope): ExportRow[] {
  const column = scope.quickSessionId ? 'quick_session_id' : 'project_id'
  return db.prepare(`SELECT * FROM exports WHERE user_id=? AND ${column}=? AND json_extract(spec_json,'$.source')='canvas-chain' ORDER BY created_at DESC,id`)
    .all(userId,scope.quickSessionId ?? scope.projectId!) as ExportRow[]
}
