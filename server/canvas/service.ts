import { createHash, randomUUID } from 'node:crypto'
import type { Database } from '../db/index'
import { badRequest, notFound } from '../lib/errors'
import { ownedProject, transaction } from '../projects/service'
import {
  CANVAS_SCHEMA_VERSION,
  emptyCanvasGraph,
  validateCanvasGraph,
  validateCanvasLayout,
  type CanvasGraph,
  type CanvasNode,
  type CanvasPlacement,
} from '../../shared/canvas'

export type ProjectItemKind = 'product' | 'prop'

export type ProjectItemRow = {
  id: string
  project_id: string
  user_id: string
  kind: ProjectItemKind
  name: string
  description: string
  continuity_notes: string
  image_prompt: string
  reference_upload_id: string | null
  revision: number
  created_at: number
  updated_at: number
}

export type ProjectItemPublic = {
  id: string
  kind: ProjectItemKind
  name: string
  description: string
  continuityNotes: string
  imagePrompt: string
  reference: { uploadId: string } | null
  revision: number
  updatedAt: number
}

export type CanvasRunPublic = {
  id: string
  nodeId: string
  kind: 'image' | 'video'
  generationId: string | null
  inputStamp: string
  createdAt: number
}

export type CanvasPublic = {
  projectId: string
  graph: CanvasGraph
  revision: number
  updatedAt: number
  runs: CanvasRunPublic[]
}

const MAX_NAME = 200
const MAX_TEXT = 4000

export function itemPublic(row: ProjectItemRow): ProjectItemPublic {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    description: row.description,
    continuityNotes: row.continuity_notes,
    imagePrompt: row.image_prompt,
    reference: row.reference_upload_id ? { uploadId: row.reference_upload_id } : null,
    revision: row.revision,
    updatedAt: row.updated_at,
  }
}

/* -------------------------------------------------------------------------- */
/* Vật phẩm / đạo cụ                                                          */
/* -------------------------------------------------------------------------- */

export function listItems(db: Database, userId: string, projectId: string): ProjectItemRow[] {
  ownedProject(db, userId, projectId)
  return db
    .prepare('SELECT * FROM project_items WHERE project_id = ? ORDER BY created_at ASC, id ASC')
    .all(projectId) as unknown as ProjectItemRow[]
}

export function ownedItem(db: Database, userId: string, projectId: string, itemId: string): ProjectItemRow {
  ownedProject(db, userId, projectId)
  const row = db
    .prepare('SELECT * FROM project_items WHERE id = ? AND project_id = ? AND user_id = ?')
    .get(itemId, projectId, userId) as unknown as ProjectItemRow | undefined
  if (!row) throw notFound('Không tìm thấy sản phẩm hoặc đạo cụ')
  return row
}

export type ItemInput = {
  kind: ProjectItemKind
  name: string
  description?: string
  continuityNotes?: string
  imagePrompt?: string
  /** Ảnh tham chiếu đã tải lên trước đó; `null` để bỏ ảnh. */
  referenceUploadId?: string | null
}

function cleanItemInput(input: ItemInput): Omit<ProjectItemRow, 'id' | 'project_id' | 'user_id' | 'revision' | 'created_at' | 'updated_at'> {
  const name = input.name.trim()
  if (!name) throw badRequest('Vui lòng nhập tên sản phẩm hoặc đạo cụ')
  if (name.length > MAX_NAME) throw badRequest(`Tên tối đa ${MAX_NAME} ký tự`)
  for (const [label, value] of [['mô tả', input.description], ['ghi chú', input.continuityNotes], ['prompt', input.imagePrompt]] as const) {
    if (value !== undefined && value.length > MAX_TEXT) throw badRequest(`${label} tối đa ${MAX_TEXT} ký tự`)
  }
  if (input.kind !== 'product' && input.kind !== 'prop') throw badRequest('Loại vật phẩm không hợp lệ')
  return {
    kind: input.kind,
    name,
    description: (input.description ?? '').trim(),
    continuity_notes: (input.continuityNotes ?? '').trim(),
    image_prompt: (input.imagePrompt ?? '').trim(),
    reference_upload_id: input.referenceUploadId ?? null,
  }
}

