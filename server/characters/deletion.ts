import type { Database } from '../db/index'
import { transaction } from '../projects/service'
import { canvasSourceUsage, removeCanvasSourceNodes, type CanvasLinkUsage } from '../canvas/service'

/**
 * Xoá nhân vật dùng chung mà không tạo bế tắc.
 *
 * Nhân vật thư viện có thể đang nằm trong cảnh của một dự án **đã lưu trữ** hoặc
 * **trong Thùng rác**. Hai trạng thái đó không sửa được (route cảnh trả 404/400),
 * nên nếu vẫn chặn xoá thì nhân vật bị giam tới lúc dự án hết hạn purge. Quy tắc:
 *
 *   - Dự án còn sửa được  → chặn, trả về đúng nơi đang dùng để người dùng tự gỡ.
 *   - Dự án lưu trữ/thùng rác → cho xoá và gỡ tham chiếu ngay trong transaction.
 *   - `detach: true` khi người dùng đã xác nhận → gỡ ở mọi nơi rồi xoá.
 */

export type ProjectState = 'active' | 'archived' | 'trashed'

export type SceneUsage = {
  projectId: string
  projectName: string
  projectState: ProjectState
  sceneId: string
  sceneTitle: string
  /** `speaker` là người nói chính, `cast` là chỉ xuất hiện trong cảnh. */
  role: 'speaker' | 'cast'
}

export type CharacterUsage = {
  scenes: SceneUsage[]
  canvas: CanvasLinkUsage[]
}

export type CharacterDetachSummary = {
  scenes: number
  canvasNodes: number
  /** Dự án đã được gỡ tham chiếu, kèm trạng thái tại thời điểm xoá. */
  projects: Array<{ id: string; name: string; state: ProjectState }>
}

function projectState(row: { archived: number; deleted_at: number | null }): ProjectState {
  if (row.deleted_at != null) return 'trashed'
  if (row.archived) return 'archived'
  return 'active'
}

/** Mọi nơi đang dùng nhân vật, kèm trạng thái dự án để quyết định chặn hay gỡ. */
export function characterUsage(db: Database, characterId: string): CharacterUsage {
  const rows = db
    .prepare(
      `SELECT s.id AS sceneId, s.title AS sceneTitle, s.character_id AS speakerId,
              p.id AS projectId, p.name AS projectName, p.archived, p.deleted_at
         FROM scenes s
         JOIN projects p ON p.id = s.project_id
        WHERE s.character_id = ?
           OR s.id IN (SELECT scene_id FROM scene_characters WHERE character_id = ?)
        ORDER BY p.created_at, s.position, s.id`,
    )
    .all(characterId, characterId) as unknown as Array<{
      sceneId: string
      sceneTitle: string
      speakerId: string | null
      projectId: string
      projectName: string
      archived: number
      deleted_at: number | null
    }>

  return {
    scenes: rows.map((row) => ({
      projectId: row.projectId,
      projectName: row.projectName,
      projectState: projectState(row),
      sceneId: row.sceneId,
      sceneTitle: row.sceneTitle,
      role: row.speakerId === characterId ? 'speaker' : 'cast',
    })),
    canvas: canvasSourceUsage(db, 'character_id', characterId),
  }
}

/** Nơi dùng ở dự án còn sửa được; chỉ những chỗ này mới đáng chặn người dùng. */
export function blockingUsage(usage: CharacterUsage): CharacterUsage {
  return {
    scenes: usage.scenes.filter((item) => item.projectState === 'active'),
    canvas: usage.canvas.filter((item) => item.projectState === 'active'),
  }
}

export function hasBlockingUsage(usage: CharacterUsage): boolean {
  const blocking = blockingUsage(usage)
  return blocking.scenes.length > 0 || blocking.canvas.length > 0
}

/** Câu tóm tắt để hiện nhanh trong thông báo lỗi; chi tiết đầy đủ nằm ở `details`. */
export function usageSummary(usage: CharacterUsage): string {
  const projects = new Map<string, { scenes: number; canvas: number }>()
  const bump = (name: string, field: 'scenes' | 'canvas'): void => {
    const entry = projects.get(name) ?? { scenes: 0, canvas: 0 }
    entry[field] += 1
    projects.set(name, entry)
  }
  for (const item of usage.scenes) bump(item.projectName, 'scenes')
  for (const item of usage.canvas) bump(item.projectName, 'canvas')
  return [...projects.entries()]
    .map(([name, count]) => `${name} (${[
      count.scenes ? `${count.scenes} cảnh` : '',
      count.canvas ? `${count.canvas} node Canvas` : '',
    ].filter(Boolean).join(', ')})`)
    .join(', ')
}

/**
 * Gỡ tham chiếu tới nhân vật khỏi cảnh và Canvas.
 *
 * `onlyNonEditable` bỏ qua dự án còn sửa được để người dùng chủ động gỡ ở đó;
 * truyền `false` khi họ đã xác nhận gỡ ở mọi nơi.
 */
export function detachCharacterReferences(
  db: Database,
  userId: string,
  characterId: string,
  usage: CharacterUsage,
  options: { onlyNonEditable: boolean },
): CharacterDetachSummary {
  const scenes = options.onlyNonEditable
    ? usage.scenes.filter((item) => item.projectState !== 'active')
    : usage.scenes
  const canvas = options.onlyNonEditable
    ? usage.canvas.filter((item) => item.projectState !== 'active')
    : usage.canvas

  const sceneIds = [...new Set(scenes.map((item) => item.sceneId))]
  const canvasProjects = [...new Set(canvas.map((item) => item.projectId))]
  const projects = new Map<string, { id: string; name: string; state: ProjectState }>()
  for (const item of [...scenes, ...canvas]) {
    projects.set(item.projectId, { id: item.projectId, name: item.projectName, state: item.projectState })
  }

  return transaction(db, () => {
    let canvasNodes = 0
    if (sceneIds.length) {
      const placeholders = sceneIds.map(() => '?').join(', ')
      // Bảng liên kết dùng ON DELETE RESTRICT nên phải xoá trước khi xoá nhân vật.
      db.prepare(`DELETE FROM scene_characters WHERE character_id = ? AND scene_id IN (${placeholders})`)
        .run(characterId, ...sceneIds)
      db.prepare(`UPDATE scenes SET character_id = NULL, updated_at = ? WHERE character_id = ? AND id IN (${placeholders})`)
        .run(Date.now(), characterId, ...sceneIds)
    }
    for (const projectId of canvasProjects) {
      canvasNodes += removeCanvasSourceNodes(db, projectId, userId, 'character_id', characterId)
    }
    return { scenes: sceneIds.length, canvasNodes, projects: [...projects.values()] }
  })
}

/** Xoá hàng nhân vật sau khi đã gỡ tham chiếu (media xử lý riêng ở route). */
export function deleteCharacterRow(db: Database, userId: string, characterId: string): void {
  db.prepare('DELETE FROM characters WHERE id = ? AND user_id = ?').run(characterId, userId)
}
