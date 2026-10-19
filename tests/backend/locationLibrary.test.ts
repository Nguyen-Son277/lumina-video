import { beforeEach, afterEach, describe, it, expect } from 'vitest'
import { startTestServer, registerUser, call, type TestContext } from './helpers'
import { listEntityCatalog, patchLibraryAsset, createLibraryAsset, resolveEntity, updateEntityHandle } from '../../server/entityLibrary/service'
import { saveProjectLocation, removeProjectLocation } from '../../server/projects/locations'
import { linkLocationSources, reconcileLocationLibrary } from '../../server/entityLibrary/locationSync'
import { uploadReferenced } from '../../server/entityLibrary/lifecycle'
let ctx: TestContext, userId: string
beforeEach(async()=>{ctx=await startTestServer();userId=(await registerUser(ctx)).userId})
afterEach(async()=>{await ctx.close()})
describe('library location identity and linked sources',()=>{
 it('supports standalone location identities with cross-kind handle uniqueness',()=>{
   const e=createLibraryAsset(ctx.db,userId,{kind:'location',name:'Forest'})
   expect(resolveEntity(ctx.db,userId,{kind:'location',id:e.id})).toMatchObject({kind:'location',handle:'forest'})
   expect(()=>createLibraryAsset(ctx.db,userId,{kind:'item',name:'Forest'})).toThrow()
 })
 it('reconciles source metadata by stable IDs, guards linked writes, hides deleted source and restores same identity',async()=>{
   const project=(await call(ctx,'/api/projects',{method:'POST',body:{name:'Film'}})).body.project
   ctx.db.prepare('INSERT INTO uploads(id,user_id,relative_path,mime_type,byte_size,created_at) VALUES (?,?,?,?,?,?)').run('forest',userId,`${userId}/uploads/forest.png`,'image/png',12,Date.now())
    const loc=saveProjectLocation(ctx.db,userId,project.id,{name:'Forest',description:'Trees',reference:{uploadId:'forest'}})
   const entity=listEntityCatalog(ctx.db,userId).find(e=>e.source?.entityId===loc.id)!
   expect(entity).toMatchObject({kind:'location',source:{kind:'project',scopeId:project.id}})
   expect(()=>patchLibraryAsset(ctx.db,userId,entity.id,{name:'not allowed'})).toThrow()
    expect(updateEntityHandle(ctx.db,userId,{kind:'location',id:entity.id},'forest-custom').handle).toBe('forest-custom')
   saveProjectLocation(ctx.db,userId,project.id,{...loc,name:'Green forest'},loc.id)
   expect(listEntityCatalog(ctx.db,userId).find(e=>e.id===entity.id)?.name).toBe('Green forest')
   ctx.db.prepare('UPDATE projects SET deleted_at=? WHERE id=?').run(Date.now(),project.id)
   reconcileLocationLibrary(ctx.db,userId)
   expect(listEntityCatalog(ctx.db,userId).some(e=>e.id===entity.id)).toBe(false)
   ctx.db.prepare('UPDATE projects SET deleted_at=NULL WHERE id=?').run(project.id)
   expect(listEntityCatalog(ctx.db,userId).find(e=>e.id===entity.id)?.name).toBe('Green forest')
   removeProjectLocation(ctx.db,userId,project.id,loc.id)
   expect(listEntityCatalog(ctx.db,userId).some(e=>e.id===entity.id)).toBe(false)
   expect(ctx.db.prepare('SELECT id FROM entity_handles WHERE entity_id=?').get(entity.id)).toBeTruthy()
 })
 it('retains nonprimary views by owner-scoped JSON, including unavailable linked sources',()=>{
   const e=createLibraryAsset(ctx.db,userId,{kind:'location',name:'Views'})
   const path=`${userId}/uploads/side.png`
   ctx.db.prepare('INSERT INTO uploads(id,user_id,relative_path,mime_type,byte_size,created_at) VALUES (?,?,?,?,?,?)').run('side',userId,path,'image/png',12,Date.now())
   ctx.db.prepare('UPDATE library_assets SET reference_views_json=?,source_deleted=1 WHERE id=?').run(JSON.stringify([{uploadId:'side'}]),e.id)
   expect(uploadReferenced(ctx.db,'side',path)).toBe(true)
 })
})


