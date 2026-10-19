import { z } from 'zod'
import { withTimelineSync } from '../canvas/timelineSync'
import type { Database } from '../db/index'
import { badRequest, notFound } from '../lib/errors'
import { MAX_LOCATIONS, MAX_LOCATION_VIEWS, newArtifactId, parseLocations, parseScript, parseTimeline, type LocationReference, type LocationView } from './artifacts'
import { ownedSession, sessionPublic, messageCount } from './service'

export const locationViewInputSchema = z.object({ id: z.string().max(100).optional(), label: z.string().trim().max(100).default(''), uploadId: z.string().max(100), sheet: z.boolean().default(false) })
export const locationInputSchema = z.object({ id: z.string().max(100).optional(), name: z.string().trim().min(1).max(200), stage: z.string().trim().max(500).default(''), description: z.string().trim().max(4000).default(''), continuityNotes: z.string().trim().max(4000).default(''), imagePrompt: z.string().trim().max(8000).default(''), reference: z.object({uploadId:z.string().max(100)}).nullable().optional(), referenceViews: z.array(locationViewInputSchema).max(MAX_LOCATION_VIEWS).optional() })
export type LocationInput = z.input<typeof locationInputSchema>
export function transaction<T>(db:Database,fn:()=>T):T { if(db.isTransaction)return fn(); db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value}catch(e){db.exec('ROLLBACK');throw e} }
export function assertLocationUpload(db:Database,userId:string,uploadId:string):void { if(!db.prepare('SELECT id FROM uploads WHERE id = ? AND user_id = ?').get(uploadId,userId))throw notFound('Không tìm thấy ảnh tham chiếu') }
/**
 * Prompt cho ảnh tham chiếu bối cảnh.
 *
 * Bối cảnh cần nhiều góc để cảnh quay ở góc khác vẫn nhất quán, nên prompt yêu cầu
 * một ảnh gộp nhiều ô góc nhìn của CÙNG một không gian: kiến trúc, bố cục, vật thể
 * cố định và ánh sáng phải giống nhau ở mọi ô.
 */
export function locationReferencePrompt(location:LocationReference):string { return ['Neutral cinematic environment reference sheet of a single empty location, no people, no characters, no faces, no text or watermark.',`Location: ${location.name}.`,location.stage,location.description,location.continuityNotes,location.imagePrompt,'One image containing several clearly separated views of the SAME place, consistent architecture, layout, fixed objects and lighting across every view: (1) wide establishing view, (2) view turned to the left, (3) view turned to the right, (4) view from behind, (5) a closer detail view.','Keep the same time of day, colour palette and recurring objects in every view. Do not add people or text; do not draw frame borders or labels.'].filter(Boolean).join(' ').slice(0,8000) }
/**
 * Chuẩn hoá bối cảnh.
 *
 * `reference` là ảnh đại diện suy ra từ view đầu tiên (ưu tiên sheet) để mọi nơi
 * đang đọc một ảnh vẫn hoạt động; `referenceViews` là nguồn sự thật của bộ góc.
 * Đổi bộ ảnh góc là đổi thiết kế nên revision tăng để ảnh storyboard cũ biết mình
 * đã lỗi thời.
 */
