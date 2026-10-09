import { randomUUID } from 'node:crypto'
import type { AppEnv } from '../env'
import type { Database } from '../db/index'
import { badRequest } from '../lib/errors'
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
import type { VideoPlan } from './prompts'
import type { PlanSessionRow } from './service'

export type ApplyOptions = {
  /** Tên dự án mới; chỉ dùng cho phiên planner. */
  newProjectName?: string
  /** Model video gán cho mọi cảnh; có thể ghi đè từng cảnh bằng sceneModelIds. */
  modelId?: string
  /** Ghi đè model theo chỉ số cảnh (0-based, tính từ cảnh đầu của kế hoạch). */
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

function findCharacterByName(db: Database, userId: string, name: string): CharacterRow | undefined {
  return db
    .prepare(
      'SELECT * FROM characters WHERE user_id = ? AND LOWER(name) = LOWER(?) ORDER BY created_at ASC LIMIT 1',
    )
    .get(userId, name) as CharacterRow | undefined
}

/**
 * Áp dụng kế hoạch đã duyệt vào dự án.
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
  plan: VideoPlan
  apply: ApplyOptions
  /** Tạo id; cho phép test thay bằng nguồn xác định. */
  newId?: () => string
}): ApplyResult {
  const { db, userId, session, plan, apply } = options
  const nextId = options.newId ?? (() => randomUUID())

  if (!plan.scenes.length) throw badRequest('Kế hoạch không có cảnh nào để áp dụng.')

  const autoGenerate = apply.autoGenerate === true
  const now = Date.now()

  // Model dùng chung cho mọi cảnh nếu người dùng không ghi đè từng cảnh.
  if (apply.modelId) requireVideoModel(db, userId, apply.modelId)
  for (const modelId of Object.values(apply.sceneModelIds ?? {})) {
    requireVideoModel(db, userId, modelId)
  }

  return transaction(db, () => {
    let project: ProjectRow

    if (session.project_id) {
      // Copilot: vá vào dự án đang mở, không tạo dự án mới.
      project = ownedProject(db, userId, session.project_id, true)
    } else {
      const name = (apply.newProjectName ?? plan.title ?? '').trim() || 'Dự án từ Trợ lý AI'
      const id = nextId()
      db.prepare(
        `INSERT INTO projects (id, user_id, name, description, style, language, archived, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(id, userId, name.slice(0, 200), '', '', 'vi', now, now)
      project = ownedProject(db, userId, id)
    }

    // --- Nhân vật ---
    const createdCharacters: CharacterRow[] = []
    const characterIdByName = new Map<string, string>()

    for (const planned of plan.characters) {
      let row: CharacterRow | undefined

      if (planned.reuseCharacterId) {
        row = db
          .prepare('SELECT * FROM characters WHERE id = ? AND user_id = ?')
          .get(planned.reuseCharacterId, userId) as CharacterRow | undefined
      }

      // Tránh tạo bản sao khi thư viện đã có nhân vật cùng tên.
      if (!row) row = findCharacterByName(db, userId, planned.name)

      if (!row) {
        const id = nextId()
        db.prepare(
          `INSERT INTO characters
             (id, user_id, project_id, name, appearance, voice_json, created_at, updated_at)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          userId,
          planned.name,
          planned.appearance,
          JSON.stringify(planned.voice),
          now,
          now,
        )
        row = db.prepare('SELECT * FROM characters WHERE id = ?').get(id) as CharacterRow
        createdCharacters.push(row)
      }

      characterIdByName.set(planned.name.trim().toLowerCase(), row.id)
    }

    // --- Cảnh ---
    const existing = db
      .prepare('SELECT COUNT(*) AS total FROM scenes WHERE project_id = ?')
      .get(project.id) as { total: number }
    let position = Number(existing.total)

    const createdScenes: SceneRow[] = []
    let pending = 0

    plan.scenes.forEach((scene, index) => {
      const modelId = apply.sceneModelIds?.[String(index)] ?? apply.modelId ?? null
      if (modelId) requireVideoModel(db, userId, modelId)

      const speakerId = scene.speaker
        ? (characterIdByName.get(scene.speaker.trim().toLowerCase()) ?? null)
        : null

      const sceneId = nextId()
      // `prompt` là mô tả dùng cho model; hành động là nguồn chính, thiếu thì lấy tiêu đề.
      const prompt = (scene.action || scene.title).slice(0, 8000)

      db.prepare(
        `INSERT INTO scenes
           (id, project_id, title, prompt, character_id, dialogue, model_id, params_json,
            position, background, approved, auto_generate, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      ).run(
        sceneId,
        project.id,
        scene.title.slice(0, 200),
        prompt,
        speakerId,
        scene.dialogue,
        modelId,
        // Thời lượng nằm trong params để tác vụ tạo dùng đúng timeline đã duyệt.
        JSON.stringify({ seconds: String(scene.durationSeconds) }),
        position,
        scene.background,
        autoGenerate ? 1 : 0,
        now,
        now,
      )

      // Liên kết nhân vật trong cảnh; người nói luôn ở vị trí 0.
      const castNames = [...scene.characters]
      if (scene.speaker) {
        const speakerKey = scene.speaker.trim().toLowerCase()
        const withoutSpeaker = castNames.filter((name) => name.trim().toLowerCase() !== speakerKey)
        castNames.length = 0
        castNames.push(scene.speaker, ...withoutSpeaker)
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
