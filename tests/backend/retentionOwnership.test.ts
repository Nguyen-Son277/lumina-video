import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerUser, startTestServer, type TestContext } from './helpers'
import { MOCK_PNG_BYTES } from '../../server/generations/adapters/mock'
import { retainedJsonReferences, retainedPathReferenced, uploadReferenced } from '../../server/entityLibrary/lifecycle'
import { cleanMediaJobs } from '../../server/projectsTrash/service'

let ctx: TestContext
let owner: string
let other: string
beforeEach(async () => {
  ctx = await startTestServer({ providerMode: 'mock' })
  owner = (await registerUser(ctx)).userId
  other = (await registerUser(ctx)).userId
})
afterEach(async () => { if (ctx) await ctx.close() })

function upload(userId = owner) {
  const id = randomUUID()
  const saved = ctx.mediaStore.saveUpload({ userId, uploadId: id, bytes: MOCK_PNG_BYTES, maxBytes: ctx.env.MAX_SOURCE_IMAGE_BYTES })
  ctx.db.prepare('INSERT INTO uploads (id,user_id,relative_path,mime_type,byte_size,created_at) VALUES (?,?,?,?,?,1)')
    .run(id, userId, saved.relativePath, saved.mimeType, saved.byteSize)
  return { id, path: saved.relativePath }
}
function project(userId: string) {
  const id = randomUUID()
  ctx.db.prepare('INSERT INTO projects (id,user_id,name,created_at,updated_at) VALUES (?,?,?,1,1)').run(id, userId, 'Synthetic retention project')
  return id
}
function generation(userId: string, value: unknown = []) {
  const id = randomUUID()
  ctx.db.prepare(`INSERT INTO generations (id,user_id,kind,prompt,snap_provider,snap_base_url,snap_model_id,status,source_images_json,created_at,updated_at)
    VALUES (?,?,'image','Retention fixture','mock','https://mock.test/v1','mock','succeeded',?,1,1)`).run(id, userId, JSON.stringify(value))
  return id
}
function plan(userId: string, value: unknown = []) {
  const id = randomUUID()
  ctx.db.prepare('INSERT INTO plan_sessions (id,user_id,timeline_json,created_at,updated_at) VALUES (?,?,?,1,1)').run(id, userId, JSON.stringify(value))
  return id
}
function retainedRow(table: string, userId: string, value: unknown) {
  const id = randomUUID(), json = JSON.stringify(value)
  switch (table) {
    case 'generations': return generation(userId, value)
    case 'plan_sessions': return plan(userId, value)
    case 'quick_sessions':
      ctx.db.prepare('INSERT INTO quick_sessions (id,user_id,prompt_document_json,created_at,updated_at) VALUES (?,?,?,1,1)').run(id, userId, json); break
    case 'scenes':
      ctx.db.prepare("INSERT INTO scenes (id,project_id,title,position,context_documents_json,created_at,updated_at) VALUES (?,?,'Retained scene',0,?,1,1)").run(id, project(userId), json); break
    case 'project_canvases': {
      const projectId = project(userId)
      ctx.db.prepare('INSERT INTO project_canvases (project_id,user_id,graph_json,created_at,updated_at) VALUES (?,?,?,1,1)').run(projectId, userId, json)
      return projectId
    }
    case 'exports':
      ctx.db.prepare('INSERT INTO exports (id,user_id,project_id,spec_json,created_at,updated_at) VALUES (?,?,?,?,1,1)').run(id, userId, project(userId), json); break
    case 'plan_image_batch_items': {
      const batchId = randomUUID()
      ctx.db.prepare("INSERT INTO plan_image_batches (id,user_id,session_id,status,total,created_at,updated_at) VALUES (?,?,?,'stopped',1,1,1)").run(batchId, userId, plan(userId))
      ctx.db.prepare('INSERT INTO plan_image_batch_items (id,batch_id,frame_id,position,snapshot_json,created_at,updated_at) VALUES (?,?,?,0,?,1,1)').run(id, batchId, randomUUID(), json); break
    }
    default: throw new Error(`Unknown fixture table ${table}`)
  }
  return id
}
function cleanup(image: { id: string; path: string }) {
  ctx.db.prepare("INSERT INTO media_cleanup_jobs (id,user_id,kind,target_id,path,created_at) VALUES (?,?,'orphan_upload',?,?,1)")
    .run(randomUUID(), owner, image.id, image.path)
}

