import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, type Database } from '../../server/db'
import { readCanvas, writeCanvas, assertSourceNotLinked, removeCanvasSourceNodes } from '../../server/canvas/service'
import { registerTimelineCanvas, resetTimelineGroup, syncTimelineSession, withTimelineSync } from '../../server/canvas/timelineSync'
import { setStatus } from '../../server/planner/service'

let db: Database
const frame = (id = 'f1', action = 'Walk') => ({ id, title: 'Scene', action, context: 'Outside', dialogue: '', durationSeconds: 5, characters: [], speaker: '', speakerCastId: null, blocking: [], beats: '', shotNotes: '' })
function setup() {
  db = openDatabase(':memory:')
  db.prepare('INSERT INTO users(id,email,password_hash,password_salt,created_at) VALUES(?,?,?,?,?)').run('u','sync@test.invalid','x','x',1)
  db.prepare("INSERT INTO projects(id,user_id,name,description,style,language,archived,created_at,updated_at) VALUES('p','u','Project','','','vi',0,1,1)").run()
  db.prepare("INSERT INTO plan_sessions(id,user_id,kind,title,status,cast_json,locations_json,timeline_json,created_at,updated_at) VALUES('s','u','planner','Plan','timeline_ready','[]','[]',?,1,1)").run(JSON.stringify({ frames: [frame()] }))
  registerTimelineCanvas(db, { sessionId: 's', userId: 'u', projectId: 'p', frames: [], characters: [], locations: [] })
  return readCanvas(db,'u','p')
}
const update = (frames: ReturnType<typeof frame>[]) => setStatus(db,'s','timeline_ready',{ timelineJson: JSON.stringify({ frames }) })
afterEach(() => db?.close())

