import { validateCanvasGraph, type CanvasEdge, type CanvasGraph, type CanvasNode } from './canvas'

/** Ordering connections are presentation/export data, never generation inputs. */
export const isSequenceEdge = (edge: CanvasEdge): boolean => edge.sourcePort === 'video' && edge.targetPort === 'sequence'

export function canConnectCanvas(graph: CanvasGraph, edge: CanvasEdge): boolean {
  return validateCanvasGraph({ ...graph, edges: [...graph.edges, edge] }).length === 0
}

/** Resolve the entire component, even when the selected video is in the middle. */
export function canvasVideoChain(graph: CanvasGraph, nodeId: string): CanvasNode[] {
  const videos = new Map(graph.nodes.filter(node => node.kind === 'video').map(node => [node.id, node]))
  if (!videos.has(nodeId)) throw new Error('sequence_node_missing')
  const before = new Map<string, string>(), after = new Map<string, string>()
  for (const edge of graph.edges.filter(isSequenceEdge)) {
    if (!videos.has(edge.source) || !videos.has(edge.target) || after.has(edge.source) || before.has(edge.target)) throw new Error('sequence_invalid')
    before.set(edge.target, edge.source)
    after.set(edge.source, edge.target)
  }
  let head = nodeId
  const visited = new Set<string>()
  while (before.has(head)) {
    if (visited.has(head)) throw new Error('sequence_invalid')
    visited.add(head)
    head = before.get(head)!
  }
  const chain: CanvasNode[] = []
  visited.clear()
  let current: string | undefined = head
  while (current) {
    if (visited.has(current)) throw new Error('sequence_invalid')
    visited.add(current)
    chain.push(videos.get(current)!)
    current = after.get(current)
  }
  return chain
}

export function canvasVideoChains(graph: CanvasGraph): CanvasNode[][] {
  const visited = new Set<string>(), chains: CanvasNode[][] = []
  for (const video of graph.nodes.filter(node => node.kind === 'video')) {
    if (visited.has(video.id)) continue
    const chain = canvasVideoChain(graph, video.id)
    chain.forEach(node => visited.add(node.id))
    chains.push(chain)
  }
  return chains
}

/** Truncate display text without splitting emoji or Vietnamese combining marks. */
export function canvasTextPreview(value: string, limit = 160): string {
  const text = value.replace(/\s+/gu, ' ').trim()
  type Segment = { segment: string }
  type SegmenterLike = { segment: (input: string) => Iterable<Segment> }
  type IntlWithSegmenter = typeof Intl & { Segmenter?: new (locale?: string, options?: { granularity: 'grapheme' }) => SegmenterLike }
  const Segmenter = (Intl as IntlWithSegmenter).Segmenter
  const characters = Segmenter
    ? Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(text), part => part.segment)
    // Fallback still keeps combining marks with their base character.
    : (text.match(/\P{Mark}\p{Mark}*/gu) ?? Array.from(text))
  return characters.length <= limit ? text : `${characters.slice(0, Math.max(0, limit - 1)).join('')}…`
}

export function canvasVideoTitle(graph: CanvasGraph, node: CanvasNode): string {
  const sourceId = graph.edges.find(edge => edge.target === node.id && edge.targetPort === 'prompt')?.source
  const prompt = graph.nodes.find(entry => entry.id === sourceId)
  return canvasTextPreview(prompt?.data.promptDocument?.text ?? prompt?.data.text ?? '', 80) || node.id
}
