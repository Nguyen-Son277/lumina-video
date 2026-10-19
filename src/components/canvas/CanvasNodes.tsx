import { createContext, useContext, type ReactNode } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import {
  AlertTriangle,
  Image as ImageIcon,
  Layers,
  LoaderCircle,
  Megaphone,
  Package,
  Play,
  Sparkles,
  StickyNote,
  UserRound,
  Video as VideoIcon,
} from 'lucide-react'
import { CANVAS_NODE_SPECS, type CanvasGroup, type CanvasNode, type CanvasNodeData, type CanvasNodeKind, type CanvasPortKind } from '../../../shared/canvas'
import type { CanvasAlias, CanvasRun, ProjectItem } from '../../api/canvas'
import type { Generation, ModelInfo } from '../../api/types'
import type { ProjectCharacter } from '../../api/projectTypes'
import type { LocationReference } from '../../api/locations'
import type { ProjectScene } from '../../api/projectTypes'
import { uploadApi } from '../../api/endpoints'
import { useTranslation } from '../../i18n'
import { canvasCatalog, type CanvasCatalogKey } from '../../i18n/catalogs/canvas'
import { notification, type Notification } from '../../i18n/messages'
import { EntityMentionTextarea } from '../EntityMentionTextarea'
import { entityReferenceUrl, type EntityLibraryEntity } from '../../api/entityLibrary'
import { useTranslation as useEntityTranslation } from '../../i18n'
import { entityLibraryCatalog } from '../../i18n/catalogs/entityLibrary'

/**
 * Hành vi dùng chung của mọi node, truyền qua context để `nodeTypes` của React Flow
 * luôn ổn định (định nghĩa lại mỗi render sẽ làm hỏng bảng).
 */
export type CanvasActions = {
  projectId: string
  entities: EntityLibraryEntity[]
  aliases: CanvasAlias[]
  characters: ProjectCharacter[]
  locations: LocationReference[]
  items: ProjectItem[]
  scenes: ProjectScene[]
  models: ModelInfo[]
  runsByNode: Record<string, CanvasRun[]>
  generations: Record<string, Generation>
  readOnly: boolean
  updateData: (nodeId: string, patch: Partial<CanvasNodeData>) => void
  insertNodes: (nodes: CanvasNode[], connectTo?: string) => void
  removeNode: (nodeId: string) => void
  selectOutput: (nodeId: string, runId: string | null) => void
  openInspector: (nodeId: string) => void
  openLayout: (nodeId: string) => void
  /** Mở hộp thoại tạo sản phẩm/đạo cụ mới rồi gắn vào node đang chọn. */
  createItemFor: (nodeId: string) => void
  /** Tải ảnh tham chiếu cho vật phẩm của node. */
  uploadItemReference: (nodeId: string) => void
  /** Sinh ảnh tham chiếu bằng model ảnh rồi gắn vào vật phẩm. */
  generateItemReference: (nodeId: string) => void
  previewNode: (nodeId: string) => void
  runNode: (nodeId: string) => void
  notify: (message: Notification) => void
}

const CanvasActionsContext = createContext<CanvasActions | null>(null)
export const CanvasActionsProvider = CanvasActionsContext.Provider

export function useCanvasActions(): CanvasActions {
  const value = useContext(CanvasActionsContext)
  if (!value) throw new Error('Canvas node dùng ngoài CanvasActionsProvider')
  return value
}

export const NODE_TITLES: Record<CanvasNodeKind, CanvasCatalogKey> = {
  prompt: 'nodePrompt',
  note: 'nodeNote',
  upload: 'nodeUpload',
  character: 'nodeCharacter',
  location: 'nodeLocation',
  item: 'nodeItem',
  library: 'nodeItem',
  sheet: 'nodeSheet',
  image: 'nodeImage',
  video: 'nodeVideo',
}

const PORT_CLASS: Record<CanvasPortKind, string> = {
  text: 'port-text',
  image: 'port-image',
  object: 'port-object',
  video: 'port-video',
}

const NODE_ICON: Record<CanvasNodeKind, ReactNode> = {
  prompt: <Megaphone size={14} />,
  note: <StickyNote size={14} />,
  upload: <ImageIcon size={14} />,
  character: <UserRound size={14} />,
  location: <Layers size={14} />,
  item: <Package size={14} />,
  library: <Package size={14} />,
  sheet: <Sparkles size={14} />,
  image: <ImageIcon size={14} />,
  video: <VideoIcon size={14} />,
}

