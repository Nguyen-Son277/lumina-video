import type { CanvasGraph, CanvasNodeKind } from '../../shared/canvas'
import type { Generation, ModelInfo } from './types'
import type { PromptDocument } from '../../shared/promptMentions'
import type { CanvasVideoSettings } from '../../shared/canvas'
import type { LogoOverlay } from './endpoints'
import { api, assertResponseOk } from './client'

/**
 * Canvas của dự án Studio: vật phẩm/đạo cụ và bảng node.
 *
 * Mọi lời gọi đều đi qua API có xác thực; trình duyệt không bao giờ tự ghép prompt
 * hiệu lực hay tự gửi đường dẫn media — server đọc lại graph đã lưu.
 */

export type ProjectItem = {
  id: string
  kind: 'product' | 'prop'
  name: string
  description: string
  continuityNotes: string
  imagePrompt: string
  reference: { uploadId: string } | null
  revision: number
  updatedAt: number
}

export type ProjectItemInput = {
  kind: 'product' | 'prop'
  name: string
  description?: string
  continuityNotes?: string
  imagePrompt?: string
}

export type CanvasRun = {
  id: string
  nodeId: string
  kind: 'image' | 'video'
  generationId: string | null
  assetId?: string | null
  inputStamp: string
  createdAt: number
}

export type CanvasAlias = {
  nodeId: string
  alias: string
  kind: 'character' | 'location' | 'item' | 'logo'
  recordId?: string
  entity?: { kind: 'character' | 'item' | 'logo' | 'location'; id: string }
  name: string
  hasReference: boolean
}

export type CanvasBoard = {
  projectId?: string
  quickSessionId?: string
  provenance?: Array<{ sourceKey: string; nodeId: string; tombstoned?: boolean; conflicts?: string[] }>
  graph: CanvasGraph
  revision: number
  updatedAt: number
  runs: CanvasRun[]
  aliases: CanvasAlias[]
  limits: { nodes: number; edges: number; placements: number; contextInputs: number }
}

export type CanvasPreviewInput = {
  kind: 'upload' | 'character'
  label: string
  reason: 'object' | 'upstream' | 'source' | 'composite'
  nodeId: string | null
  url: string
  sent: boolean
}

export type CanvasPreview = {
  nodeId: string
  kind: 'image' | 'video'
  stamp: string
  prompt: string
  userText: string
  mentions: Array<{ nodeId: string; alias: string; kind: string; name: string; hasReference: boolean }>
  unresolved: string[]
  inputs: CanvasPreviewInput[]
  warnings: string[]
  videoParams?: Record<string, unknown>
  overlays?: LogoOverlay[]
  runnable?: boolean
  limits: { maxImages: number; sentImages: number }
  model: { id: string; displayName: string; kind: string; modelId: string } | null
}

export const projectItemsApi = (projectId: string) => {
  const root = `/projects/${encodeURIComponent(projectId)}/items`
  return {
    list: () => api.get<{ items: ProjectItem[] }>(root),
    create: async (input: ProjectItemInput): Promise<ProjectItem> => (await api.post<{ item: ProjectItem }>(root, input)).item,
    update: async (itemId: string, input: Partial<ProjectItemInput>): Promise<ProjectItem> =>
      (await api.patch<{ item: ProjectItem }>(`${root}/${encodeURIComponent(itemId)}`, input)).item,
    remove: (itemId: string) => api.delete<void>(`${root}/${encodeURIComponent(itemId)}`),
    /** Tải ảnh tham chiếu thô; backend nhận dạng bằng magic bytes. */
    uploadReference: async (itemId: string, file: File): Promise<ProjectItem> => {
      const response = await fetch(`/api${root}/${encodeURIComponent(itemId)}/reference`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      })
      await assertResponseOk(response)
      return ((await response.json()) as { item: ProjectItem }).item
    },
    removeReference: async (itemId: string): Promise<ProjectItem> =>
      (await api.delete<{ item: ProjectItem }>(`${root}/${encodeURIComponent(itemId)}/reference`)).item,
    attachReference: async (itemId: string, generationId: string, assetId?: string): Promise<ProjectItem> =>
      (await api.post<{ item: ProjectItem }>(`${root}/${encodeURIComponent(itemId)}/reference/from-generation`, {
        generationId,
        ...(assetId ? { assetId } : {}),
      })).item,
    /** Sinh ảnh tham chiếu; gọi `attachReference` sau khi tác vụ thành công. */
    generateReference: (itemId: string, modelId: string) =>
      api.post<{ generation: Generation }>(`${root}/${encodeURIComponent(itemId)}/reference/generate`, { modelId }),
  }
}

export const projectCanvasApi = (projectId: string) => canvasApi(`/projects/${encodeURIComponent(projectId)}/canvas`)

export type QuickCanvasDraft = {
  promptDocument: PromptDocument
  kind: 'image' | 'video'
  modelId?: string
  imageSettings?: { size?: string; quality?: string; n?: number }
  imagePurpose?: { kind: 'item' | 'logo' | 'location'; name: string; description?: string }
  videoSettings?: CanvasVideoSettings
  sourceUploadIds?: string[]
  sourceAssetIds?: string[]
  videoInput?: { uploadId?: string; assetId?: string }
  logoOverlays?: LogoOverlay[]
  allowTemporaryMedia?: boolean
}

export const quickSessionCanvasApi = (quickSessionId: string) => {
  const root = `/quick-sessions/${encodeURIComponent(quickSessionId)}/canvas`
  return {
    ...canvasApi(root),
    resetSessionGroup: (groupId: string, baseRevision: number) =>
      api.post<{ canvas: CanvasBoard }>(`${root}/groups/${encodeURIComponent(groupId)}/reset-session`, { baseRevision }),
    sync: (baseRevision: number, draft?: QuickCanvasDraft) =>
      api.post<{ canvas: CanvasBoard }>(`${root}/sync`, { baseRevision, ...(draft ? { draft } : {}) }),
  }
}

const canvasApi = (root: string) => {
  return {
    get: () => api.get<{ canvas: CanvasBoard }>(root),
    save: (graph: CanvasGraph, baseRevision: number, scenePatch?: { sceneId: string; prompt?: string; dialogue?: string }) =>
      api.put<{ canvas: CanvasBoard }>(root, { graph, baseRevision, ...(scenePatch ? { scenePatch } : {}) }),
    runs: () => api.get<{ runs: CanvasRun[] }>(`${root}/runs`),
    resetTimelineGroup: (groupId: string, baseRevision: number) =>
      api.post<{ canvas: CanvasBoard }>(`${root}/groups/${encodeURIComponent(groupId)}/reset-timeline`, { baseRevision }),
    /** Ghép bố trí thành ảnh nguồn mới; backend chỉ đọc media nội bộ. */
    composite: (nodeId: string) =>
      api.post<{ upload: { id: string; url: string; width: number; height: number } }>(
        `${root}/nodes/${encodeURIComponent(nodeId)}/composite`, {},
      ),
    preview: (nodeId: string, kind: CanvasNodeKind) =>
      api.post<{ preview: CanvasPreview }>(`${root}/nodes/${encodeURIComponent(nodeId)}/preview`, { kind }),
    run: (nodeId: string, input: {
      kind: 'image' | 'video'
      stamp: string
      modelId?: string
      sceneId?: string | null
      idempotencyKey?: string
    }) => api.post<{ generation: Generation; run: CanvasRun }>(`${root}/nodes/${encodeURIComponent(nodeId)}/run`, input),
  }
}

export type { ModelInfo }
