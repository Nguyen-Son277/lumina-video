import { createContext, useContext, type ReactNode } from 'react'
import { CanvasVideoSettings } from './CanvasVideoSettings'
import { CanvasEntityPicker } from './CanvasEntityPicker'
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
import type { ImageEditorSource } from '../../../shared/imageEditor'
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
  projectId?: string
  quick?: boolean
  entities: EntityLibraryEntity[]
  aliases: CanvasAlias[]
  characters: ProjectCharacter[]
  locations: LocationReference[]
  items: ProjectItem[]
  scenes: ProjectScene[]
  hasVideoImageInput: (nodeId: string) => boolean
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
  /** Open an image preview with a typed editor source; the board owns the lightbox. */
  openImage: (input: { url: string; alt: string; editableSource?: ImageEditorSource }) => void
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

function OutputPreview({ generation, assetId }: { generation?: Generation; assetId?: string | null }) {
  const actions = useCanvasActions()
  const { t } = useTranslation(canvasCatalog)
  const asset = assetId ? generation?.assets?.find(asset => asset.id === assetId) : generation?.assets?.[0]
  if (!asset) return null
  return generation?.kind === 'video'
    ? <video className="canvas-output-media" src={asset.url} controls preload="metadata" />
    : <button type="button" className="canvas-output-open" aria-label={t('zoomImageAria', { name: generation?.prompt.slice(0, 60) ?? '' })}
        onClick={() => actions.openImage({ url: asset.url, alt: generation?.prompt.slice(0, 60) ?? '', editableSource: actions.readOnly ? undefined : { kind: 'asset', id: asset.id } })}>
        <img className="canvas-output-media" src={asset.url} alt="" loading="lazy" />
      </button>
}

/** Thumbnail that opens the board lightbox; only still images expose the editor.
 * The image keeps the `canvas-thumb` class so existing layout and tests stay valid. */
function CanvasThumb({ src, alt, editableSource, label }: { src: string; alt: string; editableSource?: ImageEditorSource; label: string }) {
  const actions = useCanvasActions()
  return <button type="button" className="canvas-thumb-open" aria-label={label} onClick={() => actions.openImage({ url: src, alt, editableSource })}>
    <img className="canvas-thumb" src={src} alt={alt} loading="lazy" />
  </button>
}

/** Library node source: the entity plus the picked reference view when one is selected. */
function libraryEditorSource(entity: EntityLibraryEntity | undefined, uploadId: string | null | undefined): ImageEditorSource | undefined {
  if (!entity) return undefined
  const view = uploadId ? entity.referenceViews?.find(item => item.uploadId === uploadId) : undefined
  return { kind: 'entity', entityKind: entity.kind, id: entity.id, revision: entity.revision, ...(view ? { viewId: view.id } : {}) }
}

/** Project-scoped nodes reference uploads or catalog records; the id must be known. */
function projectNodeEditorSource(kind: 'character' | 'location' | 'item', data: CanvasNodeData, actions: CanvasActions): ImageEditorSource | undefined {
  const entity = actions.entities.find(item => item.id === data.sourceId)
  if (entity) return libraryEditorSource(entity, kind === 'location' ? data.uploadId : null)
  if (kind === 'location') return data.uploadId ? { kind: 'upload', id: data.uploadId } : undefined
  if (kind === 'item') {
    const item = actions.items.find(entry => entry.id === data.sourceId)
    return item?.reference ? { kind: 'upload', id: item.reference.uploadId } : undefined
  }
  const character = actions.characters.find(entry => entry.id === data.sourceId)
  return character?.updatedAt !== undefined ? { kind: 'entity', entityKind: 'character', id: character.id, revision: character.updatedAt } : undefined
}

