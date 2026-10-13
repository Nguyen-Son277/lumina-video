/**
 * Hợp đồng Canvas dùng chung cho frontend và backend.
 *
 * Canvas là đồ thị có kiểu: mỗi node sản xuất một cổng ra (text/ảnh/đối tượng/video)
 * và các node sinh nội dung nhận cổng vào tương thích. Nhờ định nghĩa cổng ở đây,
 * giao diện chặn dây nối sai ngay lúc kéo còn server kiểm tra lại trước khi lưu —
 * hai bên không thể lệch nhau.
 */

/** Tăng khi cấu trúc graph đổi theo cách không tương thích ngược. */
import type { PromptDocument } from './promptMentions'

export const CANVAS_SCHEMA_VERSION = 1

export const CANVAS_LIMITS = {
  nodes: 100,
  edges: 200,
  placements: 24,
  contextInputs: 12,
} as const

/** Loại dữ liệu chạy trên dây nối; màu cổng ở giao diện bám theo bảng này. */
export type CanvasPortKind = 'text' | 'image' | 'object' | 'video'

export type CanvasNodeKind =
  | 'prompt'
  | 'note'
  | 'upload'
  | 'character'
  | 'location'
  | 'item'
  | 'library'
  | 'sheet'
  | 'image'
  | 'video'

export type CanvasPortSpec = {
  /** Loại dữ liệu cổng chấp nhận (hoặc phát ra). */
  kinds: CanvasPortKind[]
  /** Số dây tối đa; bỏ trống nghĩa là không giới hạn. */
  max?: number
}

type CanvasNodeSpec = {
  inputs: Record<string, CanvasPortSpec>
  outputs: Record<string, CanvasPortKind>
}

/**
 * Cổng vào/ra của từng loại node.
 *
 * `prompt` là văn bản, `context` là danh sách đối tượng (nhân vật/bối cảnh/vật phẩm),
 * `image` là ảnh tham chiếu đã chạy thành công, `output` là kết quả của node sinh nội dung.
 */
export const CANVAS_NODE_SPECS: Record<CanvasNodeKind, CanvasNodeSpec> = {
  prompt: { inputs: {}, outputs: { prompt: 'text' } },
  note: { inputs: {}, outputs: {} },
  upload: { inputs: {}, outputs: { image: 'image' } },
  character: { inputs: {}, outputs: { object: 'object' } },
  location: { inputs: {}, outputs: { object: 'object' } },
  item: { inputs: {}, outputs: { object: 'object' } },
  library: { inputs: {}, outputs: { object: 'object' } },
  sheet: {
    inputs: { prompt: { kinds: ['text'], max: 1 }, character: { kinds: ['object'], max: 1 }, image: { kinds: ['image'] } },
    outputs: { image: 'image' },
  },
  image: {
    inputs: {
      prompt: { kinds: ['text'], max: 1 },
      context: { kinds: ['object'], max: CANVAS_LIMITS.contextInputs },
      image: { kinds: ['image'] },
    },
    outputs: { image: 'image' },
  },
  video: {
    inputs: {
      prompt: { kinds: ['text'], max: 1 },
      context: { kinds: ['object'], max: CANVAS_LIMITS.contextInputs },
      image: { kinds: ['image'] },
    },
    outputs: { video: 'video' },
  },
}

export type CanvasNodeData = {
  /** Node `prompt`: nội dung người dùng gõ, có thể chứa `@alias`. */
  text?: string
  /** Optional v1 extension: explicit kind+ID bindings; raw legacy text is never inferred. */
  promptDocument?: PromptDocument
  /** Account library asset nodes share object ports with project-local items. */
  entityKind?: 'item' | 'logo'
  /** Node `upload`/`sheet`/`image`: ảnh nguồn đã chọn trong kho uploads. */
  uploadId?: string | null
  /** Node đối tượng: ID bản ghi trong dự án hoặc thư viện. */
  sourceId?: string | null
  /** Node `sheet`/`image`/`video`: model người dùng chọn. */
  modelId?: string | null
  /** Node `video`: cảnh Studio làm nguồn sự thật cho lời thoại và phiên bản. */
  sceneId?: string | null
  /** Node `note`: màu thẻ và nội dung tự do, không bao giờ gửi provider. */
  color?: 'yellow' | 'purple' | 'green'
  /** Node `image`/`video`: đầu ra đang được chọn để chảy sang node sau. */
  selectedRunId?: string | null
  /** Node `image`/`video`: bố trí đối tượng lên nền của cảnh. */
  layout?: CanvasLayout
}

export type CanvasNode = {
  id: string
  kind: CanvasNodeKind
  /** Toạ độ trên bảng, độc lập với bố cục trong khung ảnh. */
  x: number
  y: number
  data: CanvasNodeData
}

