import { test, expect } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh } from './helpers/auth'
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64')

test('picker pins a scenery angle, prevents duplicates, removes only its own binding and sends video input',async({page})=>{
 await signUpFresh(page)
 const provider=await seedProvider(page)
 await seedModel(page,provider,{kind:'image',modelId:'image'})
 const video=await seedModel(page,provider,{kind:'video',modelId:'video'})
 const uploads=[]
 for(let i=0;i<2;i++) { const response=await page.request.post(`${BASE}/api/uploads`,{headers:{'Content-Type':'image/png'},data:png});expect(response.ok()).toBe(true);uploads.push((await response.json()).upload) }
 const project=(await(await page.request.post(`${BASE}/api/projects`,{data:{name:'Reference project'}})).json()).project
 await page.request.post(`${BASE}/api/projects/${project.id}/locations`,{data:{name:'Angle forest',reference:{uploadId:uploads[0].id},referenceViews:uploads.map((upload,i)=>({id:`view-${i}`,label:i?'left':'wide',uploadId:upload.id,sheet:false}))}})
 const catalog=(await(await page.request.get(`${BASE}/api/entity-library`)).json()).entities
 const scenery=catalog.find((e:{name:string})=>e.name==='Angle forest')
 const session=(await(await page.request.post(`${BASE}/api/quick-sessions`,{data:{title:'Pinned references'}})).json()).session
 await page.goto(`${BASE}/?page=quick&session=${session.id}`)
 const prompt=page.getByPlaceholder('Mô tả điều bạn muốn tạo...')
 await prompt.fill('Paint forest')
 await page.getByRole('button',{name:'Chọn từ thư viện',exact:true}).click()
 await page.getByLabel('Góc ảnh tham chiếu').selectOption(uploads[1].id)
 await page.getByRole('button',{name:new RegExp('Angle forest \\(@')}).click()
 await expect(prompt).toHaveValue(`Paint forest @${scenery.handle}`)
 await page.getByRole('button',{name:'Chọn từ thư viện',exact:true}).click()
 await expect(page.getByRole('button',{name:new RegExp('Angle forest \\(@')})).toBeDisabled()
 await page.getByRole('button',{name:'Chọn từ thư viện',exact:true}).click()
 const previewRequest=page.waitForRequest(r=>r.url().endsWith('/api/generations/preview'))
 await page.locator('.generate-button').click()
 const input=(await previewRequest).postDataJSON()
 expect(input.promptDocument.mentions[0].entity).toMatchObject({id:scenery.id,kind:'location',viewUploadId:uploads[1].id})
 await page.getByRole('button',{name:'Huỷ',exact:true}).last().click()
 await page.locator('.prompt-box .project-source-item button').click()
 await expect(prompt).toHaveValue('Paint forest ')
 await page.locator('.mode-tabs button').nth(1).click()
 await page.getByRole('combobox',{name:'Model',exact:true}).selectOption(video)
 await page.getByRole('button',{name:'Chọn từ thư viện',exact:true}).click()
 await page.getByLabel('Góc ảnh tham chiếu').selectOption(uploads[1].id)
 await page.getByRole('button',{name:new RegExp('Angle forest \\(@')}).click()
 const request=page.waitForRequest(r=>r.url().endsWith('/api/generations/preview'))
 await page.locator('.generate-button').click()
 expect((await request).postDataJSON().videoInput).toEqual({uploadId:uploads[1].id})
})
