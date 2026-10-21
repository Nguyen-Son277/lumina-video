import { beforeEach, describe, expect, it, vi } from 'vitest'

// Minimal hook host: state/ref cells survive explicit renders; no DOM or browser needed.
const host = vi.hoisted(() => ({ cells: [] as any[], cursor: 0, effects: [] as Array<() => unknown> }))
vi.mock('react', () => ({
  useState(initial: unknown) {
    const index = host.cursor++
    if (!(index in host.cells)) host.cells[index] = typeof initial === 'function' ? initial() : initial
    return [host.cells[index], (value: any) => { host.cells[index] = typeof value === 'function' ? value(host.cells[index]) : value }]
  },
  useRef(initial: unknown) {
    const index = host.cursor++
    if (!(index in host.cells)) host.cells[index] = { current: initial }
    return host.cells[index]
  },
  useEffect(effect: () => unknown) {
    const index = host.cursor++
    if (!(index in host.cells)) { host.cells[index] = true; host.effects.push(effect) }
  },
}))
const mocks = vi.hoisted(() => ({ generate: vi.fn(), illustrate: vi.fn(), get: vi.fn(), create: vi.fn() }))
vi.mock('../../src/api/endpoints', () => ({ characterApi: { generate: mocks.generate, illustrate: mocks.illustrate, create: mocks.create }, generationApi: { get: mocks.get }, uploadApi: { remove: vi.fn().mockResolvedValue(undefined) } }))
vi.mock('../../src/api/entityLibrary', () => ({ entityLibraryApi: { generate: mocks.generate, illustrate: mocks.illustrate } }))
// Runtime import deliberately avoids pulling browser-only globals into server tsc.
const hookPath = '../../src/components/entities/useEntityCreation'
interface TestCandidate {
  candidateId: string; imagePhase?: string; status: string; progress: number | null
  generationId?: string; assetUrl?: string; createdId?: string; issue?: { key?: string }
  draft: { input: { name: string } }
}
interface TestHook {
  candidates: TestCandidate[]; phase: string; running: boolean; activeCandidateIds: string[]
  summary: { completed: number; total: number; failed: number }
  generate: (input: Record<string, unknown>) => Promise<void>
  act: (id: string, action: string) => Promise<unknown>
  stop: () => void
}
const { useEntityCreation } = await import(hookPath) as { useEntityCreation: (options: { onSaved: () => void; confirmChanged: () => boolean }) => TestHook }

function render() {
  host.cursor = 0
  const result = useEntityCreation({ onSaved: vi.fn(), confirmChanged: () => true })
  for (const effect of host.effects.splice(0)) effect()
  return result
}
const input = { kind: 'character', description: 'Fox', count: 3, language: 'en', modelId: 'llm', imageModelId: 'image', size: '1024x1024', quality: '', includeImages: true, autoSave: false, sourceFile: null }
const draft = (name: string) => ({ name, appearance: 'Fox', voice: {} })
const generation = (id: string, status = 'succeeded') => ({ id, status, progress: null, assets: status === 'succeeded' ? [{ id: `asset-${id}`, url: `/image-${id}` }] : [] })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
async function tick() { for (let i = 0; i < 15; i++) await Promise.resolve() }
beforeEach(() => {
  host.cells = []; host.effects = []; host.cursor = 0
  vi.clearAllMocks()
  mocks.generate.mockResolvedValue({ candidates: [draft('One'), draft('Two'), draft('Three')] })
  mocks.get.mockImplementation(async (id: string) => ({ generation: generation(id) }))
})

