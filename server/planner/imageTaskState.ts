import type { Database } from '../db/index'
import { getLatestImageTask, updateImageTaskStatus, type ImageTaskPublic } from './imageTasks'
import type { GenerationRow } from '../generations/types'

/** Refresh a linked task from the generation, never from stale client state. */
export function refreshImageTask(db: Database, userId: string, task: ImageTaskPublic | null): ImageTaskPublic | null {
  if (!task?.generationId) return task
  const row = db.prepare('SELECT status FROM generations WHERE id = ? AND user_id = ?').get(task.generationId, userId) as Pick<GenerationRow, 'status'> | undefined
  return row ? updateImageTaskStatus(db, userId, task.id, row.status === 'downloading' ? 'running' : row.status) : task
}

export function refreshFrameTask(db: Database, userId: string, sessionId: string, frameId: string) {
  return refreshImageTask(db, userId, getLatestImageTask(db, userId, 'planner', sessionId, 'frame', frameId))
}