function Ports({ kind }: { kind: CanvasNodeKind }) {
  const spec = CANVAS_NODE_SPECS[kind]
  const inputs = Object.entries(spec.inputs)
  const outputs = Object.entries(spec.outputs)
  return <>
    {inputs.map(([id, port], index) => (
      <Handle
        key={`in-${id}`}
        id={id}
        type="target"
        position={Position.Left}
        className={`canvas-handle ${PORT_CLASS[port.kinds[0] ?? 'text']}`}
        style={{ top: `${((index + 1) / (inputs.length + 1)) * 100}%` }}
        title={id}
      />
    ))}
    {outputs.map(([id, port], index) => (
      <Handle
        key={`out-${id}`}
        id={id}
        type="source"
        position={Position.Right}
        className={`canvas-handle ${PORT_CLASS[port]}`}
        style={{ top: `${((index + 1) / (outputs.length + 1)) * 100}%` }}
        title={id}
      />
    ))}
  </>
}

function RunBadge({ generation }: { generation?: Generation }) {
  if (!generation) return null
  const active = generation.status === 'queued' || generation.status === 'running' || generation.status === 'downloading'
  if (!active && generation.status !== 'failed' && generation.status !== 'unknown') return null
  const progress = typeof generation.progress === 'number' && generation.progress > 0 ? Math.min(100, generation.progress) : null
  return <div className={`canvas-run-badge ${generation.status}`}>
    {active ? <LoaderCircle size={12} className="spin" /> : <AlertTriangle size={12} />}
    <span>{generation.status === 'unknown' ? '?' : progress !== null ? `${progress}%` : ''}</span>
    {active && <div className={`card-progress ${progress === null ? 'is-indeterminate' : ''}`}><span style={progress !== null ? { width: `${progress}%` } : undefined} /></div>}
  </div>
}

function OutputPreview({ generation }: { generation?: Generation }) {
  const asset = generation?.assets?.[0]
  if (!asset) return null
  return generation?.kind === 'video'
    ? <video className="canvas-output-media" src={asset.url} controls preload="metadata" />
    : <img className="canvas-output-media" src={asset.url} alt="" loading="lazy" />
}

