import { createHash } from 'node:crypto'
import { resetQuickGroup } from './reset'
import { Router, type Request } from 'express'
import { z } from 'zod'
import type { Database } from '../db/index'
import type { AppEnv } from '../env'
import type { MediaStore } from '../media/store'
import type { Worker } from '../generations/worker'
import { requireUser } from '../auth/middleware'
import { AppError, badRequest, notFound, validationError } from '../lib/errors'
import type { CanvasGraph, CanvasNode } from '../../shared/canvas'
import { compileCanvasPrompt, assertMentionsResolved } from '../canvas/compiler'
import { planCanvasInputs } from '../canvas/resolve'
import { canvasStamp } from '../canvas/service'
import { renderComposite, type CompositeSource } from '../canvas/composite'
import { enqueueGeneration, type EnqueueRequest } from '../generations/enqueue'
import { generationPublic } from '../generations/routes'
import { effectiveCanvasVideoParams } from '../../shared/canvasVideoSettings'
import { completeSceneVideoParams, sceneVideoStyle } from '../../shared/sceneVideoParams'
import { readQuickCanvas, writeQuickCanvas, syncQuickCanvas, listQuickRuns, recordQuickRun, resolveQuickObjects, type QuickDraft } from './service'

const saveSchema=z.object({graph:z.unknown(),baseRevision:z.number().int().nonnegative()})
const draftSchema=z.object({kind:z.enum(['image','video']),promptDocument:z.object({version:z.literal(1),text:z.string().max(8000),mentions:z.array(z.unknown())}),modelId:z.string().optional(),imageSettings:z.object({size:z.string().max(50).optional(),quality:z.string().max(50).optional(),n:z.number().int().min(1).max(4).optional()}).optional(),videoSettings:z.unknown().optional(),sourceUploadIds:z.array(z.string().min(1)).max(16).optional(),sourceAssetIds:z.array(z.string().min(1)).max(16).optional(),videoInput:z.object({uploadId:z.string().min(1).optional(),assetId:z.string().min(1).optional()}).optional(),logoOverlays:z.array(z.unknown()).max(8).optional(),allowTemporaryMedia:z.boolean().optional(),imagePurpose:z.unknown().optional()})
const syncSchema=z.object({baseRevision:z.number().int().nonnegative().optional(),draft:draftSchema.optional()})
const previewSchema=z.object({kind:z.enum(['image','video'])})
const runSchema=previewSchema.extend({stamp:z.string().min(1),modelId:z.string().optional(),sceneId:z.string().nullable().optional(),idempotencyKey:z.string().max(100).optional()})
const single=(value:unknown):string=>{if(typeof value!=='string'||!value)throw badRequest('Thiếu ID');return value}
const sessionIdOf=(req:Request)=>single((req.params as Record<string,unknown>).id)
export function quickCanvasRoutes(db:Database,env:AppEnv,mediaStore:MediaStore,worker:Worker):Router {
  const router=Router({mergeParams:true})
  const board=(userId:string,id:string)=>readQuickCanvas(db,userId,id)
  function requireNode(userId:string,id:string,nodeId:string) {
    const canvas=board(userId,id),node=canvas.graph.nodes.find(entry=>entry.id===nodeId)
    if(!node)throw notFound('Không tìm thấy node trong bảng Canvas')
    return {graph:canvas.graph,node}
  }
  function selectedAsset(userId:string,id:string,source:CanvasNode) {
    if(!source.data.selectedRunId)return undefined
    const row=db.prepare(`SELECT a.id AS assetId,a.relative_path AS path,a.mime_type AS mime,r.id AS runId FROM quick_canvas_runs r
      JOIN generations g ON g.id=r.generation_id JOIN assets a ON a.generation_id=g.id
      WHERE r.id=? AND r.session_id=? AND r.node_id=? AND r.kind='image' AND g.user_id=?
      AND g.status='succeeded' AND g.kind='image' AND g.deleted_at IS NULL AND a.user_id=? AND a.mime_type LIKE 'image/%' AND (r.asset_id IS NULL OR a.id=r.asset_id)
      ORDER BY a.created_at,a.id LIMIT 1`).get(source.data.selectedRunId,id,source.id,userId,userId) as {assetId:string;path:string;mime:string;runId:string}|undefined
    if(!row)throw badRequest('Ảnh đầu ra đã chọn chưa thành công hoặc không thuộc node/phiên này')
    return {...row,nodeId:source.id}
  }
  function videoInput(userId:string,id:string,graph:CanvasGraph,node:CanvasNode) {
    const ids=[...new Set(graph.edges.filter(edge=>edge.target===node.id&&edge.targetPort==='image').map(edge=>edge.source))]
    const selected=node.data.videoInputNodeId
    if(selected&&!ids.includes(selected))throw badRequest('Ảnh video đã chọn không còn nối vào node này')
    if(!selected&&ids.length>1)throw badRequest('Có nhiều ảnh đầu vào. Hãy chọn một ảnh cho video.')
    const source=graph.nodes.find(entry=>entry.id===(selected??ids[0]))
    if(!source)return null
    const asset=selectedAsset(userId,id,source)
    if(asset)return asset
    const uploadId=source.data.uploadId
    const upload=uploadId?db.prepare("SELECT relative_path AS path,mime_type AS mime FROM uploads WHERE id=? AND user_id=? AND mime_type LIKE 'image/%'").get(uploadId,userId) as {path:string;mime:string}|undefined:undefined
    if(!upload)throw badRequest('Node ảnh đầu vào chưa có ảnh hợp lệ')
    return {...upload,nodeId:source.id,uploadId:uploadId!}
  }
  function compile(userId:string,graph:CanvasGraph,node:CanvasNode,strict=false) {
    const objects=resolveQuickObjects(db,userId,graph)
    const compiled=compileCanvasPrompt({graph,node,objects,projectStyle:'',aspectRatio:node.data.layout?.aspectRatio})
    if(!compiled.prompt.trim())throw badRequest('Node chưa có nội dung để gửi',undefined,{messageKey:'canvas.prompt_empty'})
    const exactLogos=new Set(graph.nodes.filter(source=>source.kind==='library'&&source.data.entityKind==='logo'&&(source.data.logoOverlay||source.data.logoPosition&&source.data.logoPosition!=='ai')).map(source=>source.id))
    // Exact logos are post-processing inputs, never image-provider references.
    const exactLogoIds=new Set(objects.filter(entry=>exactLogos.has(entry.nodeId)).map(entry=>entry.recordId))
    const overlayRefs=new Set(objects.filter(entry=>exactLogoIds.has(entry.recordId)).map(entry=>entry.nodeId))
    const selectedOutputs=new Set(graph.nodes.filter(source=>source.data.selectedRunId).map(source=>source.id))
    const providerCompiled={...compiled,inputRefs:compiled.inputRefs.filter(ref=>!(ref.reason==='object'&&overlayRefs.has(ref.nodeId??''))&&!(ref.reason==='upstream'&&selectedOutputs.has(ref.nodeId??'')))}
    return {compiled,objects,planned:planCanvasInputs(providerCompiled,env.MAX_SOURCE_IMAGES,strict&&node.kind==='image')}
  }
  function requestFor(userId:string,id:string,graph:CanvasGraph,node:CanvasNode,strict=false):EnqueueRequest {
    const {compiled,planned,objects}=compile(userId,graph,node,strict)
    if(strict)assertMentionsResolved(compiled)
    const modelId=node.data.modelId
    const model=db.prepare('SELECT id,kind,model_id AS modelId,video_api_style AS videoApiStyle FROM models WHERE id=? AND user_id=? AND enabled=1').get(modelId??'',userId) as {id:string;kind:string;modelId:string;videoApiStyle?:'openai'|'agnes'|'higgsfield'}|undefined
    if(!model||model.kind!==node.kind)throw badRequest('Vui lòng chọn model phù hợp cho node')
    const bound=new Set(compiled.contextDocuments.flatMap(doc=>doc.mentions.map(binding=>`${binding.entity.kind}:${binding.entity.id}`)))
    const contextDocuments=[...compiled.contextDocuments,...compiled.mentions.filter(entry=>entry.entity&&!bound.has(`${entry.entity.kind}:${entry.entity.id}`)).map(entry=>({version:1 as const,text:`@${entry.handle}`,mentions:[{id:`context:${entry.nodeId}`,start:0,end:entry.handle!.length+1,label:entry.handle!,entity:entry.entity!}]}))]
    const incoming=new Set(graph.edges.filter(edge=>edge.target===node.id).map(edge=>edge.source))
    const imageInputs=new Set(graph.edges.filter(edge=>edge.target===node.id&&edge.targetPort==='image').map(edge=>edge.source))
    const sourceAssetIds=graph.nodes.filter(source=>imageInputs.has(source.id)&&source.kind==='image'&&source.data.selectedRunId).map(source=>selectedAsset(userId,id,source)!.assetId)
    const extension=node.data as CanvasNode['data']&{imageSettings?:{size?:string;quality?:string;n?:number};imagePurpose?:EnqueueRequest['data']['imagePurpose']}
    let params:Record<string,unknown>=node.kind==='image'?{size:'1024x1024',n:1,...extension.imageSettings,useCharacterReference:planned.characterIds.length>0}:node.data.videoSettings?effectiveCanvasVideoParams(model,{},node.data.videoSettings):completeSceneVideoParams(model,{})
    const input=node.kind==='video'?videoInput(userId,id,graph,node):null
    if(input&&node.kind==='video'){
      const style=sceneVideoStyle(model)
      if(style==='higgsfield'){params.mode='image';delete params.aspectRatio;delete params.outputFormat}
      if(style==='agnes')params.mode=params.mode==='reference'?'reference':'keyframe'
    }
    const logoOverlays=objects.filter(entry=>entry.kind==='logo'&&incoming.has(entry.nodeId)).flatMap(entry=>{
      const data=graph.nodes.find(source=>source.id===entry.nodeId)!.data as CanvasNode['data']&{logoPosition?:string;logoWidth?:number;logoOpacity?:number}
      if(data.logoOverlay)return [{...data.logoOverlay,entityId:entry.recordId}]
      if(!data.logoPosition||data.logoPosition==='ai')return []
      return [{entityId:entry.recordId,x:0.05,y:0.05,width:data.logoWidth??0.15,opacity:data.logoOpacity??1,anchor:data.logoPosition}]
    }) as EnqueueRequest['data']['logoOverlays']
    const placements=new Map<string,string>()
    for(const overlay of logoOverlays??[]) {
      const value=JSON.stringify(overlay),previous=placements.get(overlay.entityId)
      if(previous&&previous!==value)throw badRequest('Cùng một logo có nhiều bố trí khác nhau. Hãy giữ một bố trí duy nhất.')
      placements.set(overlay.entityId,value)
    }
    return {data:{modelId:model.id,prompt:compiled.prompt,quickSessionId:id,params,...(extension.imagePurpose?{imagePurpose:extension.imagePurpose}:{}),
      ...(planned.characterIds.length?{characterIds:planned.characterIds}:{}),
      ...(node.kind==='image'&&planned.uploadIds.length?{sourceUploadIds:planned.uploadIds}:{}),
      ...(node.kind==='image'&&sourceAssetIds.length?{sourceAssetIds}:{}),
      ...(logoOverlays?.length?{logoOverlays}:{}),allowTemporaryMedia:node.data.allowTemporaryMedia===true},
      scene:null,videoInput:input,contextDocuments,canvas:{quickSessionId:id,nodeId:node.id,kind:node.kind}}
  }
  function stamp(userId:string,id:string,graph:CanvasGraph,node:CanvasNode) {
    let request:unknown
    try{request=requestFor(userId,id,graph,node)}catch(error){request={invalid:error instanceof Error?error.message:String(error)}}
    const model=node.data.modelId?db.prepare('SELECT * FROM models WHERE id=? AND user_id=?').get(node.data.modelId,userId):null
    const cast=db.prepare(`SELECT c.* FROM quick_session_characters q JOIN characters c ON c.id=q.character_id WHERE q.session_id=? AND c.user_id=? ORDER BY q.position`).all(id,userId)
    return createHash('sha256').update(JSON.stringify({quickSessionId:id,graph:canvasStamp(graph,node.id,resolveQuickObjects(db,userId,graph)),request,model,cast,maxReferences:env.MAX_SOURCE_IMAGES,origin:env.APP_ORIGIN})).digest('hex')
  }
  router.get('/',(req,res)=>{res.json({canvas:board(requireUser(req).id,sessionIdOf(req))})})
  router.put('/',(req,res)=>{const parsed=saveSchema.safeParse(req.body);if(!parsed.success)throw validationError(parsed.error);res.json({canvas:writeQuickCanvas(db,requireUser(req).id,sessionIdOf(req),parsed.data)})})
  router.post('/groups/:groupId/reset-session',(req,res)=>{const parsed=z.object({baseRevision:z.number().int().nonnegative()}).safeParse(req.body);if(!parsed.success)throw validationError(parsed.error);res.json({canvas:resetQuickGroup(db,requireUser(req).id,sessionIdOf(req),single(req.params.groupId),parsed.data.baseRevision)})})
  router.get('/runs',(req,res)=>{const id=sessionIdOf(req);board(requireUser(req).id,id);res.json({runs:listQuickRuns(db,id)})})
  router.post('/sync',(req,res)=>{const parsed=syncSchema.safeParse(req.body);if(!parsed.success)throw validationError(parsed.error);res.json({canvas:syncQuickCanvas(db,requireUser(req).id,sessionIdOf(req),parsed.data as {baseRevision?:number;draft?:QuickDraft|CanvasGraph})})})
  router.post('/nodes/:nodeId/preview',(req,res)=>{
    const userId=requireUser(req).id,id=sessionIdOf(req),parsed=previewSchema.safeParse(req.body)
    if(!parsed.success)throw validationError(parsed.error)
    const {graph,node}=requireNode(userId,id,single(req.params.nodeId))
    if(node.kind!==parsed.data.kind)throw badRequest('Loại node không khớp')
    const {compiled,planned}=compile(userId,graph,node)
    let central:import('../generations/enqueue').GenerationPreview|null=null
    const warnings:string[]=[]
    let request:EnqueueRequest|undefined
    try{request=requestFor(userId,id,graph,node);if(!compiled.unresolved.length&&!planned.dropped.length)central=enqueueGeneration({db,env,mediaStore,userId,previewOnly:true,request}) as never}catch(error){warnings.push(error instanceof Error?error.message:String(error))}
    const preview=central as import('../generations/enqueue').GenerationPreview|null
    const model=db.prepare('SELECT id,display_name AS displayName,kind,model_id AS modelId FROM models WHERE id=? AND user_id=? AND enabled=1').get(node.data.modelId??'',userId)
    res.json({preview:{nodeId:node.id,kind:node.kind,stamp:stamp(userId,id,graph,node),prompt:preview?.prompt??compiled.prompt,userText:compiled.userText,
      mentions:compiled.mentions.map(entry=>({nodeId:entry.nodeId,alias:entry.alias,kind:entry.kind,name:entry.name,hasReference:Boolean(entry.reference)})),unresolved:compiled.unresolved,
      inputs:compiled.inputRefs.map(ref=>({kind:ref.kind,label:ref.label,reason:ref.reason,nodeId:ref.nodeId,url:ref.uploadId?`/api/uploads/${ref.uploadId}`:ref.characterId?`/api/characters/${ref.characterId}/reference`:'',sent:Boolean(preview&&(ref.kind==='upload'?planned.uploadIds.includes(ref.uploadId??''):planned.characterIds.includes(ref.characterId??'')))})),
      overlays:preview?.overlays??[],
      warnings:[...compiled.warnings,...planned.warnings,...warnings,...(preview?.warnings??[])],runnable:Boolean(preview),limits:{maxImages:preview?.maxReferenceCount??env.MAX_SOURCE_IMAGES,sentImages:preview?.referenceCount??0},model:model??null,...(node.kind==='video'&&request?{videoParams:request.data.params}:{})}})
  })
  router.post('/nodes/:nodeId/run',(req,res)=>{
    const userId=requireUser(req).id,id=sessionIdOf(req),parsed=runSchema.safeParse(req.body)
    if(!parsed.success)throw validationError(parsed.error)
    const {graph,node}=requireNode(userId,id,single(req.params.nodeId))
    if(node.kind!==parsed.data.kind||parsed.data.sceneId)throw badRequest('Loại node không khớp')
    const inputStamp=stamp(userId,id,graph,node)
    if(inputStamp!==parsed.data.stamp||(parsed.data.modelId!==undefined&&parsed.data.modelId!==node.data.modelId))throw badRequest('Bảng Canvas đã thay đổi sau khi xem trước',undefined,{messageKey:'canvas.preview_stale'})
    const request=requestFor(userId,id,graph,node,true)
    request.canvas={quickSessionId:id,nodeId:node.id,nodeKind:node.kind,kind:node.kind,stamp:inputStamp,graph,mentions:compile(userId,graph,node).compiled.mentions}
    if(parsed.data.idempotencyKey)request.data.idempotencyKey=`quick-canvas:${createHash('sha256').update(JSON.stringify([id,node.id,inputStamp,parsed.data.idempotencyKey])).digest('hex')}`
    const outcome=enqueueGeneration({db,env,mediaStore,worker,userId,request})
    const run=recordQuickRun(db,id,node.id,parsed.data.kind,outcome.generation.id,inputStamp)
    res.status(202).json({generation:generationPublic(outcome.generation),run})
  })
  router.post('/nodes/:nodeId/composite',async(req,res)=>{
    const userId=requireUser(req).id,id=sessionIdOf(req),{graph,node}=requireNode(userId,id,single(req.params.nodeId))
    if(node.kind!=='image'||!node.data.layout?.instances.length)throw badRequest('Chưa có bố trí cho node ảnh')
    const uploadPath=(uploadId:string)=>{const row=db.prepare('SELECT relative_path AS path FROM uploads WHERE id=? AND user_id=?').get(uploadId,userId) as {path:string}|undefined;if(!row)throw badRequest('Ảnh không thuộc tài khoản');return row.path}
    const objects=resolveQuickObjects(db,userId,graph)
    const source=(nodeId:string):CompositeSource|null=>{const entry=objects.find(object=>object.nodeId===nodeId);if(!entry?.reference)return null
      if(entry.reference.kind==='upload')return {nodeId,path:uploadPath(entry.reference.uploadId)}
      const character=db.prepare('SELECT reference_path AS path FROM characters WHERE id=? AND user_id=? AND deleted_at IS NULL').get(entry.reference.characterId,userId) as {path:string|null}|undefined
      return character?.path?{nodeId,path:character.path}:null}
    try {const result=await renderComposite({db,env,mediaStore,userId,node,background:node.data.layout.backgroundNodeId?source(node.data.layout.backgroundNodeId):null,
      instances:node.data.layout.instances.map(placement=>({placement,source:placement.imageUploadId?{nodeId:placement.sourceNodeId,path:uploadPath(placement.imageUploadId)}:source(placement.sourceNodeId)}))})
      res.status(201).json({upload:{id:result.uploadId,url:`/api/uploads/${result.uploadId}`,width:result.width,height:result.height}})
    }catch(error){if(error instanceof AppError)throw error;throw badRequest('Không ghép được ảnh từ bố trí',undefined,{messageKey:'canvas.composite_failed'})}
  })
  return router
}
