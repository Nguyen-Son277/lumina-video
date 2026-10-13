import type { Database } from '../db/index'
import { badRequest } from '../lib/errors'
import { ownedProject } from '../projects/service'
import type { CanvasGraph } from '../../shared/canvas'
import { buildAliasIndex, type AliasEntry, type CompiledCanvasPrompt, type ResolvedObject } from './compiler'
import { listEntityCatalog, resolveEntity, type CatalogEntity } from '../entityLibrary/service'
import { validatePromptDocument } from '../../shared/promptMentions'

/**
 * Phân giải đối tượng của Canvas từ database.
 *
 * Giao diện không bao giờ gửi tên/mô tả/đường dẫn ảnh; server đọc lại bản ghi theo
 * ID đã lưu trong graph nên dữ liệu hiển thị và dữ liệu gửi provider luôn khớp nhau.
 */

type CharacterRow = { id: string; name: string; appearance: string; reference_path: string | null }
type LocationRow = { id: string; name: string; description: string; continuity_notes: string; reference_upload_id: string | null; revision: number }
type ItemRow = { id: string; name: string; description: string; continuity_notes: string; reference_upload_id: string | null; revision: number }

function characterObject(db: Database, userId: string, projectId: string, nodeId: string, id: string): ResolvedObject {
  const row = db
    .prepare('SELECT id, name, appearance, reference_path FROM characters WHERE id = ? AND user_id = ? AND (project_id IS NULL OR project_id = ?) AND deleted_at IS NULL')
    .get(id, userId, projectId) as CharacterRow | undefined
  if (!row) throw badRequest('Nhân vật trong Canvas không còn khả dụng', undefined, { messageKey: 'canvas.source_invalid' })
  const entity = resolveEntity(db, userId, { kind: 'character', id }, projectId)
  return {
    nodeId,
    recordId: row.id,
    entity: { kind: 'character', id: row.id },
    handle: entity.handle,
    revision: entity.revision,
    referenceIdentity: entity.reference?.path ?? null,
    kind: 'character',
    name: row.name,
    description: row.appearance,
    continuityNotes: '',
    reference: row.reference_path ? { kind: 'character', characterId: row.id } : null,
  }
}

function locationObject(db: Database, userId: string, projectId: string, nodeId: string, id: string): ResolvedObject {
  const row = db
    .prepare(`SELECT l.id, l.name, l.description, l.continuity_notes, l.reference_upload_id, l.revision
                FROM project_locations l JOIN projects p ON p.id = l.project_id
               WHERE l.id = ? AND l.project_id = ? AND p.user_id = ? AND p.deleted_at IS NULL`)
    .get(id, projectId, userId) as LocationRow | undefined
  if (!row) throw badRequest('Bối cảnh trong Canvas không còn khả dụng', undefined, { messageKey: 'canvas.source_invalid' })
  return {
    nodeId,
    recordId: row.id,
    kind: 'location',
    name: row.name,
    description: row.description,
    continuityNotes: row.continuity_notes,
    revision: row.revision,
    referenceIdentity: row.reference_upload_id,
    reference: row.reference_upload_id ? { kind: 'upload', uploadId: row.reference_upload_id } : null,
  }
}

function itemObject(db: Database, userId: string, projectId: string, nodeId: string, id: string): ResolvedObject {
  const row = db
    .prepare('SELECT id, name, description, continuity_notes, reference_upload_id, revision FROM project_items WHERE id = ? AND project_id = ? AND user_id = ?')
    .get(id, projectId, userId) as ItemRow | undefined
  if (!row) throw badRequest('Sản phẩm/đạo cụ trong Canvas không còn khả dụng', undefined, { messageKey: 'canvas.source_invalid' })
  return {
    nodeId,
    recordId: row.id,
    kind: 'item',
    name: row.name,
    description: row.description,
    continuityNotes: row.continuity_notes,
    revision: row.revision,
    referenceIdentity: row.reference_upload_id,
    reference: row.reference_upload_id ? { kind: 'upload', uploadId: row.reference_upload_id } : null,
  }
}

function catalogObject(entity: CatalogEntity, nodeId: string): ResolvedObject {
  return {
    nodeId, recordId: entity.id, kind: entity.kind, entity: { kind: entity.kind, id: entity.id },
    name: entity.name, handle: entity.handle, description: entity.description, continuityNotes: entity.continuityNotes,
    revision: entity.revision, referenceIdentity: entity.reference?.uploadId ?? entity.reference?.path ?? null,
    reference: entity.reference ? entity.kind === 'character'
      ? { kind: 'character', characterId: entity.id }
      : entity.reference.uploadId ? { kind: 'upload', uploadId: entity.reference.uploadId } : null : null,
  }
}

