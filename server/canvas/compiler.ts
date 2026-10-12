import type { CanvasGraph, CanvasNode, CanvasPlacement } from '../../shared/canvas'
import { CANVAS_LIMITS } from '../../shared/canvas'
import { badRequest, errorMeta } from '../lib/errors'

/**
 * Biên dịch Canvas thành prompt và danh sách ảnh đầu vào.
 *
 * Mọi thứ ở đây chạy trên graph ĐÃ LƯU của server, không tin prompt ghép sẵn hay
 * đường dẫn tệp do client gửi. Nhờ vậy preview và lúc chạy luôn cho cùng kết quả,
 * và ảnh nào thực sự được gửi provider đều xuất phát từ bản ghi trong database.
 */

/** Ảnh tham chiếu của một đối tượng: ảnh nhân vật nằm trong kho riêng, còn lại là uploads. */
export type ObjectReference =
  | { kind: 'character'; characterId: string }
  | { kind: 'upload'; uploadId: string }

/** Một đối tượng đã phân giải quyền sở hữu, dùng để dựng prompt. */
export type ResolvedObject = {
  /** Node Canvas đang tham chiếu đối tượng này. */
  nodeId: string
  /** ID bản ghi thật (characters/project_locations/project_items). */
  recordId: string
  kind: 'character' | 'location' | 'item'
  name: string
  /** Ngoại hình/mô tả chuẩn của bản ghi. */
  description: string
  continuityNotes: string
  /** Ảnh tham chiếu nội bộ, đã kiểm tra thuộc tài khoản; null khi chưa có ảnh. */
  reference: ObjectReference | null
}

export type AliasEntry = ResolvedObject & { alias: string }

const MENTION_PATTERN = /(?<!\\)@([\p{L}\p{N}_-]+)/gu

/** Bỏ dấu tiếng Việt và ký tự không hợp lệ để alias ổn định giữa các lần lưu. */
function aliasBase(name: string): string {
  const normalized = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .replace(/^_+|_+$/g, '')
  return normalized || 'doituong'
}

/**
 * Gán alias duy nhất cho từng đối tượng theo thứ tự node.
 *
 * Alias bám vào tên hiển thị tại thời điểm lưu; đổi tên sau đó không làm mention cũ
 * mất liên kết vì server luôn phân giải theo alias đã lưu trong graph.
 */
export function buildAliasIndex(objects: ResolvedObject[]): AliasEntry[] {
  const used = new Map<string, number>()
  return objects.map((object) => {
    const base = aliasBase(object.name)
    const seen = used.get(base.toLowerCase()) ?? 0
    used.set(base.toLowerCase(), seen + 1)
    return { ...object, alias: seen === 0 ? base : `${base}${seen + 1}` }
  })
}

export function aliasIndexByAlias(entries: AliasEntry[]): Map<string, AliasEntry> {
  return new Map(entries.map((entry) => [entry.alias.toLowerCase(), entry]))
}

/** Node Prompt nối vào generator, theo đúng thứ tự cạnh. */
export function promptTextFor(graph: CanvasGraph, nodeId: string): string {
  const parts: string[] = []
  for (const edge of graph.edges.filter((item) => item.target === nodeId && item.targetPort === 'prompt')) {
    const source = graph.nodes.find((item) => item.id === edge.source)
    if (source?.kind === 'prompt' && source.data?.text?.trim()) parts.push(source.data.text.trim())
  }
  return parts.join('\n\n')
}

export type MentionParseResult = {
  /** Alias xuất hiện trong prompt và đã phân giải. */
  resolved: AliasEntry[]
  /** Alias không còn đối tượng tương ứng; chặn chạy thay vì bỏ qua im lặng. */
  unresolved: string[]
}

