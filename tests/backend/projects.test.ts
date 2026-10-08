import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, seedProviderAndModel, startTestServer, waitForGeneration, type TestContext } from './helpers'
import { composeForContext } from '../../server/generations/promptComposer'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { if (ctx) await ctx.close() })
const post = (path: string, body: unknown) => call(ctx,path,{ method: 'POST',body })
const patch = (path: string, body: unknown) => call(ctx,path,{ method: 'PATCH',body })
async function setup() {
  const { userId } = await registerUser(ctx)
  const project = (await post('/api/projects',{ name: 'Film',style: 'Watercolor',language: 'Vietnamese' })).body.project
  const character = (await post(`/api/projects/${project.id}/characters`,{ name: 'Lan',appearance: 'Red coat',voice: { language: 'Vietnamese',timbre: 'Warm',pace: 'Slow' } })).body.character
  return { userId,project,character }
}

describe('Projects, characters and scenes (mock-only)', () => {
  it('requires authentication and isolates every owner-scoped path', async () => {
    expect((await call(ctx,'/api/projects',{ cookie: '' })).status).toBe(401)
    const { project,character } = await setup()
    const scene = (await post(`/api/projects/${project.id}/scenes`,{ title: 'Scene',characterId: character.id })).body.scene
    await registerUser(ctx)
    for (const path of [`/api/projects/${project.id}`,`/api/projects/${project.id}/characters`, `/api/projects/${project.id}/characters/${character.id}`,`/api/projects/${project.id}/scenes`, `/api/projects/${project.id}/scenes/${scene.id}`]) expect((await call(ctx,path)).status).toBe(404)
    expect((await post(`/api/scenes/${scene.id}/preview-prompt`,{})).status).toBe(404)
    expect((await post(`/api/scenes/${scene.id}/select-generation`,{ generationId: null })).status).toBe(404)
  })
  it('validates schemas and cross-project references; supports CRUD and archive/restore', async () => {
    const { project,character } = await setup()
    expect((await post('/api/projects',{ name: '' })).status).toBe(400)
    expect((await patch(`/api/projects/${project.id}/characters/${character.id}`,{ voice: { invented: 'voice' } })).status).toBe(400)
    const other = (await post('/api/projects',{ name: 'Other' })).body.project
    expect((await post(`/api/projects/${other.id}/scenes`,{ title: 'Wrong',characterId: character.id })).status).toBe(404)
    expect((await post(`/api/projects/${project.id}/scenes`,{ title: 'Wrong',modelId: 'missing' })).status).toBe(400)
    const scene = (await post(`/api/projects/${project.id}/scenes`,{ title: 'First',characterId: character.id,params: { seconds: 5 } })).body.scene
    const updated = await patch(`/api/projects/${project.id}/scenes/${scene.id}`,{ title: 'Updated',dialogue: 'Hello' })
    expect(updated.body.scene.title).toBe('Updated')
    expect(updated.body.scene.params).toEqual({ seconds: 5 })
    expect((await patch(`/api/projects/${project.id}/characters/${character.id}`,{ name: 'New name' })).body.character.name).toBe('New name')
    expect((await call(ctx,`/api/projects/${project.id}`,{ method: 'DELETE' })).status).toBe(204)
    expect((await call(ctx,`/api/projects/${project.id}`)).body.project.archived).toBe(true)
    expect((await post(`/api/projects/${project.id}/scenes`,{ title: 'Blocked' })).status).toBe(400)
    expect((await post(`/api/scenes/${scene.id}/preview-prompt`,{})).status).toBe(400)
    expect((await patch(`/api/projects/${project.id}`,{ archived: false,description: 'Restored' })).body.project.description).toBe('Restored')
    expect((await call(ctx,`/api/projects/${project.id}/characters/${character.id}`,{ method: 'DELETE' })).status).toBe(400)
    await patch(`/api/projects/${project.id}/scenes/${scene.id}`,{ characterId: null, dialogue: '' })
    expect((await call(ctx,`/api/projects/${project.id}/characters/${character.id}`,{ method: 'DELETE' })).status).toBe(204)
    expect((await call(ctx,`/api/projects/${project.id}/scenes/${scene.id}`)).body.scene.characterId).toBeNull()
    expect((await call(ctx,`/api/projects/${project.id}/scenes/${scene.id}`,{ method: 'DELETE' })).status).toBe(204)
  })
  it('reorders only full permutations atomically, with contiguous insertion/deletion positions', async () => {
    const { project } = await setup()
    const a = (await post(`/api/projects/${project.id}/scenes`,{ title: 'A' })).body.scene
    const b = (await post(`/api/projects/${project.id}/scenes`,{ title: 'B' })).body.scene
    const c = (await post(`/api/projects/${project.id}/scenes`,{ title: 'C',position: 1 })).body.scene
    const path = `/api/projects/${project.id}/scenes`
    const initial = (await call(ctx,path)).body.scenes
    expect(initial.map((s: any) => s.id)).toEqual([a.id,c.id,b.id])
    for (const sceneIds of [[a.id,b.id],[a.id,a.id,c.id],[a.id,b.id,'foreign']]) {
      expect((await post(`${path}/reorder`,{ sceneIds })).status).toBe(400)
      expect((await call(ctx,path)).body.scenes).toEqual(initial)
    }
    const reordered = await post(`${path}/reorder`,{ sceneIds: [b.id,c.id,a.id] })
    expect(reordered.body.scenes.map((s: any) => s.position)).toEqual([0,1,2])
    expect(reordered.body.scenes.map((s: any) => s.id)).toEqual([b.id,c.id,a.id])
    await call(ctx,`${path}/${c.id}`,{ method: 'DELETE' })
    expect((await call(ctx,path)).body.scenes.map((s: any) => s.position)).toEqual([0,1])
  })
  it('composes deterministic versioned metadata, omits image audio and rejects excess length', async () => {
    const { userId,project,character } = await setup()
    const scene = (await post(`/api/projects/${project.id}/scenes`,{ title: 'Talk',prompt: 'Forest',characterId: character.id,dialogue: 'Xin chào' })).body.scene
    const preview = await post(`/api/scenes/${scene.id}/preview-prompt`,{ kind: 'video' })
    expect(preview.status).toBe(200)
    expect(preview.body).toEqual(composeForContext(ctx.db,userId,project.id,character.id,'video','Forest','Xin chào'))
    expect(preview.body.snapshot.version).toBe('voice-consistency-v1')
    expect(preview.body.snapshot.character.voice).toEqual({ language: 'Vietnamese',timbre: 'Warm',pace: 'Slow' })
    expect(preview.body.effectivePrompt).not.toContain('Voice pitch')
    const second = (await post(`/api/scenes/${scene.id}/preview-prompt`,{ kind: 'video' })).body
    expect(second).toEqual(preview.body)
    const image = (await post(`/api/scenes/${scene.id}/preview-prompt`,{ kind: 'image' })).body
    expect(image.effectivePrompt).toContain('Red coat')
    expect(image.effectivePrompt).not.toMatch(/Voice (language|timbre|pitch)|Dialogue|Xin chào/i)
    // The version label is metadata, not an audio instruction.
    expect(() => composeForContext(ctx.db,userId,project.id,null,'video','x'.repeat(16000))).toThrow('16000')
    await patch(`/api/projects/${project.id}/characters/${character.id}`,{ voice: {} })
    const empty = composeForContext(ctx.db,userId,project.id,character.id,'video','Forest')
    expect(empty.snapshot.character?.voice).toEqual({})
    expect(empty.effectivePrompt).not.toContain('Voice timbre')
    expect(preview.body.snapshot.character.voice.timbre).toBe('Warm')
  })
  it('generates a video from saved scene context and keeps its snapshot immutable', async () => {
    const { project,character } = await setup(), { modelPk } = await seedProviderAndModel(ctx,'video')
    const scene = (await post(`/api/projects/${project.id}/scenes`,{ title: 'Video',modelId: modelPk,characterId: character.id,prompt: 'Forest',dialogue: 'Xin chào' })).body.scene
    const result = await post(`/api/scenes/${scene.id}/generate`,{})
    expect(result.status).toBe(202)
    const generation = result.body.generation
    expect(generation.sceneId).toBe(scene.id)
    expect(generation.projectId).toBe(project.id)
    expect(generation.effectivePrompt).toContain('Voice timbre: Warm')
    expect(generation.promptSnapshot.character.voice.timbre).toBe('Warm')
    await patch(`/api/projects/${project.id}/characters/${character.id}`,{ voice: { timbre: 'Changed' } })
    await patch(`/api/projects/${project.id}/scenes/${scene.id}`,{ prompt: 'City',dialogue: 'Changed' })
    const saved = (await call(ctx,`/api/generations/${generation.id}`)).body.generation
    expect(saved.effectivePrompt).toBe(generation.effectivePrompt)
    expect(saved.promptSnapshot).toEqual(generation.promptSnapshot)
    expect((await waitForGeneration(ctx,generation.id)).status).toBe('succeeded')
    await registerUser(ctx)
    expect((await post(`/api/scenes/${scene.id}/generate`,{})).status).toBe(404)
  })
  it('selects only succeeded generations from the same scene and owner', async () => {
    const { project } = await setup(), { modelPk } = await seedProviderAndModel(ctx,'image')
    const scene = (await post(`/api/projects/${project.id}/scenes`,{ title: 'One',modelId: modelPk,prompt: 'A forest' })).body.scene
    const other = (await post(`/api/projects/${project.id}/scenes`,{ title: 'Two' })).body.scene
    const generated = await post('/api/generations',{ modelId: modelPk,prompt: 'A forest' })
    const id = generated.body.generation.id
    ctx.db.prepare('UPDATE generations SET project_id=?,scene_id=? WHERE id=?').run(project.id,scene.id,id)
    const path = `/api/scenes/${scene.id}/select-generation`
    const done = await waitForGeneration(ctx,id)
    expect(done.status).toBe('succeeded')
    ctx.db.prepare("UPDATE generations SET status='failed' WHERE id=?").run(id)
    expect((await post(path,{ generationId: id })).status).toBe(400)
    ctx.db.prepare("UPDATE generations SET status='succeeded' WHERE id=?").run(id)
    expect((await post(`/api/scenes/${other.id}/select-generation`,{ generationId: id })).status).toBe(400)
    expect((await post(path,{ generationId: id })).body.scene.selectedGenerationId).toBe(id)
    expect((await post(path,{ generationId: null })).body.scene.selectedGenerationId).toBeNull()
    // Even corrupted/mismatched linkage must not bypass the generation owner check.
    const ownerCookie = ctx.cookie
    const { userId: anotherUser } = await registerUser(ctx)
    ctx.db.prepare('UPDATE generations SET user_id=? WHERE id=?').run(anotherUser,id)
    expect((await call(ctx,path,{ method: 'POST',body: { generationId: id },cookie: ownerCookie })).status).toBe(400)
    expect((await post(path,{ generationId: id })).status).toBe(404)
  })
})
