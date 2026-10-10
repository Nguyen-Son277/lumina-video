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
import type { PlanSessionRow } from './service'

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

/**
 * Tìm nhân vật THƯ VIỆN (project_id IS NULL) theo tên để tái dùng.
 *
 * Chỉ tìm trong thư viện dùng chung: nhân vật do một dự án khác tạo không được
 * gắn sang dự án này, nếu không cảnh sẽ trỏ tới nhân vật không thuộc dự án và
 * danh sách nhân vật của dự án sẽ thiếu chính nhân vật đó.
 */
function findLibraryCharacterByName(
  db: Database,
  userId: string,
  name: string,
): CharacterRow | undefined {
  return db
    .prepare(
      `SELECT * FROM characters
        WHERE user_id = ? AND project_id IS NULL AND LOWER(name) = LOWER(?)
        ORDER BY created_at ASC LIMIT 1`,
    )
    .get(userId, name) as CharacterRow | undefined
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

  const saved = mediaStore.saveCharacterReference({
    userId,
    characterId,
    bytes: upload.bytes,
    maxBytes: env.MAX_REFERENCE_BYTES,
  })
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
      const uploadId = location.reference?.uploadId
        ? copyBackgroundUpload({ db, env, mediaStore, userId, uploadId: location.reference.uploadId }) : null
      db.prepare(`INSERT INTO project_locations
        (id, project_id, name, stage, description, continuity_notes, image_prompt, reference_upload_id, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, project.id, location.name, location.stage, location.description, location.continuityNotes,
        location.imagePrompt, uploadId, location.revision, now, now,
      )
      locationIdMap.set(location.id, id)
    }

    // --- Nhân vật ---
    const createdCharacters: CharacterRow[] = []
    const characterIdByName = new Map<string, string>()
    const castNameById = new Map(cast.map((member) => [member.id, member.name.trim()]))

    for (const planned of cast) {
      let row: CharacterRow | undefined

      const hasDesignChoice = Boolean(planned.variants && (planned.variants.length > 1 || planned.variants[0]?.revision !== 1 || planned.selectedVariantId !== `${planned.id}-original`))
      if (planned.reuseCharacterId) {
        row = db
          .prepare('SELECT * FROM characters WHERE id = ? AND user_id = ?')
          .get(planned.reuseCharacterId, userId) as CharacterRow | undefined
      }

      // Tránh tạo bản sao khi thư viện đã có nhân vật cùng tên.
      if (row && hasDesignChoice && row.appearance !== planned.appearance) row = undefined
      if (!row && !hasDesignChoice) row = findLibraryCharacterByName(db, userId, planned.name)

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
      if (planned.portrait?.uploadId) {
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

      if (created) createdCharacters.push(row)
      characterIdByName.set(planned.name.trim().toLowerCase(), row.id)
    }

    // --- Cảnh ---
    const existing = db
      .prepare('SELECT COUNT(*) AS total FROM scenes WHERE project_id = ?')
      .get(project.id) as { total: number }
    let position = Number(existing.total)

    const createdScenes: SceneRow[] = []
    let pending = 0

    timeline.frames.forEach((frame, index) => {
      const modelId = apply.sceneModelIds?.[String(index)] ?? apply.modelId ?? null
      if (modelId) requireVideoModel(db, userId, modelId)

      const speakerId = frame.speaker
        ? (characterIdByName.get(frame.speaker.trim().toLowerCase()) ?? null)
        : null

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

      // Liên kết nhân vật trong cảnh; người nói luôn ở vị trí 0.
      if (frame.locationId) db.prepare('UPDATE scenes SET location_id = ? WHERE id = ?').run(locationIdMap.get(frame.locationId)!, sceneId)
      const castNames = [...frame.characters]
      if (frame.speaker) {
        const speakerKey = frame.speaker.trim().toLowerCase()
        const withoutSpeaker = castNames.filter((name) => name.trim().toLowerCase() !== speakerKey)
        castNames.length = 0
        castNames.push(frame.speaker, ...withoutSpeaker)
      }

      const linked = new Set<string>()
      let castPosition = 0
      for (const name of castNames) {
        const characterId = characterIdByName.get(name.trim().toLowerCase())
        if (!characterId || linked.has(characterId)) continue
        linked.add(characterId)
        db.prepare(
          'INSERT INTO scene_characters (scene_id, character_id, position) VALUES (?, ?, ?)',
        ).run(sceneId, characterId, castPosition)
        castPosition += 1
      }

      if (autoGenerate) pending += 1
      position += 1
      createdScenes.push(db.prepare('SELECT * FROM scenes WHERE id = ?').get(sceneId) as SceneRow)
    })

    // Ghi lại kết quả vào phiên để lần sau không tạo trùng.
    db.prepare(
      "UPDATE plan_sessions SET status = 'applied', project_id = ?, updated_at = ? WHERE id = ?",
    ).run(project.id, now, session.id)

    // Trả về nhân vật của dự án (gồm cả nhân vật vừa dùng lại từ thư viện).
    const projectCharacters = db
      .prepare(
        'SELECT * FROM characters WHERE user_id = ? AND (project_id = ? OR project_id IS NULL) ORDER BY created_at ASC, id',
      )
      .all(userId, project.id) as unknown as CharacterRow[]

    return {
      project: projectPublic(ownedProject(db, userId, project.id)),
      characters: projectCharacters.map(characterPublic),
      scenes: createdScenes.map((row) => scenePublic(row, sceneCast(db, row.id))),
      pending,
    }
  })
}