/** Ảnh tham chiếu phải thuộc đúng người dùng, giống ảnh nguồn của lần tạo. */
export function assertOwnedUpload(db: Database, userId: string, uploadId: string): void {
  const row = db
    .prepare('SELECT id FROM uploads WHERE id = ? AND user_id = ?')
    .get(uploadId, userId)
  if (!row) throw badRequest('Ảnh tham chiếu không tồn tại hoặc không thuộc tài khoản của bạn')
}

export function createItem(db: Database, userId: string, projectId: string, input: ItemInput): ProjectItemRow {
  const project = ownedProject(db, userId, projectId, true)
  const clean = cleanItemInput(input)
  if (clean.reference_upload_id) assertOwnedUpload(db, userId, clean.reference_upload_id)
  const id = randomUUID()
  const now = Date.now()
  db.prepare(
    `INSERT INTO project_items
       (id, project_id, user_id, kind, name, description, continuity_notes, image_prompt,
        reference_upload_id, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    id, project.id, userId, clean.kind, clean.name, clean.description, clean.continuity_notes,
    clean.image_prompt, clean.reference_upload_id, now, now,
  )
  return ownedItem(db, userId, projectId, id)
}

export function updateItem(db: Database, userId: string, projectId: string, itemId: string, input: Partial<ItemInput>): ProjectItemRow {
  const existing = ownedItem(db, userId, projectId, itemId)
  const merged: ItemInput = {
    kind: input.kind ?? existing.kind,
    name: input.name ?? existing.name,
    description: input.description ?? existing.description,
    continuityNotes: input.continuityNotes ?? existing.continuity_notes,
    imagePrompt: input.imagePrompt ?? existing.image_prompt,
    referenceUploadId: input.referenceUploadId === undefined ? existing.reference_upload_id : input.referenceUploadId,
  }
  const clean = cleanItemInput(merged)
  if (clean.reference_upload_id && clean.reference_upload_id !== existing.reference_upload_id) {
    assertOwnedUpload(db, userId, clean.reference_upload_id)
  }
  db.prepare(
    `UPDATE project_items
        SET kind = ?, name = ?, description = ?, continuity_notes = ?, image_prompt = ?,
            reference_upload_id = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND project_id = ? AND user_id = ?`,
  ).run(
    clean.kind, clean.name, clean.description, clean.continuity_notes, clean.image_prompt,
    clean.reference_upload_id, Date.now(), itemId, projectId, userId,
  )
  return ownedItem(db, userId, projectId, itemId)
}

/** Chặn xoá vật phẩm/nhân vật/bối cảnh đang được Canvas tham chiếu. */
export function assertSourceNotLinked(
  db: Database,
  column: 'character_id' | 'location_id' | 'item_id' | 'scene_id',
  id: string,
  message: string,
): void {
  const row = db
    .prepare(`SELECT project_id, node_id FROM project_canvas_links WHERE ${column} = ? LIMIT 1`)
    .get(id) as { project_id: string; node_id: string } | undefined
  if (row) throw badRequest(message)
}

export function removeItem(db: Database, userId: string, projectId: string, itemId: string): void {
  const existing = ownedItem(db, userId, projectId, itemId)
  assertSourceNotLinked(db, 'item_id', existing.id, 'Vật phẩm đang được Canvas sử dụng. Gỡ khỏi bảng Canvas trước khi xóa.')
  db.prepare('DELETE FROM project_items WHERE id = ? AND project_id = ? AND user_id = ?').run(itemId, projectId, userId)
}

/* -------------------------------------------------------------------------- */
/* Bảng Canvas                                                                */
/* -------------------------------------------------------------------------- */

export function readCanvas(db: Database, userId: string, projectId: string): CanvasPublic {
  ownedProject(db, userId, projectId)
  const row = db
    .prepare('SELECT graph_json, revision, updated_at FROM project_canvases WHERE project_id = ? AND user_id = ?')
    .get(projectId, userId) as { graph_json: string; revision: number; updated_at: number } | undefined
  let graph = emptyCanvasGraph()
  if (row) {
    try {
      const parsed = JSON.parse(row.graph_json) as CanvasGraph
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
        graph = parsed
      }
    } catch {
      // Graph hỏng: trả bảng trống còn hơn để giao diện không mở được.
    }
  }
  return {
    projectId,
    graph,
    revision: row?.revision ?? 0,
    updatedAt: row?.updated_at ?? 0,
    runs: listRuns(db, projectId),
  }
}

export function listRuns(db: Database, projectId: string): CanvasRunPublic[] {
  const rows = db
    .prepare('SELECT id, node_id, kind, generation_id, input_stamp, created_at FROM project_canvas_runs WHERE project_id = ? ORDER BY created_at DESC, id ASC LIMIT 200')
    .all(projectId) as unknown as Array<{ id: string; node_id: string; kind: 'image' | 'video'; generation_id: string | null; input_stamp: string; created_at: number }>
  return rows.map((row) => ({
    id: row.id,
    nodeId: row.node_id,
    kind: row.kind,
    generationId: row.generation_id,
    inputStamp: row.input_stamp,
    createdAt: row.created_at,
  }))
}

/**
 * Chỉ mục nguồn của từng node, dùng cho cả ghi link lẫn tính stamp đầu vào.
 *
 * Trả về đúng bản ghi đã kiểm tra quyền: nhân vật dùng chung của tài khoản hoặc
 * nhân vật/bối cảnh/vật phẩm của chính dự án.
 */
export type CanvasSourceRef =
  | { role: 'character'; id: string }
  | { role: 'location'; id: string }
  | { role: 'item'; id: string }
  | { role: 'scene'; id: string }
  | { role: 'upload'; id: string }
  | { role: 'output'; id: string }

function requireCharacter(db: Database, userId: string, projectId: string, id: string): string {
  const row = db
    .prepare('SELECT id FROM characters WHERE id = ? AND user_id = ? AND (project_id IS NULL OR project_id = ?)')
    .get(id, userId, projectId) as { id: string } | undefined
  if (!row) throw badRequest('Nhân vật không tồn tại hoặc không thuộc dự án của bạn', undefined, { messageKey: 'canvas.source_invalid' })
  return row.id
}

function requireLocation(db: Database, userId: string, projectId: string, id: string): string {
  const row = db
    .prepare(`SELECT l.id FROM project_locations l JOIN projects p ON p.id = l.project_id
               WHERE l.id = ? AND l.project_id = ? AND p.user_id = ?`)
    .get(id, projectId, userId) as { id: string } | undefined
  if (!row) throw badRequest('Bối cảnh không tồn tại hoặc không thuộc dự án của bạn', undefined, { messageKey: 'canvas.source_invalid' })
  return row.id
}

function requireScene(db: Database, userId: string, projectId: string, id: string): string {
  const row = db
    .prepare(`SELECT s.id FROM scenes s JOIN projects p ON p.id = s.project_id
               WHERE s.id = ? AND s.project_id = ? AND p.user_id = ? AND p.deleted_at IS NULL`)
    .get(id, projectId, userId) as { id: string } | undefined
  if (!row) throw badRequest('Cảnh không tồn tại hoặc không thuộc dự án của bạn', undefined, { messageKey: 'canvas.source_invalid' })
  return row.id
}

/** Nguồn khai báo của một node, đã kiểm tra quyền sở hữu. */
export function nodeSources(db: Database, userId: string, projectId: string, node: CanvasNode): CanvasSourceRef[] {
  const refs: CanvasSourceRef[] = []
  const data = node.data ?? {}
  switch (node.kind) {
    case 'character':
      if (data.sourceId) refs.push({ role: 'character', id: requireCharacter(db, userId, projectId, data.sourceId) })
      break
    case 'location':
      if (data.sourceId) refs.push({ role: 'location', id: requireLocation(db, userId, projectId, data.sourceId) })
      break
    case 'item':
      refs.push({ role: 'item', id: ownedItem(db, userId, projectId, data.sourceId ?? '').id })
      break
    case 'video':
      if (data.sceneId) refs.push({ role: 'scene', id: requireScene(db, userId, projectId, data.sceneId) })
      break
    case 'upload':
      if (data.uploadId) {
        assertOwnedUpload(db, userId, data.uploadId)
        refs.push({ role: 'upload', id: data.uploadId })
      }
      break
    case 'sheet':
    case 'image':
      if (data.uploadId) {
        assertOwnedUpload(db, userId, data.uploadId)
        refs.push({ role: 'upload', id: data.uploadId })
      }
      break
    default:
      break
  }
  if (node.kind === 'image' || node.kind === 'video') {
    for (const placement of node.data?.layout?.instances ?? []) {
      const uploaded = placement.imageUploadId
      if (!uploaded) continue
      assertOwnedUpload(db, userId, uploaded)
      refs.push({ role: 'upload', id: uploaded })
    }
    if (data.selectedRunId) refs.push({ role: 'output', id: data.selectedRunId })
  }
  return refs
}

export type WriteCanvasInput = {
  graph: unknown
  /** Revision client đang giữ; lệch nghĩa là có tab khác đã lưu. */
  baseRevision: number
  /** Cập nhật nội dung cảnh (prompt/lời thoại) của node video, cùng transaction. */
  scenePatch?: { sceneId: string; prompt?: string; dialogue?: string }
}

export type WriteCanvasResult = { canvas: CanvasPublic }

export function writeCanvas(db: Database, userId: string, projectId: string, input: WriteCanvasInput): WriteCanvasResult {
  ownedProject(db, userId, projectId, true)
  const issues = validateCanvasGraph(input.graph)
  if (issues.length) throw badRequest('Bảng Canvas không hợp lệ', { issues }, { messageKey: 'canvas.graph_invalid' })
  const graph = input.graph as CanvasGraph
  const nodeIds = new Set(graph.nodes.map((node) => node.id))
  for (const node of graph.nodes) {
    const layoutIssues = validateCanvasLayout(node.data?.layout, nodeIds)
    if (layoutIssues.length) throw badRequest('Bố trí trong khung hình không hợp lệ', { issues: layoutIssues }, { messageKey: 'canvas.layout_invalid' })
  }

  return transaction(db, () => {
    const current = db
      .prepare('SELECT revision FROM project_canvases WHERE project_id = ? AND user_id = ?')
      .get(projectId, userId) as { revision: number } | undefined
    const currentRevision = current?.revision ?? 0
    if (currentRevision !== input.baseRevision) {
      throw badRequest('Bảng Canvas đã được lưu ở nơi khác. Hãy tải lại trước khi lưu.', { expected: currentRevision }, { messageKey: 'canvas.revision_conflict' })
    }

    // Thu thập link và kiểm tra quyền sở hữu cho MỌI nguồn trước khi ghi.
    const links: Array<{ nodeId: string; ref: CanvasSourceRef }> = []
    for (const node of graph.nodes) {
      for (const ref of nodeSources(db, userId, projectId, node)) links.push({ nodeId: node.id, ref })
    }

    const now = Date.now()
    const nextRevision = currentRevision + 1
    db.prepare(
      `INSERT INTO project_canvases (project_id, user_id, graph_json, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id) DO UPDATE SET graph_json = excluded.graph_json, revision = excluded.revision, updated_at = excluded.updated_at`,
    ).run(projectId, userId, JSON.stringify(graph), nextRevision, now, now)

    db.prepare('DELETE FROM project_canvas_links WHERE project_id = ?').run(projectId)
    const insert = db.prepare(
      `INSERT INTO project_canvas_links
         (id, project_id, node_id, role, target_id, character_id, location_id, item_id, scene_id, upload_id, generation_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const link of links) {
      const columns = {
        character_id: link.ref.role === 'character' ? link.ref.id : null,
        location_id: link.ref.role === 'location' ? link.ref.id : null,
        item_id: link.ref.role === 'item' ? link.ref.id : null,
        scene_id: link.ref.role === 'scene' ? link.ref.id : null,
        upload_id: link.ref.role === 'upload' ? link.ref.id : null,
        generation_id: link.ref.role === 'output' ? resolveRunGeneration(db, projectId, link.ref.id) : null,
      }
      insert.run(
        randomUUID(), projectId, link.nodeId, link.ref.role, link.ref.id,
        columns.character_id, columns.location_id, columns.item_id, columns.scene_id,
        columns.upload_id, columns.generation_id, now,
      )
    }

    if (input.scenePatch) {
      const scene = graph.nodes.find((node) => node.kind === 'video' && node.data?.sceneId === input.scenePatch!.sceneId)
      if (!scene) throw badRequest('Cảnh cần cập nhật không thuộc bảng Canvas này')
      requireScene(db, userId, projectId, input.scenePatch.sceneId)
      const fields: string[] = []
      const values: Array<string | number> = []
      if (input.scenePatch.prompt !== undefined) { fields.push('prompt = ?'); values.push(input.scenePatch.prompt.slice(0, 8000)) }
      if (input.scenePatch.dialogue !== undefined) { fields.push('dialogue = ?'); values.push(input.scenePatch.dialogue.slice(0, 4000)) }
      if (fields.length) {
        fields.push('updated_at = ?')
        values.push(now, input.scenePatch.sceneId, projectId)
        db.prepare(`UPDATE scenes SET ${fields.join(', ')} WHERE id = ? AND project_id = ?`).run(...values)
      }
    }

    return { canvas: { projectId, graph, revision: nextRevision, updatedAt: now, runs: listRuns(db, projectId) } }
  })
}

