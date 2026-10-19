import { frameContextDocuments, validateFrameDocuments } from './mentions'
import { randomUUID } from 'node:crypto'
import type { AppEnv } from '../env'
import type { Database } from '../db/index'
import { badRequest } from '../lib/errors'
import type { MediaStore } from '../media/store'
import {
  characterPublic,
  ownedProject,
  projectPublic,
  sceneCast,
  scenePublic,
  transaction,
  type CharacterRow,
  type ProjectRow,
  type SceneRow,
} from '../projects/service'
import { parseLocations, type CastMember, type Timeline } from './artifacts'
import { POSITION_TEXT } from './storyboard'
import { ownedSession, type PlanSessionRow } from './service'
import { assertCharacterMediaQuota, retainCharacterMedia } from '../entityLibrary/characterMedia'
import { registerTimelineCanvas, syncTimelineSession } from '../canvas/timelineSync'

/** Empty/missing voice fields and JSON key order do not change a design. */
function voiceIdentity(voice: CastMember['voice']): string {
  return JSON.stringify(Object.entries(voice)
    .filter(([, value]) => typeof value === 'string' && value.trim())
    .map(([key, value]) => [key, value!.trim()])
    .sort(([left], [right]) => left!.localeCompare(right!)))
}

/** Only a selected, deliberately designed variant can override explicit reuse. */
function selectedDesignDiffers(
  db: Database,
  mediaStore: MediaStore | undefined,
  userId: string,
  planned: CastMember,
  original: CharacterRow,
): boolean {
  const selected = planned.variants?.find(variant => variant.id === planned.selectedVariantId)
  // normalizeCastMember synthesizes a plain original for legacy/plain reuse. Merely
  // having other proposals is not a choice to replace that original identity.
  if (!selected || (selected.id === `${planned.id}-original` && selected.revision === 1)) return false
  if (planned.appearance.trim() !== original.appearance.trim()
    || voiceIdentity(planned.voice) !== voiceIdentity(JSON.parse(original.voice_json))) return true

  // A current selected portrait can carry a changed design even with identical
  // text. Compare owned bytes, not upload IDs (a copy may be the same portrait).
  if (!mediaStore || !planned.portrait?.uploadId) return false
  const portrait = readUpload(db, mediaStore, userId, planned.portrait.uploadId)
  if (!portrait) return false
  return !original.reference_path || !mediaStore.exists(original.reference_path)
    || !Buffer.from(portrait.bytes).equals(Buffer.from(mediaStore.readFile(original.reference_path)))
}

export type ApplyOptions = {
  /** Tên dự án mới; chỉ dùng cho phiên Tạo kịch bản AI. */
  newProjectName?: string
  /** Model video gán cho mọi frame; có thể ghi đè từng frame bằng sceneModelIds. */
  modelId?: string
  /** Ghi đè model theo chỉ số frame (0-based, tính từ frame đầu của timeline). */
  sceneModelIds?: Record<string, string>
  /** Đánh dấu các cảnh mới là "sẽ tạo khi được duyệt". */
  autoGenerate?: boolean
}

export type ApplyResult = {
  project: ReturnType<typeof projectPublic>
  characters: ReturnType<typeof characterPublic>[]
  scenes: ReturnType<typeof scenePublic>[]
  /** Số cảnh được đánh dấu chờ tạo (chưa xếp hàng vì còn phải duyệt). */
  pending: number
}

/** Model phải thuộc người dùng, đang bật và đã phân loại là tạo video. */
function requireVideoModel(db: Database, userId: string, modelId: string): void {
  const row = db
    .prepare("SELECT id FROM models WHERE id = ? AND user_id = ? AND enabled = 1 AND kind = 'video'")
    .get(modelId, userId)
  if (!row) {
    throw badRequest('Cần chọn model video hợp lệ đang bật. Hãy kiểm tra trong API & Models.')
  }
}