describe('persistent timeline canvas synchronization', () => {
  it('creates grouped graph, does not revise no-ops and leaves legacy unrelated graphs untouched', () => {
    const initial = setup()
    expect(initial.graph.groups).toHaveLength(1)
    expect(initial.graph.nodes.map(node => node.kind)).toEqual(['video','prompt'])
    syncTimelineSession(db,'s')
    expect(readCanvas(db,'u','p').revision).toBe(initial.revision)
    expect(db.prepare('SELECT COUNT(*) AS n FROM scenes').get()).toMatchObject({ n: 1 })
    syncTimelineSession(db,'unknown-legacy')
    expect(readCanvas(db,'u','p').revision).toBe(initial.revision)
  })

  it('merges source changes preserving local positions, custom nodes/edges, model choices and scene overrides', () => {
    const initial = setup(), graph = initial.graph
    const prompt = graph.nodes.find(node => node.kind === 'prompt')!
    prompt.x = 999
    prompt.data = { text: 'Canvas override', promptDocument: { version: 1, text: 'Canvas override', mentions: [] } }
    graph.nodes.find(node => node.kind === 'video')!.data.modelId = 'local-model'
    graph.nodes.push({ id: 'custom', kind: 'note', x: 1, y: 2, data: { text: 'Keep me' } })
    writeCanvas(db,'u','p',{ graph, baseRevision: initial.revision, scenePatch: { sceneId: graph.groups![0]!.sceneId!, dialogue: 'Canvas dialogue' } })
    update([{ ...frame('f1','Run'), dialogue: 'Timeline dialogue' }])
    const merged = readCanvas(db,'u','p')
    expect(merged.graph.nodes.find(node => node.id === prompt.id)).toMatchObject({ x: 999, data: { text: 'Canvas override' } })
    expect(merged.graph.nodes.find(node => node.id === 'custom')).toBeDefined()
    expect(merged.graph.nodes.find(node => node.kind === 'video')!.data.modelId).toBe('local-model')
    expect(merged.graph.groups![0]!.timeline!.conflicts).toContain('scene.dialogue')
    expect(db.prepare('SELECT dialogue FROM scenes').get()).toMatchObject({ dialogue: 'Canvas dialogue' })
  })

  it('records user deletion tombstones, detaches deleted frames, and explicit reset restores generated content only', () => {
    const initial = setup(), graph = initial.graph
    const promptId = graph.nodes.find(node => node.kind === 'prompt')!.id
    graph.nodes = graph.nodes.filter(node => node.id !== promptId)
    graph.edges = []
    graph.nodes.push({ id: 'custom', kind: 'note', x: 3, y: 4, data: {} })
    writeCanvas(db,'u','p',{ graph, baseRevision: initial.revision })
    update([frame('f1','Run')])
    let canvas = readCanvas(db,'u','p')
    expect(canvas.graph.nodes.some(node => node.id === promptId)).toBe(false)
    update([])
    canvas = readCanvas(db,'u','p')
    expect(canvas.graph.groups![0]!.timeline!.detached).toBe(true)
    expect(canvas.graph.nodes.some(node => node.id === 'custom')).toBe(true)
    update([frame('f1','Return')])
    canvas = readCanvas(db,'u','p')
    const reset = resetTimelineGroup(db,'u','p',canvas.graph.groups![0]!.id,canvas.revision).canvas
    expect(reset.graph.nodes.some(node => node.id === promptId)).toBe(true)
    expect(reset.graph.nodes.some(node => node.id === 'custom')).toBe(true)
    expect(reset.graph.groups![0]!.timeline!.conflicts).toBeUndefined()
    expect(() => resetTimelineGroup(db,'u','p',reset.graph.groups![0]!.id,0)).toThrow()
  })

  it('indexes group scene references without a video node and detaches metadata during forced removal', () => {
    const initial = setup(), graph = initial.graph, sceneId = graph.groups![0]!.sceneId!
    const videoId = graph.nodes.find(node => node.kind === 'video')!.id
    graph.nodes = graph.nodes.filter(node => node.id !== videoId)
    graph.edges = graph.edges.filter(edge => edge.target !== videoId)
    writeCanvas(db,'u','p',{ graph, baseRevision: initial.revision })
    expect(() => assertSourceNotLinked(db,'scene_id',sceneId,'linked')).toThrow('linked')
    expect(removeCanvasSourceNodes(db,'p','u','scene_id',sceneId)).toBe(1)
    db.prepare('DELETE FROM scenes WHERE id=?').run(sceneId)
    const cleaned = readCanvas(db,'u','p')
    expect(cleaned.graph.groups![0]!.sceneId).toBeUndefined()
    expect(cleaned.graph.groups![0]!.timeline!.detached).toBe(true)
    update([frame('f1','New source change')])
    const latest = readCanvas(db,'u','p')
    expect(() => writeCanvas(db,'u','p',{ graph: latest.graph, baseRevision: latest.revision })).not.toThrow()
    expect(db.prepare('SELECT COUNT(*) AS n FROM scenes').get()).toMatchObject({ n: 0 })
  })

  it('joins outer transactions and rolls artifacts and graph back atomically on failure', () => {
    const initial = setup()
    db.exec('BEGIN')
    update([frame('f1','Changed')])
    expect(db.isTransaction).toBe(true)
    db.exec('ROLLBACK')
    expect(readCanvas(db,'u','p').revision).toBe(initial.revision)
    expect(() => withTimelineSync(db,'s',() => {
      db.prepare("UPDATE plan_sessions SET title='failed' WHERE id='s'").run()
      throw new Error('failure')
    })).toThrow('failure')
    expect(db.prepare("SELECT title FROM plan_sessions WHERE id='s'").get()).toMatchObject({ title: 'Plan' })
  })

  it('updates ordered scene cast for new frames and speaker/blocking changes without mutating reused identities', () => {
    setup()
    const cast = [{ id: 'a', name: 'A', appearance: 'A design', voice: {}, storage: 'project' }, { id: 'b', name: 'B', appearance: 'B design', voice: {}, storage: 'project' }]
    db.prepare('UPDATE plan_sessions SET cast_json=? WHERE id=?').run(JSON.stringify(cast),'s')
    const first = { ...frame(), speakerCastId: 'a', blocking: [{ castId: 'a', position: 'left', action: 'walk', expression: '' }] }
    update([first as any])
    const a = db.prepare("SELECT target_id FROM timeline_canvas_entities WHERE source_id='a'").get() as { target_id: string }
    expect(db.prepare('SELECT character_id FROM scene_characters').all()).toEqual([{ character_id: a.target_id }])
    update([{ ...first, speakerCastId: 'b', blocking: [{ castId: 'b', position: 'right', action: 'run', expression: '' }] } as any, { ...frame('f2'), speakerCastId: 'b', blocking: [] } as any])
    const b = db.prepare("SELECT target_id FROM timeline_canvas_entities WHERE source_id='b'").get() as { target_id: string }
    expect(db.prepare('SELECT character_id FROM scene_characters').all()).toEqual([{ character_id: b.target_id }, { character_id: b.target_id }])
  })

  it('clones an explicitly reused library character on design edits rather than mutating its identity', () => {
    setup()
    db.prepare("INSERT INTO characters(id,user_id,project_id,name,appearance,voice_json,created_at,updated_at) VALUES('library','u',NULL,'Original','original','{}',1,1)").run()
    const cast = [{ id: 'reuse', name: 'Original', appearance: 'original', voice: {}, reuseCharacterId: 'library' }]
    db.prepare('UPDATE plan_sessions SET cast_json=? WHERE id=?').run(JSON.stringify(cast),'s')
    update([{ ...frame(), speakerCastId: 'reuse' } as any])
    expect(db.prepare("SELECT target_id FROM timeline_canvas_entities WHERE source_id='reuse'").get()).toMatchObject({ target_id: 'library' })
    cast[0]!.appearance = 'new design'
    setStatus(db,'s','timeline_ready',{ castJson: JSON.stringify(cast) })
    const mapping = db.prepare("SELECT target_id FROM timeline_canvas_entities WHERE source_id='reuse'").get() as { target_id: string }
    expect(mapping.target_id).not.toBe('library')
    expect(db.prepare("SELECT appearance FROM characters WHERE id='library'").get()).toMatchObject({ appearance: 'original' })
    expect(db.prepare('SELECT appearance,project_id FROM characters WHERE id=?').get(mapping.target_id)).toMatchObject({ appearance: 'new design', project_id: 'p' })
  })

  it('preserves generated nodes referenced by custom canvas edges and layouts after source removal', () => {
    setup()
    db.prepare('UPDATE plan_sessions SET cast_json=? WHERE id=?').run(JSON.stringify([{ id: 'a', name: 'A', appearance: 'A', voice: {}, storage: 'project' }]),'s')
    update([{ ...frame(), speakerCastId: 'a', blocking: [{ castId: 'a', position: 'left', action: '', expression: '' }] } as any])
    const canvas = readCanvas(db,'u','p'), actor = canvas.graph.nodes.find(node => node.kind === 'character')!
    canvas.graph.nodes.push({ id: 'custom-image', kind: 'image', x: 0, y: 0, data: { layout: { aspectRatio: '16:9', backgroundNodeId: actor.id, instances: [] } } })
    canvas.graph.edges.push({ id: 'custom-edge', source: actor.id, sourcePort: 'object', target: 'custom-image', targetPort: 'context' })
    writeCanvas(db,'u','p',{ graph: canvas.graph, baseRevision: canvas.revision })
    update([frame()])
    const result = readCanvas(db,'u','p')
    expect(result.graph.nodes.some(node => node.id === actor.id)).toBe(true)
    expect(result.graph.edges.some(edge => edge.id === 'custom-edge')).toBe(true)
  })

  it('invalidates paid approval and reorders mapped slots without overwriting unrelated scenes', () => {
    setup()
    db.prepare("INSERT INTO scenes(id,project_id,title,prompt,dialogue,params_json,position,background,approved,auto_generate,created_at,updated_at) VALUES('unrelated','p','Keep','','','{}',9,'',0,0,1,1)").run()
    update([frame(),frame('f2')])
    expect(db.prepare("SELECT position FROM scenes WHERE id='unrelated'").get()).toMatchObject({ position: 9 })
    const second = db.prepare("SELECT scene_id FROM timeline_canvas_frames WHERE frame_id='f2'").get() as { scene_id: string }
    expect(db.prepare('SELECT position FROM scenes WHERE id=?').get(second.scene_id)).toMatchObject({ position: 10 })
    db.prepare('UPDATE scenes SET approved=1,auto_generate=1').run()
    update([frame('f2','Change'),frame()])
    expect(db.prepare('SELECT position,approved,auto_generate FROM scenes WHERE id=?').get(second.scene_id)).toMatchObject({ position: 0, approved: 0, auto_generate: 0 })
    expect(db.prepare("SELECT position FROM scenes WHERE id='unrelated'").get()).toMatchObject({ position: 9 })
  })

  it('handles sixty grouped frames without duplicate scenes or automatic spending', () => {
    setup()
    const frames = Array.from({ length: 60 }, (_, index) => frame(`frame-${index}`))
    update(frames)
    const first = readCanvas(db,'u','p')
    expect(first.graph.groups).toHaveLength(61) // Original deleted frame is detached.
    expect(first.graph.nodes).toHaveLength(122)
    update(frames)
    expect(readCanvas(db,'u','p').revision).toBe(first.revision)
    expect(db.prepare('SELECT COUNT(*) AS n FROM generations').get()).toMatchObject({ n: 0 })
    expect(db.prepare('SELECT SUM(approved) AS n,SUM(auto_generate) AS auto FROM scenes').get()).toMatchObject({ n: 0, auto: 0 })
  })

  it('skips archived/trashed projects and retains stable session association', () => {
    const initial = setup()
    db.prepare("UPDATE plan_sessions SET project_id='p' WHERE id='s'").run()
    db.prepare("UPDATE projects SET archived=1 WHERE id='p'").run()
    setStatus(db,'s','scripting',{ timelineJson: JSON.stringify({ frames: [frame('f1','Changed')] }), clearProject: true })
    expect(readCanvas(db,'u','p').revision).toBe(initial.revision)
    expect(db.prepare("SELECT project_id FROM plan_sessions WHERE id='s'").get()).toMatchObject({ project_id: 'p' })
  })
})