export type CanvasEdge = {
  id: string
  source: string
  sourcePort: string
  target: string
  targetPort: string
}

/** Một instance đối tượng đặt trên nền; toạ độ chuẩn hoá theo khung ảnh. */
export type CanvasPlacement = {
  id: string
  /** Node đối tượng được đặt (nhân vật/bối cảnh/vật phẩm). */
  sourceNodeId: string
  /** Node chứa ảnh dùng cho instance, nếu người dùng chọn ảnh khác ảnh gốc. */
  imageUploadId?: string | null
  x: number
  y: number
  width: number
  height: number
  /** Góc xoay theo độ, khoảng -180..180. */
  rotation: number
  flipX: boolean
  /** Thứ tự lớp; số lớn hơn nằm trên. */
  z: number
}

export type CanvasLayout = {
  /** Node bối cảnh làm nền chính. */
  backgroundNodeId?: string | null
  aspectRatio: string
  instances: CanvasPlacement[]
}

export type CanvasGraph = {
  schemaVersion: number
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

export const CANVAS_ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] as const

export const emptyCanvasGraph = (): CanvasGraph => ({
  schemaVersion: CANVAS_SCHEMA_VERSION,
  nodes: [],
  edges: [],
})

export const emptyCanvasLayout = (): CanvasLayout => ({
  backgroundNodeId: null,
  aspectRatio: '16:9',
  instances: [],
})

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** Cổng vào của một node, tra theo loại node; node lạ trả rỗng. */
export function canvasInputs(kind: string): Record<string, CanvasPortSpec> {
  return isCanvasNodeKind(kind) ? CANVAS_NODE_SPECS[kind].inputs : {}
}

export function canvasOutputs(kind: string): Record<string, CanvasPortKind> {
  return isCanvasNodeKind(kind) ? CANVAS_NODE_SPECS[kind].outputs : {}
}

export function isCanvasNodeKind(value: unknown): value is CanvasNodeKind {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CANVAS_NODE_SPECS, value)
}

export type CanvasValidationIssue = {
  /** Mã ổn định để giao diện dịch sang câu en/vi. */
  code:
    | 'graph_invalid'
    | 'schema_unsupported'
    | 'too_many_nodes'
    | 'too_many_edges'
    | 'too_many_placements'
    | 'node_duplicate'
    | 'node_unknown_kind'
    | 'node_coordinates_invalid'
    | 'edge_endpoint_missing'
    | 'edge_self'
    | 'edge_port_missing'
    | 'edge_kind_mismatch'
    | 'edge_port_full'
    | 'edge_duplicate'
    | 'edge_cycle'
    | 'placement_source_missing'
    | 'placement_invalid'
  /** ID node/cạnh liên quan để giao diện tô sáng. */
  id?: string
  params?: Record<string, string | number>
}

/**
 * Kiểm tra đồ thị thuần tuý, không truy cập database.
 *
 * Quyền sở hữu nguồn là việc của server; hàm này chỉ bảo đảm cấu trúc và kiểu cổng
 * hợp lệ nên giao diện dùng lại được ngay khi người dùng kéo dây.
 */
