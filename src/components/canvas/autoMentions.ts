import { CANVAS_LIMITS, type CanvasGraph, type CanvasNode } from '../../../shared/canvas'
import type { EntityRef } from '../../../shared/promptMentions'

const identity = (ref: EntityRef) => `${ref.kind}:${ref.id}:${ref.viewUploadId ?? ''}`
const nodeIdentity = (node: CanvasNode): string | null => {
  if (!node.data.sourceId) return null
  if (node.kind === 'character') return identity({ kind: 'character', id: node.data.sourceId })
  if (node.kind === 'library' && node.data.entityKind) return identity({ kind: node.data.entityKind, id: node.data.sourceId, ...(node.data.entityKind === 'location' && node.data.uploadId ? { viewUploadId: node.data.uploadId } : {}) })
  return null
}

/** Report mentions that cannot materialize under graph capacity limits. */
export function mentionGraphIssues(graph: CanvasGraph): string[] {
  const issues = new Set<string>()
  for (const prompt of graph.nodes.filter(node => node.kind === 'prompt')) {
    const targets = graph.edges.filter(edge => edge.source === prompt.id && edge.sourcePort === 'prompt' && edge.targetPort === 'prompt')
      .map(edge => graph.nodes.find(node => node.id === edge.target)).filter(node => node?.kind === 'image' || node?.kind === 'video')
    for (const mention of prompt.data.promptDocument?.mentions ?? []) {
      const source = graph.nodes.find(node => nodeIdentity(node) === identity(mention.entity))
      if (!source || targets.some(target => target && !graph.edges.some(edge => edge.source === source.id && edge.target === target.id && edge.targetPort === 'context'))) issues.add(mention.label)
    }
  }
  return [...issues]
}

/** Derive only managed context edges. Manual edges, orphan nodes and their positions survive. */
export function reconcileMentionGraph(graph: CanvasGraph, quick = false): CanvasGraph {
  const nodes = [...graph.nodes]
  const edges = graph.edges.filter(edge => !edge.autoMention)
  const byIdentity = new Map<string, CanvasNode>()
  for (const node of nodes) {
    const key = nodeIdentity(node)
    if (key && !byIdentity.has(key)) byIdentity.set(key, node)
  }
  for (const prompt of graph.nodes.filter(node => node.kind === 'prompt')) {
    const targets = graph.edges.filter(edge => edge.source === prompt.id && edge.sourcePort === 'prompt' && edge.targetPort === 'prompt')
      .map(edge => nodes.find(node => node.id === edge.target)).filter(node => node?.kind === 'image' || node?.kind === 'video')
    for (const mention of prompt.data.promptDocument?.mentions ?? []) {
      const ref = mention.entity
      const key = identity(ref)
      let source = byIdentity.get(key)
      if (!source) {
        if (nodes.length >= CANVAS_LIMITS.nodes) continue
        let id = `mention-${encodeURIComponent(key)}`
        while (nodes.some(node => node.id === id)) id += '-auto'
        // Keep automatically materialized cards far enough apart for the compact
        // preview (including its thumbnail and actions) to remain clickable.
        source = { id, kind: ref.kind === 'character' ? 'character' : 'library', x: prompt.x - 320, y: prompt.y + byIdentity.size * 360,
          autoMention: true, data: { sourceId: ref.id, ...(ref.kind !== 'character' ? { entityKind: ref.kind } : {}),
            ...(ref.viewUploadId ? { uploadId: ref.viewUploadId } : {}), ...(quick && ref.kind === 'logo' ? { logoPosition: 'top-right' } : {}) } }
        nodes.push(source)
        byIdentity.set(key, source)
      }
      for (const target of targets) {
        if (!target || edges.some(edge => edge.source === source.id && edge.target === target.id && edge.targetPort === 'context')) continue
        if (edges.length >= CANVAS_LIMITS.edges || edges.filter(edge => edge.target === target.id && edge.targetPort === 'context').length >= CANVAS_LIMITS.contextInputs) continue
        const previous = graph.edges.find(edge => edge.autoMention && edge.source === source.id && edge.target === target.id && edge.targetPort === 'context')
        edges.push(previous ?? { id: `mention-edge-${source.id}-${target.id}`, source: source.id, sourcePort: 'object', target: target.id, targetPort: 'context', autoMention: true })
      }
    }
  }
  return { ...graph, nodes, edges }
}