describe('validated source views and persistent provenance',()=>{
 function upload(id:string, owner=userId){ctx.db.prepare('INSERT INTO uploads(id,user_id,relative_path,mime_type,byte_size,created_at) VALUES (?,?,?,?,?,?)').run(id,owner,`${owner}/uploads/${id}.png`,'image/png',12,Date.now())}
 it('excludes image-less sources and filters forged foreign/nonimage views',async()=>{
   const project=(await call(ctx,'/api/projects',{method:'POST',body:{name:'Refs'}})).body.project
   const loc=saveProjectLocation(ctx.db,userId,project.id,{name:'No image'})
   expect(listEntityCatalog(ctx.db,userId).filter(e=>e.source)).toHaveLength(0)
   upload('valid');upload('wrong-mime')
   const other=(await registerUser(ctx)).userId;upload('foreign-view',other)
   ctx.db.prepare("UPDATE uploads SET mime_type='video/mp4' WHERE id='wrong-mime'").run()
   ctx.db.prepare('UPDATE project_locations SET reference_upload_id=?,reference_views_json=?,revision=7 WHERE id=?').run('wrong-mime',JSON.stringify([{id:'one',uploadId:'valid',label:'wide'},{uploadId:'missing'},{uploadId:'wrong-mime'},{uploadId:'foreign-view'}]),loc.id)
   const entity=listEntityCatalog(ctx.db,userId).find(e=>e.source)!
   expect(entity.reference?.uploadId).toBe('valid')
   expect(entity.referenceViews).toEqual([{id:'one',uploadId:'valid',label:'wide',sheet:false}])
   expect(entity.source?.revision).toBe(7)
 })
 it('deduplicates actual planner/project mappings and keeps identity after source hard deletion',async()=>{
   const project=(await call(ctx,'/api/projects',{method:'POST',body:{name:'Mapping'}})).body.project
   upload('timeline-view');upload('project-view')
   const session='source-session'
   ctx.db.prepare("INSERT INTO plan_sessions(id,user_id,kind,title,status,locations_json,created_at,updated_at) VALUES(?,?,'planner','Plan','setup',?,?,?)").run(session,userId,JSON.stringify([{id:'forest-source',name:'Timeline forest',description:'',continuityNotes:'',revision:4,reference:{uploadId:'timeline-view'}}]),Date.now(),Date.now())
   const original=listEntityCatalog(ctx.db,userId).find(e=>e.source?.kind==='timeline')!
   const loc=saveProjectLocation(ctx.db,userId,project.id,{name:'Project forest',reference:{uploadId:'project-view'}})
   linkLocationSources(ctx.db,userId,session,'forest-source',project.id,loc.id)
   const merged=listEntityCatalog(ctx.db,userId).filter(e=>e.source)
   expect(merged).toHaveLength(1);expect(merged[0]!.id).toBe(original.id)
   ctx.db.prepare('DELETE FROM plan_sessions WHERE id=?').run(session)
   const fallback=listEntityCatalog(ctx.db,userId).find(e=>e.source)!
   expect(fallback.id).toBe(original.id);expect(fallback.source?.kind).toBe('project')
   expect(fallback.reference?.uploadId).toBe('project-view')
   ctx.db.prepare(`INSERT INTO generations(id,user_id,kind,prompt,snap_provider,snap_base_url,snap_model_id,status,source_images_json,created_at,updated_at) VALUES('frozen-generation',?,'image','frozen','mock','https://mock.test','mock','succeeded',?,1,1)`).run(userId,JSON.stringify({reference:{uploadId:'project-view',path:`${userId}/uploads/project-view.png`}}))
   ctx.db.prepare('DELETE FROM project_locations WHERE id=?').run(loc.id)
   reconcileLocationLibrary(ctx.db,userId)
   const tombstone=ctx.db.prepare('SELECT reference_upload_id,reference_views_json,source_deleted FROM library_assets WHERE id=?').get(original.id)
   expect(tombstone).toMatchObject({reference_upload_id:null,reference_views_json:'[]',source_deleted:1})
   expect(ctx.db.prepare("SELECT 1 FROM media_cleanup_jobs WHERE target_id='project-view'").get()).toBeTruthy()
   expect(uploadReferenced(ctx.db,'project-view',`${userId}/uploads/project-view.png`)).toBe(true)
 })
})
