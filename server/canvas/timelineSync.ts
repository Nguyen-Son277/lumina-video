import { randomUUID } from 'node:crypto'
import type { Database } from '../db/index'
import { badRequest, notFound } from '../lib/errors'
import { ownedProject } from '../projects/service'
import { parseCast, parseLocations, parseTimeline, type CastMember, type TimelineFrame } from '../planner/artifacts'
import { frameContextDocuments } from '../planner/mentions'
import { POSITION_TEXT } from '../planner/storyboard'
import type { PromptDocument } from '../../shared/promptMentions'
import type { CanvasEdge, CanvasGraph, CanvasGroup, CanvasNode } from '../../shared/canvas'
import { readCanvas, writeCanvasInternal, type WriteCanvasResult } from './service'

type Link = { session_id: string; project_id: string; user_id: string }
type FrameLink = { frame_id: string; scene_id: string | null; group_id: string; snapshot_json: string; tombstones_json: string; detached: number }
type Snapshot = { group: CanvasGroup; nodes: CanvasNode[]; edges: CanvasEdge[]; scene: Record<string, unknown>; sceneCast: string[]; sourceBackgroundUploadId?: string | null }
type EntityLink = { source_id: string; target_id: string; managed: number; snapshot_json: string }
const json = (value: unknown) => JSON.stringify(value)
const equal = (a: unknown, b: unknown) => json(a) === json(b)
const copy = <T>(value: T): T => structuredClone(value)
let savepoint = 0

