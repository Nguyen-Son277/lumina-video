import { CanvasVideoSettings } from './CanvasVideoSettings'
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
  useNodesInitialized,
  type Connection,
  type Edge,
  type EdgeChange,
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
import { quickSessionCanvasApi, projectCanvasApi, projectItemsApi, type CanvasBoard as CanvasBoardData, type CanvasPreview, type CanvasRun, type ProjectItem } from '../../api/canvas'
import { projectLocationsApi, locationReferenceUrl, type LocationReference } from '../../api/locations'
import type { Generation, ModelInfo } from '../../api/types'
import type { ProjectCharacter, ProjectScene } from '../../api/projectTypes'
import { CANVAS_LIMITS, canvasInputs, canvasOutputs, emptyCanvasGraph, type CanvasGraph, type CanvasLayout, type CanvasNode, type CanvasNodeData, type CanvasNodeKind } from '../../../shared/canvas'
import { useTranslation } from '../../i18n'
import { canvasCatalog, type CanvasCatalogKey } from '../../i18n/catalogs/canvas'
import { notification, type Notification } from '../../i18n/messages'
import { CanvasActionsProvider, canvasNodeTypes, NODE_TITLES, type CanvasActions } from './CanvasNodes'
import { LayoutEditor, type LayoutObject } from './LayoutEditor'
import './canvas.css'

import { mentionGraphIssues, reconcileMentionGraph } from './autoMentions'
import { toFlow, toGraph, type FlowNode } from './graphFlow'
import { acknowledgeCanvasRun, canvasRunKey, type PendingCanvasRuns } from './runKeys'

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

/**
 * Bảng Canvas của dự án: đồ thị node, inspector và chạy ảnh/video.
 *
 * Bảng lưu tự động sau khi ngừng sửa, kèm revision để hai tab không ghi đè nhau.
 * Preview và run do server quyết định đầu vào; giao diện chỉ gửi node ID và stamp.
 */
export type CanvasBoardProps = {
  projectId?: string
  quickSessionId?: string
  contextMode?: 'project' | 'quick'
  projectName?: string
  archived?: boolean
  characters?: ProjectCharacter[]
  locations?: LocationReference[]
  scenes?: ProjectScene[]
  models: ModelInfo[]
  onNotify: (message: Notification) => void
  onItemsChanged?: () => void
  onBack?: () => void
  onRegisterNavigationGuard?: (guard: ((action: () => void) => void) | null) => void
}

export function CanvasBoard(props: CanvasBoardProps) {
  return <ReactFlowProvider><CanvasBoardInner {...props} /></ReactFlowProvider>
}