const retainedTables = ['generations', 'scenes', 'plan_sessions', 'quick_sessions', 'project_canvases', 'exports', 'plan_image_batch_items']
describe('owner-scoped retained media references', () => {
  it.each(retainedTables)('%s only retains snapshots belonging to the path owner', table => {
    const image = upload()
    const snapshot = { structuralDocument: { reference: { uploadId: image.id, path: image.path } } }
    retainedRow(table, other, snapshot)
    expect(uploadReferenced(ctx.db, image.id, image.path)).toBe(false)
    expect(retainedPathReferenced(ctx.db, image.path)).toBe(false)
    // The public generic JSON helper deliberately retains its original semantics.
    expect(retainedJsonReferences(ctx.db, table, [image.path])).toBe(true)
    retainedRow(table, owner, snapshot)
    expect(uploadReferenced(ctx.db, image.id, image.path)).toBe(true)
    expect(retainedPathReferenced(ctx.db, image.path)).toBe(true)
  })

  it('foreign structural quick/scene documents cannot pin an owner orphan file', () => {
    const image = upload()
    retainedRow('quick_sessions', other, { text: 'Synthetic document', mentions: [{ entity: { id: image.id }, path: image.path }] })
    retainedRow('scenes', other, [{ fields: { customReference: { uploadId: image.id, path: image.path } } }])
    cleanup(image)
    expect(cleanMediaJobs({ db: ctx.db, mediaStore: ctx.mediaStore })).toEqual({ cleaned: 1, failed: 0 })
    expect(ctx.db.prepare('SELECT id FROM uploads WHERE id=?').get(image.id)).toBeUndefined()
    expect(ctx.mediaStore.exists(image.path)).toBe(false)
  })

  it('same-owner batch source snapshots retain uploads even before a generation exists', () => {
    const image = upload(), snapshot = { sourceImages: [{ path: image.path, uploadId: image.id }] }
    const foreignItem = retainedRow('plan_image_batch_items', other, snapshot)
    expect(uploadReferenced(ctx.db, image.id, image.path)).toBe(false)
    const ownItem = retainedRow('plan_image_batch_items', owner, snapshot)
    expect(ctx.db.prepare('SELECT generation_id FROM plan_image_batch_items WHERE id=?').get(ownItem)?.generation_id).toBeNull()
    cleanup(image)
    expect(cleanMediaJobs({ db: ctx.db, mediaStore: ctx.mediaStore }).cleaned).toBe(0)
    expect(ctx.mediaStore.exists(image.path)).toBe(true)
    ctx.db.prepare('DELETE FROM plan_image_batch_items WHERE id=?').run(ownItem)
    expect(ctx.db.prepare('SELECT id FROM plan_image_batch_items WHERE id=?').get(foreignItem)).toBeDefined()
    expect(cleanMediaJobs({ db: ctx.db, mediaStore: ctx.mediaStore }).cleaned).toBe(1)
    expect(ctx.mediaStore.exists(image.path)).toBe(false)
  })

  it('discovers custom JSON columns without changing corruption-safe own snapshot matching', () => {
    ctx.db.exec('ALTER TABLE quick_sessions ADD COLUMN custom_retention_json TEXT')
    const image = upload(), ownRow = retainedRow('quick_sessions', owner, {})
    const foreignRow = retainedRow('quick_sessions', other, {})
    const corrupted = `{"reference":${JSON.stringify(image.path)},`
    ctx.db.prepare('UPDATE quick_sessions SET custom_retention_json=? WHERE id=?').run(corrupted, foreignRow)
    expect(retainedPathReferenced(ctx.db, image.path)).toBe(false)
    ctx.db.prepare('UPDATE quick_sessions SET custom_retention_json=? WHERE id=?').run(corrupted, ownRow)
    expect(retainedPathReferenced(ctx.db, image.path)).toBe(true)
  })

  it('only live grants of the path owner retain media', () => {
    const image = upload(), now = Date.now()
    const grant = (userId: string) => {
      const id = randomUUID()
      ctx.db.prepare('INSERT INTO temporary_media_grants (id,user_id,generation_id,token_hash,relative_path,mime_type,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, userId, generation(userId), randomUUID().replaceAll('-', '').padEnd(64, '0'), image.path, 'image/png', now, now + 1000)
      return id
    }
    grant(other)
    expect(uploadReferenced(ctx.db, image.id, image.path, now)).toBe(false)
    expect(retainedPathReferenced(ctx.db, image.path, now)).toBe(false)
    const ownGrant = grant(owner)
    expect(uploadReferenced(ctx.db, image.id, image.path, now)).toBe(true)
    expect(retainedPathReferenced(ctx.db, image.path, now)).toBe(true)
    expect(retainedPathReferenced(ctx.db, image.path, now + 1000)).toBe(false)
    ctx.db.prepare('UPDATE temporary_media_grants SET revoked_at=? WHERE id=?').run(now, ownGrant)
    expect(retainedPathReferenced(ctx.db, image.path, now)).toBe(false)
  })

  it('rejects mismatched upload identity/path ownership and noncanonical source paths', () => {
    const image = upload(), foreign = upload(other)
    retainedRow('generations', owner, { uploadId: foreign.id, path: image.path })
    expect(uploadReferenced(ctx.db, foreign.id, image.path)).toBe(false)
    expect(uploadReferenced(ctx.db, image.id, `${owner}/uploads/different.png`)).toBe(false)
    for (const path of ['', owner, `/${image.path}`, `${owner}/../${other}/file.png`, `${owner}//file.png`, `${owner}/./file.png`, `${owner}\\file.png`]) {
      retainedRow('quick_sessions', owner, { path, uploadId: image.id })
      expect(retainedPathReferenced(ctx.db, path)).toBe(false)
      expect(uploadReferenced(ctx.db, image.id, path)).toBe(false)
    }
  })

  it.each(['library_assets', 'project_items', 'project_locations', 'project_canvas_links', 'assets', 'characters', 'exports'])('%s direct references use their owner rather than an ID/path match alone', table => {
    const image = upload()
    const insert = (userId: string) => {
      const id = randomUUID()
      switch (table) {
        case 'library_assets': ctx.db.prepare("INSERT INTO library_assets (id,user_id,kind,name,reference_upload_id,created_at,updated_at) VALUES (?,?,'item','Fixture',?,1,1)").run(id, userId, image.id); break
        case 'project_items': ctx.db.prepare("INSERT INTO project_items (id,user_id,project_id,kind,name,reference_upload_id,created_at,updated_at) VALUES (?,?,?,'prop','Fixture',?,1,1)").run(id, userId, project(userId), image.id); break
        case 'project_locations': ctx.db.prepare("INSERT INTO project_locations (id,project_id,name,reference_upload_id,created_at,updated_at) VALUES (?,?,'Fixture',?,1,1)").run(id, project(userId), image.id); break
        case 'project_canvas_links': ctx.db.prepare("INSERT INTO project_canvas_links (id,project_id,node_id,role,target_id,upload_id,created_at) VALUES (?,?,'source','upload',?,?,1)").run(id, project(userId), image.id, image.id); break
        case 'assets': ctx.db.prepare("INSERT INTO assets (id,user_id,generation_id,relative_path,mime_type,byte_size,created_at) VALUES (?,?,?,?,'image/png',1,1)").run(id, userId, generation(userId), image.path); break
        case 'characters': ctx.db.prepare("INSERT INTO characters (id,user_id,name,reference_path,created_at,updated_at) VALUES (?,?,'Fixture',?,1,1)").run(id, userId, image.path); break
        case 'exports': ctx.db.prepare("INSERT INTO exports (id,user_id,project_id,spec_json,relative_path,created_at,updated_at) VALUES (?,?,?,'{}',?,1,1)").run(id, userId, project(userId), image.path); break
      }
    }
    // Synthetic DB-only inconsistent references verify the defense independently of API validation.
    insert(other)
    expect(uploadReferenced(ctx.db, image.id, image.path)).toBe(false)
    insert(owner)
    expect(uploadReferenced(ctx.db, image.id, image.path)).toBe(true)
  })

  it('partial migration fixtures skip absent ownership columns instead of falling back to global JSON', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec(`CREATE TABLE generations (custom_json TEXT);
        CREATE TABLE scenes (project_id TEXT, params_json TEXT);
        CREATE TABLE plan_image_batch_items (batch_id TEXT, snapshot_json TEXT);
        CREATE TABLE library_assets (reference_upload_id TEXT);
        CREATE TABLE temporary_media_grants (relative_path TEXT)`)
      const path = `${owner}/uploads/fixture.png`, id = 'fixture-upload'
      for (const table of ['generations', 'scenes', 'plan_image_batch_items']) {
        const column = table === 'generations' ? 'custom_json' : table === 'scenes' ? 'params_json' : 'snapshot_json'
        db.prepare(`INSERT INTO ${table} (${column}) VALUES (?)`).run(JSON.stringify({ id, path }))
      }
      db.prepare('INSERT INTO library_assets (reference_upload_id) VALUES (?)').run(id)
      db.prepare('INSERT INTO temporary_media_grants (relative_path) VALUES (?)').run(path)
      expect(uploadReferenced(db, id, path)).toBe(false)
      expect(retainedPathReferenced(db, path)).toBe(false)
      expect(retainedJsonReferences(db, 'generations', [path])).toBe(true)
      db.exec('ALTER TABLE generations ADD COLUMN user_id TEXT')
      db.prepare('UPDATE generations SET user_id=?').run(owner)
      expect(uploadReferenced(db, id, path)).toBe(true)
      expect(retainedPathReferenced(db, path)).toBe(true)
    } finally { db.close() }
  })
})