/** Safe inside apply/background transactions as well as standalone artifact writes. */
export function withTimelineSync<T>(db: Database, sessionId: string, fn: () => T): T {
  const name = `timeline_sync_${++savepoint}`
  db.exec(`SAVEPOINT ${name}`)
  try {
    const result = fn()
    syncTimelineSession(db, sessionId)
    db.exec(`RELEASE SAVEPOINT ${name}`)
    return result
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${name}`)
    db.exec(`RELEASE SAVEPOINT ${name}`)
    throw error
  }
}

/** Merge individual source-owned leaves; absence of a canvas field is an edit too. */
function merge<T>(current: T, previous: T, next: T, path: string, conflicts: string[], reset = false): T {
  if (equal(current, previous) || equal(current, next)) return copy(next)
  if (path.endsWith('.promptDocument')) {
    if (!reset) conflicts.push(path)
    return reset ? copy(next) : current
  }
  if (next && previous && current && typeof next === 'object' && typeof previous === 'object' && typeof current === 'object'
    && !Array.isArray(next) && !Array.isArray(previous) && !Array.isArray(current)) {
    const result = { ...current } as Record<string, unknown>
    for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      const value = merge((current as any)[key], (previous as any)[key], (next as any)[key], `${path}.${key}`, conflicts, reset)
      if (value === undefined) delete result[key]
      else result[key] = value
    }
    return result as T
  }
  if (reset) return copy(next)
  // Local overrides remain visible even if the source has not changed again.
  if (!equal(current, next)) conflicts.push(path)
  return current
}

/** Concatenate validated ID-bound documents without guessing @names or losing spans. */
export function timelineFramePrompt(frame: TimelineFrame, cast: CastMember[]): PromptDocument {
  const document: PromptDocument = { version: 1, text: '', mentions: [] }
  const append = (text: string, source?: PromptDocument) => {
    if (!text) return
    const start = document.text.length + (document.text ? 1 : 0)
    document.text += (document.text ? ' ' : '') + text
    if (source) document.mentions.push(...source.mentions.map(binding => ({ ...binding, start: binding.start + start, end: binding.end + start })))
  }
  for (const key of ['context', 'action', 'beats', 'shotNotes'] as const) {
    const text = frame[key] || (key === 'action' ? frame.title : '')
    if (text && key === 'beats') append('Nhịp hành động:')
    if (text && key === 'shotNotes') append('Góc máy:')
    append(text, frame.mentionDocuments?.[key]?.text === text ? frame.mentionDocuments[key] : undefined)
  }
  if (frame.blocking?.length) append(`Nhân vật trong khung: ${frame.blocking.map(entry => {
    const member = cast.find(item => item.id === entry.castId)
    return `${member?.name ?? entry.castId} — hành động: ${entry.action || 'đứng yên'}${entry.expression ? `, biểu cảm: ${entry.expression}` : ''} (${POSITION_TEXT[entry.position] ?? 'trong khung'})`
  }).join('; ')}.`)
  // Keep occurrence spans valid at the shared prompt limit rather than truncate bindings.
  if (document.text.length > 8000) throw badRequest('Prompt timeline vượt giới hạn 8000 ký tự; hãy rút gọn nội dung frame.')
  return document
}

export function registerTimelineCanvas(db: Database, input: {
  sessionId: string; projectId: string; userId: string
  frames: Array<{ frameId: string; sceneId: string }>
  characters: Array<{ sourceId: string; targetId: string; managed: boolean }>
  locations: Array<{ sourceId: string; targetId: string }>
}): void {
  db.prepare('INSERT INTO timeline_canvas_sessions(session_id,project_id,user_id,created_at) VALUES(?,?,?,?)')
    .run(input.sessionId, input.projectId, input.userId, Date.now())
  const session = db.prepare('SELECT cast_json, locations_json FROM plan_sessions WHERE id = ?').get(input.sessionId) as { cast_json: string | null; locations_json: string | null }
  for (const [kind, sources, entries] of [
    ['cast', parseCast(session.cast_json), input.characters], ['location', parseLocations(session.locations_json), input.locations],
  ] as const) {
    for (const entry of entries) db.prepare('INSERT INTO timeline_canvas_entities(session_id,source_kind,source_id,target_id,managed,snapshot_json) VALUES(?,?,?,?,?,?)')
      .run(input.sessionId, kind, entry.sourceId, entry.targetId, 'managed' in entry ? Number(entry.managed) : 1, json({ ...sources.find(item => item.id === entry.sourceId), ...(kind === 'cast' ? { _targetReferencePath: (db.prepare('SELECT reference_path FROM characters WHERE id=?').get(entry.targetId) as { reference_path: string | null } | undefined)?.reference_path ?? null } : {}) }))
  }
  for (const frame of input.frames) db.prepare('INSERT INTO timeline_canvas_frames(session_id,frame_id,scene_id,group_id) VALUES(?,?,?,?)')
    .run(input.sessionId, frame.frameId, frame.sceneId, `timeline:${randomUUID()}`)
  syncTimelineSession(db, input.sessionId)
}

function entityMaps(db: Database, link: Link, cast: CastMember[], locations: ReturnType<typeof parseLocations>) {
  const characters = new Map<string, string>()
  const locationIds = new Map<string, string>()
  const changedTargets = new Set<string>()
  for (const [kind, sources, result] of [['cast', cast, characters], ['location', locations, locationIds]] as const) {
    for (const source of sources) {
      let mapping = db.prepare('SELECT * FROM timeline_canvas_entities WHERE session_id=? AND source_kind=? AND source_id=?')
        .get(link.session_id, kind, source.id) as EntityLink | undefined
      let target = mapping && db.prepare(kind === 'cast'
        ? 'SELECT * FROM characters WHERE id=? AND user_id=? AND deleted_at IS NULL AND (project_id IS NULL OR project_id=?)'
        : 'SELECT * FROM project_locations WHERE id=? AND project_id=?').get(...(kind === 'cast' ? [mapping.target_id, link.user_id, link.project_id] : [mapping.target_id, link.project_id])) as Record<string, any> | undefined
      // A deleted target is a deletion, not permission to resurrect it.
      if (mapping && !target) continue
      if (!mapping && kind === 'cast' && 'reuseCharacterId' in source && source.reuseCharacterId) {
        target = db.prepare('SELECT * FROM characters WHERE id=? AND user_id=? AND deleted_at IS NULL AND (project_id IS NULL OR project_id=?)').get(source.reuseCharacterId, link.user_id, link.project_id) as Record<string, any> | undefined
        if (!target) throw badRequest('Nhân vật dùng lại không còn khả dụng')
      }
      const now = Date.now()
      const createdTarget = !target
      if (!target) {
        const id = randomUUID()
        if (kind === 'cast') {
          const member = source as CastMember
          db.prepare('INSERT INTO characters(id,user_id,project_id,name,appearance,voice_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
            .run(id, link.user_id, link.project_id, member.name, member.appearance, json(member.voice), now, now)
        } else {
          const location = source as ReturnType<typeof parseLocations>[number]
          db.prepare('INSERT INTO project_locations(id,project_id,name,stage,description,continuity_notes,image_prompt,reference_upload_id,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,1,?,?)')
            .run(id, link.project_id, location.name, location.stage, location.description, location.continuityNotes, location.imagePrompt, location.reference?.uploadId ?? null, now, now)
        }
        target = db.prepare(`SELECT * FROM ${kind === 'cast' ? 'characters' : 'project_locations'} WHERE id=?`).get(id) as Record<string, any>
      }
      if (!mapping) {
        const managed = kind === 'location' || !('reuseCharacterId' in source && source.reuseCharacterId)
        db.prepare('INSERT INTO timeline_canvas_entities(session_id,source_kind,source_id,target_id,managed,snapshot_json) VALUES(?,?,?,?,?,?)')
          .run(link.session_id, kind, source.id, target.id, Number(managed), json(source))
        mapping = { source_id: source.id, target_id: target.id, managed: Number(managed), snapshot_json: json(source) }
      }
      const oldSource = JSON.parse(mapping.snapshot_json)
      const changedDesign = kind === 'cast' && (!equal(oldSource.appearance, (source as CastMember).appearance) || !equal(oldSource.voice, (source as CastMember).voice) || !equal(oldSource.portrait?.uploadId, (source as CastMember).portrait?.uploadId))
      if (kind === 'cast' && changedDesign && (target.project_id === null || !mapping.managed)) {
        // Never mutate an account-library identity after it has escaped this session.
        const id = randomUUID()
        db.prepare(`INSERT INTO characters(id,user_id,project_id,name,appearance,voice_json,reference_path,reference_mime,reference_bytes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
          .run(id, link.user_id, link.project_id, target.name, target.appearance, target.voice_json, target.reference_path, target.reference_mime, target.reference_bytes, now, now)
        db.prepare('UPDATE timeline_canvas_entities SET target_id=?,managed=1 WHERE session_id=? AND source_kind=? AND source_id=?').run(id, link.session_id, kind, source.id)
        target = { ...target, id, project_id: link.project_id }
        mapping.target_id = id
        mapping.managed = 1
      }
      if (mapping.managed) {
        const old = JSON.parse(mapping.snapshot_json)
        const fields: Record<string, [unknown, unknown]> = kind === 'cast' ? {
          name: [old.name, source.name], appearance: [old.appearance, (source as CastMember).appearance],
          voice_json: [json(old.voice), json((source as CastMember).voice)],
        } : {
          name: [old.name, source.name], stage: [old.stage, (source as any).stage], description: [old.description, (source as any).description],
          continuity_notes: [old.continuityNotes, (source as any).continuityNotes], image_prompt: [old.imagePrompt, (source as any).imagePrompt],
          reference_upload_id: [old.reference?.uploadId ?? null, (source as any).reference?.uploadId ?? null],
        }
        const changed = Object.entries(fields).filter(([key, [previous, next]]) => equal(target![key], previous) && !equal(previous, next))
        if (changed.length) changedTargets.add(target.id)
        if (changed.length) db.prepare(`UPDATE ${kind === 'cast' ? 'characters' : 'project_locations'} SET ${changed.map(([key]) => `${key}=?`).join(',')}, updated_at=?${kind === 'location' ? ',revision=revision+1' : ''} WHERE id=?`)
          .run(...changed.map(([, [, next]]) => next as string | null), now, target.id)
      }
      if (mapping.managed && kind === 'cast') {
        const old = JSON.parse(mapping.snapshot_json)
        const member = source as CastMember
        const previousUpload = old.portrait?.uploadId ? db.prepare('SELECT relative_path FROM uploads WHERE id=? AND user_id=?').get(old.portrait.uploadId, link.user_id) as { relative_path: string } | undefined : undefined
        const expectedReference = '_targetReferencePath' in old ? old._targetReferencePath : previousUpload?.relative_path ?? null
        if ((createdTarget || target.reference_path === expectedReference) && ((createdTarget && member.portrait?.uploadId) || (old.portrait?.uploadId ?? null) !== (member.portrait?.uploadId ?? null))) {
          const upload = member.portrait?.uploadId ? db.prepare('SELECT relative_path,mime_type,byte_size FROM uploads WHERE id=? AND user_id=?').get(member.portrait.uploadId, link.user_id) as { relative_path: string; mime_type: string; byte_size: number } | undefined : undefined
          changedTargets.add(target.id)
          if (upload) db.prepare(`INSERT INTO immutable_media_versions(id,user_id,path,mime_type,byte_size,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(path) DO NOTHING`).run(randomUUID(), link.user_id, upload.relative_path, upload.mime_type, upload.byte_size, now)
          db.prepare('UPDATE characters SET reference_path=?,reference_mime=?,reference_bytes=?,updated_at=? WHERE id=?')
            .run(upload?.relative_path ?? null, upload?.mime_type ?? null, upload?.byte_size ?? null, now, target.id)
          old._targetReferencePath = upload?.relative_path ?? null
        }
        // Advance the upstream baseline, not the locally overridden target pointer.
        if (!('_targetReferencePath' in old)) old._targetReferencePath = expectedReference
        db.prepare('UPDATE timeline_canvas_entities SET snapshot_json=? WHERE session_id=? AND source_kind=? AND source_id=?').run(json({ ...source, _targetReferencePath: old._targetReferencePath }), link.session_id, kind, source.id)
      } else db.prepare('UPDATE timeline_canvas_entities SET snapshot_json=? WHERE session_id=? AND source_kind=? AND source_id=?').run(json(source), link.session_id, kind, source.id)
      result.set(source.id, target.id)
    }
  }
  return { characters, locationIds, changedTargets }
}

