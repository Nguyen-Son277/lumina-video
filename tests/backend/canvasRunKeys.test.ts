import { describe, expect, it } from 'vitest'
import { acknowledgeCanvasRun, canvasRunKey, type PendingCanvasRuns } from '../../src/components/canvas/runKeys'

describe('Canvas uncertain run retries', () => {
  it('reuses a key after an uncertain failure and rotates only on acknowledgement or stamp change', () => {
    const pending: PendingCanvasRuns = {}
    let count = 0
    const create = () => `key-${++count}`
    expect(canvasRunKey(pending, 'project:node', 'stamp', create)).toBe('key-1')
    expect(canvasRunKey(pending, 'project:node', 'stamp', create)).toBe('key-1')
    acknowledgeCanvasRun(pending, 'project:node', 'key-1')
    expect(canvasRunKey(pending, 'project:node', 'stamp', create)).toBe('key-2')
    expect(canvasRunKey(pending, 'project:node', 'new-stamp', create)).toBe('key-3')
    acknowledgeCanvasRun(pending, 'project:node', 'key-2')
    expect(canvasRunKey(pending, 'project:node', 'new-stamp', create)).toBe('key-3')
    expect(canvasRunKey(pending, 'other:node', 'new-stamp', create)).toBe('key-4')
  })
})