/** Đọc ảnh người dùng đã gắn (ảnh chân dung / ảnh nền) từ kho uploads. */
function readUpload(
  db: Database,
  mediaStore: MediaStore,
  userId: string,
  uploadId: string,
): { path: string; bytes: Uint8Array } | null {
  const row = db
    .prepare('SELECT relative_path AS path FROM uploads WHERE id = ? AND user_id = ?')
    .get(uploadId, userId) as { path: string } | undefined
  if (!row || !mediaStore.exists(row.path)) return null
  return { path: row.path, bytes: mediaStore.readFile(row.path) }
}

/** Gắn ảnh chân dung của ý tưởng nhân vật làm ảnh tham chiếu của nhân vật. */
function applyPortrait(options: {
  db: Database
  env: AppEnv
  mediaStore: MediaStore | undefined
  userId: string
  characterId: string
  uploadId: string
}): void {
  const { db, env, mediaStore, userId, characterId, uploadId } = options
  if (!mediaStore) return

  const upload = readUpload(db, mediaStore, userId, uploadId)
  if (!upload) return

  const character = db.prepare('SELECT * FROM characters WHERE id = ? AND user_id = ?').get(characterId, userId) as CharacterRow
  assertCharacterMediaQuota(db, mediaStore, env, character, upload.bytes.byteLength)
  const saved = mediaStore.saveCharacterReference({
    userId,
    characterId,
    bytes: upload.bytes,
    maxBytes: env.MAX_REFERENCE_BYTES,
  })
  // applyPlan already owns a transaction; setCharacterMedia starts another one.
  retainCharacterMedia(db, { user_id: userId, reference_path: saved.relativePath,
    reference_mime: saved.mimeType, reference_bytes: saved.byteSize })
  db.prepare(
    'UPDATE characters SET reference_path = ?, reference_mime = ?, reference_bytes = ?, updated_at = ? WHERE id = ?',
  ).run(saved.relativePath, saved.mimeType, saved.byteSize, Date.now(), characterId)
}

/**
 * Sao chép ảnh nền của frame thành một ảnh nguồn mới của người dùng.
 *
 * Sao chép thay vì trỏ chung để cảnh không phụ thuộc vòng đời của phiên kịch bản:
 * xoá phiên hoặc xoá ảnh trong phiên không làm hỏng cảnh đã chốt.
 */
