import { randomUUID } from 'node:crypto'
import cookieParser from 'cookie-parser'
import express from 'express'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { attachUser, errorHandler } from '../../server/auth/middleware'
import { entityLibraryRoutes } from '../../server/entityLibrary/routes'
import { createLibraryAsset, entityLibraryUsageBytes, listEntityCatalog, normalizeEntityHandle, resolveEntity, softDeleteLibraryAsset, updateEntityHandle } from '../../server/entityLibrary/service'
import { registerUser as registerOnAuthServer, startTestServer, type TestContext } from './helpers'

const PNG = Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0])

describe('entity library foundation', () => {
  let ctx: TestContext
  let server: Server
  let originalUrl: string

  beforeEach(async () => {
    ctx = await startTestServer()
    originalUrl = ctx.baseUrl
    await registerUser(ctx)
    const app = express()
    app.use(express.json())
    app.use(cookieParser())
    app.use(attachUser(ctx.db))
    app.use('/api/entity-library', entityLibraryRoutes(ctx.db, ctx.env, ctx.mediaStore, ctx.worker))
    app.use(errorHandler)
    server = await new Promise<Server>(resolve => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
    })
    const address = server.address() as { port: number }
    ctx.baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    ctx.baseUrl = originalUrl
    await new Promise<void>(resolve => server.close(() => resolve()))
    await ctx.close()
  })

  async function registerUser(context: TestContext, email?: string) {
    const url = context.baseUrl
    if (originalUrl) context.baseUrl = originalUrl
    try { return await registerOnAuthServer(context, email) }
    finally { context.baseUrl = url }
  }

  function addCharacter(id: string, userId: string, name: string, projectId: string | null = null, deletedAt: number | null = null) {
    ctx.db.prepare(`INSERT INTO characters (id,user_id,project_id,name,appearance,voice_json,created_at,updated_at,deleted_at)
      VALUES (?,?,?,?,?,'{}',?,?,?)`).run(id,userId,projectId,name,'appearance',Date.now(),Date.now(),deletedAt)
  }

  it('normalizes aliases consistently', () => {
    expect(normalizeEntityHandle('  @Đặng Thị Ánh  ')).toBe('dang-thi-anh')
    expect(normalizeEntityHandle('!!')).toBe('')
    expect(normalizeEntityHandle('Foo  Bar')).toBe('foo-bar')
  })

  it('lazily registers owned characters and deterministic legacy collision suffixes', async () => {
    const { userId } = await registerUser(ctx, 'legacy-collision@gigone.com')
    addCharacter('character-a1b2c3d4', userId, 'Lan')
    addCharacter('character-b1c2d3e4', userId, 'Lan')
    const entities = listEntityCatalog(ctx.db, userId)
    const first = entities.find(e => e.id === 'character-a1b2c3d4')!
    const second = entities.find(e => e.id === 'character-b1c2d3e4')!
    expect(first.handle).toBe('lan')
    expect(second.handle).toBe('lan-b1c2d3e4')
    expect(listEntityCatalog(ctx.db,userId).map(e => e.handle)).toEqual(entities.map(e => e.handle))
  })

  it('ensures handles before project filtering so hidden characters retain reservation', async () => {
    const { userId } = await registerUser(ctx, 'project-scope@gigone.com')
    const projectA = randomUUID(), projectB = randomUUID()
    for (const [id,name] of [[projectA,'A'],[projectB,'B']] as const) ctx.db.prepare('INSERT INTO projects (id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(id,userId,name,Date.now(),Date.now())
    addCharacter('in-a',userId,'Scout',projectA)
    addCharacter('in-b',userId,'Scout',projectB)
    expect(listEntityCatalog(ctx.db,userId,projectA).map(e=>e.id)).toEqual(['in-a'])
    expect(listEntityCatalog(ctx.db,userId,projectB).map(e=>e.id)).toEqual(['in-b'])
    const handles=ctx.db.prepare("SELECT handle FROM entity_handles WHERE user_id=? AND kind='character' ORDER BY entity_id").all(userId) as {handle:string}[]
    expect(handles.map(x=>x.handle)).toEqual(['scout','scout-inb'])
  })

  it('creates assets and rejects case/accent-insensitive collision across kinds', async () => {
    const { userId } = await registerUser(ctx,'handles@gigone.com')
    const item=createLibraryAsset(ctx.db,userId,{kind:'item',name:'Lantern',handle:'Ánh Đèn'})
    expect(item.handle).toBe('anh-den')
    expect(()=>createLibraryAsset(ctx.db,userId,{kind:'logo',name:'Other',handle:'anh den'})).toThrow()
    expect(updateEntityHandle(ctx.db,userId,{kind:'item',id:item.id},'My Lantern').handle).toBe('my-lantern')
  })

  it('does not leak or resolve another user records', async () => {
    const {userId}=await registerUser(ctx,'owner@gigone.com')
    const asset=createLibraryAsset(ctx.db,userId,{kind:'item',name:'Private'})
    const other=await registerUser(ctx,'other@gigone.com')
    expect(()=>resolveEntity(ctx.db,other.userId,{kind:'item',id:asset.id})).toThrow()
    expect(listEntityCatalog(ctx.db,other.userId)).toEqual([])
  })

  it('deactivates handles after deletion without rebinding to a recreated record', async () => {
    const {userId}=await registerUser(ctx,'delete-character@gigone.com')
    addCharacter('original',userId,'Pilot')
    expect(listEntityCatalog(ctx.db,userId).find(e=>e.id==='original')?.handle).toBe('pilot')
    ctx.db.prepare('UPDATE characters SET deleted_at=? WHERE id=?').run(Date.now(),'original')
    expect(listEntityCatalog(ctx.db,userId).some(e=>e.id==='original')).toBe(false)
    addCharacter('replacement',userId,'Pilot')
    expect(listEntityCatalog(ctx.db,userId).find(e=>e.id==='replacement')?.handle).toBe('pilot')
    const old=ctx.db.prepare("SELECT active FROM entity_handles WHERE kind='character' AND entity_id='original'").get() as {active:number}
    expect(old.active).toBe(0)
  })

  it('soft deletes assets for 30 days and keeps the alias inactive', async () => {
    const {userId}=await registerUser(ctx,'trash-asset@gigone.com')
    const asset=createLibraryAsset(ctx.db,userId,{kind:'logo',name:'Studio Logo'})
    softDeleteLibraryAsset(ctx.db,userId,asset.id)
    const deleted=ctx.db.prepare('SELECT deleted_at,purge_after FROM library_assets WHERE id=?').get(asset.id) as {deleted_at:number;purge_after:number}
    expect(deleted.purge_after-deleted.deleted_at).toBe(30*24*60*60*1000)
    expect(listEntityCatalog(ctx.db,userId).some(e=>e.id===asset.id)).toBe(false)
    expect((ctx.db.prepare("SELECT active FROM entity_handles WHERE entity_id=?").get(asset.id) as {active:number}).active).toBe(0)
  })

  it('scopes catalog and asset listing/search pagination endpoints to session', async () => {
    const {userId}=await registerUser(ctx,'route-catalog@gigone.com')
    const one=createLibraryAsset(ctx.db,userId,{kind:'item',name:'Golden key',description:'Brass'})
    createLibraryAsset(ctx.db,userId,{kind:'logo',name:'Blue crest'})
    const response=await fetch(`${ctx.baseUrl}/api/entity-library/assets?search=golden&limit=1`,{headers:{Cookie:ctx.cookie}})
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({total:1,limit:1,offset:0,assets:[{id:one.id,name:'Golden key'}]})
    const catalog=await fetch(`${ctx.baseUrl}/api/entity-library`,{headers:{Cookie:ctx.cookie}})
    expect((await catalog.json() as any).entities).toHaveLength(2)
    expect((await fetch(`${ctx.baseUrl}/api/entity-library/assets`,{headers:{Cookie:''}})).status).toBe(401)
  })

  it('strict CRUD and handle endpoints enforce ownership and optimistic revisions', async () => {
    const {userId}=await registerUser(ctx,'crud-library@gigone.com')
    const request=(path:string,method:string,body?:unknown)=>fetch(`${ctx.baseUrl}/api/entity-library${path}`,{method,headers:{Cookie:ctx.cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)})
    const created=await request('/assets','POST',{kind:'logo',name:'Test logo'})
    expect(created.status).toBe(201)
    const asset=(await created.json() as any).asset
    expect((await request(`/assets/${asset.id}`,'PATCH',{revision:asset.revision,name:'Renamed'})).status).toBe(200)
    expect((await request(`/assets/${asset.id}`,'PATCH',{revision:asset.revision,name:'Stale'})).status).toBe(409)
    expect((await request(`/assets/${asset.id}`,'PATCH',{userId:'spoofed'})).status).toBe(400)
    expect((await request(`/logo/${asset.id}/handle`,'PATCH',{handle:'@Acme'})).status).toBe(200)
    expect(resolveEntity(ctx.db,userId,{kind:'logo',id:asset.id}).handle).toBe('acme')
    await registerUser(ctx,'crud-stranger@gigone.com')
    expect((await request(`/assets/${asset.id}`,'PATCH',{name:'Hijack'})).status).toBe(404)
    expect((await request(`/assets/${asset.id}`,'DELETE')).status).toBe(404)
  })

  it('uploads valid raw raster reference, retains old upload after replace and clear', async () => {
    const {userId}=await registerUser(ctx,'reference-asset@gigone.com')
    const asset=createLibraryAsset(ctx.db,userId,{kind:'item',name:'Reference item'})
    const post=()=>fetch(`${ctx.baseUrl}/api/entity-library/assets/${asset.id}/reference`,{method:'POST',headers:{Cookie:ctx.cookie,'Content-Type':'image/png'},body:PNG})
    const first=await post(); expect(first.status).toBe(201)
    const firstAsset=(await first.json() as any).asset
    const oldUpload=firstAsset.reference.uploadId as string
    expect(ctx.db.prepare('SELECT id FROM uploads WHERE id=?').get(oldUpload)).toBeTruthy()
    const second=await post(); expect(second.status).toBe(201)
    expect(ctx.db.prepare('SELECT id FROM uploads WHERE id=?').get(oldUpload)).toBeTruthy()
    expect((await fetch(`${ctx.baseUrl}/api/entity-library/assets/${asset.id}/reference`,{method:'DELETE',headers:{Cookie:ctx.cookie}})).status).toBe(200)
    expect(ctx.db.prepare('SELECT id FROM uploads WHERE id=?').get(oldUpload)).toBeTruthy()
    expect(entityLibraryUsageBytes(ctx.db,userId)).toBeGreaterThanOrEqual(PNG.byteLength*2)
  })

  it('rejects malformed JSON and unsafe/non-raster reference bytes', async () => {
    const {userId}=await registerUser(ctx,'validation-asset@gigone.com')
    const asset=createLibraryAsset(ctx.db,userId,{kind:'item',name:'Validation'})
    expect((await fetch(`${ctx.baseUrl}/api/entity-library/assets`,{method:'POST',headers:{Cookie:ctx.cookie,'Content-Type':'application/json'},body:JSON.stringify({kind:'character',name:'Wrong'})})).status).toBe(400)
    const image=await fetch(`${ctx.baseUrl}/api/entity-library/assets/${asset.id}/reference`,{method:'POST',headers:{Cookie:ctx.cookie,'Content-Type':'image/png'},body:new TextEncoder().encode('<svg/>')})
    expect(image.status).toBe(502)
    expect(entityLibraryUsageBytes(ctx.db,userId)).toBe(0)
  })

  it('attaches only own successful nondeleted image generation without generation calls', async () => {
    const {userId}=await registerUser(ctx,'from-generation@gigone.com')
    const asset=createLibraryAsset(ctx.db,userId,{kind:'logo',name:'Brand'})
    const generationId=randomUUID()
    ctx.db.prepare(`INSERT INTO generations (id,user_id,kind,prompt,params_json,snap_provider,snap_base_url,snap_model_id,status,created_at,updated_at)
      VALUES (?,?,'image','prompt','{}','mock','https://mock.test','mock','succeeded',?,?)`).run(generationId,userId,Date.now(),Date.now())
    const saved=ctx.mediaStore.save({userId,generationId,bytes:PNG})
    const assetId=randomUUID()
    ctx.db.prepare('INSERT INTO assets (id,generation_id,user_id,relative_path,mime_type,byte_size,created_at) VALUES (?,?,?,?,?,?,?)').run(assetId,generationId,userId,saved.relativePath,saved.mimeType,saved.byteSize,Date.now())
    const attach=(id:string)=>fetch(`${ctx.baseUrl}/api/entity-library/assets/${asset.id}/reference/from-generation`,{method:'POST',headers:{Cookie:ctx.cookie,'Content-Type':'application/json'},body:JSON.stringify({generationId:id,assetId})})
    expect((await attach('missing')).status).toBe(404)
    const response=await attach(generationId)
    expect(response.status).toBe(201)
    expect((await response.json() as any).asset.reference.uploadId).toBeTruthy()
    ctx.db.prepare('UPDATE generations SET deleted_at=? WHERE id=?').run(Date.now(),generationId)
    expect((await attach(generationId)).status).toBe(404)
    expect((ctx.db.prepare('SELECT COUNT(*) AS total FROM generations WHERE user_id=?').get(userId) as {total:number}).total).toBe(1)
  })

  it('enforces quota including retained uploads, character references and export bytes', async () => {
    const {userId}=await registerUser(ctx,'quota-library@gigone.com')
    const asset=createLibraryAsset(ctx.db,userId,{kind:'item',name:'Quota'})
    addCharacter('quota-character',userId,'Quota person')
    ctx.db.prepare('UPDATE characters SET reference_bytes=? WHERE id=?').run(100,'quota-character')
    const projectId=randomUUID()
    ctx.db.prepare('INSERT INTO projects (id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(projectId,userId,'Export project',Date.now(),Date.now())
    ctx.db.prepare("INSERT INTO exports (id,user_id,project_id,status,spec_json,byte_size,created_at,updated_at) VALUES (?,?,?,'succeeded','{}',?,?,?)").run(randomUUID(),userId,projectId,200,Date.now(),Date.now())
    expect(entityLibraryUsageBytes(ctx.db,userId)).toBe(300)
    ctx.env.MAX_USER_MEDIA_BYTES=300
    const upload=await fetch(`${ctx.baseUrl}/api/entity-library/assets/${asset.id}/reference`,{method:'POST',headers:{Cookie:ctx.cookie,'Content-Type':'image/png'},body:PNG})
    expect(upload.status).toBe(413)
    expect((ctx.db.prepare('SELECT COUNT(*) AS total FROM uploads WHERE user_id=?').get(userId) as {total:number}).total).toBe(0)
  })

  it('restored ID cannot silently acquire a handle now reserved by a distinct ID', async () => {
    const {userId}=await registerUser(ctx,'restore-library@gigone.com')
    const original=createLibraryAsset(ctx.db,userId,{kind:'item',name:'Badge'})
    softDeleteLibraryAsset(ctx.db,userId,original.id)
    const replacement=createLibraryAsset(ctx.db,userId,{kind:'logo',name:'Badge'})
    ctx.db.prepare('UPDATE library_assets SET deleted_at=NULL,purge_after=NULL WHERE id=?').run(original.id)
    expect(()=>listEntityCatalog(ctx.db,userId)).toThrow('Handle đã được một đối tượng khác sử dụng')
    expect((ctx.db.prepare('SELECT entity_id FROM entity_handles WHERE user_id=? AND handle_key=? AND active=1').get(userId,'badge') as {entity_id:string}).entity_id).toBe(replacement.id)
    expect(updateEntityHandle(ctx.db,userId,{kind:'item',id:original.id},'badge-original').handle).toBe('badge-original')
    expect(listEntityCatalog(ctx.db,userId).filter(e=>e.id===original.id || e.id===replacement.id)).toHaveLength(2)
  })
})