describe('entity creation active loading and ordering', () => {
  it('shows two sending cards and one queued, counts only active image outcomes, then clears active IDs', async () => {
    const pending = [deferred<any>(), deferred<any>()]
    mocks.illustrate.mockReturnValueOnce(pending[0]!.promise).mockReturnValueOnce(pending[1]!.promise).mockResolvedValueOnce({ generation: generation('third') })
    const work = render().generate(input)
    expect(render().phase).toBe('text')
    await tick()
    let state = render()
    expect(state.phase).toBe('images')
    expect(state.candidates.map(candidate => candidate.imagePhase)).toEqual(['sending', 'sending', 'queued'])
    expect(state.summary).toEqual({ completed: 0, failed: 0, total: 3 })
    pending[0]!.resolve({ generation: generation('first') })
    await tick()
    state = render()
    expect(state.summary.completed).toBe(2)
    expect(state.candidates[1]!.imagePhase).toBe('sending')
    expect(state.activeCandidateIds).toHaveLength(3)
    pending[1]!.resolve({ generation: generation('second') })
    await work
    state = render()
    expect(state.running).toBe(false)
    expect(state.activeCandidateIds).toEqual([])
    expect(state.candidates.every(candidate => !candidate.imagePhase)).toBe(true)
  })

  it('stops queued/sending spinners while retaining late paid acceptance and reuses it on resume', async () => {
    const pending = deferred<any>()
    mocks.generate.mockResolvedValue({ candidates: [draft('One')] })
    mocks.illustrate.mockReturnValue(pending.promise)
    const work = render().generate(input)
    await tick()
    render().stop()
    expect(render().candidates[0]).toMatchObject({ status: 'stopped', imagePhase: undefined, progress: null })
    pending.resolve({ generation: generation('paid', 'queued') })
    await work
    let state = render()
    expect(state.running).toBe(false)
    expect(state.activeCandidateIds).toEqual([])
    expect(state.candidates[0]).toMatchObject({ generationId: 'paid', imagePhase: undefined, status: 'stopped' })
    await state.act(state.candidates[0]!.candidateId, 'resume')
    state = render()
    expect(mocks.illustrate).toHaveBeenCalledTimes(1)
    expect(state.candidates[0]).toMatchObject({ status: 'ready', assetUrl: '/image-paid', imagePhase: undefined })
  })

  it('prepends newest runs in stable internal order and puts new-image copies first', async () => {
    await render().generate({ ...input, includeImages: false })
    mocks.generate.mockResolvedValue({ candidates: [draft('New A'), draft('New B')] })
    await render().generate({ ...input, includeImages: false })
    let state = render()
    expect(state.candidates.map(candidate => candidate.draft.input.name)).toEqual(['New A', 'New B', 'One', 'Two', 'Three'])
    const originalId = state.candidates[3]!.candidateId
    mocks.illustrate.mockResolvedValue({ generation: generation('copy') })
    await state.act(originalId, 'new-image')
    state = render()
    expect(state.candidates[0]!.draft.input.name).toBe('Two')
    expect(state.candidates[0]!.candidateId).not.toBe(originalId)
    expect(state.candidates[4]!.candidateId).toBe(originalId)
    expect(state.candidates.map(candidate => candidate.draft.input.name)).toEqual(['Two', 'New A', 'New B', 'One', 'Two', 'Three'])
  })

  it('shows publishing indeterminate while counting its completed image, skips text for existing assets', async () => {
    const pending = deferred<any>()
    const asset = { id: 'existing', kind: 'item' as const, name: 'Item', handle: 'item', description: '', continuityNotes: '', revision: 1, reference: null }
    mocks.illustrate.mockReturnValue(pending.promise)
    const work = render().generate({ ...input, kind: 'item', existingEntity: asset })
    expect(render().phase).toBe('images')
    await tick()
    expect(mocks.generate).not.toHaveBeenCalled()
    render().stop()
    pending.resolve({ generation: generation('existing-image') })
    await work

    // Server publication is separate from image success and remains indeterminate.
    mocks.generate.mockResolvedValue({ candidates: [{ name: 'Item', handle: 'item', description: '', continuityNotes: '' }] })
    mocks.illustrate.mockResolvedValue({ generation: generation('publishing') })
    mocks.get.mockResolvedValue({ generation: { ...generation('publishing'), libraryPublishStatus: 'pending' } })
    vi.stubGlobal('window', { setTimeout, clearTimeout })
    const publishing = render().generate({ ...input, kind: 'item', autoSave: true })
    await tick()
    const state = render()
    expect(state.candidates[0]).toMatchObject({ imagePhase: 'publishing', progress: null })
    expect(state.summary).toEqual({ completed: 1, failed: 0, total: 1 })
    state.stop()
    await publishing
    vi.unstubAllGlobals()
  })

  it('exposes save phase through pending metadata write without regressing after stop', async () => {
    const pending = deferred<any>()
    mocks.generate.mockResolvedValue({ candidates: [draft('One')] })
    mocks.illustrate.mockResolvedValue({ generation: generation('ready') })
    mocks.create.mockReturnValue(pending.promise)
    const work = render().generate({ ...input, autoSave: true })
    await tick()
    let state = render()
    expect(state.phase).toBe('save')
    expect(state.candidates[0]!.imagePhase).toBe('saving')
    expect(state.summary).toEqual({ completed: 1, failed: 0, total: 1 })
    state.stop()
    pending.resolve({ character: { id: 'accepted-character' } })
    await work
    state = render()
    expect(state.phase).toBe('idle')
    expect(state.candidates[0]).toMatchObject({ createdId: 'accepted-character', imagePhase: undefined, status: 'stopped' })
  })

  it('times out indeterminate generation without leaving card or global spinners', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', { setTimeout, clearTimeout })
    try {
      mocks.generate.mockResolvedValue({ candidates: [draft('Slow')] })
      mocks.illustrate.mockResolvedValue({ generation: generation('slow', 'queued') })
      mocks.get.mockResolvedValue({ generation: generation('slow', 'running') })
      const work = render().generate(input)
      await tick()
      expect(render().candidates[0]).toMatchObject({ imagePhase: 'generating', progress: null })
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 1500)
      await work
      const state = render()
      expect(state.phase).toBe('idle')
      expect(state.activeCandidateIds).toEqual([])
      expect(state.candidates[0]).toMatchObject({ status: 'error', imagePhase: undefined, issue: { key: 'aiTimeout' } })
    } finally { vi.useRealTimers(); vi.unstubAllGlobals() }
  })

  it('does not count failed jobs as completed or old cards in active summary', async () => {
    await render().generate({ ...input, includeImages: false })
    const pending = deferred<any>()
    mocks.generate.mockResolvedValue({ candidates: [draft('Bad'), draft('Pending')] })
    mocks.illustrate.mockRejectedValueOnce(new Error('No image')).mockReturnValueOnce(pending.promise)
    const work = render().generate(input)
    await tick()
    expect(render().summary).toEqual({ completed: 0, failed: 1, total: 2 })
    render().stop()
    pending.resolve({ generation: generation('late') })
    await work
  })
})