function copyBackgroundUpload(options: {
  db: Database
  env: AppEnv
  mediaStore: MediaStore | undefined
  userId: string
  uploadId: string
}): string | null {
  const { db, env, mediaStore, userId, uploadId } = options
  if (!mediaStore) return null

  const upload = readUpload(db, mediaStore, userId, uploadId)
  if (!upload) return null

  const nextId = randomUUID()
  const saved = mediaStore.saveUpload({
    userId,
    uploadId: nextId,
    bytes: upload.bytes,
    maxBytes: env.MAX_SOURCE_IMAGE_BYTES,
  })
  db.prepare(
    'INSERT INTO uploads (id, user_id, relative_path, mime_type, byte_size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(nextId, userId, saved.relativePath, saved.mimeType, saved.byteSize, Date.now())
  return nextId
}

/**
 * Áp dụng timeline đã duyệt vào dự án.
 *
 * Phiên `planner` tạo dự án mới; phiên `copilot` vá vào dự án đang mở. Mọi thay
 * đổi nằm trong một transaction để không tạo ra dự án dở dang nếu có lỗi giữa
 * đường. Cảnh mới luôn ở trạng thái CHƯA duyệt: người dùng phải xem lại cảnh và
 * nhân vật tham chiếu trước khi tốn tiền tạo nội dung.
 */
export function applyPlan(options: {
  db: Database
  env: AppEnv
  userId: string
  session: PlanSessionRow
  timeline: Timeline
  cast: CastMember[]
  apply: ApplyOptions
  mediaStore?: MediaStore
  /** Tạo id; cho phép test thay bằng nguồn xác định. */
  newId?: () => string
}): ApplyResult {
  const { db, env, userId, session, timeline, cast, apply, mediaStore } = options
  ownedSession(db, userId, session.id)
  const nextId = options.newId ?? (() => randomUUID())

  if (!timeline.frames.length) throw badRequest('Timeline chưa có frame nào để áp dụng.')

  const autoGenerate = apply.autoGenerate === true
  const now = Date.now()

  // Model dùng chung cho mọi frame nếu người dùng không ghi đè từng frame.
  if (apply.modelId) requireVideoModel(db, userId, apply.modelId)
  for (const modelId of Object.values(apply.sceneModelIds ?? {})) {
    requireVideoModel(db, userId, modelId)
  }

  return transaction(db, () => {
    let project: ProjectRow
    const linked = db.prepare('SELECT project_id FROM timeline_canvas_sessions WHERE session_id=? AND user_id=?').get(session.id, userId) as { project_id: string } | undefined
    if (linked) {
      project = ownedProject(db, userId, linked.project_id, true)
      syncTimelineSession(db, session.id)
      const characters = db.prepare('SELECT * FROM characters WHERE user_id=? AND deleted_at IS NULL AND (project_id=? OR project_id IS NULL)').all(userId, project.id) as unknown as CharacterRow[]
      const scenes = db.prepare('SELECT s.* FROM scenes s JOIN timeline_canvas_frames f ON f.scene_id=s.id WHERE f.session_id=? ORDER BY s.position,s.id').all(session.id) as unknown as SceneRow[]
      db.prepare("UPDATE plan_sessions SET status='applied',project_id=?,updated_at=? WHERE id=?").run(project.id, now, session.id)
      return { project: projectPublic(project), characters: characters.map(characterPublic), scenes: scenes.map(row => scenePublic(row, sceneCast(db, row.id), db)), pending: 0 }
    }

    // Chỉ phiên `copilot` mới vá vào dự án đang mở. Không dựa vào
    // `session.project_id` vì chính applyPlan ghi cột đó cho phiên planner, khiến
    // lần chốt thứ hai bị biến thành "vá vào dự án cũ" và bỏ qua tên dự án mới.
    if (session.kind === 'copilot' && session.project_id) {
      project = ownedProject(db, userId, session.project_id, true)
    } else {
      const name = (apply.newProjectName ?? session.title ?? '').trim() || 'Dự án từ Tạo kịch bản AI'
      const id = nextId()
      db.prepare(
        `INSERT INTO projects (id, user_id, name, description, style, language, archived, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(id, userId, name.slice(0, 200), '', '', 'vi', now, now)
      project = ownedProject(db, userId, id)
    }

    const locationIdMap = new Map<string, string>()
    for (const location of parseLocations(session.locations_json)) {
      const id = nextId()
      // Copy EVERY angle: the project must keep the same multi-view references,
      // otherwise shots at other angles lose the location consistency.
      const views = location.referenceViews.length
        ? location.referenceViews
        : location.reference ? [{ id: location.reference.uploadId, label: '', uploadId: location.reference.uploadId, sheet: false }] : []
      const copiedViews = views.flatMap((view) => {
        const uploadId = copyBackgroundUpload({ db, env, mediaStore, userId, uploadId: view.uploadId })
        return uploadId ? [{ ...view, uploadId }] : []
      })
      db.prepare(`INSERT INTO project_locations
        (id, project_id, name, stage, description, continuity_notes, image_prompt, reference_upload_id, reference_views_json, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, project.id, location.name, location.stage, location.description, location.continuityNotes,
        location.imagePrompt, copiedViews[0]?.uploadId ?? null, JSON.stringify(copiedViews), location.revision, now, now,
      )
      locationIdMap.set(location.id, id)
    }

    // --- Nhân vật ---
    const createdCharacters: CharacterRow[] = []
    const characterIdByCastId = new Map<string, string>()
    const managedCharacterIds = new Set<string>()
    const uniqueCastByName = new Map(cast.filter(member => cast.filter(other => other.name.trim().toLowerCase() === member.name.trim().toLowerCase()).length === 1).map(member => [member.name.trim().toLowerCase(), member]))
    const castNameById = new Map(cast.map((member) => [member.id, member.name.trim()]))

    for (const planned of cast) {
      let row: CharacterRow | undefined

      if (planned.reuseCharacterId) {
        row = db
          .prepare('SELECT * FROM characters WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND (project_id IS NULL OR project_id = ?)')
          .get(planned.reuseCharacterId, userId, project.id) as CharacterRow | undefined
      }

      if (planned.reuseCharacterId && !row) throw badRequest('Nhân vật được chọn để dùng lại không còn thuộc phạm vi dự án.')
      // Preserve an intentional selected design without mutating the reused
      // library/project original. Only planner cast bindings map to the new ID;
      // persistent mention documents still refer to the identity users selected.
      if (row && selectedDesignDiffers(db, mediaStore, userId, planned, row)) row = undefined

      let created = false
      if (!row) {
        const id = nextId()
        // Người dùng chọn nơi lưu cho từng nhân vật: thư viện dùng chung hoặc chỉ dự án.
        const projectId = planned.storage === 'project' ? project.id : null
        db.prepare(
          `INSERT INTO characters
             (id, user_id, project_id, name, appearance, voice_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          userId,
          projectId,
          planned.name,
          planned.appearance,
          JSON.stringify(planned.voice),
          now,
          now,
        )
        row = db.prepare('SELECT * FROM characters WHERE id = ?').get(id) as CharacterRow
        created = true
      }

      // Ảnh chân dung đã sinh/tải trong phiên trở thành ảnh tham chiếu của nhân vật.
      if (created && planned.portrait?.uploadId) {
        applyPortrait({
          db,
          env,
          mediaStore,
          userId,
          characterId: row.id,
          uploadId: planned.portrait.uploadId,
        })
        row = db.prepare('SELECT * FROM characters WHERE id = ?').get(row.id) as CharacterRow
      }

      if (created) { createdCharacters.push(row); managedCharacterIds.add(row.id) }
      characterIdByCastId.set(planned.id, row.id)
    }

    // --- Cảnh ---
    const existing = db
      .prepare('SELECT COUNT(*) AS total FROM scenes WHERE project_id = ?')
      .get(project.id) as { total: number }
    let position = Number(existing.total)

    const createdScenes: SceneRow[] = []
    const frameMappings: Array<{ frameId: string; sceneId: string }> = []
    let pending = 0

    timeline.frames.forEach((frame, index) => {
      const modelId = apply.sceneModelIds?.[String(index)] ?? apply.modelId ?? null
      if (modelId) requireVideoModel(db, userId, modelId)

      const speakerCastId = frame.speakerCastId === undefined
        ? uniqueCastByName.get(frame.speaker.trim().toLowerCase())?.id : frame.speakerCastId
      const speakerId = speakerCastId ? characterIdByCastId.get(speakerCastId) ?? null : null
      validateFrameDocuments(db, userId, frame, session.kind === 'copilot' ? project.id : undefined)
      const contextDocuments = frameContextDocuments(frame)

      if (frame.locationId && !locationIdMap.has(frame.locationId)) throw badRequest('Bối cảnh của frame không tồn tại.')
      const sceneId = nextId()
      // Hành động riêng, biểu cảm từng người (blocking) phải theo sang Studio, nếu không
      // phần dàn dựng đã duyệt trong timeline sẽ mất khi tạo cảnh.
      const blockingText = frame.blocking?.length
        ? ` Nhân vật trong khung: ${frame.blocking
            .map((entry) => {
              const name = castNameById.get(entry.castId) ?? entry.castId
              const expression = entry.expression?.trim() ? `, biểu cảm: ${entry.expression.trim()}` : ''
              return `${name} — hành động: ${entry.action || 'đứng yên'}${expression} (${POSITION_TEXT[entry.position] ?? 'trong khung'})`
            })
            .join('; ')}.`
        : ''
      const beatsText = frame.beats?.trim() ? ` Nhịp hành động: ${frame.beats.trim()}.` : ''
      // `prompt` là mô tả dùng cho model; hành động là nguồn chính, thiếu thì lấy tiêu đề.
      const prompt = `${frame.action || frame.title}${beatsText}${blockingText}`.slice(0, 8000)

      const backgroundUploadId = frame.background?.uploadId
        ? copyBackgroundUpload({ db, env, mediaStore, userId, uploadId: frame.background.uploadId })
        : null

      db.prepare(
        `INSERT INTO scenes
           (id, project_id, title, prompt, character_id, dialogue, model_id, params_json,
            position, background, background_upload_id, approved, auto_generate, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      ).run(
        sceneId,
        project.id,
        frame.title.slice(0, 200),
        prompt,
        speakerId,
        frame.dialogue,
        modelId,
        // Thời lượng nằm trong params để tác vụ tạo dùng đúng timeline đã duyệt.
        JSON.stringify({ seconds: String(frame.durationSeconds) }),
        position,
        frame.context,
        backgroundUploadId,
        autoGenerate ? 1 : 0,
        now,
        now,
      )

      db.prepare('UPDATE scenes SET context_documents_json = ? WHERE id = ?').run(JSON.stringify(contextDocuments), sceneId)

      // Liên kết nhân vật trong cảnh; người nói luôn ở vị trí 0.
      if (frame.locationId) db.prepare('UPDATE scenes SET location_id = ? WHERE id = ?').run(locationIdMap.get(frame.locationId)!, sceneId)
      const frameCastIds = frame.blocking?.length
        ? frame.blocking.map(entry => entry.castId)
        : frame.characters.flatMap(name => uniqueCastByName.get(name.trim().toLowerCase())?.id ?? [])
      const linked = new Set<string>()
      let castPosition = 0
      for (const castId of [speakerCastId, ...frameCastIds]) {
        const characterId = castId ? characterIdByCastId.get(castId) : undefined
        if (!characterId || linked.has(characterId)) continue
        linked.add(characterId)
        db.prepare('INSERT INTO scene_characters (scene_id, character_id, position) VALUES (?, ?, ?)').run(sceneId, characterId, castPosition++)
      }

      if (autoGenerate) pending += 1
      position += 1
      createdScenes.push(db.prepare('SELECT * FROM scenes WHERE id = ?').get(sceneId) as SceneRow)
      frameMappings.push({ frameId: frame.id, sceneId })
    })

    // Ghi lại kết quả vào phiên để lần sau không tạo trùng.
    db.prepare(
      "UPDATE plan_sessions SET status = 'applied', project_id = ?, updated_at = ? WHERE id = ?",
    ).run(project.id, now, session.id)

    registerTimelineCanvas(db, {
      sessionId: session.id, projectId: project.id, userId, frames: frameMappings,
      characters: [...characterIdByCastId].map(([sourceId, targetId]) => ({ sourceId, targetId, managed: managedCharacterIds.has(targetId) })),
      locations: [...locationIdMap].map(([sourceId, targetId]) => ({ sourceId, targetId })),
    })

    // Trả về nhân vật của dự án (gồm cả nhân vật vừa dùng lại từ thư viện).
    const projectCharacters = db
      .prepare(
        'SELECT * FROM characters WHERE user_id = ? AND deleted_at IS NULL AND (project_id = ? OR project_id IS NULL) ORDER BY created_at ASC, id',
      )
      .all(userId, project.id) as unknown as CharacterRow[]

    return {
      project: projectPublic(ownedProject(db, userId, project.id)),
      characters: projectCharacters.map(characterPublic),
      scenes: createdScenes.map((row) => scenePublic(db.prepare('SELECT * FROM scenes WHERE id=?').get(row.id) as SceneRow, sceneCast(db, row.id), db)),
      pending,
    }
  })
}
