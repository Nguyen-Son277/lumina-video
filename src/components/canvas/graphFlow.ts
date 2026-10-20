import type { Edge, Node } from '@xyflow/react'
import { CANVAS_SCHEMA_VERSION, type CanvasGraph, type CanvasGroup, type CanvasNode } from '../../../shared/canvas'

export type FlowNode = Node<{ node: CanvasNode; group?: CanvasGroup }>

/** Group nodes are presentation-only. Stored member positions are always absolute. */
export function toFlow(graph: CanvasGraph): { nodes: FlowNode[]; edges: Edge[] } {
  const groups = new Map((graph.groups ?? []).map(group => [group.id, group]))
  return {
    nodes: [
      ...(graph.groups ?? []).map((group): FlowNode => ({
        id: group.id, type: 'canvasGroup', position: { x: group.x, y: group.y },
        style: { width: group.width, height: group.height },
        deletable: false, zIndex: -1,
        data: { group, node: { id: group.id, kind: 'note', x: group.x, y: group.y, data: {} } },
      })),
      ...graph.nodes.map((node): FlowNode => {
        const group = node.groupId ? groups.get(node.groupId) : undefined
        return { id: node.id, type: node.kind,
          position: { x: node.x - (group?.x ?? 0), y: node.y - (group?.y ?? 0) },
          ...(group ? { parentId: group.id } : {}), data: { node } }
      }),
    ],
    edges: graph.edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, sourceHandle: edge.sourcePort, targetHandle: edge.targetPort, ...(edge.autoMention ? { data: { autoMention: true } } : {}) })),
  }
}

export function toGraph(nodes: FlowNode[], edges: Edge[]): CanvasGraph {
  const parents = new Map(nodes.filter(node => node.data.group).map(node => [node.id, node]))
  const groups = [...parents.values()].map(node => ({ ...node.data.group!, x: node.position.x, y: node.position.y,
    width: typeof node.style?.width === 'number' ? node.style.width : node.data.group!.width,
    height: typeof node.style?.height === 'number' ? node.style.height : node.data.group!.height }))
  return {
    schemaVersion: CANVAS_SCHEMA_VERSION,
    ...(groups.length ? { groups } : {}),
    nodes: nodes.filter(node => !node.data.group).map(node => {
      const parent = node.parentId ? parents.get(node.parentId) : undefined
      const { groupId: _previousGroupId, ...stored } = node.data.node
      return { ...stored, id: node.id,
        x: node.position.x + (parent?.position.x ?? 0), y: node.position.y + (parent?.position.y ?? 0),
        ...(parent ? { groupId: parent.id } : {}) }
    }),
    edges: edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, sourcePort: edge.sourceHandle ?? '', targetPort: edge.targetHandle ?? '', ...(edge.data?.autoMention ? { autoMention: true } : {}) })),
  }
}
