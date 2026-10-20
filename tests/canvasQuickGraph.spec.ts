import { expect, test } from '@playwright/test'
import { mentionGraphIssues, reconcileMentionGraph } from '../src/components/canvas/autoMentions'
import { toFlow, toGraph } from '../src/components/canvas/graphFlow'
import { validateCanvasGraph, type CanvasGraph } from '../shared/canvas'

const fixture = (): CanvasGraph => ({ schemaVersion: 1, nodes: [
  { id: 'p', kind: 'prompt', x: 400, y: 0, data: { promptDocument: { version: 1, text: '@brand @place', mentions: [
    { id: 'b', start: 0, end: 6, label: 'brand', entity: { kind: 'logo', id: 'brand' } },
    { id: 'l', start: 7, end: 13, label: 'place', entity: { kind: 'location', id: 'place', viewUploadId: 'view-a' } },
  ] } } },
  { id: 'i', kind: 'image', x: 800, y: 0, data: {} },
  { id: 'v', kind: 'video', x: 800, y: 400, data: {} },
], edges: [
  { id: 'pi', source: 'p', sourcePort: 'prompt', target: 'i', targetPort: 'prompt' },
  { id: 'pv', source: 'p', sourcePort: 'prompt', target: 'v', targetPort: 'prompt' },
] })

test('quick mentions create deduplicated nodes and context edges and preserve IDs, views and positions', () => {
  const graph = reconcileMentionGraph(fixture(), true)
  expect(graph.nodes).toHaveLength(5)
  expect(graph.edges.filter(edge => edge.autoMention)).toHaveLength(4)
  const location = graph.nodes.find(node => node.data.entityKind === 'location')!
  expect(location.data.uploadId).toBe('view-a')
  location.x = -100
  expect(graph.nodes.find(node => node.data.entityKind === 'logo')!.data.logoPosition).toBe('top-right')
  const flow = toFlow(graph)
  const roundTrip = toGraph(flow.nodes, flow.edges)
  expect(reconcileMentionGraph(roundTrip, true)).toEqual(roundTrip)
  expect(roundTrip.nodes.find(node => node.id === location.id)!.x).toBe(-100)
  expect(validateCanvasGraph(roundTrip)).toEqual([])
})

test('mention deletion removes only managed edges; manual edges and nodes survive', () => {
  const graph = reconcileMentionGraph(fixture(), true)
  const logo = graph.nodes.find(node => node.data.entityKind === 'logo')!
  graph.edges = graph.edges.map(edge => edge.source === logo.id && edge.target === 'i' ? { ...edge, autoMention: undefined } : edge)
  graph.nodes[0]!.data.promptDocument!.mentions = []
  const next = reconcileMentionGraph(graph, true)
  expect(next.nodes).toEqual(graph.nodes)
  expect(next.edges.filter(edge => edge.autoMention)).toHaveLength(0)
  expect(next.edges.some(edge => edge.source === logo.id && edge.target === 'i')).toBe(true)
})

test('same location with different pinned views is distinct and old logo defaults remain AI', () => {
  const graph = fixture()
  graph.nodes.push({ id: 'logo', kind: 'library', x: 2, y: 2, data: { sourceId: 'brand', entityKind: 'logo' } })
  graph.nodes[0]!.data.promptDocument!.mentions.push({ id: 'l2', start: 7, end: 13, label: 'place', entity: { kind: 'location', id: 'place', viewUploadId: 'view-b' } })
  const next = reconcileMentionGraph(graph, true)
  expect(next.nodes.find(node => node.id === 'logo')!.data.logoPosition).toBeUndefined()
  expect(next.nodes.filter(node => node.data.entityKind === 'location')).toHaveLength(2)
  expect(next.nodes.filter(node => node.data.entityKind === 'logo')).toHaveLength(1)
})

test('mentions exceeding context capacity are reported rather than silently omitted', () => {
  const graph = fixture()
  for (let index = 0; index < 12; index++) {
    graph.nodes.push({ id: `manual-${index}`, kind: 'character', x: 0, y: 0, data: { sourceId: `character-${index}` } })
    graph.edges.push({ id: `manual-edge-${index}`, source: `manual-${index}`, sourcePort: 'object', target: 'i', targetPort: 'context' })
  }
  const next = reconcileMentionGraph(graph, true)
  expect(mentionGraphIssues(next)).toEqual(['brand', 'place'])
  expect(next.edges.filter(edge => edge.target === 'i' && edge.targetPort === 'context')).toHaveLength(12)
})

test('shared graph validation accepts settings and rejects malformed optional metadata', () => {
  const graph = fixture()
  graph.nodes[1]!.data = { imageSettings: { size: '1024x1024', quality: 'high', n: 2 }, logoPosition: 'center', logoWidth: 0.2, logoOpacity: 0.8 }
  expect(validateCanvasGraph(graph)).toEqual([])
  graph.nodes[1]!.data.logoWidth = 2
  expect(validateCanvasGraph(graph)).toContainEqual({ code: 'graph_invalid', id: 'i' })
})
