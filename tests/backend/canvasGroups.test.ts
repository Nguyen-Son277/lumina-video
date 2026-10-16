import { describe, expect, it } from 'vitest'
import { CANVAS_LIMITS, validateCanvasGraph, type CanvasGraph, type CanvasGroup } from '../../shared/canvas'
import { toFlow, toGraph } from '../../src/components/canvas/graphFlow'

const group = (): CanvasGroup => ({ id: 'frame-group', title: 'Opening frame', sceneId: 'scene', x: 100, y: 200, width: 900, height: 700, timeline: { sessionId: 'session', frameId: 'frame', conflicts: ['prompt.text'] } })
const graph = (): CanvasGraph => ({ schemaVersion: 1, groups: [group()], nodes: [{ id: 'prompt', kind: 'prompt', groupId: 'frame-group', x: 150, y: 300, data: { text: 'Hello' } }], edges: [] })

describe('Canvas presentation groups', () => {
  it('accepts optional groups and legacy ungrouped graphs', () => {
    expect(validateCanvasGraph(graph())).toEqual([])
    expect(validateCanvasGraph({ schemaVersion: 1, nodes: [], edges: [] })).toEqual([])
    expect(CANVAS_LIMITS).toMatchObject({ nodes: 2000, edges: 5000 })
  })
  it('rejects malformed containers and timeline metadata', () => {
    for (const patch of [{ width: 0 }, { height: -1 }, { x: Infinity }, { y: NaN }, { title: null }, { timeline: { sessionId: 's' } }, { timeline: { sessionId: 's', frameId: 'f', conflicts: [42] } }]) {
      expect(validateCanvasGraph({ ...graph(), groups: [{ ...group(), ...patch }] }).some(issue => issue.code === 'group_invalid')).toBe(true)
    }
    expect(validateCanvasGraph({ ...graph(), groups: {} }).some(issue => issue.code === 'group_invalid')).toBe(true)
  })
  it('rejects missing memberships, duplicate IDs, and group edge endpoints', () => {
    const value = graph()
    value.nodes[0]!.groupId = 'missing'
    expect(validateCanvasGraph(value)).toContainEqual({ code: 'node_group_missing', id: 'prompt' })
    expect(validateCanvasGraph({ ...graph(), groups: [group(), group()] })).toContainEqual({ code: 'group_duplicate', id: 'frame-group' })
    const collision = graph(); collision.nodes[0]!.id = 'frame-group'
    expect(validateCanvasGraph(collision)).toContainEqual({ code: 'group_duplicate', id: 'frame-group' })
    expect(validateCanvasGraph({ ...graph(), edges: [{ id: 'edge', source: 'frame-group', sourcePort: 'prompt', target: 'prompt', targetPort: 'prompt' }] })).toContainEqual({ code: 'edge_endpoint_missing', id: 'edge' })
  })
  it('round trips group metadata and absolute positions through history/autosave conversion', () => {
    const value = graph()
    const flow = toFlow(value)
    expect(flow.nodes[0]!.type).toBe('canvasGroup')
    expect(flow.nodes[1]).toMatchObject({ parentId: 'frame-group', position: { x: 50, y: 100 } })
    expect(toGraph(flow.nodes, flow.edges)).toEqual(value)
    flow.nodes[0]!.position.x += 80
    expect(toGraph(flow.nodes, flow.edges)).toMatchObject({ groups: [{ x: 180 }], nodes: [{ x: 230, y: 300 }] })
  })
  it('keeps members outside group bounds and drops removed parent memberships', () => {
    const flow = toFlow(graph())
    flow.nodes[1]!.position = { x: -400, y: 1200 }
    expect(toGraph(flow.nodes, flow.edges).nodes[0]).toMatchObject({ x: -300, y: 1400, groupId: 'frame-group' })
    flow.nodes[1]!.parentId = undefined
    const ungrouped = toGraph(flow.nodes.slice(1), flow.edges)
    expect(ungrouped.nodes[0]).not.toHaveProperty('groupId')
    expect(validateCanvasGraph(ungrouped)).toEqual([])
  })
  it('preserves video input and explicit consent extensions', () => {
    const value = graph(); value.nodes[0]!.data = { videoInputNodeId: 'image', allowTemporaryMedia: true }
    const flow = toFlow(value)
    expect(toGraph(flow.nodes, flow.edges)).toEqual(value)
  })
})
