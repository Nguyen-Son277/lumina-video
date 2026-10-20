import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { call, registerUser, startTestServer, type TestContext } from './helpers'
import { createLibraryAsset, listEntityCatalog, updateEntityHandle } from '../../server/entityLibrary/service'

let ctx: TestContext, userId: string
beforeEach(async () => { ctx = await startTestServer(); userId = (await registerUser(ctx)).userId })
afterEach(async () => { await ctx.close() })
describe('project restore reserves child character aliases atomically', () => {
  for (const endpoint of ['project', 'trash']) {
    it(`${endpoint} restore rejects claimed child aliases without partial activation`, async () => {
      const p = await call(ctx, '/api/projects', { method: 'POST', body: { name: 'Project' } })
      const id = p.body.project.id
      // Sort alias rows so a conflict after the first reservation also verifies rollback.
      for (const [characterId, name] of [['first', 'Free'], ['second', 'Pilot'], ['legacy', 'Old Pilot']] as const) {
        ctx.db.prepare("INSERT INTO characters(id,user_id,project_id,name,appearance,voice_json,created_at,updated_at) VALUES(?,?,?,?,'','{}',1,1)").run(characterId, userId, id, name)
      }
      listEntityCatalog(ctx.db, userId)
      // Model a legacy child which has never been catalogued.
      ctx.db.prepare("DELETE FROM entity_handles WHERE entity_id='legacy'").run()
      ctx.db.prepare("UPDATE entity_handles SET id='a' WHERE entity_id='first'").run()
      ctx.db.prepare("UPDATE entity_handles SET id='b' WHERE entity_id='second'").run()
      expect((await call(ctx, `/api/projects/${id}/trash`, { method: 'POST', body: {} })).status).toBe(200)
      const claimant = createLibraryAsset(ctx.db, userId, { kind: 'item', name: 'Pilot' })
      const path = endpoint === 'project' ? `/api/projects/${id}/restore` : `/api/trash/project/${id}/restore`
      expect((await call(ctx, path, { method: 'POST' })).status).toBe(409)
      expect(ctx.db.prepare('SELECT deleted_at FROM projects WHERE id=?').get(id)).not.toMatchObject({ deleted_at: null })
      expect(ctx.db.prepare("SELECT active FROM entity_handles WHERE entity_id='first'").get()).toMatchObject({ active: 0 })
      expect(ctx.db.prepare("SELECT active FROM entity_handles WHERE entity_id='second'").get()).toMatchObject({ active: 0 })
      updateEntityHandle(ctx.db, userId, { kind: 'item', id: claimant.id }, 'new-pilot')
      expect((await call(ctx, path, { method: 'POST' })).status).toBe(200)
      expect(ctx.db.prepare("SELECT active FROM entity_handles WHERE entity_id='second'").get()).toMatchObject({ active: 1 })
      expect(ctx.db.prepare("SELECT id FROM entity_handles WHERE entity_id='legacy'").get()).toBeUndefined()
      const catalog = listEntityCatalog(ctx.db, userId)
      expect(catalog.find(entity => entity.id === 'second')?.handle).toBe('pilot')
      expect(catalog.find(entity => entity.id === 'legacy')?.handle).not.toBe('pilot')
    })
  }
})
