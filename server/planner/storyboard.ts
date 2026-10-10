import { randomUUID } from 'node:crypto'
import type { AppEnv } from '../env'
import type { Database } from '../db/index'
import { badRequest, errorMeta, notFound } from '../lib/errors'
import type { MediaStore } from '../media/store'
import type { CastMember, TimelineFrame, LocationReference } from './artifacts'

/**
 * Dùng chung cho ảnh của phiên Tạo kịch bản AI (tải lên, gắn ảnh đã tạo) và cho
 * batch sinh ảnh storyboard, để hai lối vào không lệch nhau.
 */

/** Lưu một ảnh người dùng tải lên thành ảnh của phiên (chân dung hoặc ảnh frame). */
export function saveSessionUpload(
  options: { db: Database; env: AppEnv; mediaStore: MediaStore },
  userId: string,
  bytes: Uint8Array,
): string {
  const { db, env, mediaStore } = options
  const uploadId = randomUUID()
  const saved = mediaStore.saveUpload({
    userId,
    uploadId,
    bytes,
    maxBytes: env.MAX_REFERENCE_BYTES,
  })
  db.prepare(
    'INSERT INTO uploads (id, user_id, relative_path, mime_type, byte_size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(uploadId, userId, saved.relativePath, saved.mimeType, saved.byteSize, Date.now())
  return uploadId
}

/** Lấy asset ảnh của một tác vụ đã xong và chuyển vào uploads của người dùng. */
export function adoptGenerationImage(
  options: { db: Database; env: AppEnv; mediaStore: MediaStore },
  userId: string,
  generationId: string,
  assetId?: string,
): string {
  const { db, mediaStore } = options
  const generation = db
    .prepare('SELECT id, status FROM generations WHERE id = ? AND user_id = ?')
    .get(generationId, userId) as { id: string; status: string } | undefined
  if (!generation) throw notFound('Không tìm thấy tác vụ tạo ảnh')
  if (generation.status !== 'succeeded') {
    throw badRequest('Tác vụ tạo ảnh chưa hoàn tất. Hãy đợi ảnh xong rồi gắn vào kịch bản.')
  }

  const asset = assetId
    ? (db
        .prepare('SELECT relative_path AS path FROM assets WHERE id = ? AND generation_id = ?')
        .get(assetId, generation.id) as { path: string } | undefined)
    : (db
        .prepare(
          'SELECT relative_path AS path FROM assets WHERE generation_id = ? ORDER BY created_at ASC LIMIT 1',
        )
        .get(generation.id) as { path: string } | undefined)
  if (!asset) throw notFound('Tác vụ này không có ảnh nào để gắn')
  if (!mediaStore.exists(asset.path)) throw notFound('Ảnh của tác vụ không còn trên máy chủ')

  return saveSessionUpload(options, userId, mediaStore.readFile(asset.path))
}

/** Mô tả vị trí trong khung hình, dùng cho prompt ảnh storyboard. */
export const POSITION_LABELS: Record<string, string> = {
  left: 'đứng bên trái khung hình',
  center: 'đứng chính giữa khung hình',
  right: 'đứng bên phải khung hình',
  background: 'ở phía sau, xa máy ảnh',
}

/** Nhãn vị trí ngắn để mô tả blocking sang cảnh Studio. */
export const POSITION_TEXT: Record<string, string> = {
  left: 'bên trái khung',
  center: 'chính giữa khung',
  right: 'bên phải khung',
  background: 'phía sau',
}

/**
 * Prompt ảnh storyboard cho một frame: cảnh hoàn chỉnh **có nhân vật**, nêu rõ
 * từng người đứng đâu và làm gì, để hình dung được frame thay vì ảnh nền trống.
 */
export function storyboardPrompt(frame: TimelineFrame, cast: CastMember[]): string {
  const people = frame.blocking.map((entry) => {
    const member = cast.find((item) => item.id === entry.castId)
    const name = member?.name ?? entry.castId
    const appearance = member?.appearance?.trim() ? ` (${member.appearance.trim()})` : ''
    const position = POSITION_LABELS[entry.position] ?? POSITION_LABELS.center
    const action = entry.action.trim() ? ` đang ${entry.action.trim()}` : ''
    const expression = entry.expression?.trim() ? `, biểu cảm ${entry.expression.trim()}` : ''
    return `- ${name}${appearance}: ${position}${action}${expression}`
  })

  return [
    `Khung hình storyboard cho cảnh "${frame.title || 'không tên'}".`,
    frame.backgroundPrompt || frame.context ? `Bối cảnh: ${frame.backgroundPrompt || frame.context}.` : '',
    frame.action ? `Hành động chung: ${frame.action}.` : '',
    frame.beats?.trim() ? `Nhịp hành động: ${frame.beats.trim()}.` : '',
    people.length
      ? `Nhân vật trong khung hình (giữ đúng khuôn mặt và trang phục theo ảnh tham chiếu):\n${people.join('\n')}`
      : 'Không có nhân vật trong khung hình.',
    frame.dialogue ? `Lời thoại: "${frame.dialogue}" (không viết chữ lên ảnh).` : '',
    frame.shotNotes ? `Góc máy: ${frame.shotNotes}.` : '',
    'Ảnh ngang 16:9, phong cách điện ảnh chân thực, ánh sáng nhất quán, chi tiết cao.',
    'Không có chữ, phụ đề hay watermark trong ảnh; không thêm người ngoài danh sách trên.',
  ]
    .filter(Boolean)
    .join(' ')
}

export type StoryboardInputs = {
  prompt: string
  sourceUploadIds: string[]
  sourceRoles: Array<{ uploadId: string; role: 'location' | 'character'; id: string }>
  locationId: string | null
  characterRevisions?: Record<string, number>
  locationRevision: number | null
}

/** Required location reference first, then canonical portraits; never silently truncate. */
export function storyboardInputs(
  frame: TimelineFrame, cast: CastMember[], locations: LocationReference[], max = 16,
): StoryboardInputs {
  const location = frame.locationId ? locations.find(item => item.id === frame.locationId) : null
  if (frame.locationId && !location) throw badRequest('Bối cảnh được chọn không tồn tại.', undefined, errorMeta('locations.unknown'))
  if (location && !location.reference?.uploadId) throw badRequest('Bối cảnh được chọn chưa có ảnh tham chiếu.', undefined, errorMeta('locations.reference_missing'))
  const sourceRoles: StoryboardInputs['sourceRoles'] = []
  if (location?.reference) sourceRoles.push({ uploadId: location.reference.uploadId, role: 'location', id: location.id })
  for (const entry of frame.blocking) {
    const member = cast.find(item => item.id === entry.castId)
    const uploadId = member?.portrait?.uploadId
    if (uploadId && !sourceRoles.some(item => item.uploadId === uploadId)) {
      sourceRoles.push({ uploadId, role: 'character', id: member!.id })
    }
  }
  if (sourceRoles.length > max) throw badRequest(`Cảnh cần ${sourceRoles.length} ảnh tham chiếu nhưng model chỉ nhận tối đa ${max}.`, undefined, errorMeta('locations.too_many_references', { count: sourceRoles.length, max }))
  const continuity = location ? [
    `Canonical location: ${location.name}; stage: ${location.stage}; revision: ${location.revision}.`,
    `Location description: ${location.description}. Continuity: ${location.continuityNotes}.`,
    'Input image 1 is the canonical EMPTY location reference: preserve its layout, architecture, fixed objects and lighting continuity; do not copy characters from it.',
    sourceRoles.filter(item => item.role === 'character').map((item, index) => `Input image ${index + 2} is the canonical portrait of ${cast.find(member => member.id === item.id)?.name ?? item.id}; use it for character identity only.`).join(' '),
  ].filter(Boolean).join(' ') : ''
  return {
    prompt: [storyboardPrompt(frame, cast), continuity].filter(Boolean).join(' '),
    sourceUploadIds: sourceRoles.map(item => item.uploadId), sourceRoles,
    characterRevisions: Object.fromEntries(frame.blocking.map(entry => [entry.castId, cast.find(x => x.id === entry.castId)?.revision ?? 1])),
    locationId: location?.id ?? null, locationRevision: location?.revision ?? null,
  }
}

/** Ảnh chân dung của những nhân vật có mặt trong frame, theo đúng thứ tự blocking. */
export function portraitUploadIds(frame: TimelineFrame, cast: CastMember[]): string[] {
  const ids: string[] = []
  for (const entry of frame.blocking) {
    const uploadId = cast.find((item) => item.id === entry.castId)?.portrait?.uploadId
    if (uploadId && !ids.includes(uploadId)) ids.push(uploadId)
  }
  return ids
}
