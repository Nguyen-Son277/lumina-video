import { afterAll,beforeAll,describe,expect,it } from 'vitest'
import { call,registerUser,seedProviderAndModel,startTestServer,waitForGeneration,type TestContext } from './helpers'
import { randomUUID } from 'node:crypto'
import { createLibraryAsset } from '../../server/entityLibrary/service'
import { MOCK_PNG_BYTES } from '../../server/generations/adapters/mock'
let ctx:TestContext
beforeAll(async()=>{ctx=await startTestServer()})
afterAll(async()=>{if(ctx)await ctx.close()})
async function setup(){await registerUser(ctx);const session=(await call(ctx,'/api/quick-sessions',{method:'POST',body:{title:'Quick canvas'}})).body.session;const {modelPk}=await seedProviderAndModel(ctx,'image');return {id:session.id as string,modelPk}}
describe('quick canvas backend',()=>{
  it('creates no fake projects, persists revision and enforces ownership',async()=>{
    const {id}=await setup(),url=`/api/quick-sessions/${id}/canvas`
    const initial=await call(ctx,url);expect(initial.status).toBe(200);expect(initial.body.canvas).toMatchObject({projectId:id,quickSessionId:id,revision:0})
    expect((await call(ctx,'/api/projects')).body.projects).toHaveLength(0)
    const graph={schemaVersion:1,nodes:[{id:'note',kind:'note',x:0,y:0,data:{text:'local'}}],edges:[]}
    expect((await call(ctx,url,{method:'PUT',body:{graph,baseRevision:0}})).body.canvas.revision).toBe(1)
    expect((await call(ctx,url,{method:'PUT',body:{graph,baseRevision:0}})).status).toBe(409)
    await registerUser(ctx)
    expect((await call(ctx,url)).status).toBe(404)
  })
  it('imports draft once and preserves local edits, deleted nodes and tombstones',async()=>{
    const {id,modelPk}=await setup(),url=`/api/quick-sessions/${id}/canvas`
    const draft={kind:'image',modelId:modelPk,promptDocument:{version:1,text:'A mountain',mentions:[]},imageSettings:{size:'1024x1024',n:1}}
    const first=await call(ctx,`${url}/sync`,{method:'POST',body:{baseRevision:0,draft}})
    expect(first.status).toBe(200);const canvas=first.body.canvas
    expect(canvas.graph.nodes).toHaveLength(2)
    expect((await call(ctx,`${url}/sync`,{method:'POST',body:{baseRevision:canvas.revision,draft}})).body.canvas.revision).toBe(canvas.revision)
    canvas.graph.nodes=canvas.graph.nodes.filter((node:{kind:string})=>node.kind!=='prompt');canvas.graph.edges=[]
    canvas.graph.nodes[0].x=901
    const saved=await call(ctx,url,{method:'PUT',body:{graph:canvas.graph,baseRevision:canvas.revision}})
    const synced=await call(ctx,`${url}/sync`,{method:'POST',body:{baseRevision:saved.body.canvas.revision,draft}})
    expect(synced.body.canvas.graph.nodes).toHaveLength(1);expect(synced.body.canvas.graph.nodes[0].x).toBe(901)
  })
  it('previews and enqueues images through shared pipeline with session provenance and idempotency',async()=>{
    const {id,modelPk}=await setup(),url=`/api/quick-sessions/${id}/canvas`
    await call(ctx,`${url}/sync`,{method:'POST',body:{draft:{kind:'image',modelId:modelPk,promptDocument:{version:1,text:'A mountain',mentions:[]}}}})
    const preview=await call(ctx,`${url}/nodes/quick-draft/preview`,{method:'POST',body:{kind:'image'}})
    expect(preview.status).toBe(200);expect(preview.body.preview.runnable).toBe(true)
    const body={kind:'image',stamp:preview.body.preview.stamp,idempotencyKey:'same'}
    const first=await call(ctx,`${url}/nodes/quick-draft/run`,{method:'POST',body})
    expect(first.status).toBe(202);expect(first.body.generation.quickSessionId).toBe(id)
    const second=await call(ctx,`${url}/nodes/quick-draft/run`,{method:'POST',body})
    expect(second.body.generation.id).toBe(first.body.generation.id);expect(second.body.run.id).toBe(first.body.run.id)
    expect((await call(ctx,`${url}/runs`)).body.runs).toHaveLength(1)
    const canvas=(await call(ctx,url)).body.canvas;canvas.graph.nodes[0].data.modelId='different'
    await call(ctx,url,{method:'PUT',body:{graph:canvas.graph,baseRevision:canvas.revision}})
    expect((await call(ctx,`${url}/nodes/quick-draft/run`,{method:'POST',body})).body.error.messageKey).toBe('canvas.preview_stale')
  })
  it('runs quick video without a project or scene',async()=>{
    const {id}=await setup(),{modelPk}=await seedProviderAndModel(ctx,'video'),url=`/api/quick-sessions/${id}/canvas`
    await call(ctx,`${url}/sync`,{method:'POST',body:{draft:{kind:'video',modelId:modelPk,promptDocument:{version:1,text:'Ocean waves',mentions:[]}}}})
    const preview=await call(ctx,`${url}/nodes/quick-draft/preview`,{method:'POST',body:{kind:'video'}})
    expect(preview.status).toBe(200);expect(preview.body.preview.runnable).toBe(true)
    const run=await call(ctx,`${url}/nodes/quick-draft/run`,{method:'POST',body:{kind:'video',stamp:preview.body.preview.stamp}})
    expect(run.status).toBe(202);expect(run.body.generation.quickSessionId).toBe(id)
  })
  it('syncs saved session documents without DTO and imports history without duplicates',async()=>{
    const {id,modelPk}=await setup(),url=`/api/quick-sessions/${id}/canvas`
    await call(ctx,`/api/quick-sessions/${id}`,{method:'PATCH',body:{promptDocument:{version:1,text:'Saved draft',mentions:[]}}})
    const synced=await call(ctx,`${url}/sync`,{method:'POST',body:{baseRevision:0}})
    expect(synced.status).toBe(200);expect(synced.body.canvas.graph.nodes.find((node:{kind:string})=>node.kind==='prompt').data.text).toBe('Saved draft')
    const created=await call(ctx,'/api/generations',{method:'POST',body:{quickSessionId:id,modelId:modelPk,prompt:'History generation',params:{size:'1024x1024',n:1}}})
    expect(created.status).toBe(202)
    const imported=await call(ctx,`${url}/sync`,{method:'POST',body:{baseRevision:synced.body.canvas.revision}})
    expect(imported.status).toBe(200);expect(imported.body.canvas.runs).toHaveLength(1)
    const second=await call(ctx,`${url}/sync`,{method:'POST',body:{baseRevision:imported.body.canvas.revision}})
    expect(second.body.canvas.revision).toBe(imported.body.canvas.revision)
    const graph=second.body.canvas.graph;graph.nodes=graph.nodes.filter((node:{id:string})=>!node.id.startsWith('quick-generation:'));graph.edges=[]
    const saved=await call(ctx,url,{method:'PUT',body:{baseRevision:second.body.canvas.revision,graph}})
    const third=await call(ctx,`${url}/sync`,{method:'POST',body:{baseRevision:saved.body.canvas.revision}})
    expect(third.body.canvas.graph.nodes).toHaveLength(2)
  })
  it('pins the exact asset imported from a multi-output generation',async()=>{
    const {id,modelPk}=await setup(),url=`/api/quick-sessions/${id}/canvas`
    const created=await call(ctx,'/api/generations',{method:'POST',body:{quickSessionId:id,modelId:modelPk,prompt:'Two images',params:{size:'1024x1024',n:1}}})
    await waitForGeneration(ctx,created.body.generation.id)
    const userId=(ctx.db.prepare('SELECT user_id FROM generations WHERE id=?').get(created.body.generation.id) as {user_id:string}).user_id
    const assetId=randomUUID(),saved=ctx.mediaStore.saveUpload({userId,uploadId:randomUUID(),bytes:MOCK_PNG_BYTES,maxBytes:ctx.env.MAX_REFERENCE_BYTES})
    ctx.db.prepare('INSERT INTO assets(id,generation_id,user_id,relative_path,mime_type,byte_size,created_at) VALUES(?,?,?,?,?,?,?)').run(assetId,created.body.generation.id,userId,saved.relativePath,saved.mimeType,saved.byteSize,Date.now()+100)
    const synced=await call(ctx,`${url}/sync`,{method:'POST',body:{draft:{kind:'image',modelId:modelPk,promptDocument:{version:1,text:'Edit second asset',mentions:[]},sourceAssetIds:[assetId]}}})
    expect(synced.status).toBe(200);expect(synced.body.canvas.runs.find((run:{assetId?:string})=>run.assetId===assetId)).toBeTruthy()
    const preview=await call(ctx,`${url}/nodes/quick-draft/preview`,{method:'POST',body:{kind:'image'}})
    expect(preview.body.preview.runnable).toBe(true)
    const run=await call(ctx,`${url}/nodes/quick-draft/run`,{method:'POST',body:{kind:'image',stamp:preview.body.preview.stamp}})
    expect(run.status).toBe(202)
    const row=ctx.db.prepare('SELECT source_images_json FROM generations WHERE id=?').get(run.body.generation.id) as {source_images_json:string}
    expect(row.source_images_json).toContain(saved.relativePath)
  })
  it('merges untouched draft fields while preserving conflicting local text and recording provenance',async()=>{
    const {id,modelPk}=await setup(),url=`/api/quick-sessions/${id}/canvas`
    const draft={kind:'image',modelId:modelPk,promptDocument:{version:1,text:'Original',mentions:[]}}
    const first=await call(ctx,`${url}/sync`,{method:'POST',body:{draft}})
    const graph=first.body.canvas.graph,prompt=graph.nodes.find((node:{kind:string})=>node.kind==='prompt')
    prompt.data.text='Local';prompt.data.promptDocument.text='Local';prompt.x=999
    const saved=await call(ctx,url,{method:'PUT',body:{graph,baseRevision:first.body.canvas.revision}})
    const next=await call(ctx,`${url}/sync`,{method:'POST',body:{baseRevision:saved.body.canvas.revision,draft:{...draft,promptDocument:{version:1,text:'Remote',mentions:[]},imageSettings:{n:2}}}})
    expect(next.status).toBe(200)
    expect(next.body.canvas.graph.nodes.find((node:{kind:string})=>node.kind==='prompt').data.text).toBe('Local')
    expect(next.body.canvas.graph.nodes.find((node:{kind:string})=>node.kind==='image').data.imageSettings.n).toBe(2)
    expect(next.body.canvas.provenance.find((source:{sourceKey:string})=>source.sourceKey==='draft-prompt').conflicts).toContain('text')
  })
  it('fallback sync retains video settings and reset explicitly restores remote draft text',async()=>{
    const {id}=await setup(),{modelPk}=await seedProviderAndModel(ctx,'video'),url=`/api/quick-sessions/${id}/canvas`
    const draft={kind:'video',modelId:modelPk,promptDocument:{version:1,text:'Before',mentions:[]},videoSettings:{modelId:modelPk,params:{size:'1280x720',seconds:'4'}}}
    const first=await call(ctx,`${url}/sync`,{method:'POST',body:{draft}})
    await call(ctx,`/api/quick-sessions/${id}`,{method:'PATCH',body:{promptDocument:{version:1,text:'After',mentions:[]}}})
    const updated=await call(ctx,`${url}/sync`,{method:'POST',body:{baseRevision:first.body.canvas.revision}})
    expect(updated.status).toBe(200)
    expect(updated.body.canvas.graph.nodes.find((node:{kind:string})=>node.kind==='video').data).toMatchObject({modelId:modelPk,videoSettings:draft.videoSettings})
    expect(updated.body.canvas.graph.nodes.find((node:{kind:string})=>node.kind==='prompt').data.text).toBe('After')
    const graph=updated.body.canvas.graph,prompt=graph.nodes.find((node:{kind:string})=>node.kind==='prompt');prompt.data.text='Local';prompt.data.promptDocument.text='Local'
    const saved=await call(ctx,url,{method:'PUT',body:{graph,baseRevision:updated.body.canvas.revision}})
    await call(ctx,`/api/quick-sessions/${id}`,{method:'PATCH',body:{promptDocument:{version:1,text:'Reset target',mentions:[]}}})
    const conflict=await call(ctx,`${url}/sync`,{method:'POST',body:{baseRevision:saved.body.canvas.revision}})
    const noop=await call(ctx,`${url}/sync`,{method:'POST',body:{baseRevision:conflict.body.canvas.revision}})
    expect(noop.body.canvas.provenance.find((source:{sourceKey:string})=>source.sourceKey==='draft-prompt').conflicts).toContain('text')
    const reset=await call(ctx,`${url}/groups/quick-group:draft/reset-session`,{method:'POST',body:{baseRevision:noop.body.canvas.revision}})
    expect(reset.status).toBe(200);expect(reset.body.canvas.graph.nodes.find((node:{kind:string})=>node.kind==='prompt').data.text).toBe('Reset target')
  })
  it('keeps exact logos out of provider refs, binds width in stamp and imports sanitized history overlays',async()=>{
    const {id,modelPk}=await setup(),url=`/api/quick-sessions/${id}/canvas`
    const userId=(ctx.db.prepare('SELECT user_id FROM quick_sessions WHERE id=?').get(id) as {user_id:string}).user_id
    const uploadId=randomUUID(),saved=ctx.mediaStore.saveUpload({userId,uploadId,bytes:MOCK_PNG_BYTES,maxBytes:ctx.env.MAX_REFERENCE_BYTES})
    ctx.db.prepare('INSERT INTO uploads(id,user_id,relative_path,mime_type,byte_size,created_at) VALUES(?,?,?,?,?,?)').run(uploadId,userId,saved.relativePath,saved.mimeType,saved.byteSize,Date.now())
    const logo=createLibraryAsset(ctx.db,userId,{kind:'logo',name:'Exact brand'})
    ctx.db.prepare('UPDATE library_assets SET reference_upload_id=? WHERE id=?').run(uploadId,logo.id)
    const synced=await call(ctx,`${url}/sync`,{method:'POST',body:{draft:{kind:'image',modelId:modelPk,promptDocument:{version:1,text:'A forest',mentions:[]},logoOverlays:[{entityId:logo.id,x:.1,y:.2,width:.15,opacity:1,anchor:'top-right'}]}}})
    expect(synced.status).toBe(200)
    const preview=await call(ctx,`${url}/nodes/quick-draft/preview`,{method:'POST',body:{kind:'image'}})
    expect(preview.body.preview.runnable).toBe(true);expect(preview.body.preview.limits.sentImages).toBe(0)
    const run=await call(ctx,`${url}/nodes/quick-draft/run`,{method:'POST',body:{kind:'image',stamp:preview.body.preview.stamp}})
    expect(run.status).toBe(202)
    const row=ctx.db.prepare('SELECT source_images_json,logo_overlays_json FROM generations WHERE id=?').get(run.body.generation.id) as {source_images_json:string|null;logo_overlays_json:string}
    expect(JSON.parse(row.source_images_json??'[]')).toHaveLength(0);expect(JSON.parse(row.logo_overlays_json)[0].anchor).toBe('top-right')
    const graph=synced.body.canvas.graph,logoNode=graph.nodes.find((node:{kind:string})=>node.kind==='library');logoNode.data.logoOverlay.width=.25
    await call(ctx,url,{method:'PUT',body:{graph,baseRevision:synced.body.canvas.revision}})
    expect((await call(ctx,`${url}/nodes/quick-draft/run`,{method:'POST',body:{kind:'image',stamp:preview.body.preview.stamp}})).body.error.messageKey).toBe('canvas.preview_stale')
    ctx.db.prepare('DELETE FROM quick_canvas_runs WHERE generation_id=?').run(run.body.generation.id)
    const history=await call(ctx,`${url}/sync`,{method:'POST',body:{}})
    expect(history.status).toBe(200)
    const imported=history.body.canvas.graph.nodes.find((node:{id:string})=>node.id===`quick-generation:${run.body.generation.id}:logo:0`)
    expect(imported.data.logoOverlay.anchor).toBe('top-right');expect(imported.data.logoOverlay).not.toHaveProperty('path');expect(imported.data.logoOverlay).not.toHaveProperty('mime')
  })
  it('composites owned library source images into a new upload',async()=>{
    const {id,modelPk}=await setup(),url=`/api/quick-sessions/${id}/canvas`
    const userId=(ctx.db.prepare('SELECT user_id FROM quick_sessions WHERE id=?').get(id) as {user_id:string}).user_id
    const uploadId=randomUUID(),saved=ctx.mediaStore.saveUpload({userId,uploadId,bytes:MOCK_PNG_BYTES,maxBytes:ctx.env.MAX_REFERENCE_BYTES})
    ctx.db.prepare('INSERT INTO uploads(id,user_id,relative_path,mime_type,byte_size,created_at) VALUES(?,?,?,?,?,?)').run(uploadId,userId,saved.relativePath,saved.mimeType,saved.byteSize,Date.now())
    const item=createLibraryAsset(ctx.db,userId,{kind:'item',name:'Composite item'})
    ctx.db.prepare('UPDATE library_assets SET reference_upload_id=? WHERE id=?').run(uploadId,item.id)
    const graph={schemaVersion:1,nodes:[{id:'item',kind:'library',x:0,y:0,data:{sourceId:item.id,entityKind:'item'}},{id:'image',kind:'image',x:400,y:0,data:{modelId:modelPk,layout:{aspectRatio:'1:1',instances:[{id:'placement',sourceNodeId:'item',x:.1,y:.1,width:.5,height:.5,rotation:0,flipX:false,z:0}]}}}],edges:[]}
    expect((await call(ctx,url,{method:'PUT',body:{graph,baseRevision:0}})).status).toBe(200)
    const composite=await call(ctx,`${url}/nodes/image/composite`,{method:'POST',body:{}})
    expect(composite.status).toBe(201);expect(composite.body.upload.width).toBeGreaterThan(0)
    expect(ctx.db.prepare('SELECT user_id FROM uploads WHERE id=?').get(composite.body.upload.id)).toMatchObject({user_id:userId})
  })
  it('rejects project-specific nodes and malformed graphs',async()=>{
    const {id}=await setup(),url=`/api/quick-sessions/${id}/canvas`
    for(const graph of [{},{schemaVersion:1,nodes:[{id:'bad',kind:'location',x:0,y:0,data:{sourceId:'not-owned'}}],edges:[]}])expect((await call(ctx,url,{method:'PUT',body:{graph,baseRevision:0}})).status).toBe(400)
  })
})
