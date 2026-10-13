import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  AlertTriangle,
  Image as ImageIcon,
  Layers,
  LoaderCircle,
  Maximize2,
  Megaphone,
  Package,
  Redo2,
  Save,
  StickyNote,
  Undo2,
  UserRound,
  Video as VideoIcon,
  X,
} from 'lucide-react'
import { entityLibraryApi, entityReferenceUrl, type EntityLibraryEntity } from '../../api/entityLibrary'
import { entityLibraryCatalog } from '../../i18n/catalogs/entityLibrary'
import { errorMessage } from '../../api/client'
import { generationApi } from '../../api/endpoints'
import { projectCanvasApi, projectItemsApi, type CanvasBoard as CanvasBoardData, type CanvasPreview, type CanvasRun, type ProjectItem } from '../../api/canvas'
import { projectLocationsApi, locationReferenceUrl, type LocationReference } from '../../api/locations'
import type { Generation, ModelInfo } from '../../api/types'
import type { ProjectCharacter, ProjectScene } from '../../api/projectTypes'
import { CANVAS_LIMITS, CANVAS_SCHEMA_VERSION, canvasInputs, canvasOutputs, emptyCanvasGraph, type CanvasGraph, type CanvasLayout, type CanvasNode, type CanvasNodeData, type CanvasNodeKind } from '../../../shared/canvas'
import { useTranslation } from '../../i18n'
import { canvasCatalog, type CanvasCatalogKey } from '../../i18n/catalogs/canvas'
import { notification, type Notification } from '../../i18n/messages'
import { CanvasActionsProvider, canvasNodeTypes, NODE_TITLES, type CanvasActions } from './CanvasNodes'
import { LayoutEditor, type LayoutObject } from './LayoutEditor'
import './canvas.css'

type FlowNode = Node<{ node: CanvasNode }>

const ACTIVE_STATUSES = ['queued', 'running', 'downloading']
const AUTOSAVE_MS = 700
const POLL_MS = 2000

const ADD_MENU: Array<{ kind: CanvasNodeKind; labelKey: CanvasCatalogKey; icon: ReactElement }> = [
  { kind: 'prompt', labelKey: 'addPrompt', icon: <Megaphone size={14} /> },
  { kind: 'upload', labelKey: 'addUpload', icon: <ImageIcon size={14} /> },
  { kind: 'character', labelKey: 'addCharacter', icon: <UserRound size={14} /> },
  { kind: 'location', labelKey: 'addLocation', icon: <Layers size={14} /> },
  { kind: 'item', labelKey: 'addItem', icon: <Package size={14} /> },
  { kind: 'sheet', labelKey: 'addSheet', icon: <ImageIcon size={14} /> },
  { kind: 'image', labelKey: 'addImage', icon: <ImageIcon size={14} /> },
  { kind: 'video', labelKey: 'addVideo', icon: <VideoIcon size={14} /> },
  { kind: 'note', labelKey: 'addNote', icon: <StickyNote size={14} /> },
]

function toFlow(graph: CanvasGraph): { nodes: FlowNode[]; edges: Edge[] } {
  return {
    nodes: graph.nodes.map((node) => ({ id: node.id, type: node.kind, position: { x: node.x, y: node.y }, data: { node } })),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourcePort,
      targetHandle: edge.targetPort,
    })),
  }
}

function toGraph(nodes: FlowNode[], edges: Edge[]): CanvasGraph {
  return {
    schemaVersion: CANVAS_SCHEMA_VERSION,
    nodes: nodes.map((node) => ({
      id: node.id,
      kind: (node.type as CanvasNodeKind) ?? 'note',
      x: node.position.x,
      y: node.position.y,
      data: node.data?.node?.data ?? {},
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourcePort: edge.sourceHandle ?? '',
      targetPort: edge.targetHandle ?? '',
    })),
  }
}

/**
 * Bảng Canvas của dự án: đồ thị node, inspector và chạy ảnh/video.
 *
 * Bảng lưu tự động sau khi ngừng sửa, kèm revision để hai tab không ghi đè nhau.
 * Preview và run do server quyết định đầu vào; giao diện chỉ gửi node ID và stamp.
 */