/** Tách `@alias` trong văn bản; `\@` được hiểu là ký tự thường. */
export function parseMentions(text: string, index: Map<string, AliasEntry>): MentionParseResult {
  const resolved: AliasEntry[] = []
  const unresolved: string[] = []
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const raw = match[1] ?? ''
    if (!raw) continue
    const entry = index.get(raw.toLowerCase())
    if (!entry) {
      if (!unresolved.includes(raw)) unresolved.push(raw)
      continue
    }
    if (!resolved.some((item) => item.nodeId === entry.nodeId)) resolved.push(entry)
  }
  return { resolved, unresolved }
}

export type CanvasInputRef = {
  /** Ảnh uploads nội bộ hoặc ảnh tham chiếu nhân vật (kho media riêng). */
  kind: 'upload' | 'character'
  uploadId?: string
  characterId?: string
  /** Vì sao ảnh này được gửi, để giao diện giải thích cho người dùng. */
  reason: 'object' | 'upstream' | 'source' | 'composite'
  /** Node sinh ra ảnh, nếu có. */
  nodeId: string | null
  label: string
}

export type CompiledCanvasPrompt = {
  /** Prompt gửi cho model, đã gồm mô tả đối tượng và chỉ dẫn bố trí. */
  prompt: string
  /** Prompt gốc người dùng gõ, giữ nguyên để hiển thị lại. */
  userText: string
  mentions: AliasEntry[]
  unresolved: string[]
  inputRefs: CanvasInputRef[]
  /**
   * ID bản ghi của nhân vật chính, dùng cho hợp đồng characterId của lần tạo.
   * Đây là ID nhân vật thật, KHÔNG phải ID node Canvas.
   */
  primaryCharacterId: string | null
  warnings: string[]
}

const KIND_LABEL: Record<ResolvedObject['kind'], string> = {
  character: 'nhân vật',
  location: 'bối cảnh',
  item: 'sản phẩm/đạo cụ',
}

function placementLine(placement: CanvasPlacement, objects: Map<string, AliasEntry>): string {
  const object = objects.get(placement.sourceNodeId)
  const alias = object?.alias ?? placement.sourceNodeId
  const layer = placement.z <= 0 ? 'lớp sau' : `lớp ${placement.z + 1}`
  const flip = placement.flipX ? ', lật ngang' : ''
  return `- @${alias}: đặt tại (${placement.x.toFixed(3)}, ${placement.y.toFixed(3)}), rộng ${placement.width.toFixed(3)} khung, xoay ${Math.round(placement.rotation)}°${flip}, ${layer}`
}

export type CompileOptions = {
  graph: CanvasGraph
  node: CanvasNode
  objects: ResolvedObject[]
  /** Tiêu đề dự án và phong cách chung, ghép vào prompt cho nhất quán. */
  projectStyle?: string
  /** Tỷ lệ khung hình của cảnh. */
  aspectRatio?: string
}

/**
 * Dựng prompt cuối cùng của một node sinh nội dung.
 *
 * Thứ tự khối cố định để preview đọc được và để model nhận đúng thứ tự ưu tiên:
 * chỉ dẫn chung → đối tượng → bố trí → mô tả người dùng.
 */
