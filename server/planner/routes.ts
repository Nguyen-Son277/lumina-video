import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import type { AppEnv } from '../env'
import type { Database } from '../db/index'
import { requireUser } from '../auth/middleware'
import { badRequest, providerError } from '../lib/errors'
import { createRateLimiter } from '../lib/rateLimit'
import { chatText, parseJsonLoose } from '../llm/chat'
import { resolveLlmTarget } from '../llm/connections'
import { ownedLlmConnection } from '../llm/connections'
import {
  characterPublic,
  ownedProject,
  projectPublic,
  sceneCast,
  scenePublic,
  type CharacterRow,
  type SceneRow,
} from '../projects/service'
import { applyPlan } from './apply'
import {
  buildChatSystem,
  buildIdeasMessages,
  buildPlanMessages,
  durationRange,
  normalizeIdeas,
  normalizePlan,
  type ChatMessage,
  type VideoIdeas,
  type VideoPlan,
} from './prompts'
import {
  appendMessage,
  gatherContext,
  historyFor,
  listMessages,
  listSessions,
  messageCount,
  messagePublic,
  ownedSession,
  requireStatus,
  sessionPublic,
  setStatus,
  touchSession,
} from './service'

const MAX_MESSAGE_LENGTH = 8000

const createSchema = z
  .object({
    kind: z.enum(['planner', 'copilot']).default('planner'),
    title: z.string().trim().max(200).optional(),
    connectionId: z.string().trim().min(1).optional(),
    projectId: z.string().trim().min(1).optional(),
  })
  .strict()

const patchSchema = z
  .object({
    title: z.string().trim().max(200).optional(),
    connectionId: z.string().trim().min(1).nullable().optional(),
  })
  .strict()

const messageSchema = z
  .object({
    content: z
      .string()
      .trim()
      .min(1, 'Vui lòng nhập nội dung')
      .max(MAX_MESSAGE_LENGTH, `Nội dung tối đa ${MAX_MESSAGE_LENGTH} ký tự`),
  })
  .strict()

const applySchema = z
  .object({
    /** Chỉ dùng cho phiên planner; phiên copilot vá vào dự án đang mở. */
    newProjectName: z.string().trim().max(200).optional(),
    /** Model video gán cho mọi cảnh của kế hoạch. */
    modelId: z.string().trim().min(1).optional(),
    /** Ghi đè model theo chỉ số cảnh (0-based). */
    sceneModelIds: z.record(z.string(), z.string().trim().min(1)).optional(),
    /** Đánh dấu cảnh mới sẽ được tạo ngay khi người dùng duyệt. */
    autoGenerate: z.boolean().default(false),
  })
  .strict()

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw badRequest(result.error.issues[0]?.message ?? 'Dữ liệu không hợp lệ')
  return result.data
}

/**
 * Trợ lý AI: chat lập kế hoạch, tổng hợp ý kiến, duyệt, rồi sinh kịch bản +
 * nhân vật + timeline.
 *
 * Cổng duyệt được ép ở server (`requireStatus`), không tin trạng thái client gửi
 * lên. Mọi endpoint gọi model đều dùng chung một giới hạn tần suất vì tiêu tốn
 * token trong key của người dùng.
 */