/** Thân node theo từng loại; mọi node đều nằm trong một khung giống nhau. */
export function CanvasNodeEditor({ node }: { node: CanvasNode }) {
  const actions = useCanvasActions()
  const { t } = useTranslation(canvasCatalog)
  const { t: entityT } = useEntityTranslation(entityLibraryCatalog)
  const data = node.data ?? {}
  const disabled = actions.readOnly
  const runs = actions.runsByNode[node.id] ?? []
  const selectedRun = data.selectedRunId ? runs.find((run) => run.id === data.selectedRunId) : runs.find((run) => run.generationId && actions.generations[run.generationId])
  const generation = selectedRun?.generationId ? actions.generations[selectedRun.generationId] : undefined

  if (node.kind === 'prompt') {
    return <div className="canvas-prompt-editor nodrag nowheel"><div className="canvas-prompt-label"><span>{t('promptText')}</span><span>{t('promptCount', { count: (data.promptDocument?.text ?? data.text ?? '').length })}</span></div><EntityMentionTextarea
      document={data.promptDocument ?? { version: 1, text: data.text ?? '', mentions: [] }}
      projectId={actions.projectId}
      aria-label={t('promptText')}
      disabled={disabled}
      rows={4}
      maxLength={8000}
      onChange={(promptDocument) => actions.updateData(node.id, { text: promptDocument.text, promptDocument })}
    /></div>
  }

  if (node.kind === 'library') {
    const selected = actions.entities.find(entity => entity.id === data.sourceId && entity.kind === data.entityKind)
    const reference = selected?.kind === 'location' && data.uploadId ? `/api/uploads/${encodeURIComponent(data.uploadId)}` : selected ? entityReferenceUrl(selected) : null
    return <>
      <CanvasEntityPicker label={entityT('title')} value={selected ? `${selected.kind}:${selected.id}` : ''} disabled={disabled}
        types={(['item', 'location', 'logo'] as const).map(kind => ({ value: kind, label: entityT(kind) }))}
        options={actions.entities.filter(entity => entity.kind !== 'character').map(entity => ({ value: `${entity.kind}:${entity.id}`, type: entity.kind, label: `#${entity.handle} · ${entity.name} (${entityT(entity.kind)})`, thumbnail: entityReferenceUrl(entity), description: entity.description }))}
        onChange={value => {
          const entity = actions.entities.find(entity => `${entity.kind}:${entity.id}` === value)
          if (entity?.kind === 'character') return
          actions.updateData(node.id, { sourceId: entity?.id ?? null, entityKind: entity?.kind, uploadId: null, ...(actions.quick && entity?.kind === 'logo' && data.logoPosition === undefined ? { logoPosition: 'top-right' as const } : {}) })
        }} />
      {reference ? <CanvasThumb src={reference} alt="" label={t('zoomImageAria', { name: selected?.name ?? '' })} editableSource={libraryEditorSource(selected, data.uploadId)} /> : <div className="canvas-thumb is-empty"><ImageIcon size={18} /><span>{t('noImage')}</span></div>}
      {selected && <p className="canvas-node-note">{selected.description}</p>}
      {selected?.kind === 'location' && !!selected.referenceViews?.length && <label>{t('locationView')}
        <select className="canvas-select" value={data.uploadId ?? ''} disabled={disabled} onChange={event => actions.updateData(node.id, { uploadId: event.target.value || null })}>
          <option value="">{t('locationDefaultView')}</option>
          {selected.referenceViews.map(view => <option key={view.id} value={view.uploadId}>{view.label}</option>)}
        </select>
      </label>}
      {actions.quick && selected?.kind === 'logo' && <div className="nodrag nowheel">
        <label>{t('logoPosition')}<select className="canvas-select" value={data.logoOverlay && !data.logoOverlay.anchor ? 'custom' : data.logoPosition ?? data.logoOverlay?.anchor ?? 'ai'} disabled={disabled} onChange={event => actions.updateData(node.id, { logoPosition: event.target.value as CanvasNodeData['logoPosition'], logoOverlay: undefined })}>
          {data.logoOverlay && !data.logoOverlay.anchor && <option value="custom" disabled>{t('logoPositionCustom')}</option>}
          {(['ai', 'top-left', 'top-center', 'top-right', 'middle-left', 'center', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right'] as const).map(position => <option key={position} value={position}>{t(`logoPosition_${position}`)}</option>)}
        </select></label>
        <label>{t('logoWidth')}<input type="range" min="0.01" max="1" step="0.01" value={data.logoOverlay?.width ?? data.logoWidth ?? 0.15} disabled={disabled} onChange={event => actions.updateData(node.id, { logoWidth: Number(event.target.value), ...(data.logoOverlay ? { logoOverlay: { ...data.logoOverlay, width: Number(event.target.value) } } : {}) })} /></label>
        <label>{t('logoOpacity')}<input type="range" min="0" max="1" step="0.01" value={data.logoOverlay?.opacity ?? data.logoOpacity ?? 1} disabled={disabled} onChange={event => actions.updateData(node.id, { logoOpacity: Number(event.target.value), ...(data.logoOverlay ? { logoOverlay: { ...data.logoOverlay, opacity: Number(event.target.value) } } : {}) })} /></label>
      </div>}
    </>
  }

  if (node.kind === 'note') {
    return <div className={`canvas-note color-${data.color ?? 'yellow'}`}>
      <textarea
        value={data.text ?? ''}
        aria-label={t('nodeNote')}
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
      {node.kind !== 'upload' && <label>{t('chooseModel')}<select className="canvas-select" aria-label={t('chooseModel')} value={data.modelId ?? ''} disabled={disabled} onChange={event => actions.updateData(node.id, { modelId: event.target.value || null })}>
        <option value="">{t('chooseModel')}</option>
        {actions.models.filter(model => model.enabled && model.kind === 'image').map(model => <option key={model.id} value={model.id}>{model.displayName}</option>)}
      </select></label>}
      {data.uploadId
        ? <CanvasThumb src={`/api/uploads/${encodeURIComponent(data.uploadId)}`} alt="" label={t('zoomImageAria', { name: '' })} editableSource={{ kind: 'upload', id: data.uploadId }} />
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
      {node.kind !== 'upload' && <OutputPreview generation={generation} assetId={selectedRun?.assetId} />}
      {node.kind !== 'upload' && <RunBadge generation={generation} />}
    </>
  }

  // Node đối tượng: chọn bản ghi đã có trong dự án/thư viện.
  if (node.kind === 'character' && actions.quick) {
    const selected = actions.entities.find(entity => entity.kind === 'character' && entity.id === data.sourceId)
    const reference = selected ? entityReferenceUrl(selected) : null
    return <>
      <CanvasEntityPicker label={t('chooseCharacter')} value={data.sourceId ?? ''} disabled={disabled}
        options={actions.entities.filter(entity => entity.kind === 'character').map(entity => ({ value: entity.id, label: `@${entity.handle} · ${entity.name}`, thumbnail: entityReferenceUrl(entity), description: entity.description }))}
        onChange={value => actions.updateData(node.id, { sourceId: value || null })} />
      {reference ? <CanvasThumb src={reference} alt="" label={t('zoomImageAria', { name: selected?.name ?? '' })} editableSource={libraryEditorSource(selected, null)} /> : <div className="canvas-thumb is-empty"><ImageIcon size={18} /><span>{t('noImage')}</span></div>}
      {selected && <p className="canvas-node-note">{selected.description}</p>}
    </>
  }
  if (node.kind === 'character' || node.kind === 'location' || node.kind === 'item') {
    const options = node.kind === 'character'
      ? actions.characters.map(item => ({ value: item.id, label: `@${actions.entities.find(entity => entity.kind === 'character' && entity.id === item.id)?.handle ?? item.name} · ${item.name}`, thumbnail: item.referenceUrl, description: item.appearance }))
      : node.kind === 'location'
        ? actions.locations.map(item => ({ value: item.id, label: `#${item.name}`, thumbnail: item.reference ? `/api/uploads/${encodeURIComponent(item.reference.uploadId)}` : null, description: item.description }))
        : actions.items.map(item => ({ value: item.id, label: `#${item.name}`, thumbnail: item.reference ? `/api/uploads/${encodeURIComponent(item.reference.uploadId)}` : null, description: item.description }))
    const label = node.kind === 'character' ? t('chooseCharacter') : node.kind === 'location' ? t('chooseLocation') : t('chooseItem')
    const selected = node.kind === 'character'
      ? actions.characters.find((item) => item.id === data.sourceId)
      : node.kind === 'location'
        ? actions.locations.find((item) => item.id === data.sourceId)
        : actions.items.find((item) => item.id === data.sourceId)
    const referenceUrl = node.kind === 'character'
      ? actions.characters.find((item) => item.id === data.sourceId)?.referenceUrl ?? null
      : node.kind === 'location'
        ? (data.uploadId ? `/api/uploads/${encodeURIComponent(data.uploadId)}` : actions.locations.find((item) => item.id === data.sourceId)?.reference ? `/api/uploads/${encodeURIComponent(actions.locations.find((item) => item.id === data.sourceId)!.reference!.uploadId)}` : null)
        : (actions.items.find((item) => item.id === data.sourceId)?.reference ? `/api/uploads/${encodeURIComponent(actions.items.find((item) => item.id === data.sourceId)!.reference!.uploadId)}` : null)
    return <>
      <CanvasEntityPicker label={label} value={data.sourceId ?? ''} disabled={disabled} options={options}
        onChange={value => actions.updateData(node.id, { sourceId: value || null, ...(node.kind === 'location' ? { uploadId: null } : {}) })} />
      {referenceUrl
        ? <CanvasThumb src={referenceUrl} alt="" label={t('zoomImageAria', { name: 'name' in (selected ?? {}) ? (selected as { name: string }).name : '' })} editableSource={projectNodeEditorSource(node.kind, data, actions)} />
        : <div className="canvas-thumb is-empty"><ImageIcon size={18} /><span>{t('noImage')}</span></div>}
      {selected && <p className="canvas-node-note">{'appearance' in selected ? selected.appearance : selected.description}</p>}
      {node.kind === 'location' && !!actions.locations.find(item => item.id === data.sourceId)?.referenceViews?.length && <label>{t('locationView')}
        <select className="canvas-select" value={data.uploadId ?? ''} disabled={disabled} onChange={event => actions.updateData(node.id, { uploadId: event.target.value || null })}>
          <option value="">{t('locationDefaultView')}</option>
          {actions.locations.find(item => item.id === data.sourceId)!.referenceViews.map(view => <option key={view.id} value={view.uploadId}>{view.label}</option>)}
        </select>
      </label>}
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
    {node.kind === 'video' && !actions.quick && (
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
    {node.kind === 'video' && <CanvasVideoSettings quick={actions.quick} node={node} models={actions.models} scenes={actions.scenes} hasImageInput={actions.hasVideoImageInput(node.id)} disabled={disabled} onChange={patch => actions.updateData(node.id, patch)} />}
    <OutputPreview generation={generation} assetId={selectedRun?.assetId} />
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
    <div className="canvas-node-body"><CanvasNodeEditor node={node} /></div>
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
