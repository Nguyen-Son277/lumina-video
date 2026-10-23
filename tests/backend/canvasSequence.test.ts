import { describe, expect, it } from 'vitest'
import { validateCanvasGraph, type CanvasGraph } from '../../shared/canvas'
import { canvasTextPreview, canvasVideoChain, canvasVideoChains, canConnectCanvas } from '../../shared/canvasSequence'
import { canvasStamp } from '../../server/canvas/service'
import { compileCanvasPrompt } from '../../server/canvas/compiler'

const videoGraph = (edges: CanvasGraph['edges'] = []): CanvasGraph => ({
  schemaVersion: 1,
  nodes: ['a', 'b', 'c'].map((id, index) => ({ id, kind: 'video' as const, x: index * 300, y: 0, data: {} })),
  edges,
})

describe('Canvas video sequence', () => {
  it('orders a chain from its head when selecting a middle node', () => {
    const graph = videoGraph([
      { id: 'ab', source: 'a', sourcePort: 'video', target: 'b', targetPort: 'sequence' },
      { id: 'bc', source: 'b', sourcePort: 'video', target: 'c', targetPort: 'sequence' },
    ])
    expect(canvasVideoChain(graph, 'b').map(node => node.id)).toEqual(['a', 'b', 'c'])
    expect(canvasVideoChains(graph)).toHaveLength(1)
  })

  it('rejects a branch, loop, duplicate outgoing link and wrong port', () => {
    const graph = videoGraph([{ id: 'ab', source: 'a', sourcePort: 'video', target: 'b', targetPort: 'sequence' }])
    expect(canConnectCanvas(graph, { id: 'ac', source: 'a', sourcePort: 'video', target: 'c', targetPort: 'sequence' })).toBe(false)
    expect(canConnectCanvas(graph, { id: 'ca', source: 'c', sourcePort: 'video', target: 'a', targetPort: 'sequence' })).toBe(true)
    const closed = videoGraph([
      { id: 'ab', source: 'a', sourcePort: 'video', target: 'b', targetPort: 'sequence' },
      { id: 'bc', source: 'b', sourcePort: 'video', target: 'c', targetPort: 'sequence' },
      { id: 'ca', source: 'c', sourcePort: 'video', target: 'a', targetPort: 'sequence' },
    ])
    expect(validateCanvasGraph(closed).some(issue => issue.code === 'edge_cycle')).toBe(true)
    expect(canConnectCanvas(graph, { id: 'wrong', source: 'a', sourcePort: 'video', target: 'b', targetPort: 'prompt' })).toBe(false)
    expect(canConnectCanvas(graph, { id: 'self', source: 'a', sourcePort: 'video', target: 'a', targetPort: 'sequence' })).toBe(false)
    expect(canConnectCanvas(graph, { ...graph.edges[0]!, id: 'duplicate' })).toBe(false)
    expect(canConnectCanvas(graph, { id: 'merge', source: 'c', sourcePort: 'video', target: 'b', targetPort: 'sequence' })).toBe(false)
  })

  it('keeps single clips separate and sequence links out of generation prompts and stamps', () => {
    const graph = videoGraph()
    graph.nodes.push({ id: 'prompt', kind: 'prompt', x: 0, y: 0, data: { text: 'Camera pan' } })
    graph.edges.push({ id: 'pb', source: 'prompt', sourcePort: 'prompt', target: 'b', targetPort: 'prompt' })
    expect(canvasVideoChains(graph).map(chain => chain.map(node => node.id))).toEqual([['a'], ['b'], ['c']])
    const connected = { ...graph, edges: [...graph.edges, { id: 'ab', source: 'a', sourcePort: 'video', target: 'b', targetPort: 'sequence' }] }
    const compile = (board: CanvasGraph) => compileCanvasPrompt({ graph: board, node: board.nodes[1]!, objects: [] })
    expect(compile(connected)).toEqual(compile(graph))
    expect(canvasStamp(connected, 'b')).toBe(canvasStamp(graph, 'b'))
    expect(canvasStamp(connected, 'a')).toBe(canvasStamp(graph, 'a'))
  })

  it('truncates Unicode without changing the stored text', () => {
    const input = `${'😀'.repeat(100)} ${'a\u0301'.repeat(100)}`
    const output = canvasTextPreview(input)
    expect((output.match(/\P{Mark}\p{Mark}*/gu) ?? []).length).toBeLessThanOrEqual(160)
    expect(output.endsWith('…')).toBe(true)
    expect(output.endsWith('a\u0301…')).toBe(true)
  })
})