function CanvasBoardInner({ projectId, quickSessionId, contextMode, projectName = '', archived = false, characters = [], locations = [], scenes = [], models, onNotify, onItemsChanged, onBack, onRegisterNavigationGuard }: CanvasBoardProps) {
  const quick = contextMode === 'quick' || !!quickSessionId
  const scopeId = quick ? `quick:${quickSessionId}` : `project:${projectId}`
  const { t } = useTranslation(canvasCatalog)
  const { t: entityT } = useTranslation(entityLibraryCatalog)
  const { fitView } = useReactFlow()
  const nodesInitialized = useNodesInitialized()
  const fittedProject = useRef<string | null>(null)
  const api = useMemo(() => quick ? quickSessionCanvasApi(quickSessionId!) : projectCanvasApi(projectId!), [quick, quickSessionId, projectId])
  const itemsApi = useMemo(() => projectItemsApi(projectId!), [projectId])

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
  const dirtyRef = useRef(false)
  const busyRef = useRef(busy)
  const editVersion = useRef(0)
  busyRef.current = busy
  dirtyRef.current = dirty
  const graphRef = useRef<CanvasGraph>(emptyCanvasGraph())
  graphRef.current = toGraph(nodes, edges)
  const conflictRef = useRef(conflict)
  conflictRef.current = conflict
  /** Stamp đầu vào đã được người dùng xác nhận cho từng node. */
  const confirmedStamps = useRef<Record<string, string>>({})
  // Deliberately survive applyLoaded: a background revision reload is not a run acknowledgement.
  const pendingRunKeys = useRef<PendingCanvasRuns>({})
  const undoStack = useRef<string[]>([])
  const redoStack = useRef<string[]>([])
  const readOnly = archived

  const applyLoaded = useCallback((data: CanvasBoardData) => {
    setBoard(data)
    revisionRef.current = data.revision
    const flow = toFlow(data.graph ?? emptyCanvasGraph())
    setNodes(flow.nodes)
    setEdges(flow.edges)
    setDirty(false)
    dirtyRef.current = false
    setConflict(false)
    undoStack.current = []
    redoStack.current = []
    confirmedStamps.current = {}
  }, [])

  // ReactFlow mounts after async loading; fit only after every custom node has
  // measured dimensions. A mount-time fit can otherwise use incomplete bounds.
  useEffect(() => {
    if (!nodesInitialized || !board || fittedProject.current === scopeId) return
    const frame = window.requestAnimationFrame(() => {
      void fitView({ padding: 0.18, minZoom: 0.05, maxZoom: 1 }).then(() => { fittedProject.current = scopeId })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [board, fitView, nodesInitialized, scopeId])

  // Nạp bảng, vật phẩm và danh sách tác vụ của dự án.
  useEffect(() => {
    let alive = true
    setBusy('load')
    Promise.all([api.get(), quick ? Promise.resolve({ items: [] }) : itemsApi.list(), generationApi.list({ ...(quick ? { quickSessionId } : { projectId }), limit: 100 }), entityLibraryApi.list(quick ? {} : { projectId })])
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
  }, [api, itemsApi, projectId, quick, quickSessionId, applyLoaded])

  // Revision polling must never replace local unsaved edits or an in-flight save.
  useEffect(() => {
    let alive = true
    let pending = false
    const timer = window.setInterval(() => {
      if (pending || busyRef.current) return
      pending = true
      void api.get().then(({ canvas }) => {
        if (!alive || canvas.revision <= revisionRef.current) return
        if (dirtyRef.current || busyRef.current) { conflictRef.current = true; setConflict(true) }
        else applyLoaded(canvas)
      }).catch(() => { /* background polling is best-effort */ }).finally(() => { pending = false })
    }, 15000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [api, applyLoaded])

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
      generationApi.list({ ...(quick ? { quickSessionId } : { projectId }), limit: 100 })
        .then((result) => setGenerations(Object.fromEntries(result.generations.map((item) => [item.id, item]))))
        .catch(() => { /* lỗi tạm thời khi làm mới nền */ })
      if (hasActive) {
        api.runs().then((result) => setBoard((current) => (current ? { ...current, runs: result.runs } : current))).catch(() => { /* bỏ qua */ })
      }
    }, hasActive ? POLL_MS : 15000)
    return () => window.clearInterval(interval)
  }, [api, board, hasActive, projectId, quick, quickSessionId])

  const pushHistory = useCallback(() => {
    undoStack.current.push(JSON.stringify(toGraph(nodes, edges)))
    if (undoStack.current.length > 50) undoStack.current.shift()
    redoStack.current = []
  }, [nodes, edges])

  const markDirty = useCallback(() => { editVersion.current++; dirtyRef.current = true; setDirty(true) }, [])

  useEffect(() => {
    if (!board || readOnly) return
    const graph = toGraph(nodes, edges)
    const next = reconcileMentionGraph(graph, quick)
    if (JSON.stringify(graph) === JSON.stringify(next)) return
    const flow = toFlow(next)
    const current = new Map(nodes.map(node => [node.id, node]))
    setNodes(flow.nodes.map(node => current.has(node.id) ? { ...current.get(node.id)!, data: node.data } : node))
    setEdges(flow.edges)
    markDirty()
  }, [board, nodes, edges, quick, readOnly, markDirty])

  const updateData = useCallback((nodeId: string, patch: Partial<CanvasNodeData>) => {
    if (readOnly) return
    setNodes((current) => current.map((node) => node.id === nodeId
      ? { ...node, data: { ...node.data, node: { ...node.data.node, data: { ...node.data.node.data, ...patch } } } }
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
    if (nodes.filter(node => !node.data.group).length >= CANVAS_LIMITS.nodes) return
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
    const allowed = changes.filter(change => {
      if (readOnly && (change.type === 'position' || change.type === 'remove')) return false
      // Timeline containers may only be detached/reset by the sync service.
      return change.type !== 'remove' || !nodes.find(node => node.id === change.id)?.data.group
    })
    setNodes((current) => applyNodeChanges(allowed, current))
    if (allowed.some((change) => change.type === 'position' || change.type === 'remove')) markDirty()
  }, [markDirty, nodes, readOnly])

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
    if (readOnly || conflictRef.current) return
    const version = editVersion.current
    setBusy('save')
    setError(null)
    try {
      const result = await api.save(graphRef.current, revisionRef.current)
      revisionRef.current = result.canvas.revision
      setBoard(result.canvas)
      setConflict(false)
      setSaveFailed(false)
      if (editVersion.current === version) { dirtyRef.current = false; setDirty(false) }
    } catch (cause) {
      setSaveFailed(true)
      const message = errorMessage(cause)
      if (/Canvas|revision|nơi khác/i.test(message)) { conflictRef.current = true; setConflict(true) }
      setError(cause)
    } finally {
      setBusy(null)
    }
  }, [api, readOnly])

  const saveQueue = useRef<Promise<void>>(Promise.resolve())
  const save = useCallback((): Promise<void> => {
    const task = saveQueue.current.then(() => saveNow())
    saveQueue.current = task.catch(() => undefined)
    return task
  }, [saveNow])

  useEffect(() => {
    if (!onRegisterNavigationGuard) return
    onRegisterNavigationGuard(action => {
      if (conflictRef.current) { setError(new Error(t('notifyRevisionConflict'))); return }
      if (!dirtyRef.current) { action(); return }
      void save().then(() => { if (!dirtyRef.current && !conflictRef.current) action() })
    })
    return () => onRegisterNavigationGuard(null)
  }, [onRegisterNavigationGuard, save, t])

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current && !conflictRef.current) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [])

  // Autosave sau khi ngừng sửa; đổi cấu trúc liên tục không tạo request mỗi bước.
  useEffect(() => {
    if (!dirty || readOnly || conflict) return
    const timer = window.setTimeout(() => { void save() }, AUTOSAVE_MS)
    return () => window.clearTimeout(timer)
  }, [conflict, dirty, edges, nodes, readOnly, save])

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
    const unresolved = mentionGraphIssues(graphRef.current)
    if (unresolved.length) { setError(new Error(t('mentionCapacity', { aliases: unresolved.join(', ') }))); return }
    setBusy('preview')
    setError(null)
    try {
      if (dirtyRef.current) await save()
      if (dirtyRef.current || conflictRef.current) return
      const result = await api.preview(nodeId, kind)
      setPreview(result.preview)
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy(null)
    }
  }, [api, nodes, save, t])

  /** Chạy thật với stamp đã xác nhận; không bao giờ tự chạy từ thao tác nối dây. */
  const executeRun = useCallback(async (nodeId: string, stamp: string) => {
    const node = nodes.find((item) => item.id === nodeId)
    const kind = node?.type as CanvasNodeKind
    if (kind !== 'image' && kind !== 'video') return
    const scope = `${scopeId}:${nodeId}`
    const idempotencyKey = canvasRunKey(pendingRunKeys.current, scope, stamp)
    setBusy('run')
    setError(null)
    try {
      const result = await api.run(nodeId, {
        kind,
        modelId: node?.data.node.data.modelId ?? undefined,
        sceneId: node?.data.node.data.sceneId ?? null,
        stamp,
        idempotencyKey,
      })
      acknowledgeCanvasRun(pendingRunKeys.current, scope, idempotencyKey)
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
  }, [api, nodes, onNotify, scopeId])

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
    if (mentionGraphIssues(graphRef.current).length) { setError(new Error(t('mentionCapacity', { aliases: mentionGraphIssues(graphRef.current).join(', ') }))); return }
    if (!node?.data.node.data.modelId) {
      onNotify(notification('canvas', 'runNeedsModel'))
      return
    }
    setBusy('preview')
    setError(null)
    try {
      // Bảng phải được lưu trước: server đọc graph đã lưu để dựng prompt.
      if (dirty) await save()
      if (dirtyRef.current || conflictRef.current) return
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
  }, [api, dirty, executeRun, nodes, onNotify, save, t])

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
    projectId: quick ? undefined : projectId, quick, entities,
    aliases: board?.aliases ?? [],
    characters,
    locations,
    items,
    scenes,
    hasVideoImageInput: (nodeId: string) => edges.some(edge => edge.target === nodeId && edge.targetHandle === 'image'),
    models,
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
  }), [projectId, quick, entities, edges, board, characters, generations, items, locations, models, onNotify, openLayout, previewNode, readOnly, removeNode, runNode, runsByNode, scenes, selectOutput, updateData])

  const mentionIssues = mentionGraphIssues(toGraph(nodes, edges))
  const selected = nodes.find((node) => node.id === selectedId && !node.data.group) ?? null
  const selectedGroup = nodes.find(node => node.id === selectedId)?.data.group
  const selectedQuickGroup = quick && selectedGroup?.id.startsWith('quick-group:')
  const groupNodeIds = new Set(nodes.filter(node => node.data.node.groupId === selectedGroup?.id).map(node => node.id))
  const quickGroupConflicts = (board?.provenance ?? []).filter(entry => groupNodeIds.has(entry.nodeId)).flatMap(entry => entry.conflicts ?? [])
  const videoInputs = selected?.type === 'video' ? edges.filter(edge => edge.target === selected.id && edge.targetHandle === 'image').flatMap(edge => {
    const source = nodes.find(node => node.id === edge.source)
    return source && (source.type === 'image' || source.type === 'upload' || source.type === 'sheet') ? [source] : []
  }) : []
  const selectedPreview = preview && preview.nodeId === selectedId ? preview : null

  if (busy === 'load' && !board) {
    return <div className="empty-state"><LoaderCircle size={24} className="spin" /><h3>{t('loading')}</h3></div>
  }

  return <div className={`canvas-shell ${fullscreen ? 'is-fullscreen' : ''}`}>
    <div className="canvas-toolbar">
      {onBack && <button type="button" className="canvas-tool" onClick={onBack}>{t('back')}</button>}
      {quick && <button type="button" className="canvas-tool" disabled={readOnly || !!busy || conflict} onClick={() => {
        if (!quickSessionId) return
        setBusy('save')
        const version = editVersion.current
        void save().then(() => {
          if (dirtyRef.current || conflictRef.current) throw new Error(t('saveFailed'))
          return quickSessionCanvasApi(quickSessionId).sync(revisionRef.current)
        }).then(result => {
          if (version === editVersion.current) applyLoaded(result.canvas)
          else { revisionRef.current = result.canvas.revision; setBoard(result.canvas); markDirty() }
        }).catch(setError).finally(() => setBusy(null))
      }}>{t('syncTimeline')}</button>}
      <div className="canvas-toolbar-group">
        <button type="button" className="canvas-tool" onClick={() => setAddOpen((open) => !open)} disabled={readOnly}>
          + {t('toolbarAdd')}
        </button>
        {addOpen && (
          <div className="canvas-add-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => { addNode('library'); setAddOpen(false) }}><Package size={14} /> {entityT('title')}</button>
            {ADD_MENU.filter(entry => !quick || (entry.kind !== 'item' && entry.kind !== 'location' && entry.kind !== 'sheet')).map((entry) => (
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
      <button type="button" className="canvas-tool" onClick={() => void save()} disabled={readOnly || conflict || busy === 'save'}>
        <Save size={14} /> {t('saveNow')}
      </button>
      <button type="button" className="canvas-tool icon" title={t('fitView')} aria-label={t('fitView')} onClick={() => fitView({ padding: 0.2, minZoom: 0.05, maxZoom: 1 })}><Maximize2 size={15} /></button>
      <button type="button" className="canvas-tool" onClick={() => setFullscreen((value) => !value)}>
        {fullscreen ? t('exitFullscreen') : t('fullscreen')}
      </button>
    </div>

    {conflict && <div className="canvas-conflict" role="alert">
      <AlertTriangle size={15} /> {t('notifyRevisionConflict')}
      <button type="button" className="text-button" onClick={() => window.location.reload()}>{t('reload')}</button>
    </div>}
    {mentionIssues.length > 0 && <div className="form-error" role="alert">{t('mentionCapacity', { aliases: mentionIssues.map(label => `@${label}`).join(', ') })}</div>}
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
            minZoom={0.05}
            fitViewOptions={{ padding: 0.18, minZoom: 0.05, maxZoom: 1 }}
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

      {selectedGroup && <aside className="canvas-inspector" aria-label={selectedGroup.title}>
        <div className="canvas-inspector-head"><strong>{selectedGroup.title}</strong>
          <button type="button" className="close-button" aria-label={t('previewClose')} onClick={() => setSelectedId(null)}><X size={16} /></button>
        </div>
        {selectedQuickGroup && <>
          <p className="project-hint">{t(quickGroupConflicts.length ? 'groupConflicts' : 'quickGroupSynced')}</p>
          {quickGroupConflicts.map((field, index) => <p className="project-hint" key={`${field}-${index}`}>{field}</p>)}
          <button type="button" className="canvas-tool" disabled={readOnly || !!busy || dirty || conflict} onClick={() => {
            if (!quickSessionId || !window.confirm(t('quickGroupResetConfirm'))) return
            setBusy('save')
            void quickSessionCanvasApi(quickSessionId).resetSessionGroup(selectedGroup.id, revisionRef.current).then(result => applyLoaded(result.canvas)).catch(setError).finally(() => setBusy(null))
          }}>{t('quickGroupReset')}</button>
        </>}
        {!selectedQuickGroup && <p className="project-hint">{t(selectedGroup.timeline?.detached ? 'groupDetached' : selectedGroup.timeline?.conflicts?.length ? 'groupConflicts' : selectedGroup.timeline ? 'groupSynced' : 'groupLocal')}</p>}
        {selectedGroup.timeline?.conflicts?.map(field => <p className="project-hint" key={field}>{field}</p>)}
        {selectedGroup.timeline && !selectedGroup.timeline.detached && <button type="button" className="canvas-tool" disabled={readOnly || !!busy || dirty || conflict} onClick={() => {
          if (!window.confirm(t('groupResetConfirm'))) return
          setBusy('save')
          void api.resetTimelineGroup(selectedGroup.id, revisionRef.current).then(result => applyLoaded(result.canvas)).catch(setError).finally(() => setBusy(null))
        }}>{t('groupReset')}</button>}
      </aside>}
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
              {selectedPreview.kind === 'video' && selectedPreview.videoParams && <dl className="canvas-video-settings__summary">
                <div><dt>{t('videoDuration')}</dt><dd>{String(selectedPreview.videoParams.duration ?? selectedPreview.videoParams.seconds ?? '—')} {t('videoSeconds')}</dd></div>
                <div><dt>{t('videoResolution')}</dt><dd>{String(selectedPreview.videoParams.resolution ?? selectedPreview.videoParams.size ?? '—')}</dd></div>
                {selectedPreview.videoParams.aspectRatio != null && <div><dt>{t('videoRatio')}</dt><dd>{String(selectedPreview.videoParams.aspectRatio)}</dd></div>}
              </dl>}
              {!!selectedPreview.overlays?.length && <div className="canvas-inspector-block">
                <span>{t('logoPosition')}</span>
                {selectedPreview.overlays.map((overlay, index) => <p className="project-hint" key={`${overlay.entityId}-${index}`}>
                  {entities.find(entity => entity.kind === 'logo' && entity.id === overlay.entityId)?.name ?? overlay.entityId} · {overlay.anchor ? t(`logoPosition_${overlay.anchor}`) : `${Math.round(overlay.x * 100)}%, ${Math.round(overlay.y * 100)}%`} · {t('logoWidth')}: {Math.round(overlay.width * 100)}% · {t('logoOpacity')}: {Math.round(overlay.opacity * 100)}%
                </p>)}
              </div>}
              {selectedPreview.warnings.map((warning) => <p className="project-hint" key={warning}>{warning}</p>)}
              <button type="button" className="generate-button" disabled={busy === 'run' || !selectedPreview.model || selectedPreview.unresolved.length > 0 || selectedPreview.runnable === false} onClick={() => { void executeRun(selectedPreview.nodeId, selectedPreview.stamp) }}>
                {busy === 'run' ? <LoaderCircle size={16} className="spin" /> : <ImageIcon size={16} />} {t('confirmRun')}
              </button>
              <p className="cost-note">{t('runCostWarning')}</p>
            </>
          ) : selected ? (
            <>
              {selected.type === 'video' ? <CanvasVideoSettings quick={quick} node={selected.data.node} models={models} scenes={scenes} hasImageInput={videoInputs.length > 0} disabled={readOnly} onChange={patch => updateData(selected.id, patch)} /> : <>
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
              </>}
              {selected.type === 'video' && !quick && <div className="canvas-inspector-block">
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
              {selected.type === 'video' && <div className="canvas-inspector-block">
                {videoInputs.length > 1 && <label>{t('videoInput')}
                  <select className="canvas-select" value={selected.data.node.data.videoInputNodeId ?? ''} disabled={readOnly} onChange={event => updateData(selected.id, { videoInputNodeId: event.target.value || null })}>
                    <option value="">{t('videoInputChoose')}</option>
                    {videoInputs.map(source => <option key={source.id} value={source.id}>{t(NODE_TITLES[source.data.node.kind])} · {source.id}</option>)}
                  </select>
                </label>}
                <label className="canvas-video-consent"><input type="checkbox" checked={selected.data.node.data.allowTemporaryMedia === true} disabled={readOnly} onChange={event => updateData(selected.id, { allowTemporaryMedia: event.target.checked })} />{t('videoTemporaryConsent')}</label>
              </div>}
              {selected.type === 'image' && <div className="canvas-inspector-block">
                <label>{t('imageSize')}<input className="canvas-select" value={selected.data.node.data.imageSettings?.size ?? ''} disabled={readOnly} placeholder="1024x1024" onChange={event => updateData(selected.id, { imageSettings: { ...selected.data.node.data.imageSettings, size: event.target.value || undefined } })} /></label>
                <label>{t('imageQuality')}<select className="canvas-select" value={selected.data.node.data.imageSettings?.quality ?? ''} disabled={readOnly} onChange={event => updateData(selected.id, { imageSettings: { ...selected.data.node.data.imageSettings, quality: event.target.value || undefined } })}>
                  <option value="">{t('imageDefault')}</option>{['auto', 'low', 'medium', 'high', 'standard', 'hd'].map(value => <option key={value} value={value}>{value}</option>)}
                </select></label>
                <label>{t('imageCount')}<input type="number" min={1} max={10} value={selected.data.node.data.imageSettings?.n ?? 1} disabled={readOnly} onChange={event => updateData(selected.id, { imageSettings: { ...selected.data.node.data.imageSettings, n: Math.max(1, Math.min(10, Number(event.target.value) || 1)) } })} /></label>
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
