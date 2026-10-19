import express, { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Database } from '../db/index'
import type { AppEnv } from '../env'
import type { MediaStore } from '../media/store'
import type { Worker } from '../generations/worker'
import { enqueueGeneration } from '../generations/enqueue'
import { generationPublic } from '../generations/routes'
import type { GenerationRow } from '../generations/types'
import { enqueueImageTask, fingerprintImageInput, getLatestImageTask, acknowledgeImageTaskAttachment } from './imageTasks'
import { refreshImageTask } from './imageTaskState'
import { resolveImageSettings } from '../models/imageSettings'
import { requireUser } from '../auth/middleware'
import { badRequest, validationError } from '../lib/errors'
import { saveSessionUpload, adoptGenerationImage } from './storyboard'
import { ownedSession } from './service'
import { parseJsonLoose } from '../llm/chat'
import { runLoggedLlm } from '../usage/llm'
import { resolveLlmTarget } from '../llm/connections'
import { locationInputSchema, listPlanLocations, savePlanLocations, updatePlanLocation, removePlanLocation, ownedPlanLocation, assignPlanLocation, locationReferencePrompt, planLocationSession } from './locations'
import type { LocationReference } from './artifacts'

export function planLocationRoutes(db:Database,env:AppEnv,mediaStore:MediaStore,worker:Worker):Router {
 const router=Router();const deps={db,env,mediaStore};const raw=express.raw({type:['image/*','application/octet-stream'],limit:env.MAX_REFERENCE_BYTES});
 const reply=(userId:string,id:string)=>({locations:listPlanLocations(db,userId,id),session:planLocationSession(db,userId,id)});
 router.get('/:id/locations',(req,res)=>{const user=requireUser(req);res.json(reply(user.id,req.params.id))});
 router.put('/:id/locations',(req,res)=>{const user=requireUser(req);const parsed=z.object({locations:z.array(locationInputSchema).max(20)}).safeParse(req.body);if(!parsed.success)throw validationError(parsed.error);savePlanLocations(db,user.id,req.params.id,parsed.data.locations);res.json(reply(user.id,req.params.id))});
 router.post('/:id/locations',(req,res)=>{const user=requireUser(req);const parsed=locationInputSchema.safeParse(req.body);if(!parsed.success)throw validationError(parsed.error);savePlanLocations(db,user.id,req.params.id,[...listPlanLocations(db,user.id,req.params.id),parsed.data]);res.status(201).json(reply(user.id,req.params.id))});
 router.post('/:id/locations/propose',async(req,res)=>{const user=requireUser(req);const session=ownedSession(db,user.id,req.params.id);if(!session.chat_model_id)throw badRequest('Phiên chưa chọn model chat. Hãy chọn cấu hình model trước khi đề xuất bối cảnh.');const target=resolveLlmTarget(db,env,user.id,session.chat_model_id);const rawText=await runLoggedLlm({db,env,userId:user.id,target,source:'planner_locations',planSessionId:session.id,projectId:session.project_id,messages:[{role:'system',content:'Suggest up to 20 recurring filming locations as JSON {locations:[{name,stage,description,continuityNotes,imagePrompt}]}. Empty environment only, no people. This is a suggestion, do not modify existing locations.'},{role:'user',content:JSON.stringify({script:session.script_json,existing:listPlanLocations(db,user.id,session.id)})}]});const result=parseJsonLoose(rawText) as {locations?:unknown}|null;const parsed=z.array(locationInputSchema.omit({id:true,reference:true})).max(20).safeParse(result?.locations);if(!parsed.success)throw badRequest('AI không trả về bối cảnh hợp lệ');res.json({...reply(user.id,session.id),locations:[...listPlanLocations(db,user.id,session.id),...parsed.data.map(item=>({...item,id:randomUUID(),reference:null,revision:1}))],suggestions:parsed.data})});
 router.post('/:id/locations/assign',(req,res)=>{const user=requireUser(req);const parsed=z.object({locationId:z.string().nullable(),frameIds:z.array(z.string()).max(30)}).safeParse(req.body);if(!parsed.success)throw validationError(parsed.error);assignPlanLocation(db,user.id,req.params.id,parsed.data.locationId,parsed.data.frameIds);res.json(reply(user.id,req.params.id))});
 router.patch('/:id/locations/:locationId',(req,res)=>{const user=requireUser(req);const parsed=locationInputSchema.partial().safeParse(req.body);if(!parsed.success)throw validationError(parsed.error);updatePlanLocation(db,user.id,req.params.id,req.params.locationId,parsed.data);res.json(reply(user.id,req.params.id))});
 router.delete('/:id/locations/:locationId',(req,res)=>{const user=requireUser(req);removePlanLocation(db,user.id,req.params.id,req.params.locationId);res.json(reply(user.id,req.params.id))});
 router.post('/:id/locations/:locationId/reference',(req,res)=>enqueueLocationReference(req as express.Request<{id:string;locationId:string}>,res));
 router.get('/:id/locations/:locationId/reference/task',(req,res)=>{const user=requireUser(req);const session=ownedSession(db,user.id,req.params.id);ownedPlanLocation(db,user.id,session.id,req.params.locationId);const task=refreshImageTask(db,user.id,getLatestImageTask(db,user.id,'planner',session.id,'location',req.params.locationId));const row=task?.generationId?db.prepare('SELECT * FROM generations WHERE id=? AND user_id=? AND deleted_at IS NULL').get(task.generationId,user.id) as GenerationRow|undefined:undefined;res.json({task,generation:row?generationPublic(row):null})});

  /**
   * Ghi một ảnh góc vào bộ tham chiếu bối cảnh.
   *
   * Cùng nhãn góc (hoặc cùng là sheet) nghĩa là tạo lại góc đó nên thay thế; nhãn
   * mới là thêm một góc, không xoá các góc đang có.
   */
  const applyLocationView=(db:Database,userId:string,sessionId:string,location:LocationReference,uploadId:string,view?:{label?:string;sheet?:boolean})=>{
    const label=(view?.label??'').trim()
    const sheet=view?.sheet===true
    const views=location.referenceViews.filter(item=>sheet? !item.sheet : item.label.trim().toLowerCase()!==label.toLowerCase())
    const next=[...views,{id:randomUUID(),label,uploadId,sheet}]
    updatePlanLocation(db,userId,sessionId,location.id,{referenceViews:next})
  };
  const enqueueLocationReference=(req:express.Request<{id:string;locationId:string}>,res:express.Response)=>{const user=requireUser(req);const session=ownedSession(db,user.id,req.params.id);const location=ownedPlanLocation(db,user.id,session.id,req.params.locationId);const parsed=z.object({modelId:z.string().min(1).optional(),requestKey:z.string().min(1).max(200).optional(),confirmNew:z.boolean().optional(),viewLabel:z.string().trim().max(100).optional()}).safeParse(req.body??{});if(!parsed.success)throw validationError(parsed.error);const modelId=parsed.data.modelId??session.image_model_id;if(!modelId)throw badRequest('Chưa chọn model ảnh');const settings=resolveImageSettings(db,modelId,user.id);const prompt=locationReferencePrompt(location);const fingerprint=fingerprintImageInput({prompt});const outcome=enqueueImageTask({db,userId:user.id,scope:'planner',scopeId:session.id,targetType:'location',targetId:location.id,revision:location.revision,fingerprint,requestKey:parsed.data.requestKey,confirmNew:parsed.data.confirmNew,enqueue:task=>enqueueGeneration({db,env,worker,userId:user.id,request:{data:{modelId,prompt,params:settings.params,idempotencyKey:`image-task-${task.id}`},scene:null}}).generation.id});const row=db.prepare('SELECT * FROM generations WHERE id=? AND user_id=? AND deleted_at IS NULL').get(outcome.task.generationId,user.id) as GenerationRow|undefined;res.status(202).json({task:outcome.task,generation:row?generationPublic(row):null,locationId:location.id,revision:location.revision})};
  router.post('/:id/locations/:locationId/reference',(req,res)=>{return enqueueLocationReference(req,res)});
  router.post('/:id/locations/:locationId/reference/generate',(req,res)=>enqueueLocationReference(req,res));
 router.post('/:id/locations/:locationId/reference/upload',raw,(req,res)=>{const user=requireUser(req);ownedPlanLocation(db,user.id,req.params.id,req.params.locationId);if(!Buffer.isBuffer(req.body))throw badRequest('Ảnh không hợp lệ');const uploadId=saveSessionUpload(deps,user.id,req.body);updatePlanLocation(db,user.id,req.params.id,req.params.locationId,{reference:{uploadId}});res.json(reply(user.id,req.params.id))});
 router.post('/:id/locations/:locationId/reference/attach',(req,res)=>{const user=requireUser(req);const location=ownedPlanLocation(db,user.id,req.params.id,req.params.locationId);const parsed=z.object({generationId:z.string(),assetId:z.string().optional(),revision:z.number().int().optional(),view:z.object({label:z.string().trim().max(100).optional(),sheet:z.boolean().optional()}).optional()}).safeParse(req.body);if(!parsed.success)throw validationError(parsed.error);const prior=db.prepare("SELECT attached_at FROM image_tasks WHERE user_id=? AND scope_id=? AND target_type='location' AND target_id=? AND generation_id=?").get(user.id,req.params.id,location.id,parsed.data.generationId) as {attached_at:number|null}|undefined;if(prior?.attached_at){res.json(reply(user.id,req.params.id));return}if(parsed.data.revision!==undefined&&parsed.data.revision!==location.revision)throw badRequest('Bối cảnh đã thay đổi. Hãy kiểm tra ảnh trước khi gắn.');const task=getLatestImageTask(db,user.id,'planner',req.params.id,'location',location.id);if(task?.generationId===parsed.data.generationId){const modelRow=db.prepare('SELECT model_pk,params_json FROM generations WHERE id=? AND user_id=?').get(task.generationId,user.id) as {model_pk:string;params_json:string}|undefined;const currentFingerprint=modelRow?fingerprintImageInput({prompt:locationReferencePrompt(location)}):'';const accepted=acknowledgeImageTaskAttachment(db,user.id,task.id,location.revision,currentFingerprint,()=>{const uploadId=adoptGenerationImage(deps,user.id,parsed.data.generationId,parsed.data.assetId);applyLocationView(db,user.id,req.params.id,location,uploadId,parsed.data.view)});if(!accepted)throw badRequest("Bối cảnh đã thay đổi hoặc ảnh chưa sẵn sàng. Hãy kiểm tra lại trước khi gắn.");res.json(reply(user.id,req.params.id));return}const uploadId=adoptGenerationImage(deps,user.id,parsed.data.generationId,parsed.data.assetId);applyLocationView(db,user.id,req.params.id,location,uploadId,parsed.data.view);res.json(reply(user.id,req.params.id))});
 router.delete('/:id/locations/:locationId/reference',(req,res)=>{const user=requireUser(req);updatePlanLocation(db,user.id,req.params.id,req.params.locationId,{reference:null});res.json(reply(user.id,req.params.id))});return router
}
