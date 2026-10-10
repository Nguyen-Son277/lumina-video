import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startTestServer, call, registerUser, seedProviderAndModel, waitForGeneration, type TestContext } from './helpers'
import { normalizeCastMember, normalizeVariant, variantSystemPrompt } from '../../server/planner/characterVariants'
import type { CastMember } from '../../server/planner/artifacts'
let ctx: TestContext
beforeAll(async()=>{ctx=await startTestServer();await registerUser(ctx)})
afterAll(async()=>{await ctx?.close()})
describe('Planner character variants',()=>{
 it('normalizes legacy cast without losing original portrait and stable identity',()=>{
  const old={id:'cast1',name:'Lan',appearance:'Áo đỏ',role:'',voice:{},storage:'project',portrait:{uploadId:'photo'},reuseCharacterId:null} as CastMember
  const next=normalizeCastMember(old)
  expect(next.id).toBe('cast1');expect(next.variants).toHaveLength(1);expect(next.appearance).toBe('Áo đỏ');expect(next.portrait).toEqual(old.portrait)
  expect(normalizeCastMember(next)).toEqual(next)
  expect(variantSystemPrompt()).toContain('Không suy quốc tịch')
 })
 it('hides stale reference while preserving preview',()=>{
  const v=normalizeVariant({id:'v',appearance:'original',portrait:{uploadId:'photo'},revision:2,portraitRevision:1})
  const next=normalizeCastMember({id:'c',name:'C',appearance:'',role:'',voice:{},storage:'library',portrait:null,reuseCharacterId:null,variants:[v],selectedVariantId:'v'} as CastMember)
  expect(next.portrait).toBeNull();expect(next.variants![0]!.portrait).not.toBeNull()
 })
 it('proposes profiles, selects one, guards revisions and keeps variants through legacy saves',async()=>{
  const {modelPk:imageModelId}=await seedProviderAndModel(ctx,'image')
  const provider = await call(ctx, '/api/providers', {method:'POST',body:{name:'Chat',baseUrl:'https://llm.mock.test/v1',apiKey:'sk-test-12345678'}})
  const model = await call(ctx, '/api/models', {method:'POST',body:{providerId:provider.body.provider.id,modelId:'mock-chat-model',kind:'llm'}})
  const chatModelId = model.body.model.id
  const created=await call(ctx,'/api/plans',{method:'POST',body:{kind:'planner'}})
  const id=created.body.session.id
  await call(ctx,`/api/plans/${id}/setup`,{method:'PATCH',body:{chatModelId,imageModelId}})
  const cast=await call(ctx,`/api/plans/${id}/cast`,{method:'PUT',body:{cast:[{id:'c1',name:'Lan',appearance:'Áo đỏ',role:'Chính',voice:{},storage:'project'}]}})
  expect(cast.status).toBe(200)
  const base=`/api/plans/${id}/cast/c1/variants`
  const completed=await call(ctx,base+'/c1-original/profile/complete',{method:'POST',body:{revision:1}})
  expect(completed.status).toBe(200)
  const original=completed.body.session.cast[0].variants[0]
  expect(original.profile.skinTone).toBeTruthy();expect(original.profile.clothing).toBeTruthy();expect(original.sourceAppearance).toBe('Áo đỏ')
  const edited=await call(ctx,base+'/c1-original',{method:'PATCH',body:{label:original.label,profile:{...original.profile,heightCm:'183'},revision:original.revision}})
  const filledAgain=await call(ctx,base+'/c1-original/profile/complete',{method:'POST',body:{revision:edited.body.session.cast[0].variants[0].revision}})
  expect(filledAgain.body.session.cast[0].variants[0].profile.heightCm).toBe('183')
  const conflict=await call(ctx,base+'/c1-original/profile/complete',{method:'POST',body:{revision:1}})
  expect(conflict.status).toBe(409)
  const proposals=await call(ctx,base+'/propose',{method:'POST',body:{count:3}})
  expect(proposals.status).toBe(200)
  const member=proposals.body.session.cast[0]
  expect(member.variants).toHaveLength(4)
  expect(member.selectedVariantId).toBe('c1-original')
  const v=member.variants[1]
  expect(v.profile.skinTone).toBeTruthy();expect(v.profile.heightCm).toBeTruthy();expect(v.appearance).toContain('Trang phục')
  const selected=await call(ctx,base+`/${v.id}/select`,{method:'POST',body:{revision:v.revision}})
  expect(selected.status).toBe(200);expect(selected.body.session.cast[0].appearance).toBe(v.appearance)
  const stale=await call(ctx,base+`/${v.id}`,{method:'PATCH',body:{label:'X',profile:v.profile,revision:99}})
  expect(stale.status).toBe(409)
  const generated=await call(ctx,base+`/${v.id}/portrait`,{method:'POST'})
  expect(generated.status).toBe(202);await waitForGeneration(ctx,generated.body.generation.id)
  const attached=await call(ctx,base+`/${v.id}/portrait/attach`,{method:'POST',body:{generationId:generated.body.generation.id,revision:v.revision}})
  expect(attached.status).toBe(201);expect(attached.body.session.cast[0].portrait).toBeTruthy()
  const save=await call(ctx,`/api/plans/${id}/cast`,{method:'PUT',body:{cast:[{id:'c1',name:'Lan',appearance:v.appearance,role:'New',voice:{},storage:'project'}]}})
  expect(save.body.session.cast[0].variants).toHaveLength(4);expect(save.body.session.cast[0].appearance).toBe(v.appearance)
  const del=await call(ctx,base+`/${v.id}`,{method:'DELETE',body:{revision:v.revision}})
  expect(del.status).toBe(400)
 })
})
