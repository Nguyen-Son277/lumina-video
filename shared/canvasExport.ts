export type CanvasExportScope = { projectId: string; quickSessionId?: never } | { projectId?: never; quickSessionId: string }

export type CanvasExportItem = {
  nodeId: string
  label: string
  runId: string | null
  generationId: string | null
  assetId: string | null
  fallback: boolean
  issue: 'missing_video' | 'media_missing' | 'logo_pending' | null
}

export type CanvasExportPreview = {
  nodeId: string
  revision: number
  stamp: string
  ready: boolean
  items: CanvasExportItem[]
}

export type CanvasChainExportSpec = {
  source: 'canvas-chain'
  nodeId: string
  revision: number
  items: Array<{ nodeId: string; label: string; runId: string; generationId: string; assetId: string }>
}
