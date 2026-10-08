import { afterAll, beforeAll, expect, test } from 'vitest'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'
let ctx: TestContext
beforeAll(async()=>{ctx=await startTestServer()})
afterAll(async()=>{if(ctx) await ctx.close()})

test('two scenes reuse exact voice block while dialogue and scene differ', async()=>{
  await registerUser(ctx)
  const project=(await call(ctx,'/api/projects',{method:'POST',body:{name:'Series',language:'vi'}})).body.project
  const char=(await call(ctx,`/api/projects/${project.id}/characters`,{method:'POST',body:{name:'Minh',voice:{accent:'Miền Bắc',timbre:'Trầm, hơi khàn',pace:'Vừa phải'}}})).body.character
  const previews=[]
  for(const [title,dialogue] of [['Cảnh 1','Xin chào.'],['Cảnh 2','Hẹn gặp lại.']]){
    const scene=(await call(ctx,`/api/projects/${project.id}/scenes`,{method:'POST',body:{title,prompt:title,characterId:char.id,dialogue}})).body.scene
    const preview=await call(ctx,`/api/scenes/${scene.id}/preview-prompt`,{method:'POST',body:{}})
    expect(preview.status).toBe(200)
    previews.push(preview.body)
  }
  const voice=(p:string)=>p.split('\n').filter(l=>l.startsWith('Voice ')).join('\n')
  expect(voice(previews[0].effectivePrompt)).toBe(voice(previews[1].effectivePrompt))
  expect(voice(previews[0].effectivePrompt)).toContain('Trầm, hơi khàn')
  expect(previews[0].effectivePrompt).not.toBe(previews[1].effectivePrompt)
})

test('image project request saves context without voice instructions, standalone stays unchanged',async()=>{
  await registerUser(ctx)
  const {modelPk}=await seedProviderAndModel(ctx,'image')
  const project=(await call(ctx,'/api/projects',{method:'POST',body:{name:'Images',style:'Watercolor'}})).body.project
  const character=(await call(ctx,`/api/projects/${project.id}/characters`,{method:'POST',body:{name:'Lan',appearance:'Red coat',voice:{timbre:'Warm'}}})).body.character
  const job=await call(ctx,'/api/generations',{method:'POST',body:{modelId:modelPk,projectId:project.id,characterId:character.id,prompt:'Forest'}})
  expect(job.status).toBe(202)
  expect(job.body.generation.effectivePrompt).toContain('Red coat')
  expect(job.body.generation.effectivePrompt).not.toContain('Voice timbre')
  const standalone=await call(ctx,'/api/generations',{method:'POST',body:{modelId:modelPk,prompt:'Unchanged'}})
  expect(standalone.body.generation.effectivePrompt).toBe('Unchanged')
  expect(standalone.body.generation.projectId).toBeNull()
})