/** Mọi đối tượng khai báo trong graph, dùng để dựng bảng alias của cả bảng Canvas. */
export function resolveCanvasObjects(db: Database, userId: string, projectId: string, graph: CanvasGraph): ResolvedObject[] {
  ownedProject(db, userId, projectId)
  const objects: ResolvedObject[] = []
  for (const node of graph.nodes) {
    const sourceId = node.data?.sourceId
    if (!sourceId) continue
    if (node.kind === 'character') objects.push(characterObject(db, userId, projectId, node.id, sourceId))
    else if (node.kind === 'location') objects.push(locationObject(db, userId, projectId, node.id, sourceId))
    else if (node.kind === 'item') objects.push(itemObject(db, userId, projectId, node.id, sourceId))
    else if (node.kind === 'library') {
      if (node.data.entityKind !== 'item' && node.data.entityKind !== 'logo') throw badRequest('Loại đối tượng thư viện không hợp lệ')
      objects.push(catalogObject(resolveEntity(db, userId, { kind: node.data.entityKind, id: sourceId }, projectId), node.id))
    }
  }
  // Bound mentions do not require fake graph edges. Their identities are persisted
  // as prompt-node links by writeCanvas, and resolved against the account catalog.
  const catalog = listEntityCatalog(db, userId, projectId)
  for (const node of graph.nodes) {
    if (node.kind !== 'prompt' || !node.data?.promptDocument) continue
    if (validatePromptDocument(node.data.promptDocument).length) throw badRequest('Tài liệu mention không hợp lệ')
    for (const binding of node.data.promptDocument.mentions) {
      if (objects.some(object => object.entity?.kind === binding.entity.kind && object.recordId === binding.entity.id)) continue
      const entity = catalog.find(entity => entity.kind === binding.entity.kind && entity.id === binding.entity.id)
      if (entity) objects.push(catalogObject(entity, `mention:${binding.entity.kind}:${binding.entity.id}`))
      // Deleted IDs stay unresolved; an entity recreated with the same handle never replaces them.
    }
  }
  return objects
}

/** Danh sách alias ổn định của bảng, kèm cờ có ảnh tham chiếu hay không. */
export function canvasAliases(objects: ResolvedObject[]): Array<AliasEntry & { hasReference: boolean }> {
  return buildAliasIndex(objects).map(({ referenceIdentity: _privatePath, ...entry }) => ({ ...entry, hasReference: Boolean(entry.reference) }))
}

/** Đối tượng nối trực tiếp vào một node sinh nội dung. */
export function contextObjectsFor(db: Database, userId: string, projectId: string, graph: CanvasGraph, nodeId: string): ResolvedObject[] {
  const node = graph.nodes.find((item) => item.id === nodeId)
  if (!node) throw badRequest('Node không tồn tại trong bảng Canvas')
  const connected = graph.edges
    .filter((edge) => edge.target === nodeId && edge.targetPort === 'context')
    .map((edge) => edge.source)
  const wanted = new Set(connected)
  const all = resolveCanvasObjects(db, userId, projectId, graph)
  return all.filter((object) => wanted.has(object.nodeId))
}

export type PlannedInputs = {
  uploadIds: string[]
  characterIds: string[]
  /** Ảnh không gửi được trong lần này, kèm lý do hiển thị cho người dùng. */
  dropped: Array<{ label: string; reason: 'limit' }>
  warnings: string[]
}

/**
 * Chọn ảnh thật sự gửi provider trong giới hạn của model.
 *
 * Ảnh do người dùng nối trực tiếp (vật phẩm, bối cảnh, đầu ra node trước) được ưu
 * tiên trước ảnh tham chiếu nhân vật, và mọi ảnh bị bỏ đều được báo lại thay vì
 * biến mất im lặng.
 */
export function planCanvasInputs(compiled: CompiledCanvasPrompt, maxImages: number, strict = true): PlannedInputs {
  const uploadIds: string[] = []
  const characterIds: string[] = []
  for (const ref of compiled.inputRefs) {
    if (ref.kind === 'upload' && ref.uploadId && !uploadIds.includes(ref.uploadId)) uploadIds.push(ref.uploadId)
    if (ref.kind === 'character' && ref.characterId && !characterIds.includes(ref.characterId)) characterIds.push(ref.characterId)
  }
  if (uploadIds.length > maxImages && strict) {
    throw badRequest(
      `Cảnh đang cần ${uploadIds.length} ảnh nhưng model chỉ nhận ${maxImages}. Hãy bỏ bớt ảnh hoặc giảm đối tượng.`,
      { count: uploadIds.length, max: maxImages },
      { messageKey: 'canvas.inputs_overflow', messageParams: { count: uploadIds.length, max: maxImages } },
    )
  }
  // Preview báo rõ ảnh nào sẽ không gửi thay vì âm thầm cắt bớt khi chạy.
  const usableUploads = strict ? uploadIds : uploadIds.slice(0, maxImages)
  const overflowUploads = uploadIds.slice(usableUploads.length)
  const room = Math.max(maxImages - usableUploads.length, 0)
  const keptCharacters = characterIds.slice(0, room)
  const droppedCharacters = characterIds.slice(keptCharacters.length)
  const dropped: PlannedInputs['dropped'] = [
    ...overflowUploads.map((id) => ({
      label: compiled.inputRefs.find((ref) => ref.uploadId === id)?.label ?? 'image',
      reason: 'limit' as const,
    })),
    ...droppedCharacters.map((id) => ({
      label: compiled.inputRefs.find((ref) => ref.characterId === id)?.label ?? 'character',
      reason: 'limit' as const,
    })),
  ]
  const warnings: string[] = []
  if (overflowUploads.length) warnings.push(`Chỉ gửi được ${usableUploads.length}/${uploadIds.length} ảnh vì giới hạn ${maxImages} ảnh đầu vào.`)
  if (droppedCharacters.length) warnings.push(`Chỉ gửi được ${keptCharacters.length}/${characterIds.length} ảnh tham chiếu nhân vật vì giới hạn ${maxImages} ảnh đầu vào.`)
  return { uploadIds: usableUploads, characterIds: keptCharacters, dropped, warnings }
}
