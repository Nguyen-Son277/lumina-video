import { randomUUID } from 'node:crypto'
import type { AppEnv } from '../env'
import type { Database } from '../db/index'
import type { MediaStore } from '../media/store'
import type { GenerationRow } from '../generations/types'
import { insufficientStorage, providerIncompatible } from '../lib/errors'
import type { EditorInternal } from './service'
import { fetchForegroundMask } from './service'
import { padImage, applyForegroundMask } from './processing'

/**
 * Local work enters the same queue and history as provider work, but never asks
 * for a provider, a credential or a network round trip to a paid API.
 */
export async function runLocalImageEditor(options: { db: Database; env: AppEnv; mediaStore: MediaStore; generation: GenerationRow }): Promise<void> {
  const { db, env, mediaStore: store, generation: g } = options
  const internal = JSON.parse(g.image_editor_json!) as EditorInternal
  const { request, width, height } = internal
  if (!store.exists(internal.sourcePath)) {
    throw providerIncompatible('Ảnh nguồn không còn trong kho media. Hãy chọn lại ảnh nguồn.')
  }
  const source = store.readFile(internal.sourcePath)
  let bytes: Uint8Array
  if (request.operation === 'reframe') {
    bytes = await padImage(source, width, height, request.frame!)
  } else {
    const mask = await fetchForegroundMask(env, source)
    bytes = await applyForegroundMask(source, mask, width, height, request.background?.mode === 'replace' ? request.background.color : undefined)
  }
  if (store.userUsageBytes(db, g.user_id) + bytes.length > env.MAX_USER_MEDIA_BYTES) {
    throw insufficientStorage('Kết quả chỉnh sửa vượt giới hạn dung lượng media cho phép')
  }
  // Crash recovery checks for a persisted asset before running this deterministic local work again.
  const saved = store.save({ userId: g.user_id, generationId: g.id, bytes, declaredMime: 'image/png' })
  db.prepare('INSERT INTO assets (id, generation_id, user_id, relative_path, mime_type, byte_size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), g.id, g.user_id, saved.relativePath, saved.mimeType, saved.byteSize, Date.now())
}
