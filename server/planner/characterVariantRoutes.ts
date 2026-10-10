import { completeCharacterProfiles } from './completeProfiles'
import express, { Router } from 'express'
import { z } from 'zod'
import type { Database } from '../db/index'
import type { AppEnv } from '../env'
import type { MediaStore } from '../media/store'
import { ownedSession, sessionPublic, gatherContext } from './service'
import { parseCast, parseTimeline, parseLocations, type CastMember } from './artifacts'
import { normalizeVariant, normalizeCastMember, MAX_VARIANTS, variantSystemPrompt } from './characterVariants'
import { CHARACTER_PROFILE_KEYS, type CharacterVariant } from '../../shared/characterVariants'
import { badRequest, conflict, notFound, validationError } from '../lib/errors'
import { chatText, parseJsonLoose } from '../llm/chat'
import { resolveLlmTarget } from '../llm/connections'
import { saveSessionUpload, adoptGenerationImage } from './storyboard'
import { buildCharacterSheetPrompt } from '../characters/portrait'

const profileSchema = z.object(Object.fromEntries(CHARACTER_PROFILE_KEYS.map(key => [key, z.string().trim().max(1000).default('')])) as Record<(typeof CHARACTER_PROFILE_KEYS)[number], z.ZodDefault<z.ZodString>>).strict()
const inputSchema = z.object({ label: z.string().trim().min(1).max(200), profile: profileSchema, appearance: z.string().max(4000).optional(), rationale: z.string().max(2000).default(''), assumptions: z.array(z.string().max(500)).max(12).default([]), revision: z.number().int().positive().optional() }).strict()
const revisionSchema = z.object({ revision: z.number().int().positive() }).strict()
export function characterVariantRoutes(options: {
 db: Database; env: AppEnv; mediaStore: MediaStore;
 checkChatLimit: (id: string) => void;
 enqueueImage: (userId: string, session: ReturnType<typeof ownedSession>, prompt: string) => { id: string };
}): Router {
 const { db, env, mediaStore } = options
 const router = Router()
 function load(userId: string, sessionId: string, castId: string) {
  const session = ownedSession(db, userId, sessionId)
  const cast = parseCast(session.cast_json)
  const member = cast.find(x => x.id === castId)
  if (!member) throw notFound('Không tìm thấy nhân vật trong phiên')
  return { session, cast, member }
 }
 function variant(member: CastMember, variantId: string) {
  const value = member.variants?.find(x => x.id === variantId)
  if (!value) throw notFound('Không tìm thấy biến thể nhân vật')
  return value
 }
 function check(value: CharacterVariant, revision: number | undefined) {
  if (revision === undefined || value.revision !== revision) throw conflict('Thiết kế đã thay đổi. Hãy tải lại và kiểm tra trước khi tiếp tục.')
 }
 function save(userId: string, sessionId: string, member: CastMember) {
  // Re-read at commit time: do not overwrite another character's edits after an LLM call.
  const session = ownedSession(db, userId, sessionId)
  const old = parseCast(session.cast_json)
  const previous = old.find(x => x.id === member.id)
  if (!previous) throw notFound('Nhân vật đã bị xóa')
  const next = normalizeCastMember({ ...member, revision: (previous.revision ?? 1) + 1 })
  const cast = old.map(x => x.id === member.id ? next : x)
  const changed = previous.appearance !== next.appearance || previous.portrait?.uploadId !== next.portrait?.uploadId
  const timeline = parseTimeline(session.timeline_json)
  if (timeline && changed) timeline.frames = timeline.frames.map(frame => ({ ...frame, backgroundStale: frame.backgroundStale || Boolean(frame.background && frame.blocking.some(x => x.castId === member.id)) }))
  db.prepare('UPDATE plan_sessions SET cast_json = ?, timeline_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(cast), timeline ? JSON.stringify(timeline) : session.timeline_json, Date.now(), session.id)
  return { session: sessionPublic(ownedSession(db, userId, sessionId), (db.prepare('SELECT COUNT(*) AS n FROM plan_messages WHERE session_id = ?').get(sessionId) as {n:number}).n) }
 }
 // Local middleware uses same authenticated user contract as all plan routes.
 router.use((req, _res, next) => { requireUser(req); next() })
 const base = '/:id/cast/:castId/variants'
 router.post(`${base}/:variantId/profile/complete`, async (req,res) => {
  const user=requireUser(req); const {session,member}=load(user.id,req.params.id,req.params.castId);const old=variant(member,req.params.variantId)
  const data=revisionSchema.safeParse(req.body);if(!data.success)throw validationError(data.error);check(old,data.data.revision)
  options.checkChatLimit(user.id)
  const target=resolveLlmTarget(db,env,user.id,session.chat_model_id??undefined)
  const profiles=await completeCharacterProfiles(env,target,{script:session.script_json,locations:parseLocations(session.locations_json),project:gatherContext(db,user.id,session).project},[{id:old.id,name:member.name,appearance:old.appearance,profile:old.profile}])
  const latest=load(user.id,session.id,member.id).member;const current=variant(latest,old.id);check(current,old.revision)
  if(latest.revision!==member.revision)throw conflict('Nhân vật đã thay đổi trong lúc AI điền hồ sơ. Hãy thử lại.')
  const result=profiles.get(old.id)!
  const updated=normalizeVariant({...old,...result,sourceAppearance:old.sourceAppearance||old.appearance,revision:old.revision+1,generationId:null})
  res.json(save(user.id,session.id,{...latest,variants:latest.variants!.map(v=>v.id===old.id?updated:v)}))
 })
 router.post(`${base}/propose`, async (req, res) => {
  const user = requireUser(req)
  const parsed = z.object({ count: z.number().int().min(1).max(6).default(3), instruction: z.string().max(4000).default('') }).strict().safeParse(req.body ?? {})
  if (!parsed.success) throw validationError(parsed.error)
  const { session, member } = load(user.id, req.params.id, req.params.castId)
  if ((member.variants?.length ?? 0) + parsed.data.count > MAX_VARIANTS) throw badRequest('Mỗi nhân vật lưu tối đa 12 biến thể')
  options.checkChatLimit(user.id)
  const target = resolveLlmTarget(db, env, user.id, session.chat_model_id ?? undefined)
  const raw = await chatText(env, target, [{ role: 'system', content: variantSystemPrompt() }, { role: 'user', content: JSON.stringify({ count: parsed.data.count, instruction: parsed.data.instruction, script: session.script_json, locations: parseLocations(session.locations_json), character: member }) }])
  const result = parseJsonLoose(raw) as { variants?: unknown } | null
  const candidates = z.array(inputSchema.omit({revision:true})).min(1).max(6).safeParse(result?.variants)
  if (!candidates.success) throw badRequest('AI không trả về hồ sơ biến thể hợp lệ. Dữ liệu cũ được giữ nguyên.')
  const current = load(user.id, session.id, member.id).member
  if (current.revision !== member.revision) throw conflict('Nhân vật đã thay đổi trong lúc AI đề xuất. Hãy thử lại.')
  const known = new Set(current.variants?.map(v => v.appearance))
  const additions = candidates.data.slice(0, parsed.data.count).map(v => normalizeVariant(v)).filter(v => { if (!v.appearance || known.has(v.appearance)) return false; known.add(v.appearance); return true })
  if (!additions.length) throw badRequest('AI không đề xuất thiết kế mới khác biệt')
  res.json(save(user.id, session.id, { ...current, variants: [...current.variants!, ...additions] }))
 })
 router.post(base, (req, res) => {
  const user = requireUser(req); const {member} = load(user.id, req.params.id, req.params.castId)
  const data = inputSchema.safeParse(req.body); if (!data.success) throw validationError(data.error)
  if (member.variants!.length >= MAX_VARIANTS) throw badRequest('Mỗi nhân vật lưu tối đa 12 biến thể')
  res.status(201).json(save(user.id, req.params.id, {...member, variants: [...member.variants!, normalizeVariant(data.data)]}))
 })
 router.patch(`${base}/:variantId`, (req,res) => {
  const user = requireUser(req); const {member} = load(user.id, req.params.id, req.params.castId); const old = variant(member, req.params.variantId)
  const data = inputSchema.safeParse(req.body); if (!data.success) throw validationError(data.error); check(old,data.data.revision)
  const edited = normalizeVariant({...old,...data.data,revision:old.revision+1,generationId:null})
  res.json(save(user.id,req.params.id,{...member,variants:member.variants!.map(v=>v.id===old.id?edited:v)}))
 })
 router.delete(`${base}/:variantId`, (req,res)=>{
  const user=requireUser(req);const {member}=load(user.id,req.params.id,req.params.castId);const old=variant(member,req.params.variantId)
  const data=revisionSchema.safeParse(req.body);if(!data.success)throw validationError(data.error);check(old,data.data.revision)
  if(member.selectedVariantId===old.id)throw badRequest('Hãy chọn bản chính khác trước khi xóa biến thể này')
  res.json(save(user.id,req.params.id,{...member,variants:member.variants!.filter(v=>v.id!==old.id)}))
 })
 router.post(`${base}/:variantId/select`,(req,res)=>{
  const user=requireUser(req);const {member}=load(user.id,req.params.id,req.params.castId);const old=variant(member,req.params.variantId)
  const data=revisionSchema.safeParse(req.body);if(!data.success)throw validationError(data.error);check(old,data.data.revision)
  res.json(save(user.id,req.params.id,{...member,selectedVariantId:old.id}))
 })
 router.post(`${base}/:variantId/portrait`,(req,res)=>{
  const user=requireUser(req);const {session,member}=load(user.id,req.params.id,req.params.castId);const old=variant(member,req.params.variantId)
  const context = gatherContext(db, user.id, session)
  let visualStyle = context.project?.style ?? ''
  try { visualStyle ||= (JSON.parse(session.ideas_json ?? '{}') as {visualStyle?:string}).visualStyle ?? '' } catch { /* malformed legacy ideas */ }
  const generation=options.enqueueImage(user.id,session,buildCharacterSheetPrompt({name:member.name,appearance:old.appearance,style:visualStyle}))
  save(user.id,req.params.id,{...member,variants:member.variants!.map(v=>v.id===old.id?{...v,generationId:generation.id}:v)})
  res.status(202).json({generation,revision:old.revision})
 })
 router.post(`${base}/:variantId/portrait/attach`,(req,res)=>{
  const user=requireUser(req);const {member}=load(user.id,req.params.id,req.params.castId);const old=variant(member,req.params.variantId)
  const data=z.object({generationId:z.string().min(1),assetId:z.string().optional(),revision:z.number().int().positive()}).strict().safeParse(req.body);if(!data.success)throw validationError(data.error);check(old,data.data.revision)
  if(old.generationId!==data.data.generationId)throw conflict('Tác vụ không thuộc thiết kế hiện tại')
  const uploadId=adoptGenerationImage({db,env,mediaStore},user.id,data.data.generationId,data.data.assetId)
  res.status(201).json(save(user.id,req.params.id,{...member,variants:member.variants!.map(v=>v.id===old.id?{...v,portrait:{uploadId},portraitRevision:v.revision,generationId:null}:v)}))
 })
 router.post(`${base}/:variantId/portrait/upload`,express.raw({type:['image/*','application/octet-stream'],limit:env.MAX_REFERENCE_BYTES}),(req,res)=>{
  const user=requireUser(req);const {member}=load(user.id,req.params.id,req.params.castId);const old=variant(member,req.params.variantId);check(old,Number(req.query.revision))
  if(!Buffer.isBuffer(req.body)||!req.body.length)throw badRequest('Ảnh không hợp lệ')
  const uploadId=saveSessionUpload({db,env,mediaStore},user.id,req.body)
  res.json(save(user.id,req.params.id,{...member,variants:member.variants!.map(v=>v.id===old.id?{...v,portrait:{uploadId},portraitRevision:v.revision,generationId:null}:v)}))
 })
 router.delete(`${base}/:variantId/portrait`,(req,res)=>{
  const user=requireUser(req);const {member}=load(user.id,req.params.id,req.params.castId);const old=variant(member,req.params.variantId)
  const data=revisionSchema.safeParse(req.body);if(!data.success)throw validationError(data.error);check(old,data.data.revision)
  res.json(save(user.id,req.params.id,{...member,variants:member.variants!.map(v=>v.id===old.id?{...v,portrait:null,portraitRevision:null,generationId:null}:v)}))
 })
 return router
}
import { requireUser } from '../auth/middleware'