function desiredFrame(link: Link, mapping: FrameLink, frame: TimelineFrame, index: number, cast: CastMember[], maps: ReturnType<typeof entityMaps>, modelId: string | null): Snapshot {
  const x = 0, y = index * 1700
  const group: CanvasGroup = { id: mapping.group_id, title: frame.title, sceneId: mapping.scene_id!, x, y, width: 1080, height: Math.max(760, 240 + (frame.blocking?.length ?? 0) * 100), timeline: { sessionId: link.session_id, frameId: frame.id } }
  const nodes: CanvasNode[] = [], edges: CanvasEdge[] = []
  const prefix = mapping.group_id
  const add = (suffix: string, kind: CanvasNode['kind'], dx: number, dy: number, data: CanvasNode['data']) => {
    const node: CanvasNode = { id: `${prefix}:${suffix}`, kind, groupId: group.id, x: x + dx, y: y + dy, data }
    nodes.push(node); return node
  }
  const video = add('video', 'video', 760, 90, { sceneId: mapping.scene_id!, modelId })
  const document = timelineFramePrompt(frame, cast)
  const prompt = add('prompt', 'prompt', 30, 90, { text: document.text, promptDocument: document })
  const connect = (node: CanvasNode, sourcePort: string, targetPort: string) => edges.push({ id: `${prefix}:edge:${node.id}`, source: node.id, sourcePort, target: video.id, targetPort })
  connect(prompt, 'prompt', 'prompt')
  const castIds = [...new Set([frame.speakerCastId, ...(frame.blocking ?? []).map(entry => entry.castId)].filter((id): id is string => Boolean(id)))]
  castIds.forEach((id, i) => {
    const target = maps.characters.get(id)
    if (target) connect(add(`cast:${id}`, 'character', 380, 90 + i * 100, { sourceId: target }), 'object', 'context')
  })
  if (frame.locationId && maps.locationIds.has(frame.locationId)) connect(add('location', 'location', 380, 560, { sourceId: maps.locationIds.get(frame.locationId)! }), 'object', 'context')
  if (frame.background?.uploadId) connect(add('background', 'upload', 30, 470, { uploadId: frame.background.uploadId }), 'image', 'image')
  return { group, nodes, edges, sceneCast: castIds.flatMap(id => maps.characters.get(id) ?? []), scene: {
    title: frame.title.slice(0, 200), prompt: document.text, dialogue: frame.dialogue, background: frame.context,
    background_upload_id: frame.background?.uploadId ?? null, location_id: frame.locationId ? maps.locationIds.get(frame.locationId) ?? null : null,
    character_id: frame.speakerCastId ? maps.characters.get(frame.speakerCastId) ?? null : null,
    context_documents_json: json(frameContextDocuments(frame)), params_json: { seconds: String(frame.durationSeconds) },
  } }
}