export function CanvasBoard({ projectId, projectName, archived, characters, locations, scenes, models, onNotify, onItemsChanged }: {
  projectId: string
  projectName: string
  archived: boolean
  characters: ProjectCharacter[]
  locations: LocationReference[]
  scenes: ProjectScene[]
  models: ModelInfo[]
  onNotify: (message: Notification) => void
  onItemsChanged?: () => void
}) {
  return <ReactFlowProvider>
    <CanvasBoardInner
      projectId={projectId}
      projectName={projectName}
      archived={archived}
      characters={characters}
      locations={locations}
      scenes={scenes}
      models={models}
      onNotify={onNotify}
      onItemsChanged={onItemsChanged}
    />
  </ReactFlowProvider>
}

function CanvasBoardInner({ projectId, projectName, archived, characters, locations, scenes, models, onNotify, onItemsChanged }: {
  projectId: string
  projectName: string
  archived: boolean
  characters: ProjectCharacter[]
  locations: LocationReference[]
  scenes: ProjectScene[]
  models: ModelInfo[]
  onNotify: (message: Notification) => void
  onItemsChanged?: () => void
}) {
  const { t } = useTranslation(canvasCatalog)
  const { t: entityT } = useTranslation(entityLibraryCatalog)
  const { fitView } = useReactFlow()
  const api = useMemo(() => projectCanvasApi(projectId), [projectId])
  const itemsApi = useMemo(() => projectItemsApi(projectId), [projectId])

  const [board, setBoard] = useState<CanvasBoardData | null>(null)
  const [items, setItems] = useState<ProjectItem[]>([])
  const [entities, setEntities] = useState<EntityLibraryEntity[]>([])
  const [nodes, setNodes] = useState<FlowNode[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [generations, setGenerations] = useState<Record<string, Generation>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [preview, setPreview] = useState<CanvasPreview | null>(null)
  const [layoutNodeId, setLayoutNodeId] = useState<string | null>(null)
  const [busy, setBusy] = useState<'load' | 'save' | 'run' | 'preview' | null>('load')
  const [error, setError] = useState<unknown>(null)
  const [conflict, setConflict] = useState(false)
  /** Chỉ báo lưu: không trộn với lỗi của thao tác khác như ghép ảnh hay chạy node. */
  const [saveFailed, setSaveFailed] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  /** Node đang tạo vật phẩm mới; mở hộp thoại nhập tên/mô tả. */
  const [itemForNode, setItemForNode] = useState<string | null>(null)
  const [itemDraft, setItemDraft] = useState({ kind: 'product' as 'product' | 'prop', name: '', description: '', continuityNotes: '', imagePrompt: '' })
  const itemFileRef = useRef<HTMLInputElement>(null)
  const itemForNodeRef = useRef<string | null>(null)
  itemForNodeRef.current = itemForNode

  const revisionRef = useRef(0)
  /** Stamp đầu vào đã được người dùng xác nhận cho từng node. */
  const confirmedStamps = useRef<Record<string, string>>({})
  const undoStack = useRef<string[]>([])
  const redoStack = useRef<string[]>([])
  const readOnly = archived

  const applyLoaded = useCallback((data: CanvasBoardData) => {
    setBoard(data)
    revisionRef.current = data.revision
    const flow = toFlow(data.graph.nodes.length || data.graph.edges.length ? data.graph : emptyCanvasGraph())
    setNodes(flow.nodes)
    setEdges(flow.edges)
    setDirty(false)
  }, [])

  // Nạp bảng, vật phẩm và danh sách tác vụ của dự án.
  useEffect(() => {
    let alive = true
    setBusy('load')
    Promise.all([api.get(), itemsApi.list(), generationApi.list({ projectId, limit: 100 }), entityLibraryApi.list({ projectId })])
      .then(([canvas, itemResult, generationResult, entityResult]) => {
        if (!alive) return
        applyLoaded(canvas.canvas)
        setItems(itemResult.items)
        setEntities(entityResult.entities)
        setGenerations(Object.fromEntries(generationResult.generations.map((item) => [item.id, item])))
      })
      .catch((cause: unknown) => { if (alive) setError(cause) })
      .finally(() => { if (alive) setBusy(null) })
    return () => { alive = false }
  }, [api, itemsApi, projectId, applyLoaded])

  const runsByNode = useMemo(() => {
    const map: Record<string, CanvasRun[]> = {}
    for (const run of board?.runs ?? []) map[run.nodeId] = [...(map[run.nodeId] ?? []), run]
    return map
  }, [board])

  const hasActive = Object.values(generations).some((item) => ACTIVE_STATUSES.includes(item.status))

  // Theo dõi tiến trình để node hiện trạng thái chạy.
  useEffect(() => {
    if (!hasActive && !board) return
    const interval = window.setInterval(() => {
      generationApi.list({ projectId, limit: 100 })
        .then((result) => setGenerations(Object.fromEntries(result.generations.map((item) => [item.id, item]))))
        .catch(() => { /* lỗi tạm thời khi làm mới nền */ })
      if (hasActive) {
        api.runs().then((result) => setBoard((current) => (current ? { ...current, runs: result.runs } : current))).catch(() => { /* bỏ qua */ })
      }
    }, hasActive ? POLL_MS : 15000)
    return () => window.clearInterval(interval)
  }, [api, board, hasActive, projectId])

  const pushHistory = useCallback(() => {
    undoStack.current.push(JSON.stringify(toGraph(nodes, edges)))
    if (undoStack.current.length > 50) undoStack.current.shift()
    redoStack.current = []
  }, [nodes, edges])

  const markDirty = useCallback(() => setDirty(true), [])

  const updateData = useCallback((nodeId: string, patch: Partial<CanvasNodeData>) => {
    if (readOnly) return
    setNodes((current) => current.map((node) => node.id === nodeId
      ? { ...node, data: { node: { ...node.data.node, data: { ...node.data.node.data, ...patch } } } }
      : node))
    markDirty()
  }, [markDirty, readOnly])

  const removeNode = useCallback((nodeId: string) => {
    if (readOnly) return
    setNodes((current) => current.filter((node) => node.id !== nodeId).map(node => {
      const layout = node.data.node.data.layout
      if (!layout) return node
      return { ...node, data: { node: { ...node.data.node, data: { ...node.data.node.data, layout: {
        ...layout, backgroundNodeId: layout.backgroundNodeId === nodeId ? null : layout.backgroundNodeId,
        instances: layout.instances.filter(instance => instance.sourceNodeId !== nodeId),
      } } } } }
    }))
    setEdges((current) => current.filter((edge) => edge.source !== nodeId && edge.target !== nodeId))
    setSelectedId((current) => (current === nodeId ? null : current))
    onNotify(notification('canvas', 'notifyNodeRemoved'))
    markDirty()
  }, [markDirty, onNotify, readOnly])

  const addNode = useCallback((kind: CanvasNodeKind) => {
    if (readOnly) return
    if (nodes.length >= CANVAS_LIMITS.nodes) return
    const id = crypto.randomUUID()
    const node: CanvasNode = { id, kind, x: 120 + (nodes.length % 6) * 40, y: 80 + (nodes.length % 8) * 40, data: kind === 'prompt' ? { text: '' } : {} }
    setNodes((current) => [...current, { id, type: kind, position: { x: node.x, y: node.y }, data: { node } }])
    setSelectedId(id)
    onNotify(notification('canvas', 'notifyNodeAdded'))
    markDirty()
  }, [markDirty, nodes.length, onNotify, readOnly])

  const selectOutput = useCallback((nodeId: string, runId: string | null) => {
    updateData(nodeId, { selectedRunId: runId })
  }, [updateData])

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current))
    if (changes.some((change) => change.type === 'position' || change.type === 'remove')) markDirty()
  }, [markDirty])

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((current) => applyEdgeChanges(changes, current))
    if (changes.some((change) => change.type === 'remove')) markDirty()
  }, [markDirty])

  /** Chỉ cho nối cổng tương thích; server kiểm tra lại lần nữa khi lưu. */
  const isValidConnection = useCallback((connection: Connection | Edge) => {
    const source = nodes.find((node) => node.id === connection.source)
    const target = nodes.find((node) => node.id === connection.target)
    if (!source || !target || source.id === target.id) return false
    const outputKind = canvasOutputs((source.type as CanvasNodeKind) ?? '' )[connection.sourceHandle ?? '']
    const input = canvasInputs((target.type as CanvasNodeKind) ?? '')[connection.targetHandle ?? '']
    if (!outputKind || !input) return false
    if (!input.kinds.includes(outputKind)) return false
    if (input.max !== undefined) {
      const used = edges.filter((edge) => edge.target === target.id && edge.targetHandle === connection.targetHandle).length
      if (used >= input.max) return false
    }
    return true
  }, [edges, nodes])

  const onConnect = useCallback((connection: Connection) => {
    if (readOnly) return
    setEdges((current) => addEdge({ ...connection, id: `e-${crypto.randomUUID()}` }, current))
    markDirty()
  }, [markDirty, readOnly])

  /**
   * Ghi bảng hiện tại lên server.
   *
   * Mọi lần lưu đi qua hàng đợi một-lần-một để autosave, nút Lưu và thao tác ghép ảnh
   * không gửi hai request cùng baseRevision (một trong hai sẽ bị từ chối 409).
   */
  const saveNow = useCallback(async (): Promise<void> => {
    if (readOnly) return
    setBusy('save')
    setError(null)
    try {
      const result = await api.save(toGraph(nodes, edges), revisionRef.current)
      revisionRef.current = result.canvas.revision
      setBoard(result.canvas)
      setConflict(false)
      setSaveFailed(false)
      setDirty(false)
    } catch (cause) {
      setSaveFailed(true)
      const message = errorMessage(cause)
      if (/Canvas|revision|nơi khác/i.test(message)) setConflict(true)
      setError(cause)
    } finally {
      setBusy(null)
    }
  }, [api, edges, nodes, readOnly])

  const saveQueue = useRef<Promise<void>>(Promise.resolve())
  const save = useCallback((): Promise<void> => {
    const task = saveQueue.current.then(() => saveNow())
    saveQueue.current = task.catch(() => undefined)
    return task
  }, [saveNow])

  // Autosave sau khi ngừng sửa; đổi cấu trúc liên tục không tạo request mỗi bước.
  useEffect(() => {
    if (!dirty || readOnly || conflict) return
    const timer = window.setTimeout(() => { void save() }, AUTOSAVE_MS)
    return () => window.clearTimeout(timer)
  }, [conflict, dirty, readOnly, save])

  const undo = useCallback(() => {
    const previous = undoStack.current.pop()
    if (!previous) return
    redoStack.current.push(JSON.stringify(toGraph(nodes, edges)))
    const graph = JSON.parse(previous) as CanvasGraph
    const flow = toFlow(graph)
    setNodes(flow.nodes)
    setEdges(flow.edges)
    markDirty()
  }, [edges, markDirty, nodes])

  const redo = useCallback(() => {
    const next = redoStack.current.pop()
    if (!next) return
    undoStack.current.push(JSON.stringify(toGraph(nodes, edges)))
    const graph = JSON.parse(next) as CanvasGraph
    const flow = toFlow(graph)
    setNodes(flow.nodes)
    setEdges(flow.edges)
    markDirty()
  }, [edges, markDirty, nodes])

  const previewNode = useCallback(async (nodeId: string) => {
    const node = nodes.find((item) => item.id === nodeId)
    const kind = node?.type as CanvasNodeKind
    if (kind !== 'image' && kind !== 'video') return
    setBusy('preview')
    setError(null)
    try {
      const result = await api.preview(nodeId, kind)
      setPreview(result.preview)
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy(null)
    }
  }, [api, nodes])

  /** Chạy thật với stamp đã xác nhận; không bao giờ tự chạy từ thao tác nối dây. */
  const executeRun = useCallback(async (nodeId: string, stamp: string) => {
    const node = nodes.find((item) => item.id === nodeId)
    const kind = node?.type as CanvasNodeKind
    if (kind !== 'image' && kind !== 'video') return
    setBusy('run')
    setError(null)
    try {
      const result = await api.run(nodeId, {
        kind,
        modelId: node?.data.node.data.modelId ?? undefined,
        sceneId: node?.data.node.data.sceneId ?? null,
        stamp,
        idempotencyKey: crypto.randomUUID(),
      })
      confirmedStamps.current[nodeId] = stamp
      setGenerations((current) => ({ ...current, [result.generation.id]: result.generation }))
      setBoard((current) => (current ? { ...current, runs: [result.run, ...current.runs] } : current))
      onNotify(notification('canvas', 'runStarted'))
      setPreview(null)
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy(null)
    }
  }, [api, nodes, onNotify])

  /**
   * Nút Chạy: lấy preview mới để biết stamp hiện tại.
   *
   * Lần đầu (hoặc khi đầu vào đổi) phải xem trước và xác nhận; chỉ khi stamp trùng
   * lần đã xác nhận trước đó mới chạy ngay.
   */
  const runNode = useCallback(async (nodeId: string) => {
    const node = nodes.find((item) => item.id === nodeId)
    const kind = node?.type as CanvasNodeKind
    if (kind !== 'image' && kind !== 'video') return
    if (!node?.data.node.data.modelId) {
      onNotify(notification('canvas', 'runNeedsModel'))
      return
    }
    setBusy('preview')
    setError(null)
    try {
      // Bảng phải được lưu trước: server đọc graph đã lưu để dựng prompt.
      if (dirty) await save()
      const fresh = await api.preview(nodeId, kind)
      setSelectedId(nodeId)
      if (confirmedStamps.current[nodeId] === fresh.preview.stamp) {
        await executeRun(nodeId, fresh.preview.stamp)
        return
      }
      setPreview(fresh.preview)
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy(null)
    }
  }, [api, dirty, executeRun, nodes, onNotify, save])

  const openLayout = useCallback((nodeId: string) => setLayoutNodeId(nodeId), [])

  /**
   * Ghép bố trí thành ảnh nguồn cho node tạo ảnh.
   *
   * Backend chỉ đọc media nội bộ của tài khoản; ảnh ghép được lưu thành upload mới
   * nên gỡ ảnh gốc sau đó không làm hỏng tác vụ đang dùng bản ghép.
   */
  const compositeNode = useCallback(async (nodeId: string) => {
    setBusy('run')
    setError(null)
    try {
      if (dirty) await save()
      const result = await api.composite(nodeId)
      updateData(nodeId, { uploadId: result.upload.id })
      onNotify(notification('canvas', 'notifyCompositeReady'))
      setLayoutNodeId(null)
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy(null)
    }
  }, [api, dirty, onNotify, save, updateData])

  const layoutObjects: LayoutObject[] = useMemo(() => {
    const node = nodes.find((item) => item.id === layoutNodeId)
    if (!node) return []
    const connected = edges
      .filter((edge) => edge.target === layoutNodeId && edge.targetHandle === 'context')
      .map((edge) => edge.source)
    return connected.flatMap((nodeId) => {
      const source = nodes.find((item) => item.id === nodeId)
      if (!source) return []
      const sourceId = source.data.node.data.sourceId
      const kind = source.type === 'library' ? source.data.node.data.entityKind ?? 'item' : source.type as 'character' | 'location' | 'item'
      const entity = source.type === 'library' ? entities.find(entity => entity.id === sourceId && entity.kind === kind) : null
      const character = characters.find((item) => item.id === sourceId)
      const location = locations.find((item) => item.id === sourceId)
      const item = items.find((entry) => entry.id === sourceId)
      return [{
        nodeId,
        kind,
        name: entity?.name ?? character?.name ?? location?.name ?? item?.name ?? t('nodeCharacter'),
        imageUrl: (entity ? entityReferenceUrl(entity) : null) ?? character?.referenceUrl
          ?? (location ? locationReferenceUrl(location) || null : null)
          ?? (item?.reference ? `/api/uploads/${encodeURIComponent(item.reference.uploadId)}` : null),
      }]
    })
  }, [characters, entities, edges, items, layoutNodeId, locations, nodes, t])

  const backgroundNodeId = nodes.find((item) => item.id === layoutNodeId)?.data.node.data.layout?.backgroundNodeId ?? null
  const backgroundObject = layoutObjects.find((item) => item.nodeId === backgroundNodeId) ?? null

  async function createItemForNode(): Promise<void> {
    const nodeId = itemForNode
    if (!nodeId || !itemDraft.name.trim()) return
    try {
      const created = await itemsApi.create({
        kind: itemDraft.kind,
        name: itemDraft.name.trim(),
        description: itemDraft.description,
        continuityNotes: itemDraft.continuityNotes,
        imagePrompt: itemDraft.imagePrompt,
      })
      setItems((current) => [...current, created])
      updateData(nodeId, { sourceId: created.id })
      setItemForNode(null)
      setItemDraft({ kind: 'product', name: '', description: '', continuityNotes: '', imagePrompt: '' })
      onNotify(notification('canvas', 'itemCreated'))
      onItemsChanged?.()
    } catch (cause) {
      setError(cause)
    }
  }

  /** Ảnh tham chiếu của vật phẩm thuộc đúng node đang chọn. */
  function itemIdForNode(nodeId: string): string | null {
    return nodes.find((node) => node.id === nodeId)?.data.node.data.sourceId ?? null
  }

  async function uploadItemReference(nodeId: string): Promise<void> {
    itemForNodeRef.current = nodeId
    itemFileRef.current?.click()
  }

  function onItemFilePicked(file: File | undefined): void {
    const nodeId = itemForNodeRef.current
    const itemId = nodeId ? itemIdForNode(nodeId) : null
    if (!file || !itemId) return
    void itemsApi.uploadReference(itemId, file)
      .then((updated) => {
        setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)))
        onNotify(notification('canvas', 'itemCreated'))
      })
      .catch((cause: unknown) => setError(cause))
  }

  /**
   * Sinh ảnh tham chiếu cho vật phẩm: gửi yêu cầu, theo dõi tác vụ rồi gắn ảnh.
   * Không gắn ảnh khi tác vụ chưa thành công để vật phẩm không trỏ vào ảnh rỗng.
   */
  async function generateItemReference(nodeId: string): Promise<void> {
    const itemId = itemIdForNode(nodeId)
    const modelId = nodes.find((node) => node.id === nodeId)?.data.node.data.modelId
      ?? models.find((model) => model.enabled && model.kind === 'image')?.id
    if (!itemId) return
    if (!modelId) {
      onNotify(notification('canvas', 'itemNoImageModel'))
      return
    }
    setBusy('run')
    setError(null)
    try {
      const created = await itemsApi.generateReference(itemId, modelId)
      const generationId = created.generation.id
      setGenerations((current) => ({ ...current, [generationId]: created.generation }))
      const deadline = Date.now() + 4 * 60 * 1000
      while (Date.now() < deadline) {
        const current = (await generationApi.get(generationId)).generation
        setGenerations((value) => ({ ...value, [generationId]: current }))
        if (current.status === 'succeeded') {
          const updated = await itemsApi.attachReference(itemId, generationId, current.assets[0]?.id)
          setItems((value) => value.map((item) => (item.id === updated.id ? updated : item)))
          onNotify(notification('canvas', 'itemCreated'))
          return
        }
        if (current.status === 'failed' || current.status === 'unknown') throw new Error(current.errorMessage ?? '')
        await new Promise((resolve) => window.setTimeout(resolve, 1500))
      }
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy(null)
    }
  }

  const actions: CanvasActions = useMemo(() => ({
    projectId, entities,
    aliases: board?.aliases ?? [],
    characters,
    locations,
    items,
    scenes,
    models: models.filter((model) => model.enabled),
    runsByNode,
    generations,
    readOnly,
    updateData,
    insertNodes: () => { /* chèn node do toolbar quản lý */ },
    removeNode,
    selectOutput,
    openInspector: setSelectedId,
    openLayout,
    createItemFor: setItemForNode,
    uploadItemReference: (nodeId) => { void uploadItemReference(nodeId) },
    generateItemReference: (nodeId) => { void generateItemReference(nodeId) },
    previewNode: (nodeId) => { void previewNode(nodeId) },
    runNode: (nodeId) => { void runNode(nodeId) },
    notify: onNotify,
  }), [projectId, entities, board, characters, generations, items, locations, models, onNotify, openLayout, previewNode, readOnly, removeNode, runNode, runsByNode, scenes, selectOutput, updateData])

  const selected = nodes.find((node) => node.id === selectedId) ?? null
  const selectedPreview = preview && preview.nodeId === selectedId ? preview : null

  if (busy === 'load' && !board) {
    return <div className="empty-state"><LoaderCircle size={24} className="spin" /><h3>{t('loading')}</h3></div>
  }

  return <div className={`canvas-shell ${fullscreen ? 'is-fullscreen' : ''}`}>
    <div className="canvas-toolbar">
      <div className="canvas-toolbar-group">
        <button type="button" className="canvas-tool" onClick={() => setAddOpen((open) => !open)} disabled={readOnly}>
          + {t('toolbarAdd')}
        </button>
        {addOpen && (
          <div className="canvas-add-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => { addNode('library'); setAddOpen(false) }}><Package size={14} /> {entityT('title')}</button>
            {ADD_MENU.map((entry) => (
              <button key={entry.kind} type="button" role="menuitem" onClick={() => { addNode(entry.kind); setAddOpen(false) }}>
                {entry.icon} {t(entry.labelKey)}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="canvas-toolbar-group">
        <button type="button" className="canvas-tool icon" title={t('undo')} aria-label={t('undo')} onClick={undo} disabled={!undoStack.current.length || readOnly}><Undo2 size={15} /></button>
        <button type="button" className="canvas-tool icon" title={t('redo')} aria-label={t('redo')} onClick={redo} disabled={!redoStack.current.length || readOnly}><Redo2 size={15} /></button>
      </div>
      <div className="canvas-toolbar-spacer" />
      {readOnly && <span className="canvas-readonly">{t('readOnlyBadge')}</span>}
      <span className={`canvas-save-state ${saveFailed ? 'is-error' : dirty ? 'is-dirty' : ''}`}>
        {busy === 'save' ? t('saving') : saveFailed ? t('saveFailed') : dirty ? t('saving') : t('saved')}
      </span>
      <button type="button" className="canvas-tool" onClick={() => void save()} disabled={readOnly || busy === 'save'}>
        <Save size={14} /> {t('saveNow')}
      </button>
      <button type="button" className="canvas-tool icon" title={t('fitView')} aria-label={t('fitView')} onClick={() => fitView({ padding: 0.2 })}><Maximize2 size={15} /></button>
      <button type="button" className="canvas-tool" onClick={() => setFullscreen((value) => !value)}>
        {fullscreen ? t('exitFullscreen') : t('fullscreen')}
      </button>
    </div>

    {conflict && <div className="canvas-conflict" role="alert">
      <AlertTriangle size={15} /> {t('notifyRevisionConflict')}
      <button type="button" className="text-button" onClick={() => window.location.reload()}>{t('saveNow')}</button>
    </div>}
    {error != null && <div className="form-error" role="alert">{errorMessage(error)}</div>}

    <div className="canvas-workarea">
      <div className="canvas-flow">
        <CanvasActionsProvider value={actions}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={canvasNodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onNodeClick={(_, node) => { setSelectedId(node.id); setPreview(null) }}
            onPaneClick={() => { setSelectedId(null); setPreview(null) }}
            onNodeDragStart={pushHistory}
            fitView
            proOptions={{ hideAttribution: true }}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            edgesFocusable
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#2c2a33" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor="#4b3f5e" maskColor="rgba(12,12,16,.75)" />
          </ReactFlow>
        </CanvasActionsProvider>
        {!nodes.length && <div className="canvas-empty">
          <h3>{t('tabTitle')}</h3>
          <p>{t('emptyHint')}</p>
        </div>}
      </div>

      {(selected || selectedPreview) && (
        <aside className="canvas-inspector" aria-label={t('previewTitle')}>
          <div className="canvas-inspector-head">
            <strong>{selectedPreview ? t('previewTitle') : selected ? t(NODE_TITLES[(selected.type as CanvasNodeKind) ?? 'note']) : t('previewTitle')}</strong>
            <button type="button" className="close-button" aria-label={t('previewClose')} onClick={() => { setSelectedId(null); setPreview(null) }}><X size={16} /></button>
          </div>
          {selectedPreview ? (
            <>
              <div className="canvas-inspector-block">
                <span>{t('previewPrompt')}</span>
                <pre>{selectedPreview.prompt}</pre>
              </div>
              <div className="canvas-inspector-block">
                <span>{t('previewInputs')} · {selectedPreview.limits.sentImages}/{selectedPreview.limits.maxImages}</span>
                {selectedPreview.inputs.length ? selectedPreview.inputs.map((input, index) => (
                  <div className={`canvas-input-row ${input.sent ? '' : 'is-skipped'}`} key={`${input.url}-${index}`}>
                    {input.url ? <img src={input.url} alt="" /> : <span className="canvas-layout-dot" />}
                    <em>{input.label}</em>
                    <small>{input.sent ? t('previewSent') : t('previewSkipped')}</small>
                  </div>
                )) : <p className="project-hint">{t('runCostWarning')}</p>}
              </div>
              {selectedPreview.unresolved.length > 0 && <div className="form-error" role="alert">
                {t('mentionUnresolved', { aliases: selectedPreview.unresolved.map((alias) => `@${alias}`).join(', ') })}
              </div>}
              {selectedPreview.warnings.map((warning) => <p className="project-hint" key={warning}>{warning}</p>)}
              <button type="button" className="generate-button" disabled={busy === 'run' || !selectedPreview.model || selectedPreview.unresolved.length > 0 || selectedPreview.runnable === false} onClick={() => { void executeRun(selectedPreview.nodeId, selectedPreview.stamp) }}>
                {busy === 'run' ? <LoaderCircle size={16} className="spin" /> : <ImageIcon size={16} />} {t('confirmRun')}
              </button>
              <p className="cost-note">{t('runCostWarning')}</p>
            </>
          ) : selected ? (
            <>
              <div className="canvas-inspector-block">
                <span>{t('chooseModel')}</span>
                <select
                  className="canvas-select"
                  value={selected.data.node.data.modelId ?? ''}
                  disabled={readOnly}
                  onChange={(event) => updateData(selected.id, { modelId: event.target.value || null })}
                >
                  <option value="">{t('chooseModel')}</option>
                  {models.filter((model) => model.enabled).map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
                </select>
              </div>
              {selected.type === 'video' && <div className="canvas-inspector-block">
                <span>{t('chooseScene')}</span>
                <select
                  className="canvas-select"
                  value={selected.data.node.data.sceneId ?? ''}
                  disabled={readOnly}
                  onChange={(event) => updateData(selected.id, { sceneId: event.target.value || null })}
                >
                  <option value="">{t('chooseScene')}</option>
                  {scenes.map((scene) => <option key={scene.id} value={scene.id}>{scene.title}</option>)}
                </select>
              </div>}
              {(selected.type === 'image' || selected.type === 'video') && <>
                <button type="button" className="text-button" onClick={() => openLayout(selected.id)}>{t('layoutOpen')}</button>
                <p className="project-hint">{t('layoutHint')}</p>
              </>}
              {(selected.type === 'image' || selected.type === 'sheet') && <p className="project-hint">{t('compositeNote')}</p>}
            </>
          ) : null}
        </aside>
      )}
    </div>

    <input ref={itemFileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(event) => { onItemFilePicked(event.target.files?.[0]); event.target.value = '' }} />

    {itemForNode && (
      <div className="canvas-layout-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setItemForNode(null) }}>
        <div className="canvas-layout canvas-item-dialog" role="dialog" aria-modal="true" aria-label={t('itemCreateOpen')}>
          <header>
            <div>
              <div className="eyebrow"><span className="eyebrow-dot" /> {t('nodeItem')}</div>
              <h3>{t('itemCreateOpen')}</h3>
            </div>
            <button type="button" className="close-button" aria-label={t('previewClose')} onClick={() => setItemForNode(null)}><X size={18} /></button>
          </header>
          <div className="canvas-item-form">
            <label>{t('itemKindLabel')}
              <select value={itemDraft.kind} onChange={(event) => setItemDraft({ ...itemDraft, kind: event.target.value as 'product' | 'prop' })}>
                <option value="product">{t('itemKindProduct')}</option>
                <option value="prop">{t('itemKindProp')}</option>
              </select>
            </label>
            <label>{t('itemName')}
              <input value={itemDraft.name} onChange={(event) => setItemDraft({ ...itemDraft, name: event.target.value })} />
            </label>
            <label>{t('itemDescription')}
              <textarea value={itemDraft.description} onChange={(event) => setItemDraft({ ...itemDraft, description: event.target.value })} />
            </label>
            <label>{t('itemContinuity')}
              <textarea value={itemDraft.continuityNotes} onChange={(event) => setItemDraft({ ...itemDraft, continuityNotes: event.target.value })} />
            </label>
            <label>{t('itemImagePrompt')}
              <textarea value={itemDraft.imagePrompt} onChange={(event) => setItemDraft({ ...itemDraft, imagePrompt: event.target.value })} />
            </label>
          </div>
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={() => setItemForNode(null)}>{t('cancel')}</button>
            <button type="button" className="primary-small-button" disabled={!itemDraft.name.trim()} onClick={() => void createItemForNode()}>{t('itemCreateSave')}</button>
          </div>
        </div>
      </div>
    )}

    {layoutNodeId && (() => {
      const node = nodes.find((item) => item.id === layoutNodeId)
      if (!node) return null
      return <LayoutEditor
        title={`${projectName} · ${t('layoutTitle')}`}
        layout={node.data.node.data.layout ?? { aspectRatio: '16:9', instances: [] }}
        objects={layoutObjects}
        backgroundObject={backgroundObject}
        readOnly={readOnly}
        onChange={(layout: CanvasLayout) => updateData(layoutNodeId, { layout })}
        onClose={() => setLayoutNodeId(null)}
        {...(node.type === 'image' ? { onComposite: () => { void compositeNode(layoutNodeId) }, compositing: busy === 'run' } : {})}
      />
    })()}
  </div>
}

export { projectItemsApi }