export function validateCanvasGraph(graph: unknown): CanvasValidationIssue[] {
  const issues: CanvasValidationIssue[] = []
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    return [{ code: 'graph_invalid' }]
  }
  const candidate = graph as Partial<CanvasGraph>
  if (candidate.schemaVersion !== CANVAS_SCHEMA_VERSION) {
    issues.push({ code: 'schema_unsupported', params: { version: Number(candidate.schemaVersion ?? 0) } })
  }
  const nodes = Array.isArray(candidate.nodes) ? candidate.nodes : null
  const edges = Array.isArray(candidate.edges) ? candidate.edges : null
  if (!nodes || !edges) return [...issues, { code: 'graph_invalid' }]
  if (nodes.length > CANVAS_LIMITS.nodes) issues.push({ code: 'too_many_nodes', params: { max: CANVAS_LIMITS.nodes } })
  if (edges.length > CANVAS_LIMITS.edges) issues.push({ code: 'too_many_edges', params: { max: CANVAS_LIMITS.edges } })

  const byId = new Map<string, CanvasNode>()
  for (const raw of nodes) {
    const node = raw as CanvasNode
    if (!node || typeof node.id !== 'string' || !node.id.trim()) {
      issues.push({ code: 'graph_invalid' })
      continue
    }
    if (byId.has(node.id)) {
      issues.push({ code: 'node_duplicate', id: node.id })
      continue
    }
    if (!isCanvasNodeKind(node.kind)) {
      issues.push({ code: 'node_unknown_kind', id: node.id, params: { kind: String(node.kind ?? '') } })
      continue
    }
    if (!isFiniteNumber(node.x) || !isFiniteNumber(node.y)) {
      issues.push({ code: 'node_coordinates_invalid', id: node.id })
    }
    byId.set(node.id, node)
  }

  const usedPorts = new Map<string, number>()
  const adjacency = new Map<string, string[]>()
  const seenEdges = new Set<string>()
  for (const raw of edges) {
    const edge = raw as CanvasEdge
    if (!edge || typeof edge.source !== 'string' || typeof edge.target !== 'string') {
      issues.push({ code: 'graph_invalid' })
      continue
    }
    const source = byId.get(edge.source)
    const target = byId.get(edge.target)
    if (!source || !target) {
      issues.push({ code: 'edge_endpoint_missing', id: edge.id })
      continue
    }
    if (edge.source === edge.target) {
      issues.push({ code: 'edge_self', id: edge.id })
      continue
    }
    const outputs = canvasOutputs(source.kind)
    const inputs = canvasInputs(target.kind)
    const outputKind = typeof edge.sourcePort === 'string' && Object.prototype.hasOwnProperty.call(outputs, edge.sourcePort) ? outputs[edge.sourcePort] : undefined
    const inputSpec = typeof edge.targetPort === 'string' && Object.prototype.hasOwnProperty.call(inputs, edge.targetPort) ? inputs[edge.targetPort] : undefined
    if (!outputKind || !inputSpec) {
      issues.push({ code: 'edge_port_missing', id: edge.id })
      continue
    }
    if (!inputSpec.kinds.includes(outputKind)) {
      issues.push({ code: 'edge_kind_mismatch', id: edge.id, params: { from: outputKind, to: inputSpec.kinds.join('|') } })
      continue
    }
    const fingerprint = `${edge.source}:${edge.sourcePort}->${edge.target}:${edge.targetPort}`
    if (seenEdges.has(fingerprint)) {
      issues.push({ code: 'edge_duplicate', id: edge.id })
      continue
    }
    seenEdges.add(fingerprint)
    const portKey = `${edge.target}:${edge.targetPort}`
    const used = (usedPorts.get(portKey) ?? 0) + 1
    usedPorts.set(portKey, used)
    if (inputSpec.max !== undefined && used > inputSpec.max) {
      issues.push({ code: 'edge_port_full', id: edge.id, params: { port: edge.targetPort, max: inputSpec.max } })
      continue
    }
    adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge.target])
  }

  // Chu trình bị chặn để không có nhánh tự chạy vòng quanh.
  const visiting = new Set<string>()
  const done = new Set<string>()
  const walk = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (done.has(id)) return false
    visiting.add(id)
    for (const next of adjacency.get(id) ?? []) {
      if (walk(next)) return true
    }
    visiting.delete(id)
    done.add(id)
    return false
  }
  for (const id of byId.keys()) {
    if (walk(id)) {
      issues.push({ code: 'edge_cycle', id })
      break
    }
  }

  return issues
}

/** Kiểm tra bố trí của một node sinh nội dung. */
export function validateCanvasLayout(layout: unknown, nodeIds: Set<string>): CanvasValidationIssue[] {
  if (layout === undefined || layout === null) return []
  if (typeof layout !== 'object' || Array.isArray(layout)) return [{ code: 'graph_invalid' }]
  const candidate = layout as Partial<CanvasLayout>
  const instances = Array.isArray(candidate.instances) ? candidate.instances : []
  const issues: CanvasValidationIssue[] = []
  if (instances.length > CANVAS_LIMITS.placements) {
    issues.push({ code: 'too_many_placements', params: { max: CANVAS_LIMITS.placements } })
  }
  if (candidate.backgroundNodeId && !nodeIds.has(candidate.backgroundNodeId)) {
    issues.push({ code: 'placement_source_missing', id: candidate.backgroundNodeId })
  }
  for (const raw of instances) {
    const placement = raw as CanvasPlacement
    if (!placement || typeof placement.id !== 'string' || typeof placement.sourceNodeId !== 'string') {
      issues.push({ code: 'placement_invalid' })
      continue
    }
    if (!nodeIds.has(placement.sourceNodeId)) {
      issues.push({ code: 'placement_source_missing', id: placement.sourceNodeId })
      continue
    }
    if (
      !isFiniteNumber(placement.x) || !isFiniteNumber(placement.y)
      || !isFiniteNumber(placement.width) || !isFiniteNumber(placement.height)
      || !isFiniteNumber(placement.rotation) || !isFiniteNumber(placement.z)
      || placement.width <= 0 || placement.height <= 0
    ) {
      issues.push({ code: 'placement_invalid', id: placement.id })
    }
  }
  return issues
}
