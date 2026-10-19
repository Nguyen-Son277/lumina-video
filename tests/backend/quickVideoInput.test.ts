import { beforeEach,afterEach,it,expect } from 'vitest'
import { call,registerUser,seedProviderAndModel,startTestServer,type TestContext } from './helpers'
import { resolvePromptDocument } from '../../server/entityLibrary/mentions'
import { createLibraryAsset } from '../../server/entityLibrary/service'
import { insertPromptMention } from '../../shared/promptMentions'
import { MOCK_PNG_BYTES } from '../../server/generations/adapters/mock'
let ctx:TestContext,userId:string,modelId:string
beforeEach(async()=>{ctx=await startTestServer();await ctx.worker.stop();userId=(await registerUser(ctx)).userId;modelId=(await seedProviderAndModel(ctx,'video')).modelPk})
afterEach(async()=>{await ctx.close()})
it('accepts owned input image for quick video preview and rejects foreign or ambiguous sources',async()=>{
 const upload=ctx.mediaStore.saveUpload({userId,uploadId:'video-input',bytes:MOCK_PNG_BYTES,maxBytes:ctx.env.MAX_IMAGE_BYTES})
 ctx.db.prepare('INSERT INTO uploads(id,user_id,relative_path,mime_type,byte_size,created_at) VALUES(?,?,?,?,?,?)').run('video-input',userId,upload.relativePath,upload.mimeType,upload.byteSize,Date.now())
 const request={modelId,prompt:'Animate landscape',params:{size:'1280x720',seconds:'7'},videoInput:{uploadId:'video-input'}}
 const preview=await call(ctx,'/api/generations/preview',{method:'POST',body:request})
 expect(preview.status).toBe(200)
 expect(preview.body.preview.referenceCount).toBe(1)
 const entity=createLibraryAsset(ctx.db,userId,{kind:'location',name:'Pinned view'})
 ctx.db.prepare('UPDATE library_assets SET reference_upload_id=?,reference_views_json=? WHERE id=?').run('video-input',JSON.stringify([{id:'side',uploadId:'video-input',label:'left'}]),entity.id)
 const document=insertPromptMention({version:1,text:'Animate ',mentions:[]},8,8,{kind:'location',id:entity.id,viewUploadId:'video-input'},entity.handle)
 expect(resolvePromptDocument(ctx.db,userId,document).entities[0]!.reference?.uploadId).toBe('video-input')
 const selected=await call(ctx,'/api/generations/preview',{method:'POST',body:{...request,prompt:document.text,promptDocument:document}})
 expect(selected.status).toBe(200)
 expect(selected.body.preview.entities[0].referenceMode).toBe('sent')
 const forged=structuredClone(document);forged.mentions[0]!.entity.viewUploadId='foreign'
 expect((await call(ctx,'/api/generations/preview',{method:'POST',body:{...request,prompt:forged.text,promptDocument:forged}})).status).toBe(400)
 expect((await call(ctx,'/api/generations/preview',{method:'POST',body:{...request,videoInput:{uploadId:'missing'}}})).status).toBe(400)
 expect((await call(ctx,'/api/generations/preview',{method:'POST',body:{...request,videoInput:{uploadId:'video-input',assetId:'x'}}})).status).toBe(400)
})