export function compileCanvasPrompt(options: CompileOptions): CompiledCanvasPrompt {
  const { graph, node, objects } = options
  const entries = buildAliasIndex(objects)
  const byNode = new Map(entries.map((entry) => [entry.nodeId, entry]))
  const userText = promptTextFor(graph, node.id)
  const parsed = parseMentions(userText, aliasIndexByAlias(entries))

  const layout = node.data?.layout
  const placements = layout?.instances ?? []
  if (placements.length > CANVAS_LIMITS.placements) {
    throw badRequest(`Tối đa ${CANVAS_LIMITS.placements} đối tượng trong một khung hình`)
  }

  const warnings: string[] = []
  // Đối tượng nối vào cảnh nhưng chưa được gọi tên vẫn được mô tả: nối node là ý định rõ ràng.
  const connected = new Set(
    graph.edges.filter((edge) => edge.target === node.id && edge.targetPort === 'context').map((edge) => edge.source),
  )
  const used = new Map<string, AliasEntry>()
  for (const entry of parsed.resolved) used.set(entry.nodeId, entry)
  for (const nodeId of connected) {
    const entry = byNode.get(nodeId)
    if (entry) used.set(nodeId, entry)
  }

  const lines: string[] = []
  if (options.projectStyle?.trim()) lines.push(`Phong cách chung của dự án: ${options.projectStyle.trim()}`)
  if (options.aspectRatio) lines.push(`Tỷ lệ khung hình: ${options.aspectRatio}`)

  if (used.size) {
    lines.push('Đối tượng phải giữ đúng nhận diện (dùng đúng những đối tượng này, không thêm người hoặc vật khác):')
    for (const entry of used.values()) {
      const parts = [`@${entry.alias} (${KIND_LABEL[entry.kind]})`]
      if (entry.description) parts.push(entry.description)
      if (entry.continuityNotes) parts.push(`Bắt buộc giữ: ${entry.continuityNotes}`)
      if (!entry.reference) parts.push('chưa có ảnh tham chiếu, chỉ dựa vào mô tả')
      lines.push(`- ${parts.join(' — ')}`)
    }
  }

  if (placements.length) {
    lines.push('Bố trí trong khung hình (theo tỷ lệ khung, gốc trên-trái):')
    for (const placement of placements) lines.push(placementLine(placement, byNode))
    if (layout?.backgroundNodeId) {
      const background = byNode.get(layout.backgroundNodeId)
      if (background) lines.push(`Nền chính: @${background.alias}`)
    }
  }

  lines.push(userText)

  const inputRefs: CanvasInputRef[] = []
  const pushRef = (ref: CanvasInputRef): void => {
    const key = ref.kind === 'upload' ? `upload:${ref.uploadId}` : `character:${ref.characterId}`
    if (!inputRefs.some((item) => (item.kind === 'upload' ? `upload:${item.uploadId}` : `character:${item.characterId}`) === key)) {
      inputRefs.push(ref)
    }
  }

  // Ảnh của đối tượng đứng trước để model thấy nhân diện chuẩn trước tiên.
  for (const entry of used.values()) {
    if (!entry.reference) continue
    pushRef(entry.reference.kind === 'character'
      ? { kind: 'character', characterId: entry.reference.characterId, reason: 'object', nodeId: entry.nodeId, label: entry.name }
      : { kind: 'upload', uploadId: entry.reference.uploadId, reason: 'object', nodeId: entry.nodeId, label: entry.name })
  }
  // Ảnh sinh ra từ node phía trước (đầu ra đang chọn).
  for (const edge of graph.edges.filter((item) => item.target === node.id && item.targetPort === 'image')) {
    const source = graph.nodes.find((item) => item.id === edge.source)
    if (source?.data?.uploadId) {
      pushRef({ kind: 'upload', uploadId: source.data.uploadId, reason: 'upstream', nodeId: source.id, label: source.kind })
    }
  }
  // Ảnh nguồn chọn trực tiếp trên node.
  if (node.data?.uploadId) {
    pushRef({ kind: 'upload', uploadId: node.data.uploadId, reason: 'source', nodeId: node.id, label: 'source' })
  }

  const primaryCharacter = [...used.values()].find((entry) => entry.kind === 'character') ?? null

  return {
    prompt: lines.filter(Boolean).join('\n'),
    userText,
    mentions: [...used.values()],
    unresolved: parsed.unresolved,
    inputRefs,
    primaryCharacterId: primaryCharacter?.recordId ?? null,
    warnings,
  }
}

/** Chặn chạy khi prompt còn gọi đối tượng không phân giải được. */
export function assertMentionsResolved(compiled: CompiledCanvasPrompt): void {
  if (compiled.unresolved.length) {
    throw badRequest(
      `Prompt đang gọi đối tượng không còn khả dụng: ${compiled.unresolved.map((alias) => `@${alias}`).join(', ')}`,
      { aliases: compiled.unresolved },
      errorMeta('canvas.mention_unresolved', { aliases: compiled.unresolved.map((alias) => `@${alias}`).join(', ') }),
    )
  }
}
