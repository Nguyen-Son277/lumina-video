import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Database } from '../../server/db/index'
import { enqueueImageTask, fingerprintImageInput, getImageTask, getLatestImageTask, listImageTasks, acknowledgeImageTaskAttachment, updateImageTaskStatus } from '../../server/planner/imageTasks'

let db: Database
let dir = ''
const userId = 'task-test-user'
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'image-tasks-test-'))
  db = openDatabase(join(dir, 'test.db'))
  db.prepare(`INSERT INTO users(id,email,password_hash,password_salt,created_at) VALUES(?,?,?,?,?)`).run(userId, 'image-task@test.invalid', 'x', 'x', Date.now())
  db.prepare(`INSERT INTO plan_sessions(id,user_id,kind,title,status,created_at,updated_at) VALUES('session-a',?,'planner','','setup',?,?)`).run(userId, Date.now(), Date.now())
})
afterAll(() => { if (db) db.close(); if (dir) rmSync(dir, { recursive: true, force: true }) })

let generationCounter = 0
function createTask(overrides: Partial<Parameters<typeof enqueueImageTask>[0]> = {}) {
  return enqueueImageTask({
    db,
    userId,
    scope: 'planner',
    scopeId: 'session-a',
    targetType: 'frame',
    targetId: 'frame-a',
    revision: 1,
    fingerprint: fingerprintImageInput({ prompt: 'hello', refs: ['x'] }),
    enqueue: () => {
      const id = `generation-${++generationCounter}`
      db.prepare(`INSERT INTO generations(id,user_id,kind,prompt,params_json,snap_provider,snap_base_url,snap_model_id,status,created_at,updated_at)
        VALUES(?,?,'image','prompt','{}','mock','http://mock.test','mock-model','queued',?,?)`).run(id, userId, Date.now(), Date.now())
      return id
    },
    ...overrides,
  })
}

describe('durable image task core', () => {
  it('supersedes older unknown links after a newer successful replacement and permits regeneration', () => {
    const old = createTask({ targetId: 'deleted-frame' })
    db.prepare("UPDATE generations SET status = 'succeeded' WHERE id = ?").run(old.task.generationId)
    getLatestImageTask(db, userId, 'planner', 'session-a', 'frame', 'deleted-frame')
    const successful = createTask({ targetId: 'deleted-frame' })
    db.prepare('UPDATE image_tasks SET created_at = ? WHERE id = ?').run(100, old.task.id)
    db.prepare('UPDATE image_tasks SET created_at = ? WHERE id = ?').run(200, successful.task.id)
    db.prepare("UPDATE generations SET status = 'unknown' WHERE id = ?").run(old.task.generationId)
    db.prepare("UPDATE generations SET status = 'succeeded' WHERE id = ?").run(successful.task.generationId)
    const fresh = createTask({ targetId: 'deleted-frame', requestKey: 'new-after-delete' })
    expect(fresh.reused).toBe(false)
    expect(getImageTask(db, userId, old.task.id).status).toBe('abandoned')
    expect((db.prepare('SELECT status FROM generations WHERE id = ?').get(old.task.generationId) as { status: string }).status).toBe('unknown')
  })

  it('hashes canonical JSON deterministically', () => {
    expect(fingerprintImageInput({ b: 2, a: { y: 1, x: 2 } })).toBe(fingerprintImageInput({ a: { x: 2, y: 1 }, b: 2 }))
    expect(fingerprintImageInput({ a: 2 })).not.toBe(fingerprintImageInput({ a: 3 }))
  })

  it('reuses request keys and prevents a concurrent active target', () => {
    const first = createTask({ requestKey: 'request-1' })
    const duplicate = createTask({ requestKey: 'request-1', enqueue: () => { throw new Error('must not enqueue') } })
    expect(first.reused).toBe(false)
    expect(duplicate.reused).toBe(true)
    expect(duplicate.task.id).toBe(first.task.id)
    expect(() => createTask({ requestKey: 'request-2' })).toThrow(/đang có/)
  })

  it('blocks unknown outcomes unless explicitly confirmed', () => {
    const first = createTask({ targetId: 'frame-unknown' })
    db.prepare("UPDATE generations SET status = 'unknown' WHERE id = ?").run(first.task.generationId)
    updateImageTaskStatus(db, userId, first.task.id, 'unknown')
    db.prepare('UPDATE generations SET deleted_at=? WHERE id=?').run(Date.now(), first.task.generationId)
    expect(getLatestImageTask(db, userId, 'planner', 'session-a', 'frame', 'frame-unknown')?.trashedAt).toBeTruthy()
    expect(() => createTask({ targetId: 'frame-unknown' })).toThrow(/unknown/)
    const confirmed = createTask({ targetId: 'frame-unknown', confirmNew: true, requestKey: 'confirmed' })
    expect(confirmed.reused).toBe(false)
    expect(getImageTask(db, userId, first.task.id).status).toBe('abandoned')
  })

  it('reads latest/list only for the owning user and acknowledges current attachment once', () => {
    const result = createTask({ targetId: 'frame-attach' })
    expect(getLatestImageTask(db, userId, 'planner', 'session-a', 'frame', 'frame-attach')?.id).toBe(result.task.id)
    expect(() => listImageTasks(db, 'not-owner', 'planner', 'session-a')).toThrow()
    expect(() => getImageTask(db, 'not-owner', result.task.id)).toThrow()
    updateImageTaskStatus(db, userId, result.task.id, 'succeeded')
    let attached = 0
    const attach = () => { attached += 1 }
    expect(acknowledgeImageTaskAttachment(db, userId, result.task.id, 1, result.task.fingerprint, attach)).toBe(true)
    expect(acknowledgeImageTaskAttachment(db, userId, result.task.id, 1, result.task.fingerprint, attach)).toBe(true)
    expect(attached).toBe(1)
    expect(acknowledgeImageTaskAttachment(db, userId, result.task.id, 2, result.task.fingerprint, attach)).toBe(false)
  })

  it('rolls back reservation when generation enqueue callback fails', () => {
    expect(() => createTask({ targetId: 'frame-rollback', enqueue: () => { throw new Error('failed') } })).toThrow('failed')
    expect(getLatestImageTask(db, userId, 'planner', 'session-a', 'frame', 'frame-rollback')).toBeNull()
  })

  it('rejects reading another user task even if task id is known', () => {
    const task = createTask({ targetId: 'frame-private' }).task
    const otherUserId = 'other-user'
    db.prepare(`INSERT INTO users(id,email,password_hash,password_salt,created_at) VALUES(?,?,?,?,?)`).run(otherUserId, 'other-image-task@test.invalid', 'x', 'x', Date.now())
    db.prepare(`INSERT INTO plan_sessions(id,user_id,kind,title,status,created_at,updated_at) VALUES('session-other',?,'planner','','setup',?,?)`).run(otherUserId, Date.now(), Date.now())
    expect(listImageTasks(db, otherUserId, 'planner', 'session-other')).toEqual([])
    expect(() => getImageTask(db, otherUserId, task.id)).toThrow()
  })
})