/** Thân node theo từng loại; mọi node đều nằm trong một khung giống nhau. */
function NodeBody({ node }: { node: CanvasNode }) {
  const actions = useCanvasActions()
  const { t } = useTranslation(canvasCatalog)
  const { t: entityT } = useEntityTranslation(entityLibraryCatalog)
  const data = node.data ?? {}
  const disabled = actions.readOnly
  const runs = actions.runsByNode[node.id] ?? []
  const selectedRun = data.selectedRunId ? runs.find((run) => run.id === data.selectedRunId) : runs.find((run) => run.generationId && actions.generations[run.generationId])
  const generation = selectedRun?.generationId ? actions.generations[selectedRun.generationId] : undefined

  if (node.kind === 'prompt') {
    return <div className="nodrag nowheel"><EntityMentionTextarea
      document={data.promptDocument ?? { version: 1, text: data.text ?? '', mentions: [] }}
      projectId={actions.projectId}
      disabled={disabled}
      rows={4}
      maxLength={8000}
      onChange={(promptDocument) => actions.updateData(node.id, { text: promptDocument.text, promptDocument })}
    /></div>
  }

  if (node.kind === 'library') {
    const selected = actions.entities.find(entity => entity.id === data.sourceId && entity.kind === data.entityKind)
    const reference = selected ? entityReferenceUrl(selected) : null
    return <>
      <select className="canvas-select" aria-label={entityT('title')} value={selected ? `${selected.kind}:${selected.id}` : ''} disabled={disabled}
        onChange={event => {
          const entity = actions.entities.find(entity => `${entity.kind}:${entity.id}` === event.target.value)
          if (entity?.kind === 'character') return
          actions.updateData(node.id, { sourceId: entity?.id ?? null, entityKind: entity?.kind })
        }}>
        <option value="">{entityT('title')}</option>
        {actions.entities.filter(entity => entity.kind !== 'character').map(entity => <option key={`${entity.kind}:${entity.id}`} value={`${entity.kind}:${entity.id}`}>@{entity.handle} · {entity.name} ({entityT(entity.kind)})</option>)}
      </select>
      {reference ? <img className="canvas-thumb" src={reference} alt="" loading="lazy" /> : <div className="canvas-thumb is-empty"><ImageIcon size={18} /><span>{t('noImage')}</span></div>}
      {selected && <p className="canvas-node-note">{selected.description}</p>}
    </>
  }

  if (node.kind === 'note') {
    return <div className={`canvas-note color-${data.color ?? 'yellow'}`}>
      <textarea
        value={data.text ?? ''}
        disabled={disabled}
        placeholder={t('notePlaceholder')}
        onChange={(event) => actions.updateData(node.id, { text: event.target.value })}
      />
      <div className="canvas-note-colors">
        {(['yellow', 'purple', 'green'] as const).map((color) => (
          <button key={color} type="button" className={`color-${color} ${data.color === color || (!data.color && color === 'yellow') ? 'is-active' : ''}`} aria-label={color} disabled={disabled} onClick={() => actions.updateData(node.id, { color })} />
        ))}
      </div>
    </div>
  }

  if (node.kind === 'upload' || node.kind === 'sheet' || node.kind === 'image') {
    return <>
      {data.uploadId
        ? <img className="canvas-thumb" src={`/api/uploads/${encodeURIComponent(data.uploadId)}`} alt="" loading="lazy" />
        : <div className="canvas-thumb is-empty"><ImageIcon size={18} /></div>}
      {!disabled && (
        <label className="canvas-upload">
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (!file) return
              void uploadApi.upload(file)
                .then((upload) => actions.updateData(node.id, { uploadId: upload.id }))
                .catch((cause: unknown) => actions.notify(String(cause)))
            }}
          />
          {data.uploadId ? t('replaceImage') : t('uploadImage')}
        </label>
      )}
      {node.kind !== 'upload' && <OutputPreview generation={generation} />}
      {node.kind !== 'upload' && <RunBadge generation={generation} />}
    </>
  }

  // Node đối tượng: chọn bản ghi đã có trong dự án/thư viện.
  if (node.kind === 'character' || node.kind === 'location' || node.kind === 'item') {
    const options = node.kind === 'character'
      ? actions.characters.map((item) => ({ value: item.id, label: item.name }))
      : node.kind === 'location'
        ? actions.locations.map((item) => ({ value: item.id, label: item.name }))
        : actions.items.map((item) => ({ value: item.id, label: item.name }))
    const label = node.kind === 'character' ? t('chooseCharacter') : node.kind === 'location' ? t('chooseLocation') : t('chooseItem')
    const selected = node.kind === 'character'
      ? actions.characters.find((item) => item.id === data.sourceId)
      : node.kind === 'location'
        ? actions.locations.find((item) => item.id === data.sourceId)
        : actions.items.find((item) => item.id === data.sourceId)
    const referenceUrl = node.kind === 'character'
      ? actions.characters.find((item) => item.id === data.sourceId)?.referenceUrl ?? null
      : node.kind === 'location'
        ? (actions.locations.find((item) => item.id === data.sourceId)?.reference ? `/api/uploads/${encodeURIComponent(actions.locations.find((item) => item.id === data.sourceId)!.reference!.uploadId)}` : null)
        : (actions.items.find((item) => item.id === data.sourceId)?.reference ? `/api/uploads/${encodeURIComponent(actions.items.find((item) => item.id === data.sourceId)!.reference!.uploadId)}` : null)
    return <>
      <select
        className="canvas-select"
        aria-label={label}
        value={data.sourceId ?? ''}
        disabled={disabled}
        onChange={(event) => actions.updateData(node.id, { sourceId: event.target.value || null })}
      >
        <option value="">{label}</option>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      {referenceUrl
        ? <img className="canvas-thumb" src={referenceUrl} alt="" loading="lazy" />
        : <div className="canvas-thumb is-empty"><ImageIcon size={18} /><span>{t('noImage')}</span></div>}
      {selected && node.kind === 'item' && <p className="canvas-node-note">{(selected as ProjectItem).description}</p>}
      {node.kind === 'item' && !disabled && <div className="canvas-item-actions">
        <button type="button" className="text-button" onClick={() => actions.createItemFor(node.id)}>{t('itemCreateOpen')}</button>
        {data.sourceId && <>
          <button type="button" className="text-button" onClick={() => actions.uploadItemReference(node.id)}>{t('itemAttachUpload')}</button>
          <button type="button" className="text-button" onClick={() => actions.generateItemReference(node.id)}>
            <Sparkles size={12} /> {t('itemGenerateReference')}
          </button>
        </>}
      </div>}
    </>
  }

  // Node tạo video cần cảnh Studio làm nguồn sự thật cho lời thoại và phiên bản.
  return <>
    {node.kind === 'video' && (
      <select
        className="canvas-select"
        aria-label={t('chooseScene')}
        value={data.sceneId ?? ''}
        disabled={disabled}
        onChange={(event) => actions.updateData(node.id, { sceneId: event.target.value || null })}
      >
        <option value="">{t('chooseScene')}</option>
        {actions.scenes.map((scene) => <option key={scene.id} value={scene.id}>{scene.title}</option>)}
      </select>
    )}
    <select
      className="canvas-select"
      aria-label={t('chooseModel')}
      value={data.modelId ?? ''}
      disabled={disabled}
      onChange={(event) => actions.updateData(node.id, { modelId: event.target.value || null })}
    >
      <option value="">{t('chooseModel')}</option>
      {actions.models.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
    </select>
    <OutputPreview generation={generation} />
    <RunBadge generation={generation} />
  </>
}