/** Transaction-free: all artifact writers invoke this before committing their write. */
export function syncTimelineSession(db: Database, sessionId: string, resetGroupId?: string): void {
  const link = db.prepare('SELECT * FROM timeline_canvas_sessions WHERE session_id=?').get(sessionId) as Link | undefined
  if (!link) return // Legacy association alone is not trustworthy provenance.
  const project = db.prepare('SELECT archived,deleted_at FROM projects WHERE id=? AND user_id=?').get(link.project_id, link.user_id) as { archived: number; deleted_at: number | null } | undefined
  const session = db.prepare('SELECT * FROM plan_sessions WHERE id=? AND user_id=? AND deleted_at IS NULL').get(sessionId, link.user_id) as { cast_json: string | null; locations_json: string | null; timeline_json: string | null; video_model_id: string | null } | undefined
  if (!project || project.archived || project.deleted_at != null || !session) return
  const timeline = parseTimeline(session.timeline_json)
  const cast = parseCast(session.cast_json), locations = parseLocations(session.locations_json)
  const maps = entityMaps(db, link, cast, locations)
  const canvas = readCanvas(db, link.user_id, link.project_id)
  const graph: CanvasGraph = copy(canvas.graph)
  graph.groups ??= []
  const mappings = db.prepare('SELECT * FROM timeline_canvas_frames WHERE session_id=?').all(sessionId) as unknown as FrameLink[]
  const active = new Set(timeline?.frames.map(frame => frame.id) ?? [])
  for (const mapping of mappings) {
    if (active.has(mapping.frame_id)) continue
    const group = graph.groups.find(item => item.id === mapping.group_id)
    if (group?.timeline) group.timeline.detached = true
    db.prepare('UPDATE timeline_canvas_frames SET detached=1 WHERE session_id=? AND frame_id=?').run(sessionId, mapping.frame_id)
  }
  const positions = (db.prepare(`SELECT s.position FROM scenes s JOIN timeline_canvas_frames f ON f.scene_id=s.id WHERE f.session_id=? AND f.frame_id IN (SELECT value FROM json_each(?)) ORDER BY s.position,s.id`).all(sessionId, json([...active])) as Array<{ position: number }>).map(row => row.position)
  let nextPosition = Number((db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS n FROM scenes WHERE project_id=?').get(link.project_id) as { n: number }).n)
  const orderedPositions = (timeline?.frames ?? []).map((_, index) => positions[index] ?? nextPosition++)
  for (const [index, frame] of (timeline?.frames ?? []).entries()) {
    let mapping = mappings.find(item => item.frame_id === frame.id)
    if (!mapping) {
      const sceneId = randomUUID()
      db.prepare(`INSERT INTO scenes(id,project_id,title,prompt,dialogue,model_id,params_json,position,background,approved,auto_generate,created_at,updated_at) VALUES(?,?,?,'','',?,'{}',?,'',0,0,?,?)`)
        .run(sceneId, link.project_id, frame.title.slice(0, 200), session.video_model_id, orderedPositions[index]!, Date.now(), Date.now())
      mapping = { frame_id: frame.id, scene_id: sceneId, group_id: `timeline:${randomUUID()}`, snapshot_json: '{}', tombstones_json: '[]', detached: 0 }
      db.prepare('INSERT INTO timeline_canvas_frames(session_id,frame_id,scene_id,group_id) VALUES(?,?,?,?)').run(sessionId, frame.id, sceneId, mapping.group_id)
    }
    // A deliberately removed scene is a tombstone; never resurrect its inputs.
    if (!mapping.scene_id) {
      const group = graph.groups.find(item => item.id === mapping!.group_id)
      if (group) { delete group.sceneId; if (group.timeline) group.timeline.detached = true }
      continue
    }
    const reset = resetGroupId === mapping.group_id
    const previous = JSON.parse(mapping.snapshot_json) as Partial<Snapshot>
    const tombstones = new Set<string>(reset ? [] : JSON.parse(mapping.tombstones_json))
    const sceneModel = mapping.scene_id ? db.prepare('SELECT model_id FROM scenes WHERE id=? AND project_id=?').get(mapping.scene_id, link.project_id) as { model_id: string | null } | undefined : undefined
    const desired = desiredFrame(link, mapping, frame, index, cast, maps, sceneModel?.model_id ?? session.video_model_id)
    desired.sourceBackgroundUploadId = frame.background?.uploadId ?? null
    const existingBackground = mapping.scene_id ? db.prepare('SELECT background_upload_id FROM scenes WHERE id=? AND project_id=?').get(mapping.scene_id, link.project_id) as { background_upload_id: string | null } | undefined : undefined
    // Initial apply deliberately copied media; retain that immutable target while
    // the originating source stays selected instead of relinking it to the draft.
    if ((!previous.group || previous.sourceBackgroundUploadId === desired.sourceBackgroundUploadId) && existingBackground?.background_upload_id) {
      const uploadId = previous.scene?.background_upload_id ?? existingBackground.background_upload_id
      desired.scene.background_upload_id = uploadId
      const background = desired.nodes.find(node => node.id === `${mapping.group_id}:background`)
      if (background) background.data.uploadId = uploadId as string
    }
    const conflicts: string[] = []
    const currentGroup = graph.groups.find(item => item.id === mapping!.group_id)
    if (!currentGroup && previous.group && !reset) tombstones.add(`group:${mapping.group_id}`)
    if (!tombstones.has(`group:${mapping.group_id}`)) {
      if (!currentGroup) graph.groups.push(copy(desired.group))
      else {
        // Geometry and membership are canvas-owned, never source-managed.
        currentGroup.title = merge(currentGroup.title, previous.group?.title ?? currentGroup.title, desired.group.title, 'group.title', conflicts, reset)
        currentGroup.sceneId = desired.group.sceneId
        currentGroup.timeline = desired.group.timeline
      }
      for (const old of previous.nodes ?? []) {
        if (!reset && !graph.nodes.some(node => node.id === old.id)) tombstones.add(`node:${old.id}`)
        if (!desired.nodes.some(node => node.id === old.id)) {
          const current = graph.nodes.find(node => node.id === old.id)
          const oldEdges = new Set((previous.edges ?? []).map(edge => edge.id))
          const customReference = graph.edges.some(edge => !oldEdges.has(edge.id) && (edge.source === old.id || edge.target === old.id))
            || graph.nodes.some(node => node.id !== old.id && (node.data.layout?.backgroundNodeId === old.id || node.data.layout?.instances.some(instance => instance.sourceNodeId === old.id) || node.data.videoInputNodeId === old.id))
          if (current && equal(current.data, old.data) && !customReference) {
            graph.nodes = graph.nodes.filter(node => node.id !== old.id)
            graph.edges = graph.edges.filter(edge => edge.source !== old.id && edge.target !== old.id)
          }
        }
      }
      for (const node of desired.nodes) {
        if (tombstones.has(`node:${node.id}`)) continue
        const current = graph.nodes.find(item => item.id === node.id)
        const old = previous.nodes?.find(item => item.id === node.id)
        if (!current) graph.nodes.push(copy(node))
        else if (old) {
          // Models, selected runs, manual layout and positions belong to Canvas.
          const { modelId: _model, ...nextData } = node.data
          const { modelId: _oldModel, ...oldData } = old.data
          if (node.kind === 'prompt') {
            const currentPrompt = { text: current.data.text, promptDocument: current.data.promptDocument }
            const oldPrompt = { text: oldData.text, promptDocument: oldData.promptDocument }
            const nextPrompt = { text: nextData.text, promptDocument: nextData.promptDocument }
            if (reset || equal(currentPrompt, oldPrompt) || equal(currentPrompt, nextPrompt)) Object.assign(current.data, copy(nextPrompt))
            else conflicts.push(`node.${node.id}.prompt`)
          } else current.data = merge(current.data, oldData, nextData, `node.${node.id}`, conflicts, reset)
        }
      }
      for (const old of previous.edges ?? []) {
        if (!reset && !graph.edges.some(edge => edge.id === old.id)) tombstones.add(`edge:${old.id}`)
        if (!desired.edges.some(edge => edge.id === old.id)) graph.edges = graph.edges.filter(edge => edge.id !== old.id || !equal(edge, old))
      }
      for (const edge of desired.edges) {
        if (tombstones.has(`edge:${edge.id}`) || !graph.nodes.some(node => node.id === edge.source) || !graph.nodes.some(node => node.id === edge.target)) continue
        const current = graph.edges.find(item => item.id === edge.id)
        const old = previous.edges?.find(item => item.id === edge.id)
        if (current && old) Object.assign(current, merge(current, old, edge, `edge.${edge.id}`, conflicts, reset))
        else if (!current) {
          // A user rewired the single prompt input: keep that wire rather than fail validation.
          if (edge.targetPort === 'prompt' && graph.edges.some(item => item.target === edge.target && item.targetPort === 'prompt')) conflicts.push(`edge.${edge.id}`)
          else graph.edges.push(copy(edge))
        }
      }
      const group = graph.groups.find(item => item.id === mapping!.group_id)!
      group.timeline = { ...desired.group.timeline!, ...(conflicts.length ? { conflicts: [...new Set(conflicts)] } : {}) }
    }
    const scene = mapping.scene_id && db.prepare('SELECT * FROM scenes WHERE id=? AND project_id=?').get(mapping.scene_id, link.project_id) as Record<string, any> | undefined
    if (scene) {
      const currentCast = (db.prepare('SELECT character_id FROM scene_characters WHERE scene_id=? ORDER BY position').all(mapping.scene_id) as Array<{ character_id: string }>).map(item => item.character_id)
      const nextCast = merge(currentCast, previous.sceneCast ?? currentCast, desired.sceneCast, 'scene.cast', conflicts, reset)
      const castChanged = !equal(currentCast, nextCast)
      if (castChanged) {
        db.prepare('DELETE FROM scene_characters WHERE scene_id=?').run(mapping.scene_id)
        nextCast.forEach((id, position) => db.prepare('INSERT INTO scene_characters(scene_id,character_id,position) VALUES(?,?,?)').run(mapping.scene_id, id, position))
      }
      const currentScene = Object.fromEntries(Object.keys(desired.scene).map(key => [key, key === 'params_json' ? JSON.parse(scene[key]) : scene[key]]))
      const updated = merge(currentScene, previous.scene ?? currentScene, desired.scene, 'scene', conflicts, reset)
      const fields = Object.keys(desired.scene).filter(key => !equal(currentScene[key], updated[key]))
      if (fields.length) db.prepare(`UPDATE scenes SET ${fields.map(key => `${key}=?`).join(',')}${previous.group ? ',approved=0,auto_generate=0' : ''},updated_at=? WHERE id=? AND project_id=?`)
        .run(...fields.map(key => key === 'params_json' ? json(updated[key]) : updated[key] as string | null), Date.now(), mapping.scene_id, link.project_id)
      const entityChanged = desired.sceneCast.some(id => maps.changedTargets.has(id)) || (typeof desired.scene.location_id === 'string' && maps.changedTargets.has(desired.scene.location_id))
      if ((castChanged || entityChanged) && previous.group) db.prepare('UPDATE scenes SET approved=0,auto_generate=0,updated_at=? WHERE id=? AND project_id=?').run(Date.now(), mapping.scene_id, link.project_id)
      if (scene.position !== orderedPositions[index]) db.prepare('UPDATE scenes SET position=?,updated_at=? WHERE id=? AND project_id=?').run(orderedPositions[index]!, Date.now(), mapping.scene_id, link.project_id)
      const group = graph.groups.find(item => item.id === mapping!.group_id)
      if (group?.timeline && conflicts.length) group.timeline.conflicts = [...new Set(conflicts)]
    }
    db.prepare('UPDATE timeline_canvas_frames SET snapshot_json=?,tombstones_json=?,detached=0 WHERE session_id=? AND frame_id=?')
      .run(json(desired), json([...tombstones]), sessionId, frame.id)
  }
  if (!equal(graph, canvas.graph)) writeCanvasInternal(db, link.user_id, link.project_id, { graph, baseRevision: canvas.revision })
}

export function resetTimelineGroup(db: Database, userId: string, projectId: string, groupId: string, baseRevision: number): WriteCanvasResult {
  ownedProject(db, userId, projectId, true)
  const mapping = db.prepare(`SELECT f.session_id FROM timeline_canvas_frames f JOIN timeline_canvas_sessions s ON s.session_id=f.session_id WHERE s.project_id=? AND s.user_id=? AND f.group_id=?`).get(projectId, userId, groupId) as { session_id: string } | undefined
  if (!mapping) throw notFound('Không tìm thấy nhóm timeline')
  const name = `timeline_reset_${++savepoint}`
  db.exec(`SAVEPOINT ${name}`)
  try {
    const canvas = readCanvas(db, userId, projectId)
    if (canvas.revision !== baseRevision) throw badRequest('Bảng Canvas đã được lưu ở nơi khác. Hãy tải lại trước khi lưu.', { expected: canvas.revision }, { messageKey: 'canvas.revision_conflict' })
    syncTimelineSession(db, mapping.session_id, groupId)
    db.exec(`RELEASE SAVEPOINT ${name}`)
    return { canvas: readCanvas(db, userId, projectId) }
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${name}`); db.exec(`RELEASE SAVEPOINT ${name}`); throw error
  }
}