function resolveRunGeneration(db: Database, projectId: string, runId: string): string | null {
  const row = db
    .prepare('SELECT generation_id FROM project_canvas_runs WHERE id = ? AND project_id = ?')
    .get(runId, projectId) as { generation_id: string | null } | undefined
  return row?.generation_id ?? null
}

export function recordRun(
  db: Database,
  projectId: string,
  nodeId: string,
  kind: 'image' | 'video',
  generationId: string,
  inputStamp: string,
): CanvasRunPublic {
  const id = randomUUID()
  const now = Date.now()
  db.prepare(
    'INSERT INTO project_canvas_runs (id, project_id, node_id, kind, generation_id, input_stamp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, projectId, nodeId, kind, generationId, inputStamp, now)
  return { id, nodeId, kind, generationId, inputStamp, createdAt: now }
}

export function ownedRun(db: Database, projectId: string, runId: string) {
  return db
    .prepare('SELECT * FROM project_canvas_runs WHERE id = ? AND project_id = ?')
    .get(runId, projectId) as { id: string; node_id: string; kind: 'image' | 'video'; generation_id: string | null } | undefined
}

/** Dấu vân tay đầu vào của một node, dùng để phát hiện preview đã cũ. */
export function canvasStamp(graph: CanvasGraph, nodeId: string): string {
  const node = graph.nodes.find((item) => item.id === nodeId)
  if (!node) throw notFound('Không tìm thấy node trong bảng Canvas')
  const upstream = graph.edges
    .filter((edge) => edge.target === nodeId)
    .map((edge) => {
      const source = graph.nodes.find((item) => item.id === edge.source)
      return `${edge.sourcePort}->${edge.targetPort}:${JSON.stringify(source?.data ?? {})}`
    })
    .sort()
  return createHash('sha256')
    .update(JSON.stringify({ kind: node.kind, data: node.data ?? {}, upstream }))
    .digest('hex')
    .slice(0, 32)
}

export type { CanvasPlacement, CanvasNode }
export { CANVAS_SCHEMA_VERSION }
