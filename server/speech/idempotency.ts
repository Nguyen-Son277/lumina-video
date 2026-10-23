import { createHash } from 'node:crypto'
import type { Request } from 'express'
import type { Database } from '../db/index'
import { badRequest, conflict, errorMeta } from '../lib/errors'

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]))
  }
  return value
}

export function requestKey(req: Request): string | undefined {
  const value = req.get('Idempotency-Key')
  if (value === undefined) return undefined
  if (!value.trim() || value.length > 200) throw badRequest('Idempotency-Key must contain 1–200 characters')
  return value
}

export function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

export function replayRequest(db: Database, userId: string, operation: string, key: string | undefined, hash: string): string | null {
  if (!key) return null
  const row = db.prepare('SELECT request_hash, resource_id FROM request_idempotency WHERE user_id=? AND operation=? AND key=?')
    .get(userId, operation, key) as { request_hash: string; resource_id: string } | undefined
  if (!row) return null
  if (row.request_hash !== hash) throw conflict('Khóa chống tạo trùng này đã được dùng cho yêu cầu khác.', errorMeta('speech.idempotency_conflict'))
  return row.resource_id
}

export function rememberRequest(db: Database, userId: string, operation: string, key: string | undefined, hash: string, id: string): void {
  if (!key) return
  db.prepare('INSERT INTO request_idempotency(user_id,operation,key,request_hash,resource_id,created_at) VALUES(?,?,?,?,?,?)')
    .run(userId, operation, key, hash, id, Date.now())
}

export function speechTransaction<T>(db: Database, action: () => T): T {
  db.exec('SAVEPOINT speech_request')
  try {
    const result = action()
    db.exec('RELEASE speech_request')
    return result
  } catch (error) {
    db.exec('ROLLBACK TO speech_request')
    db.exec('RELEASE speech_request')
    throw error
  }
}
