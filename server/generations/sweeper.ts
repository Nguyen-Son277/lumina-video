import type { AppEnv } from '../env'
import type { Database } from '../db/index'
import { logger } from '../lib/logger'
import type { SceneRow } from '../projects/service'
import { enqueueGeneration, enqueueSchema } from './enqueue'
import type { Worker } from './worker'

/**
 * Xếp hàng tạo nội dung cho các cảnh đã được duyệt.
 *
 * Vì `MAX_CONCURRENT_JOBS_PER_USER` giới hạn số tác vụ chạy đồng thời (mặc định
 * 2), không thể xếp hàng hàng chục cảnh trong một lần. Bộ quét này chạy ở cuối
 * mỗi vòng của worker: mỗi lần lấp đầy số chỗ còn trống, nên dự án dài vẫn chạy
 * hết tuần tự và tiếp tục chạy kể cả khi người dùng đã đóng tab.
 *
 * Chỉ cảnh `auto_generate = 1 AND approved = 1` được xếp hàng; cảnh chưa duyệt
 * không bao giờ tốn tiền. Cảnh chưa gán model được giữ nguyên cờ để lần sau gán
 * model xong sẽ tự vào hàng.
 */
export function sweepAutoGenerate(options: {
  db: Database
  env: AppEnv
  worker: Worker
}): number {
  const { db, env, worker } = options

  const users = db
    .prepare(
      `SELECT DISTINCT p.user_id AS userId
         FROM scenes s
         JOIN projects p ON p.id = s.project_id
        WHERE s.auto_generate = 1 AND s.approved = 1`,
    )
    .all() as unknown as Array<{ userId: string }>

  let queued = 0

  for (const { userId } of users) {
    const active = db
      .prepare(
        "SELECT COUNT(*) AS total FROM generations WHERE user_id = ? AND status IN ('queued','running','downloading')",
      )
      .get(userId) as { total: number }

    let slots = env.MAX_CONCURRENT_JOBS_PER_USER - Number(active.total)
    if (slots <= 0) continue

    const scenes = db
      .prepare(
        `SELECT s.* FROM scenes s
           JOIN projects p ON p.id = s.project_id
          WHERE p.user_id = ? AND s.auto_generate = 1 AND s.approved = 1
          ORDER BY s.project_id, s.position, s.id`,
      )
      .all(userId) as unknown as SceneRow[]

    for (const scene of scenes) {
      if (slots <= 0) break

      // Chưa chọn model thì để lại trong hàng, không phải lỗi.
      if (!scene.model_id) continue

      // Cảnh đang có tác vụ chạy thì không xếp thêm.
      const running = db
        .prepare(
          "SELECT 1 AS found FROM generations WHERE scene_id = ? AND status IN ('queued','running','downloading') LIMIT 1",
        )
        .get(scene.id)
      if (running) continue

      const parsed = enqueueSchema.safeParse({
        projectId: scene.project_id,
        characterId: scene.character_id ?? undefined,
        modelId: scene.model_id,
        prompt: scene.prompt,
        params: JSON.parse(scene.params_json) as Record<string, unknown>,
      })
      if (!parsed.success) {
        // Cảnh thiếu nội dung hoặc dữ liệu sai: bỏ qua để không chặn các cảnh khác.
        logger.warn('Bỏ qua cảnh chưa đủ điều kiện tạo nội dung', { sceneId: scene.id })
        continue
      }

      try {
        const cast = (
          db
            .prepare('SELECT character_id FROM scene_characters WHERE scene_id = ? ORDER BY position')
            .all(scene.id) as unknown as Array<{ character_id: string }>
        ).map((row) => row.character_id)

        enqueueGeneration({
          db,
          env,
          worker,
          userId,
          request: {
            data: parsed.data,
            scene: {
              id: scene.id,
              projectId: scene.project_id,
              dialogue: scene.dialogue,
              speakerId: scene.character_id,
              castIds: cast,
              background: scene.background,
            },
          },
        })

        // Đã vào hàng thì hạ cờ để không xếp trùng ở vòng sau.
        db.prepare('UPDATE scenes SET auto_generate = 0, updated_at = ? WHERE id = ?').run(
          Date.now(),
          scene.id,
        )
        slots -= 1
        queued += 1
      } catch (error) {
        // Hết chỗ hoặc lỗi tạm thời: giữ cờ để vòng sau thử lại.
        logger.warn('Không xếp hàng được cảnh', {
          sceneId: scene.id,
          message: error instanceof Error ? error.message : 'lỗi không xác định',
        })
        break
      }
    }
  }

  return queued
}