function CanvasNodeCard({ id, data, selected, type }: NodeProps & { data: { node: CanvasNode } }) {
  const actions = useCanvasActions()
  const { t } = useTranslation(canvasCatalog)
  const node = data.node ?? { id, kind: (type as CanvasNodeKind) ?? 'note', x: 0, y: 0, data: {} }
  const kind = node.kind
  const isGenerator = kind === 'image' || kind === 'video' || kind === 'sheet'
  const runs = actions.runsByNode[id] ?? []
  const activeRuns = runs.filter((run) => {
    const generation = run.generationId ? actions.generations[run.generationId] : undefined
    return generation && ['queued', 'running', 'downloading'].includes(generation.status)
  })

  return <div className={`canvas-node kind-${kind} ${selected ? 'is-selected' : ''}`}>
    <Ports kind={kind} />
    <header>
      <span className="canvas-node-icon">{NODE_ICON[kind]}</span>
      <strong>{t(NODE_TITLES[kind])}</strong>
      {activeRuns.length > 0 && <em className="canvas-node-active">{t('activeRuns', { count: activeRuns.length })}</em>}
      {!actions.readOnly && (
        <button type="button" className="canvas-node-remove" aria-label={t('removeNode')} title={t('removeNode')} onClick={() => actions.removeNode(id)}>
          ×
        </button>
      )}
    </header>
    <div className="canvas-node-body"><NodeBody node={node} /></div>
    {isGenerator && !actions.readOnly && (
      <footer>
        {kind !== 'sheet' && <button type="button" className="text-button" onClick={() => actions.openLayout(id)}>{t('layoutOpen')}</button>}
        <button type="button" className="text-button" onClick={() => actions.previewNode(id)}>{t('preview')}</button>
        <button type="button" className="canvas-run-button" onClick={() => actions.runNode(id)} disabled={!node.data?.modelId}>
          <Play size={12} /> {runs.length ? t('runAgain') : t('run')}
        </button>
      </footer>
    )}
    {isGenerator && runs.length > 0 && (
      <div className="canvas-node-runs">
        <span>{t('runsTitle')}</span>
        {runs.slice(0, 4).map((run) => (
          <button
            key={run.id}
            type="button"
            className={node.data?.selectedRunId === run.id ? 'is-active' : ''}
            onClick={() => actions.selectOutput(id, node.data?.selectedRunId === run.id ? null : run.id)}
            title={t('runSelect')}
          >
            {actions.generations[run.generationId ?? '']?.status === 'succeeded' ? '✓' : '…'}
          </button>
        ))}
      </div>
    )}
  </div>
}

function CanvasGroupCard({ data }: NodeProps) {
  const { t } = useTranslation(canvasCatalog)
  const group = data.group as CanvasGroup
  const timeline = group.timeline
  const state = timeline?.detached ? 'groupDetached' : timeline?.conflicts?.length ? 'groupConflicts' : timeline ? 'groupSynced' : 'groupLocal'
  return <div className={`canvas-group ${state}`}>
    <header><strong>{group.title}</strong><span>{t(state)}</span></header>
    {!!timeline?.conflicts?.length && <p>{timeline.conflicts.join(', ')}</p>}
  </div>
}

/** `nodeTypes` must stay stable, including synthetic presentation containers. */
export const canvasNodeTypes = {
  ...Object.fromEntries((Object.keys(CANVAS_NODE_SPECS) as CanvasNodeKind[]).map((kind) => [kind, CanvasNodeCard])),
  canvasGroup: CanvasGroupCard,
}