export function normalizeLocation(input:LocationInput, previous?:LocationReference):LocationReference {
  const data = locationInputSchema.parse(input)
  const previousViews = previous?.referenceViews ?? []
  // Không gửi `referenceViews` nghĩa là giữ nguyên bộ ảnh cũ; gửi mảng (kể cả rỗng) là thay thế.
  const rawViews = data.referenceViews === undefined
    ? previousViews
    : data.referenceViews.map((view) => ({
        id: view.id ?? newArtifactId(),
        label: view.label,
        uploadId: view.uploadId,
        sheet: view.sheet,
      }))
  const seenViews = new Set<string>()
  const nextViews: LocationView[] = []
  for (const view of rawViews) {
    if (!view.uploadId || seenViews.has(view.uploadId)) continue
    seenViews.add(view.uploadId)
    nextViews.push(view)
    if (nextViews.length >= MAX_LOCATION_VIEWS) break
  }
  // Tương thích ngược: client cũ chỉ gửi `reference` thì coi đó là một view một góc.
  // Chỉ áp dụng khi KHÔNG gửi `referenceViews`: nếu cả hai cùng có, danh sách view
  // là nguồn sự thật, còn `reference` chỉ là ảnh đại diện cũ đi kèm.
  if (data.referenceViews === undefined && data.reference !== undefined) {
    const legacyUpload = data.reference?.uploadId ?? null
    if (!legacyUpload) nextViews.length = 0
    else if (!seenViews.has(legacyUpload)) nextViews.push({ id: newArtifactId(), label: '', uploadId: legacyUpload, sheet: false })
  }
  const reference = nextViews.length ? { uploadId: nextViews[0]!.uploadId } : null
  const next = { id: previous?.id ?? data.id ?? newArtifactId(), name: data.name, stage: data.stage, description: data.description, continuityNotes: data.continuityNotes, imagePrompt: data.imagePrompt, reference, referenceViews: nextViews, revision: previous?.revision ?? 1 }
  if (previous && JSON.stringify({ ...next, revision: 0 }) !== JSON.stringify({ ...previous, revision: 0 })) next.revision = previous.revision + 1
  return next
}
export function listPlanLocations(db:Database,userId:string,sessionId:string):LocationReference[]{return parseLocations(ownedSession(db,userId,sessionId).locations_json)}
export function ownedPlanLocation(db:Database,userId:string,sessionId:string,id:string):LocationReference { const item=listPlanLocations(db,userId,sessionId).find(x=>x.id===id);if(!item)throw notFound('Không tìm thấy bối cảnh');return item }
export function savePlanLocations(db:Database,userId:string,sessionId:string,inputs:LocationInput[]):LocationReference[]{return withTimelineSync(db,sessionId,()=>{const row=ownedSession(db,userId,sessionId);if(inputs.length>MAX_LOCATIONS)throw badRequest('Tối đa 20 bối cảnh');const previous=parseLocations(row.locations_json);const seen=new Set<string>();const next=inputs.map(input=>{const old=previous.find(x=>x.id===input.id);const item=normalizeLocation(input,old);if(seen.has(item.id))throw badRequest('ID bối cảnh bị trùng');seen.add(item.id);for(const view of item.referenceViews)assertLocationUpload(db,userId,view.uploadId);return item});const timeline=parseTimeline(row.timeline_json);const script=parseScript(row.script_json);if(timeline)timeline.frames=timeline.frames.map(frame=>{const location=next.find(x=>x.id===frame.locationId);const old=previous.find(x=>x.id===frame.locationId);return {...frame,locationId:location?.id??null,backgroundStale:frame.backgroundStale===true||Boolean(frame.background&&(!location&&old||location&&old&&location.revision!==old.revision))}});if(script)script.scenes=script.scenes.map(scene=>({...scene,locationId:next.some(x=>x.id===scene.locationId)?scene.locationId:null}));db.prepare('UPDATE plan_sessions SET locations_json = ?, timeline_json = ?, script_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(next),timeline?JSON.stringify(timeline):row.timeline_json,script?JSON.stringify(script):row.script_json,Date.now(),sessionId);return next})}
export function updatePlanLocation(db:Database,userId:string,sessionId:string,id:string,patch:Partial<LocationInput>):LocationReference {const current=listPlanLocations(db,userId,sessionId);const old=ownedPlanLocation(db,userId,sessionId,id);const next=savePlanLocations(db,userId,sessionId,current.map(x=>x.id===id?{...old,...patch,id}:x));return next.find(x=>x.id===id)!}
export function removePlanLocation(db:Database,userId:string,sessionId:string,id:string):void {ownedPlanLocation(db,userId,sessionId,id);savePlanLocations(db,userId,sessionId,listPlanLocations(db,userId,sessionId).filter(x=>x.id!==id))}
export function assignPlanLocation(db:Database,userId:string,sessionId:string,locationId:string|null,frameIds:string[]):void {withTimelineSync(db,sessionId,()=>{const row=ownedSession(db,userId,sessionId);if(locationId)ownedPlanLocation(db,userId,sessionId,locationId);const timeline=parseTimeline(row.timeline_json);if(!timeline)throw badRequest('Timeline chưa có frame');const ids=new Set(frameIds);if(ids.size!==frameIds.length||frameIds.some(id=>!timeline.frames.some(f=>f.id===id)))throw badRequest('Frame không hợp lệ');timeline.frames=timeline.frames.map(frame=>ids.has(frame.id)?{...frame,locationId,backgroundStale:frame.backgroundStale===true||Boolean(frame.background&&frame.locationId!==locationId)}:frame);db.prepare('UPDATE plan_sessions SET timeline_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(timeline),Date.now(),sessionId)})}
export function planLocationSession(db:Database,userId:string,id:string){return sessionPublic(ownedSession(db,userId,id),messageCount(db,id))}