export function planRoutes(db: Database, env: AppEnv): Router {
  const router = Router()

  const chatLimiter = createRateLimiter({
    windowMs: 60_000,
    max: env.RATE_LIMIT_LLM_CHAT_PER_MIN || Number.MAX_SAFE_INTEGER,
  })

  function checkChatLimit(userId: string): void {
    if (!chatLimiter.check(`planner:${userId}`)) {
      throw badRequest('Bạn thao tác quá nhanh. Vui lòng đợi một lát rồi thử lại.')
    }
  }

  /** Gọi model bằng kết nối của phiên (hoặc kết nối tốt nhất nếu phiên chưa gắn). */
  async function callModel(
    userId: string,
    session: { id: string; llm_connection_id: string | null },
    messages: ChatMessage[],
  ): Promise<string> {
    const target = resolveLlmTarget(db, env, userId, session.llm_connection_id ?? undefined)
    const content = await chatText(env, target, messages)

    // Ghi lại kết nối đã dùng để lần sau tái lập đúng kết quả.
    if (!session.llm_connection_id) {
      db.prepare('UPDATE plan_sessions SET llm_connection_id = ? WHERE id = ?').run(
        target.connection.id,
        session.id,
      )
    }
    return content
  }

  router.get('/', (req, res) => {
    const user = requireUser(req)
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined
    const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined
    if (kind && kind !== 'planner' && kind !== 'copilot') {
      throw badRequest('Loại phiên trò chuyện không hợp lệ')
    }

    let sessions = listSessions(db, user.id, projectId)
    if (kind) sessions = sessions.filter((item) => item.session.kind === kind)

    res.json({
      sessions: sessions.map((item) => sessionPublic(item.session, item.messageCount)),
    })
  })

  router.post('/', (req, res) => {
    const user = requireUser(req)
    const data = parse(createSchema, req.body)

    if (data.kind === 'copilot') {
      if (!data.projectId) throw badRequest('Phiên trong dự án cần có projectId')
      // Kiểm tra sở hữu và trạng thái dự án trước khi gắn phiên.
      ownedProject(db, user.id, data.projectId, true)
    } else if (data.projectId) {
      throw badRequest('Phiên lập kế hoạch không gắn dự án có sẵn')
    }

    if (data.connectionId) ownedLlmConnection(db, user.id, data.connectionId)

    const id = randomUUID()
    const now = Date.now()
    db.prepare(
      `INSERT INTO plan_sessions
         (id, user_id, kind, llm_connection_id, project_id, title, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'chatting', ?, ?)`,
    ).run(
      id,
      user.id,
      data.kind,
      data.connectionId ?? null,
      data.projectId ?? null,
      data.title ?? '',
      now,
      now,
    )

    res.status(201).json({ session: sessionPublic(ownedSession(db, user.id, id), 0) })
  })

  router.get('/:id', (req, res) => {
    const user = requireUser(req)
    const session = ownedSession(db, user.id, req.params.id)
    res.json({
      session: sessionPublic(session, messageCount(db, session.id)),
      messages: listMessages(db, session.id).map(messagePublic),
    })
  })

  router.patch('/:id', (req, res) => {
    const user = requireUser(req)
    const session = ownedSession(db, user.id, req.params.id)
    const data = parse(patchSchema, req.body)

    if (data.connectionId) ownedLlmConnection(db, user.id, data.connectionId)

    const fields: string[] = []
    const values: Array<string | number | null> = []
    if (data.title !== undefined) {
      fields.push('title = ?')
      values.push(data.title)
    }
    if (data.connectionId !== undefined) {
      fields.push('llm_connection_id = ?')
      values.push(data.connectionId)
    }
    if (!fields.length) throw badRequest('Không có thay đổi nào để lưu')

    fields.push('updated_at = ?')
    values.push(Date.now())
    db.prepare(`UPDATE plan_sessions SET ${fields.join(', ')} WHERE id = ?`).run(
      ...values,
      session.id,
    )

    const updated = ownedSession(db, user.id, session.id)
    res.json({ session: sessionPublic(updated, messageCount(db, session.id)) })
  })

  router.delete('/:id', (req, res) => {
    const user = requireUser(req)
    const session = ownedSession(db, user.id, req.params.id)
    db.prepare('DELETE FROM plan_sessions WHERE id = ? AND user_id = ?').run(session.id, user.id)
    res.status(204).end()
  })

  /** Gửi một tin nhắn và nhận câu trả lời của model. */
  router.post('/:id/messages', async (req, res) => {
    const user = requireUser(req)
    const session = ownedSession(db, user.id, req.params.id)
    checkChatLimit(user.id)
    const data = parse(messageSchema, req.body)

    const context = gatherContext(db, user.id, session)
    appendMessage(db, session.id, 'user', data.content)
    touchSession(db, session.id)

    const history = historyFor(db, session.id)
    const reply = await callModel(user.id, session, [
      { role: 'system', content: buildChatSystem(context) },
      ...history,
    ])

    const assistant = appendMessage(db, session.id, 'assistant', reply)
    const updated = ownedSession(db, user.id, session.id)

    res.json({
      session: sessionPublic(updated, messageCount(db, session.id)),
      messages: listMessages(db, session.id).map(messagePublic),
      reply: messagePublic(assistant),
    })
  })

  /**
   * Tổng hợp toàn bộ hội thoại thành một đề xuất ý kiến.
   *
   * Sinh lại ý kiến sẽ xoá kế hoạch cũ vì kế hoạch đó dựa trên ý kiến trước.
   */
  router.post('/:id/ideas', async (req, res) => {
    const user = requireUser(req)
    const session = ownedSession(db, user.id, req.params.id)
    checkChatLimit(user.id)

    const history = historyFor(db, session.id)
    if (!history.some((message) => message.role === 'user')) {
      throw badRequest('Hãy trao đổi với AI ít nhất một lượt trước khi tổng hợp ý kiến.')
    }

    const context = gatherContext(db, user.id, session)
    const range = durationRange(context.videoModels)
    const content = await callModel(
      user.id,
      session,
      buildIdeasMessages(context, history),
    )

    const parsedJson = parseJsonLoose(content)
    if (parsedJson === null) {
      throw providerError('AI trả về dữ liệu không đọc được. Hãy thử lại.')
    }

    const ideas = normalizeIdeas(parsedJson, {
      language: context.language,
      lower: range.lower,
      upper: range.upper,
    })

    if (!ideas.logline && !ideas.keyPoints.length && !ideas.characters.length) {
      throw providerError('AI trả về dữ liệu không đọc được. Hãy thử lại.')
    }

    const updated = setStatus(db, session.id, 'ideas_ready', {
      ideasJson: JSON.stringify(ideas),
      // Ý kiến đổi thì kế hoạch cũ không còn giá trị.
      planJson: null,
      ...(session.title ? {} : { title: ideas.logline.slice(0, 200) || 'Kế hoạch mới' }),
    })

    res.json({ session: sessionPublic(updated, messageCount(db, session.id)), ideas })
  })

  /** Duyệt đề xuất ý kiến để mở khoá bước sinh kịch bản. */
  router.post('/:id/ideas/approve', (req, res) => {
    const user = requireUser(req)
    const session = ownedSession(db, user.id, req.params.id)
    requireStatus(session, ['ideas_ready'], 'Chưa có đề xuất ý kiến để duyệt.')

    const updated = setStatus(db, session.id, 'ideas_approved')
    res.json({ session: sessionPublic(updated, messageCount(db, session.id)) })
  })

  /** Sinh kịch bản + nhân vật + timeline từ ý kiến đã duyệt. */
  router.post('/:id/plan', async (req, res) => {
    const user = requireUser(req)
    const session = ownedSession(db, user.id, req.params.id)
    requireStatus(session, ['ideas_approved'], 'Cần duyệt ý kiến trước khi lên kịch bản.')
    checkChatLimit(user.id)

    const ideas = JSON.parse(session.ideas_json ?? '{}') as VideoIdeas
    const context = gatherContext(db, user.id, session)
    const range = durationRange(context.videoModels)
    const history = historyFor(db, session.id)

    const content = await callModel(
      user.id,
      session,
      buildPlanMessages(context, ideas, history),
    )

    const parsedJson = parseJsonLoose(content)
    if (parsedJson === null) {
      throw providerError('AI trả về dữ liệu không đọc được. Hãy thử lại.')
    }

    const plan: VideoPlan = normalizePlan(parsedJson, {
      language: context.language,
      lower: range.lower,
      upper: range.upper,
      libraryCharacters: context.libraryCharacters,
      ...(range.conflict ? { durationConflict: true } : {}),
    })

    if (!plan.scenes.length) {
      throw providerError('AI không tạo được cảnh nào. Hãy mô tả rõ hơn rồi thử lại.')
    }

    const updated = setStatus(db, session.id, 'plan_ready', {
      planJson: JSON.stringify(plan),
      ...(session.title ? {} : { title: plan.title.slice(0, 200) || 'Kế hoạch mới' }),
    })

    res.json({ session: sessionPublic(updated, messageCount(db, session.id)), plan })
  })

  /**
   * Chốt kế hoạch: tạo dự án mới (planner) hoặc vá vào dự án đang mở (copilot).
   *
   * Cảnh mới luôn ở trạng thái CHƯA duyệt nên chưa tốn tiền; người dùng xem lại
   * cảnh và nhân vật tham chiếu trong Studio rồi mới duyệt để xếp hàng tạo.
   */
  router.post('/:id/apply', (req, res) => {
    const user = requireUser(req)
    const session = ownedSession(db, user.id, req.params.id)
    const data = parse(applySchema, req.body)

    // Chốt hai lần thì trả lại dự án đã tạo thay vì tạo trùng.
    if (session.status === 'applied' && session.project_id) {
      const project = ownedProject(db, user.id, session.project_id)
      const scenes = db
        .prepare('SELECT * FROM scenes WHERE project_id = ? ORDER BY position, id')
        .all(project.id) as unknown as SceneRow[]
      const characters = db
        .prepare(
          'SELECT * FROM characters WHERE user_id = ? AND (project_id = ? OR project_id IS NULL) ORDER BY created_at ASC, id',
        )
        .all(user.id, project.id) as unknown as CharacterRow[]

      res.json({
        project: projectPublic(project),
        characters: characters.map(characterPublic),
        scenes: scenes.map((row) => scenePublic(row, sceneCast(db, row.id))),
        pending: 0,
        alreadyApplied: true,
      })
      return
    }

    requireStatus(session, ['plan_ready'], 'Cần sinh kế hoạch trước khi áp dụng.')
    if (!session.plan_json) throw badRequest('Kế hoạch trống, hãy sinh lại kế hoạch.')

    const plan = JSON.parse(session.plan_json) as VideoPlan
    const result = applyPlan({ db, env, userId: user.id, session, plan, apply: data })

    res.status(201).json(result)
  })

  return router
}
