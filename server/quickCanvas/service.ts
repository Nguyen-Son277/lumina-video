import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { imagePurposeSchema } from '../../shared/imagePurpose'
import type { Database } from '../db/index'
import { badRequest, conflict } from '../lib/errors'
import { transaction } from '../projects/service'
import { ownedQuickSession } from '../quickSessions/service'
import { assertOwnedUpload } from '../canvas/service'
import { canvasAliases } from '../canvas/resolve'
import { type ResolvedObject } from '../canvas/compiler'
import { resolveEntity, listEntityCatalog, type CatalogEntity } from '../entityLibrary/service'
import { validatePromptDocument } from '../../shared/promptMentions'
import { CANVAS_LIMITS, emptyCanvasGraph, validateCanvasGraph, validateCanvasLayout, type CanvasGraph, type CanvasNode } from '../../shared/canvas'
import { sanitizeCanvasVideoSettings } from '../../shared/canvasVideoSettings'
import type { GenerationRow } from '../generations/types'

const object = (entity: CatalogEntity, nodeId: string): ResolvedObject => ({
  nodeId, recordId: entity.id, kind: entity.kind, entity: { kind: entity.kind, id: entity.id }, name: entity.name,
  handle: entity.handle, description: entity.description, continuityNotes: entity.continuityNotes, revision: entity.revision,
  referenceIdentity: entity.reference?.path ?? null,
  reference: entity.reference ? entity.kind === 'character' ? { kind: 'character', characterId: entity.id } : entity.reference.uploadId ? { kind: 'upload', uploadId: entity.reference.uploadId } : null : null,
})
export function resolveQuickObjects(db: Database, userId: string, graph: CanvasGraph): ResolvedObject[] {
  const result: ResolvedObject[] = []
  for (const node of graph.nodes) {
    if (node.data?.sourceId && (node.kind === 'character' || node.kind === 'library')) {
      const kind = node.kind === 'character' ? 'character' : node.data.entityKind
      if (!kind) throw badRequest('Loại đối tượng không hợp lệ')
      const entity=resolveEntity(db,userId,{kind,id:node.data.sourceId})
      if(kind==='location'&&node.data.uploadId) {
        if(!entity.referenceViews?.some(view=>view.uploadId===node.data.uploadId))throw badRequest('Góc nhìn không thuộc bối cảnh thư viện')
        const upload=db.prepare('SELECT relative_path AS path,mime_type AS mime FROM uploads WHERE id=? AND user_id=?').get(node.data.uploadId,userId) as {path:string;mime:string}|undefined
        if(!upload)throw badRequest('Ảnh góc nhìn không còn khả dụng')
        entity.reference={...upload,uploadId:node.data.uploadId}
      }
      result.push(object(entity,node.id))
    }
  }
  const catalog = listEntityCatalog(db, userId)
  for (const node of graph.nodes) for (const binding of node.data?.promptDocument?.mentions ?? []) {
    if (result.some(entry => entry.entity?.kind === binding.entity.kind && entry.recordId === binding.entity.id)) continue
    const entity = catalog.find(entry => entry.kind === binding.entity.kind && entry.id === binding.entity.id)
    if (entity) result.push(object(entity, `mention:${entity.kind}:${entity.id}`))
  }
  return result
}
export function listQuickRuns(db: Database, sessionId: string) {
  return db.prepare(`SELECT r.id,r.node_id AS nodeId,r.kind,g.id AS generationId,r.asset_id AS assetId,r.input_stamp AS inputStamp,r.created_at AS createdAt
    FROM quick_canvas_runs r LEFT JOIN generations g ON g.id=r.generation_id AND g.deleted_at IS NULL
    WHERE r.session_id=? ORDER BY r.created_at DESC,r.id LIMIT 200`).all(sessionId)
}
export function readQuickCanvas(db: Database, userId: string, sessionId: string) {
  ownedQuickSession(db, userId, sessionId)
  const row = db.prepare('SELECT graph_json,revision,updated_at FROM quick_canvases WHERE session_id=? AND user_id=?').get(sessionId,userId) as {graph_json:string;revision:number;updated_at:number}|undefined
  const graph: CanvasGraph = row ? JSON.parse(row.graph_json) : emptyCanvasGraph()
  return { projectId: sessionId, quickSessionId: sessionId, graph, revision: row?.revision ?? 0, updatedAt: row?.updated_at ?? 0,
    provenance: (db.prepare('SELECT source_key AS sourceKey,node_id AS nodeId,tombstoned,conflicts_json FROM quick_canvas_sources WHERE session_id=? ORDER BY source_key').all(sessionId) as Array<{sourceKey:string;nodeId:string;tombstoned:number;conflicts_json:string}>).map(({conflicts_json,tombstoned,...source})=>({...source,tombstoned:Boolean(tombstoned),conflicts:JSON.parse(conflicts_json)})),
    runs: listQuickRuns(db,sessionId), aliases: canvasAliases(resolveQuickObjects(db,userId,graph)), limits: CANVAS_LIMITS }
}
export function validateQuickGraph(db: Database, userId: string, sessionId: string, graph: CanvasGraph, previous?: CanvasGraph) {
  const issues = validateCanvasGraph(graph)
  if (issues.length) throw badRequest('Bảng Canvas không hợp lệ',{issues},{messageKey:'canvas.graph_invalid'})
  const ids = new Set(graph.nodes.map(node=>node.id))
  for (const group of graph.groups ?? []) if (group.sceneId || group.timeline) throw badRequest('Canvas phiên không dùng cảnh dự án')
  for (const node of graph.nodes) {
    if (!node.data || typeof node.data !== 'object' || Array.isArray(node.data)) throw badRequest('Dữ liệu node không hợp lệ')
    if (node.kind === 'item' || node.kind === 'location' || node.data.sceneId) throw badRequest('Canvas phiên chỉ dùng đối tượng thư viện')
    const layoutIssues = validateCanvasLayout(node.data.layout,ids)
    if (layoutIssues.length) throw badRequest('Bố trí không hợp lệ',{issues:layoutIssues})
    if (node.data.promptDocument && (validatePromptDocument(node.data.promptDocument).length || node.data.text !== node.data.promptDocument.text)) throw badRequest('Tài liệu mention không hợp lệ')
    const extension=node.data as CanvasNode['data']&{imagePurpose?:unknown}
    if(extension.imagePurpose&&!imagePurposeSchema.safeParse(extension.imagePurpose).success)throw badRequest('Mục đích tạo ảnh không hợp lệ')
    if(node.data.imageSettings&&!z.object({size:z.string().max(50).optional(),quality:z.string().max(50).optional(),n:z.number().int().min(1).max(4).optional()}).strict().safeParse(node.data.imageSettings).success)throw badRequest('Cấu hình ảnh không hợp lệ')
    if(node.data.logoOverlay&&!z.object({entityId:z.string().min(1),x:z.number().finite().min(0).max(1),y:z.number().finite().min(0).max(1),width:z.number().finite().positive().max(1),opacity:z.number().finite().min(0).max(1),anchor:z.enum(['top-left','top-center','top-right','middle-left','center','middle-right','bottom-left','bottom-center','bottom-right']).optional()}).strict().safeParse(node.data.logoOverlay).success)throw badRequest('Bố trí logo không hợp lệ')
    for(const binding of node.data.promptDocument?.mentions??[]) {
      const entity=resolveEntity(db,userId,binding.entity)
      if(binding.entity.viewUploadId&&!entity.referenceViews?.some(view=>view.uploadId===binding.entity.viewUploadId))throw badRequest('Góc nhìn không thuộc đối tượng đã chọn')
    }
    if (node.data.uploadId) assertOwnedUpload(db,userId,node.data.uploadId)
    for (const placement of node.data.layout?.instances ?? []) if (placement.imageUploadId) assertOwnedUpload(db,userId,placement.imageUploadId)
    if (node.data.videoSettings) {
      const model = db.prepare("SELECT model_id AS modelId,video_api_style AS videoApiStyle FROM models WHERE id=? AND user_id=? AND kind='video'").get(node.data.modelId ?? '',userId) as Parameters<typeof sanitizeCanvasVideoSettings>[1]|undefined
      if (!model) throw badRequest('Model video không hợp lệ')
      try { sanitizeCanvasVideoSettings(node.data.videoSettings,model) } catch { throw badRequest('Cấu hình video không hợp lệ') }
    }
    if (node.data.selectedRunId) {
      const run = db.prepare(`SELECT g.deleted_at FROM quick_canvas_runs r JOIN generations g ON g.id=r.generation_id WHERE r.id=? AND r.session_id=? AND r.node_id=? AND r.kind=? AND g.user_id=?`).get(node.data.selectedRunId,sessionId,node.id,node.kind,userId) as {deleted_at:number|null}|undefined
      const old = previous?.nodes.find(entry=>entry.id===node.id)?.data.selectedRunId
      if (!run || (run.deleted_at != null && old!==node.data.selectedRunId)) throw badRequest('Đầu ra không thuộc node của phiên này')
    }
  }
  resolveQuickObjects(db,userId,graph)
}
function persist(db:Database,userId:string,sessionId:string,graph:CanvasGraph,revision:number) {
  const now=Date.now()
  db.prepare(`INSERT INTO quick_canvases(session_id,user_id,graph_json,revision,created_at,updated_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(session_id) DO UPDATE SET graph_json=excluded.graph_json,revision=excluded.revision,updated_at=excluded.updated_at`).run(sessionId,userId,JSON.stringify(graph),revision,now,now)
}
function quickAtomic<T>(db:Database,fn:()=>T):T {
  const name=`quick_${randomUUID().replaceAll('-','')}`
  db.exec(`SAVEPOINT ${name}`)
  try{const result=fn();db.exec(`RELEASE ${name}`);return result}catch(error){db.exec(`ROLLBACK TO ${name}`);db.exec(`RELEASE ${name}`);throw error}
}
export function writeQuickCanvas(db:Database,userId:string,sessionId:string,input:{graph:unknown;baseRevision:number}) {
  return quickAtomic(db,()=>{
    const current=readQuickCanvas(db,userId,sessionId)
    if(current.revision!==input.baseRevision) throw conflict('Bảng Canvas đã được lưu ở nơi khác',{messageKey:'canvas.revision_conflict'})
    const graph=input.graph as CanvasGraph
    validateQuickGraph(db,userId,sessionId,graph,current.graph)
    for(const source of db.prepare('SELECT source_key,node_id FROM quick_canvas_sources WHERE session_id=? AND tombstoned=0').all(sessionId) as Array<{source_key:string;node_id:string}>) {
      if(!graph.nodes.some(node=>node.id===source.node_id)) db.prepare('UPDATE quick_canvas_sources SET tombstoned=1 WHERE session_id=? AND source_key=?').run(sessionId,source.source_key)
    }
    persist(db,userId,sessionId,graph,current.revision+1)
    return readQuickCanvas(db,userId,sessionId)
  })
}
export function recordQuickRun(db:Database,sessionId:string,nodeId:string,kind:'image'|'video',generationId:string,stamp:string,createdAt=Date.now(),assetId?:string) {
  db.prepare(`INSERT OR IGNORE INTO quick_canvas_runs(id,session_id,node_id,kind,generation_id,input_stamp,created_at) VALUES(?,?,?,?,?,?,?)`).run(randomUUID(),sessionId,nodeId,kind,generationId,stamp,createdAt)
  if(assetId)db.prepare('UPDATE quick_canvas_runs SET asset_id=? WHERE session_id=? AND node_id=? AND generation_id=? AND input_stamp=? AND asset_id IS NULL').run(assetId,sessionId,nodeId,generationId,stamp)
  return db.prepare('SELECT id,node_id AS nodeId,kind,generation_id AS generationId,input_stamp AS inputStamp,created_at AS createdAt FROM quick_canvas_runs WHERE session_id=? AND node_id=? AND generation_id=? AND input_stamp=?').get(sessionId,nodeId,generationId,stamp)
}
export type QuickDraft = { kind:'image'|'video'; promptDocument: import('../../shared/promptMentions').PromptDocument; modelId?:string; imageSettings?:{size?:string;quality?:string;n?:number};videoSettings?:import('../../shared/canvasVideoSettings').CanvasVideoSettings;sourceUploadIds?:string[];sourceAssetIds?:string[];videoInput?:{uploadId?:string;assetId?:string};logoOverlays?:unknown[];allowTemporaryMedia?:boolean;imagePurpose?:import('../generations/enqueue').EnqueuePayload['imagePurpose'] }
export function syncQuickCanvas(db:Database,userId:string,sessionId:string,input:{baseRevision?:number;draft?:QuickDraft|CanvasGraph}) {
  return transaction(db,()=>{
    const current=readQuickCanvas(db,userId,sessionId), graph=current.graph
    if(input.baseRevision!==undefined && input.baseRevision!==current.revision) throw conflict('Bảng Canvas đã được lưu ở nơi khác',{messageKey:'canvas.revision_conflict'})
    let changed=false
    function seed(key:string,node:CanvasNode) {
      const provenance=db.prepare('SELECT snapshot_json,tombstoned FROM quick_canvas_sources WHERE session_id=? AND source_key=?').get(sessionId,key) as {snapshot_json:string;tombstoned:number}|undefined
      if(provenance) {
        const local=graph.nodes.find(entry=>entry.id===node.id)
        if(!provenance.tombstoned&&local&&key.startsWith('draft')) {
          const previous=JSON.parse(provenance.snapshot_json) as CanvasNode
          const existingConflicts=db.prepare('SELECT conflicts_json FROM quick_canvas_sources WHERE session_id=? AND source_key=?').get(sessionId,key) as {conflicts_json:string}
          const conflicts:string[]=JSON.parse(existingConflicts.conflicts_json)
          for(const field of new Set([...Object.keys(previous.data),...Object.keys(node.data)])) {
            const oldValue=(previous.data as Record<string,unknown>)[field],nextValue=(node.data as Record<string,unknown>)[field]
            if(JSON.stringify(oldValue)===JSON.stringify(nextValue))continue
            const localValue=(local.data as Record<string,unknown>)[field]
            if(JSON.stringify(localValue)===JSON.stringify(oldValue)) {
              if(nextValue===undefined)delete (local.data as Record<string,unknown>)[field]
              else (local.data as Record<string,unknown>)[field]=nextValue
              changed=true
            } else if(JSON.stringify(localValue)!==JSON.stringify(nextValue)&&!conflicts.includes(field))conflicts.push(field)
          }
          node.groupId=previous.groupId??local.groupId
          db.prepare('UPDATE quick_canvas_sources SET snapshot_json=?,conflicts_json=? WHERE session_id=? AND source_key=?').run(JSON.stringify(node),JSON.stringify(conflicts),sessionId,key)
        }
        return false
      }
      if(graph.nodes.some(entry=>entry.id===node.id)) throw badRequest('ID node nhập bị trùng')
      const groupId=key.startsWith('draft')?'quick-group:draft':node.id.startsWith('quick-generation:')?`quick-group:generation:${node.id.split(':')[1]}`:undefined
      if(groupId) {
        node.groupId=groupId
        graph.groups??=[]
        if(!graph.groups.some(group=>group.id===groupId))graph.groups.push({id:groupId,title:groupId==='quick-group:draft'?'Bản nháp phiên':'Lịch sử tạo nội dung',x:node.x-40,y:node.y-60,width:900,height:600})
      }
      graph.nodes.push(node)
      db.prepare('INSERT INTO quick_canvas_sources(session_id,source_key,node_id,snapshot_json) VALUES(?,?,?,?)').run(sessionId,key,node.id,JSON.stringify(node))
      changed=true;return true
    }
    const generations=db.prepare('SELECT * FROM generations WHERE quick_session_id=? AND user_id=? AND deleted_at IS NULL ORDER BY created_at,id').all(sessionId,userId) as GenerationRow[]
    for(const generation of generations) {
      const id=`quick-generation:${generation.id}`
      // Jobs created by this board already have node provenance and must not duplicate.
      if(db.prepare('SELECT 1 FROM quick_canvas_runs WHERE session_id=? AND generation_id=?').get(sessionId,generation.id)) continue
      const params=JSON.parse(generation.params_json) as Record<string,unknown>
      const data:CanvasNode['data']={modelId:generation.model_pk,...(generation.kind==='image'?{imageSettings:{...(typeof params.size==='string'?{size:params.size}:{}),...(typeof params.quality==='string'?{quality:params.quality}:{}),...(typeof params.n==='number'?{n:params.n}:{})}}:{})}
      const promptId=`${id}:prompt`
      const seeded=seed(`generation:${generation.id}`,{id,kind:generation.kind,x:420,y:graph.nodes.length*100,data})
      if(!seeded) continue
      const document=generation.prompt_document_json?JSON.parse(generation.prompt_document_json):undefined
      seed(`generation-prompt:${generation.id}`,{id:promptId,kind:'prompt',x:0,y:graph.nodes.length*100,data:{text:document?.text??generation.prompt,...(document?{promptDocument:document}:{})}})
      if(generation.kind==='video'&&generation.model_pk) {
        const model={modelId:generation.snap_model_id,videoApiStyle:generation.snap_video_style}
        try{data.videoSettings=sanitizeCanvasVideoSettings({modelId:generation.model_pk,params},model)}catch{/* Legacy unsupported values remain in immutable generation history. */}
      }
      if(generation.image_purpose_json)(data as CanvasNode['data']&{imagePurpose?:unknown}).imagePurpose=JSON.parse(generation.image_purpose_json)
      data.allowTemporaryMedia=params.allowTemporaryMedia===true
      for(const [index,overlay] of (JSON.parse(generation.logo_overlays_json??'[]') as Array<{entityId:string;anchor?:string;x:number;y:number;width:number;opacity:number;startSeconds?:number;endSeconds?:number}>).entries()) {
        try{resolveEntity(db,userId,{kind:'logo',id:overlay.entityId})}catch{continue}
        if(overlay.startSeconds!==undefined||overlay.endSeconds!==undefined)db.prepare('UPDATE quick_canvas_sources SET conflicts_json=? WHERE session_id=? AND source_key=?').run(JSON.stringify(['overlay_timing_not_supported']),sessionId,`generation:${generation.id}`)
        const source=`${id}:logo:${index}`
        seed(`generation-logo:${generation.id}:${index}`,{id:source,kind:'library',x:0,y:graph.nodes.length*100,data:{entityKind:'logo',sourceId:overlay.entityId,logoPosition:overlay.anchor??'ai',logoWidth:overlay.width,logoOpacity:overlay.opacity,logoOverlay:{entityId:overlay.entityId,x:overlay.x,y:overlay.y,width:overlay.width,opacity:overlay.opacity,...(overlay.anchor?{anchor:overlay.anchor}:{})}} as CanvasNode['data']})
        graph.edges.push({id:`${source}:edge`,source,sourcePort:'object',target:id,targetPort:'context'})
      }
      for(const [index,reference] of (JSON.parse(generation.source_images_json??'[]') as Array<{path?:string}>).entries()) {
        if(!reference.path)continue
        const upload=db.prepare('SELECT id FROM uploads WHERE relative_path=? AND user_id=?').get(reference.path,userId) as {id:string}|undefined
        const asset=upload?undefined:db.prepare(`SELECT a.id,g.id AS generationId FROM assets a JOIN generations g ON g.id=a.generation_id WHERE a.relative_path=? AND a.user_id=? AND g.user_id=? AND g.deleted_at IS NULL AND g.status='succeeded' AND g.kind='image'`).get(reference.path,userId,userId) as {id:string;generationId:string}|undefined
        if(!upload&&!asset){db.prepare('UPDATE quick_canvas_sources SET conflicts_json=? WHERE session_id=? AND source_key=?').run(JSON.stringify(['source_media_missing']),sessionId,`generation:${generation.id}`);continue}
        const source=`${id}:source:${index}`
        const sourceData:CanvasNode['data']=upload?{uploadId:upload.id}:{selectedRunId:(recordQuickRun(db,sessionId,source,'image',asset!.generationId,`history-asset:${asset!.id}`,generation.created_at,asset!.id) as {id:string}).id}
        seed(`generation-source:${generation.id}:${index}`,{id:source,kind:upload?'upload':'image',x:0,y:graph.nodes.length*100,data:sourceData})
        graph.edges.push({id:`${source}:edge`,source,sourcePort:'image',target:id,targetPort:'image'})
      }
      graph.edges.push({id:`${id}:edge`,source:promptId,sourcePort:'prompt',target:id,targetPort:'prompt'})
      const run=recordQuickRun(db,sessionId,id,generation.kind,generation.id,`history:${generation.id}`,generation.created_at) as {id:string}
      data.selectedRunId=run.id
      const importedNode=graph.nodes.find(node=>node.id===id)!
      db.prepare('UPDATE quick_canvas_sources SET snapshot_json=? WHERE session_id=? AND source_key=?').run(JSON.stringify(importedNode),sessionId,`generation:${generation.id}`)
    }
    const session=ownedQuickSession(db,userId,sessionId)
    const fallbackDraft:QuickDraft|undefined=session.prompt_document_json?{kind:'image',promptDocument:JSON.parse(session.prompt_document_json)}:undefined
    if(input.draft??fallbackDraft) {
      const draft=(input.draft??fallbackDraft)!
      if('nodes' in draft) {
        for(const node of draft.nodes) seed(`draft:${node.id}`,node)
        for(const edge of draft.edges) if(!graph.edges.some(entry=>entry.id===edge.id)&&graph.nodes.some(node=>node.id===edge.source)&&graph.nodes.some(node=>node.id===edge.target)) { graph.edges.push(edge);changed=true }
      } else {
        const id='quick-draft',promptId='quick-draft:prompt'
        if(validatePromptDocument(draft.promptDocument).length) throw badRequest('Tài liệu mô tả không hợp lệ')
        seed('draft-prompt',{id:promptId,kind:'prompt',x:0,y:0,data:{text:draft.promptDocument.text,promptDocument:draft.promptDocument}})
        const savedDraft=graph.nodes.find(node=>node.id===id)
        if((input.draft||!savedDraft)&&seed('draft', {id,kind:draft.kind,x:420,y:0,data:{modelId:draft.modelId,allowTemporaryMedia:draft.allowTemporaryMedia===true,...(draft.imagePurpose?{imagePurpose:draft.imagePurpose}:{}),...(draft.imageSettings?{imageSettings:draft.imageSettings}:{}),...(draft.videoSettings?{videoSettings:draft.videoSettings}:{})} as CanvasNode['data']})) {
          seed('draft-prompt',{id:promptId,kind:'prompt',x:0,y:0,data:{text:draft.promptDocument.text,promptDocument:draft.promptDocument}})
          graph.edges.push({id:'quick-draft:edge',source:promptId,sourcePort:'prompt',target:id,targetPort:'prompt'})
          const uploads=[...new Set([...(draft.sourceUploadIds??[]),...(draft.videoInput?.uploadId?[draft.videoInput.uploadId]:[])])]
          const assets=[...new Set([...(draft.sourceAssetIds??[]),...(draft.videoInput?.assetId?[draft.videoInput.assetId]:[])])]
          assets.forEach((assetId,index)=>{
            const asset=db.prepare(`SELECT g.id,g.kind FROM assets a JOIN generations g ON g.id=a.generation_id WHERE a.id=? AND a.user_id=? AND g.user_id=? AND g.kind='image' AND g.status='succeeded' AND g.deleted_at IS NULL AND a.mime_type LIKE 'image/%'`).get(assetId,userId,userId) as {id:string;kind:'image'}|undefined
            if(!asset)throw badRequest('Ảnh nguồn không thuộc tài khoản hoặc chưa thành công')
            const source=`quick-draft:asset:${index}`
            const run=recordQuickRun(db,sessionId,source,'image',asset.id,`draft-asset:${assetId}`,Date.now(),assetId) as {id:string}
            seed(`draft-asset:${index}`,{id:source,kind:'image',x:0,y:400+index*150,data:{selectedRunId:run.id}})
            graph.edges.push({id:`${source}:edge`,source,sourcePort:'image',target:id,targetPort:'image'})
          })
          for(const [index,overlay] of (draft.logoOverlays??[]).entries()) {
            if(!overlay||typeof overlay!=='object')throw badRequest('Logo không hợp lệ')
            const logo=overlay as {entityId?:string;anchor?:string;width?:number;opacity?:number}
            if(!logo.entityId)throw badRequest('Logo không hợp lệ')
            resolveEntity(db,userId,{kind:'logo',id:logo.entityId})
            const source=`quick-draft:logo:${index}`
            seed(`draft-logo:${index}`,{id:source,kind:'library',x:0,y:600+index*150,data:{sourceId:logo.entityId,entityKind:'logo',logoPosition:logo.anchor??'ai',logoWidth:logo.width,logoOpacity:logo.opacity,logoOverlay:overlay} as CanvasNode['data']})
            graph.edges.push({id:`${source}:edge`,source,sourcePort:'object',target:id,targetPort:'context'})
          }
          uploads.forEach((uploadId,index)=>{const source=`quick-draft:upload:${index}`;seed(`draft-upload:${index}`,{id:source,kind:'upload',x:0,y:200+index*150,data:{uploadId}});graph.edges.push({id:`${source}:edge`,source,sourcePort:'image',target:id,targetPort:'image'})})
        }
      }
    }
    for(const source of db.prepare("SELECT source_key FROM quick_canvas_sources WHERE session_id=? AND source_key LIKE 'generation:%'").all(sessionId) as Array<{source_key:string}>) {
      const generationId=source.source_key.slice('generation:'.length)
      const available=generations.some(generation=>generation.id===generationId)
      if(!available)db.prepare('UPDATE quick_canvas_sources SET conflicts_json=? WHERE session_id=? AND source_key=?').run(JSON.stringify(['detached']),sessionId,source.source_key)
    }
    if(changed) {validateQuickGraph(db,userId,sessionId,graph,current.graph);persist(db,userId,sessionId,graph,current.revision+1)}
    return readQuickCanvas(db,userId,sessionId)
  })
}
