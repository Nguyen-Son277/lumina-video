import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import express from 'express'
import { z } from 'zod'
import type { AppEnv } from '../env'
import type { Database } from '../db/index'
import type { Worker } from '../generations/worker'
import { enqueueGeneration } from '../generations/enqueue'
import type { MediaStore } from '../media/store'
import { requireUser } from '../auth/middleware'
import { badRequest, errorMeta, notFound, providerError, validationError } from '../lib/errors'
import { createRateLimiter } from '../lib/rateLimit'
import { chatText, parseJsonLoose } from '../llm/chat'
import { ownedLlmModel, resolveLlmTarget } from '../llm/connections'
import { CHARACTER_SHEET_SIZE, buildCharacterSheetPrompt } from '../characters/portrait'
import {
  advanceImageBatch,
  createImageBatch,
  latestImageBatch,
  retryImageBatch,
  stopImageBatch,
} from './imageBatch'
import {
  adoptGenerationImage as adoptImage,
  portraitUploadIds,
  saveSessionUpload as saveUpload,
  storyboardPrompt,
  storyboardInputs,
} from './storyboard'
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
  castFromPlan,
  legacyScript,
  newArtifactId,
  parseCast,
  parseLocations,
  parseScript,
  parseTimeline,
  sceneFromPlan,
  scriptFromPlan,
  scriptTextFromScenes,
  normalizeBlocking,
  normalizeTimelineBlocking,
  timelineFromPlan,
  type CastMember,
  type DraftScene,
  type ScriptDraft,
  type Timeline,
  type TimelineFrame,
} from './artifacts'
import {
  buildArrangeRequest,
  buildArrangeSystem,
  buildArtifactRequest,
  buildArtifactSystem,
  buildChatSystem,
  durationRange,
  normalizePlan,
  type ArtifactTarget,
  type ChatMessage,
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
  sessionPublic,
  setStatus,
  updateSessionFields,
} from './service'

const MAX_MESSAGE_LENGTH = 8000

/** Nhãn tiếng Việt của bước agent, dùng trong thông báo trả về giao diện. */
const ARTIFACT_LABELS: Record<ArtifactTarget, string> = {
  script: 'Viết kịch bản',
  cast: 'Đề xuất nhân vật',
  timeline: 'Lên timeline',
}

/** Vòng đời tăng dần; dùng để không hạ trạng thái khi người dùng quay lại tab trước. */
const STATUS_ORDER = ['setup', 'scripting', 'script_ready', 'cast_ready', 'timeline_ready', 'applied'] as const

const createSchema = z
  .object({
    kind: z.enum(['planner', 'copilot']).default('planner'),
    title: z.string().trim().max(200).optional(),
    /** Model chat chọn sẵn khi tạo phiên; bỏ trống thì phiên bắt đầu ở bước chọn model. */
    chatModelId: z.string().trim().min(1).optional(),
    projectId: z.string().trim().min(1).optional(),
  })
  .strict()

const patchSchema = z
  .object({
    title: z.string().trim().max(200).optional(),
    chatModelId: z.string().trim().min(1).nullable().optional(),
  })
  .strict()

const setupSchema = z
  .object({
    chatModelId: z.string().trim().min(1).nullable().optional(),
    imageModelId: z.string().trim().min(1).nullable().optional(),
    videoModelId: z.string().trim().min(1).nullable().optional(),
  })
  .strict()

const messageSchema = z
  .object({
    content: z.string().trim().min(1, 'Vui lòng nhập nội dung').max(MAX_MESSAGE_LENGTH),
    target: z.enum(['script', 'cast', 'timeline']).default('script'),
  })
  .strict()

/** Một nhân vật trong frame: id (hoặc tên), hành động riêng, vị trí tương đối. */
const blockingSchema = z
  .object({
    castId: z.string().trim().min(1).max(200).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    action: z.string().trim().max(2000).default(''),
    position: z.enum(['left', 'center', 'right', 'background']).default('center'),
  })
  .strict()

const sceneSchema = z
  .object({
    id: z.string().min(1).optional(),
    title: z.string().trim().max(200).default(''),
    context: z.string().trim().max(2000).default(''),
    action: z.string().trim().max(8000).default(''),
    dialogue: z.string().trim().max(4000).default(''),
    speaker: z.string().trim().max(200).default(''),
    characters: z.array(z.string().trim().min(1).max(200)).max(12).default([]),
    durationSeconds: z.number().int().min(1).max(600).default(8),
    shotNotes: z.string().trim().max(500).default(''),
    locationId: z.string().min(1).nullable().optional(),
    backgroundLocationRevision: z.number().int().nonnegative().nullable().optional(),
    backgroundStale: z.boolean().optional(),
    backgroundPrompt: z.string().trim().max(2000).optional(),
    backgroundUploadId: z.string().trim().min(1).nullable().optional(),
    /** Danh sách nhân vật có mặt trong frame kèm hành động riêng và vị trí. */
    blocking: z.array(blockingSchema).max(12).optional(),
    /** Trường chỉ đọc khi giao diện gửi lại nguyên frame. */
    background: z.unknown().optional(),
  })
  .strict()

const scriptSchema = z
  .object({
    text: z.string().max(20000).default(''),
    scenes: z.array(sceneSchema).max(60).default([]),
  })
  .strict()

const castSchema = z
  .object({
    cast: z
      .array(
        z
          .object({
            id: z.string().min(1).optional(),
            name: z.string().trim().min(1, 'Nhân vật cần có tên').max(200),
            appearance: z.string().trim().max(4000).default(''),
            role: z.string().trim().max(200).default(''),
            voice: z.record(z.string(), z.unknown()).default({}),
            reuseCharacterId: z.string().trim().min(1).nullable().default(null),
            storage: z.enum(['library', 'project']).default('library'),
            /** Trường chỉ đọc khi giao diện gửi lại nguyên nhân vật. */
            portrait: z.unknown().optional(),
          })
          .strict(),
      )
      .max(12),
  })
  .strict()

const timelineSchema = z
  .object({ frames: z.array(sceneSchema).max(60) })
  .strict()

/** Yêu cầu sinh ảnh storyboard cho cả timeline. */
const imageBatchSchema = z
  .object({
    /** true: làm mới cả frame đã có ảnh (tốn phí và thay ảnh cũ). */
    regenerateAll: z.boolean().default(false),
  })
  .strict()

const applySchema = z
  .object({
    newProjectName: z.string().trim().max(200).optional(),
    modelId: z.string().trim().min(1).optional(),
    sceneModelIds: z.record(z.string(), z.string()).optional(),
    autoGenerate: z.boolean().optional(),
  })
  .strict()

const attachSchema = z
  .object({
    generationId: z.string().trim().min(1, 'Thiếu tác vụ tạo ảnh'),
    assetId: z.string().trim().min(1).optional(),
  })
  .strict()

/**
 * Tạo kịch bản AI: chọn model → chat + kịch bản nháp → ý tưởng nhân vật → timeline.
 *
 * Mọi thao tác gọi model đều là hành động chủ động của người dùng nên đều có giới
 * hạn tần suất riêng. Ảnh chân dung và ảnh nền dùng chính pipeline tạo ảnh của
 * Studio (hàng đợi nền), không có đường tắt nào bỏ qua kiểm tra model.
 */
export function planRoutes(db: Database, env: AppEnv, mediaStore: MediaStore, worker: Worker): Router {
  const router = Router()
  const masterKey = env.APP_ENCRYPTION_KEY

  const chatLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: env.RATE_LIMIT_LLM_CHAT_PER_MIN || Number.MAX_SAFE_INTEGER,
  })

  /** Ảnh người dùng tải lên cho chân dung/ảnh nền; nhận dạng bằng magic bytes. */
  const rawImage = express.raw({
    type: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    limit: env.MAX_REFERENCE_BYTES,
  })

  function checkChatLimit(userId: string): void {
    if (!chatLimiter.check(`script:${userId}`)) {
      throw badRequest('Bạn thao tác quá nhanh. Vui lòng đợi một lát rồi thử lại.')
    }
  }

  /** Model phải thuộc người dùng, đang bật và đúng phân loại. */
  function requireModelOfKind(userId: string, modelId: string, kind: 'llm' | 'image' | 'video'): void {
    const row = db
      .prepare('SELECT id FROM models WHERE id = ? AND user_id = ? AND kind = ? AND enabled = 1')
      .get(modelId, userId, kind)
    if (!row) {
      const label = kind === 'llm' ? 'LLM & Chat' : kind === 'image' ? 'Tạo ảnh' : 'Tạo video'
      throw badRequest(
        `Model đã chọn không hợp lệ hoặc chưa được phân loại thành "${label}".`,
        undefined,
        errorMeta('planner.model_label_mismatch', { label }),
      )
    }
  }

  /** Trạng thái chỉ tiến, không lùi (trừ khi kịch bản được sinh lại và dự án cũ bị bỏ). */
  function advanceStatus(current: string, target: Exclude<ArtifactTarget, never>): typeof STATUS_ORDER[number] {
    const desired: typeof STATUS_ORDER[number] =
      target === 'script' ? 'script_ready' : target === 'cast' ? 'cast_ready' : 'timeline_ready'
    const currentIndex = STATUS_ORDER.indexOf(current as typeof STATUS_ORDER[number])
    const desiredIndex = STATUS_ORDER.indexOf(desired)
    if (current === 'applied') return desired
    return desiredIndex > currentIndex ? desired : (current as typeof STATUS_ORDER[number])
  }

  /**
   * Gom context + artifact hiện tại cho model, rồi gọi chat và cập nhật artifact.
   *
   * Model trả JSON `{reply, ...artifact}`. JSON hỏng thì chỉ dùng phần text làm câu
   * trả lời và GIỮ NGUYÊN artifact cũ, để một câu trả lời lỗi không phá bản nháp
   * người dùng đang sửa.
   */
  async function runArtifact(options: {
    userId: string
    session: Parameters<typeof sessionPublic>[0]
    target: ArtifactTarget
    history: ChatMessage[]
    /** Khi có: yêu cầu AI viết/viết lại artifact thay vì trả lời chat. */
    instruction?: ChatMessage
  }): Promise<{ reply: string; session: ReturnType<typeof sessionPublic>; ran: ArtifactTarget | null }> {
    const { userId, target } = options
    const session = options.session
    const context = gatherContext(db, userId, session)

    const current = {
      script: parseScript(session.script_json),
      cast: parseCast(session.cast_json),
      timeline: parseTimeline(session.timeline_json),
    }

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: buildArtifactSystem(target, context, {
          script: current.script,
          cast: current.cast,
          timeline: current.timeline,
          locations: parseLocations(session.locations_json),
        }),
      },
      ...options.history.slice(-10),
    ]
    if (options.instruction) messages.push(options.instruction)

    const targetModel = resolveLlmTarget(db, env, userId, session.chat_model_id ?? undefined)
    // Phiên chưa chọn model chat thì ghi lại model vừa dùng để lần sau tái lập đúng.
    if (!session.chat_model_id) {
      updateSessionFields(db, session.id, { chatModelId: targetModel.modelPk })
    }
    const raw = await chatText(env, targetModel, messages)
    const parsed = parseJsonLoose(raw)
    const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    const reply =
      record && typeof record.reply === 'string' && record.reply.trim()
        ? record.reply.trim()
        : record
          ? ''
          : raw.trim()

    // Định tuyến agent: model có thể xin chạy thêm MỘT bước (script/cast/timeline).
    const requested = typeof record?.run === 'string' ? record.run : null
    const ran: ArtifactTarget | null =
      requested === 'script' || requested === 'cast' || requested === 'timeline' ? requested : null

    const range = durationRange(context.videoModels)
    const normalized = record
      ? normalizePlan(
          target === 'timeline' && current.cast.length
            ? { ...record, characters: current.cast }
            : record,
          {
            language: context.language,
            lower: range.lower,
            upper: range.upper,
            libraryCharacters: context.libraryCharacters,
            ...(range.conflict ? { durationConflict: true } : {}),
          },
        )
      : null

    const patch: Parameters<typeof setStatus>[3] = {}
    if (normalized) {
      if (target === 'script') {
        const explicitText = typeof record?.script === 'string' ? (record.script as string) : undefined
        patch.scriptJson = JSON.stringify(scriptFromPlan(normalized, explicitText))
      } else if (target === 'cast') {
        patch.castJson = JSON.stringify(castFromPlan(normalized, current.cast))
      } else {
        const cast = current.cast.length ? current.cast : castFromPlan(normalized)
        patch.castJson = JSON.stringify(cast)
        patch.timelineJson = JSON.stringify(
          restrictTimeline(timelineFromPlan(normalized, current.timeline), cast),
        )
      }
    }

    const status = normalized ? advanceStatus(session.status, target) : session.status
    const updated = setStatus(db, session.id, status, {
      ...patch,
      // Sinh lại kịch bản/timeline thì dự án đã chốt trước đó không còn là đích.
      clearProject: normalized !== null && session.kind === 'planner',
      ...(session.title ? {} : { title: normalized?.title?.slice(0, 200) ?? '' }),
    })

    return { reply, session: sessionPublic(updated, messageCount(db, session.id)), ran }
  }

  /** Chỉ giữ nhân vật có trong cast; frame trỏ tên lạ sẽ bị bỏ để không tạo cảnh lỗi. */
  /**
   * Chỉ giữ nhân vật có trong cast, đồng thời chuẩn hoá blocking (ai ở đâu, làm gì)
   * và đồng bộ lại `characters`/`speaker` theo blocking. Frame không còn nhân vật
   * hợp lệ nào sẽ giữ tên gốc để người dùng thấy mà sửa, trừ khi cast đã có.
   */
  function restrictTimeline(timeline: Timeline, cast: CastMember[]): Timeline {
    if (!cast.length) {
      return {
        frames: timeline.frames.map((frame) => {
          const { blocking, characters, speaker } = normalizeBlocking(frame, [])
          return { ...frame, blocking, characters, speaker }
        }),
      }
    }
    return normalizeTimelineBlocking(timeline, cast)
  }

  /** Sinh ảnh cho phiên bằng model ảnh đã chọn; trả về tác vụ để giao diện theo dõi. */
  function enqueueArtifactImage(options: {
    userId: string
    session: Parameters<typeof sessionPublic>[0]
    prompt: string
    characterId?: string | null
    /** Kích thước ảnh; mặc định là khổ sheet nhân vật. */
    size?: string
    /** Ảnh nguồn (chân dung nhân vật) để giữ nhận diện; tối đa theo cấu hình. */
    sourceUploadIds?: string[]
  }) {
    const { userId, session } = options
    if (session.project_id) ownedProject(db, userId, session.project_id)
    if (!session.image_model_id) {
      throw badRequest('Chưa chọn model ảnh cho phiên này. Hãy chọn ở bước cấu hình model.')
    }
    requireModelOfKind(userId, session.image_model_id, 'image')

    const outcome = enqueueGeneration({
      db,
      env,
      worker,
      userId,
      request: {
        data: {
          modelId: session.image_model_id,
          prompt: options.prompt.slice(0, 8000),
          params: { size: options.size ?? CHARACTER_SHEET_SIZE },
          ...(options.characterId ? { characterId: options.characterId } : {}),
          ...(options.sourceUploadIds?.length
            ? { sourceUploadIds: options.sourceUploadIds }
            : {}),
          idempotencyKey: `plan-image-${randomUUID()}`,
        },
        scene: null,
      },
    })
    return outcome.generation
  }

  function currentScript(session: Parameters<typeof sessionPublic>[0]): ScriptDraft | null {
    return parseScript(session.script_json)
  }

  function currentCast(session: Parameters<typeof sessionPublic>[0]): CastMember[] {
    return parseCast(session.cast_json)
  }

  function currentTimeline(session: Parameters<typeof sessionPublic>[0]): Timeline | null {
    const timeline = parseTimeline(session.timeline_json)
    if (!timeline) return null
    // Chuẩn hoá tại chỗ đọc để frame cũ (chưa có blocking) vẫn có dữ liệu người/hành động.
    return normalizeTimelineBlocking(timeline, currentCast(session))
  }

  /** Ảnh nền: cập nhật đúng frame trong timeline đã lưu. */
  function updateFrame(
    session: Parameters<typeof sessionPublic>[0],
    frameId: string,
    patch: (frame: TimelineFrame) => TimelineFrame,
  ): Timeline {
    const timeline = currentTimeline(session)
    if (!timeline) throw badRequest('Timeline chưa có frame nào. Hãy lên timeline trước.')
    if (!timeline.frames.some((frame) => frame.id === frameId)) {
      throw notFound('Không tìm thấy frame trong timeline')
    }
    return { frames: timeline.frames.map((frame) => (frame.id === frameId ? patch(frame) : frame)) }
  }

  /** Ảnh chân dung: cập nhật đúng ý tưởng nhân vật đã lưu. */
  function updateCastMember(
    session: Parameters<typeof sessionPublic>[0],
    castId: string,
    patch: (member: CastMember) => CastMember,
  ): CastMember[] {
    const cast = currentCast(session)
    if (!cast.some((member) => member.id === castId)) {
      throw notFound('Không tìm thấy nhân vật trong phiên')
    }
    return cast.map((member) => (member.id === castId ? patch(member) : member))
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
    const data = createSchema.safeParse(req.body)
    if (!data.success) throw validationError(data.error)

    if (data.data.kind === 'copilot') {
      if (!data.data.projectId) throw badRequest('Phiên trong dự án cần có projectId')
      ownedProject(db, user.id, data.data.projectId, true)
    } else if (data.data.projectId) {
      throw badRequest('Phiên lập kế hoạch không gắn dự án có sẵn')
    }

    if (data.data.chatModelId) ownedLlmModel(db, user.id, data.data.chatModelId)

    const id = randomUUID()
    const now = Date.now()
    db.prepare(
      `INSERT INTO plan_sessions
         (id, user_id, kind, chat_model_id, project_id, title, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      user.id,
      data.data.kind,
      data.data.chatModelId ?? null,
      data.data.projectId ?? null,
      data.data.title ?? '',
      data.data.chatModelId ? 'scripting' : 'setup',
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
    const data = patchSchema.safeParse(req.body)
    if (!data.success) throw badRequest('Dữ liệu không hợp lệ')
    if (data.data.chatModelId) ownedLlmModel(db, user.id, data.data.chatModelId)
    if (data.data.title === undefined && data.data.chatModelId === undefined) {
      throw badRequest('Không có thay đổi nào để lưu')
    }

    const updated = updateSessionFields(db, session.id, {
      ...(data.data.title !== undefined ? { title: data.data.title } : {}),
      ...(data.data.chatModelId !== undefined ? { chatModelId: data.data.chatModelId } : {}),
    })
    res.json({ session: sessionPublic(updated, messageCount(db, session.id)) })
  })

  /** Bước 0: chọn model chat / ảnh / video trước khi vào giao diện chính. */
  router.patch('/:id/setup', (req, res) => {
    const user = requireUser(req)
    const session = ownedSession(db, user.id, req.params.id)
    const data = setupSchema.safeParse(req.body)
    if (!data.success) throw badRequest('Dữ liệu không hợp lệ')

    if (data.data.chatModelId) ownedLlmModel(db, user.id, data.data.chatModelId)
    if (data.data.imageModelId) requireModelOfKind(user.id, data.data.imageModelId, 'image')
    if (data.data.videoModelId) requireModelOfKind(user.id, data.data.videoModelId, 'video')

    const updated = updateSessionFields(db, session.id, {
      ...(data.data.chatModelId !== undefined ? { chatModelId: data.data.chatModelId } : {}),
      ...(data.data.imageModelId !== undefined ? { imageModelId: data.data.imageModelId } : {}),
      ...(data.data.videoModelId !== undefined ? { videoModelId: data.data.videoModelId } : {}),
    })

    // Chưa có model chat thì chưa dùng được tab nào.
    if (!updated.chat_model_id && updated.status === 'scripting') {
      setStatus(db, session.id, 'setup')
    } else if (updated.chat_model_id && updated.status === 'setup') {
      setStatus(db, session.id, 'scripting')
    }

    res.json({ session: sessionPublic(ownedSession(db, user.id, session.id), messageCount(db, session.id)) })
  })

  router.delete('/:id', (req, res) => {
    const user = requireUser(req)
    const session = ownedSession(db, user.id, req.params.id)
    db.prepare('DELETE FROM plan_sessions WHERE id = ? AND user_id = ?').run(session.id, user.id)
    res.status(204).end()
  })

  /**
   * Chat trong một tab. AI vừa trả lời vừa trả về artifact đã cập nhật của tab đó,
   * nên "nhắn AI sửa" và "sửa tay" cùng ghi vào một chỗ.
   */
  router.post('/:id/messages', async (req, res) => {
    const user = requireUser(req)
    const session = ownedSession(db, user.id, req.params.id)
    checkChatLimit(user.id)
    const data = messageSchema.safeParse(req.body)
    if (!data.success) throw validationError(data.error)

    appendMessage(db, session.id, 'user', data.data.content)
    updateSessionFields(db, session.id, {})

    const history = historyFor(db, session.id)
    const first = await runArtifact({
      userId: user.id,
      session,
      target: data.data.target,
      history,
    })

    let reply = first.reply
    let ran: ArtifactTarget | null = null

    // Chạy tối đa MỘT bước phụ mỗi tin nhắn, và chỉ khi artifact thượng nguồn đã có.
    // Bước này tính thêm một lượt vào giới hạn tần suất vì tốn thêm một lần gọi model.
    if (first.ran && first.ran !== data.data.target) {
      const refreshed = ownedSession(db, user.id, session.id)
      const hasScript = Boolean(parseScript(refreshed.script_json) ?? legacyScript(refreshed))
      if (first.ran === 'script' || hasScript) {
        checkChatLimit(user.id)
        const second = await runArtifact({
          userId: user.id,
          session: refreshed,
          target: first.ran,
          history,
          instruction: buildArtifactRequest(first.ran),
        })
        ran = first.ran
        const label = ARTIFACT_LABELS[first.ran]
        reply = [reply, `Đã tự chạy bước: ${label}.`].filter(Boolean).join('\n\n')
      }
    }

    const assistant = appendMessage(db, session.id, 'assistant', reply)
    const updated = ownedSession(db, user.id, session.id)

    res.json({
      session: sessionPublic(updated, messageCount(db, session.id)),
      messages: listMessages(db, session.id).map(messagePublic),
      reply: messagePublic(assistant),
      ran,
    })
  })

  /** Viết (hoặc viết lại) kịch bản nháp từ hội thoại hiện có. */
  router.post('/:id/script', async (req, res) => {
    const user = requireUser(req)
    const session = ownedSession(db, user.id, req.params.id)
    checkChatLimit(user.id)

    const { session: updated } = await runArtifact({
      userId: user.id,
      session,
      target: 'script',
      history: historyFor(db, session.id),
      instruction: buildArtifactRequest('script'),
    })
    res.json({ session: updated })
  })

  /** Lưu kịch bản nháp do người dùng sửa tay. */
  router.put('/:id/script', (req, res) => {
    const user = requireUser(req)
    const session = ownedSession(db, user.id, req.params.id)
    const data = scriptSchema.safeParse(req.body)
    if (!data.success) throw validationError(data.error)

    const scenes: DraftScene[] = data.data.scenes.map((scene) => ({
      id: scene.id ?? newArtifactId(),
      title: scene.title,
      context: scene.context,
      action: scene.action,
      dialogue: scene.dialogue,
      speaker: scene.speaker,
      characters: scene.characters,
      durationSeconds: scene.durationSeconds,
      shotNotes: scene.shotNotes,
      locationId: scene.locationId ?? parseScript(session.script_json)?.scenes.find((item) => item.id === scene.id)?.locationId ?? null,
    }))
    const script: ScriptDraft = {
      text: data.data.text || scriptTextFromScenes(session.title, scenes),
      scenes,
    }

    const updated = setStatus(db, session.id, advanceStatus(session.status, 'script'), {
      scriptJson: JSON.stringify(script),
      clearProject: session.kind === 'planner',
      ...(session.title ? {} : { title: script.text.split('\n')[0]?.slice(0, 200) ?? '' }),
    })
    res.json({ session: sessionPublic(updated, messageCount(db, session.id)) })
  })

  /** AI đề xuất ý tưởng nhân vật từ kịch bản nháp. */
  router.post('/:id/cast', async (req, res) => {
    const user = requireUser(req)
    const session = ownedSession(db, user.id, req.params.id)
    checkChatLimit(user.id)

    const { session: updated } = await runArtifact({
      userId: user.id,
      session,
      target: 'cast',
      history: historyFor(db, session.id),
      instruction: buildArtifactRequest('cast'),
    })
    res.json({ session: updated })
  })

  /** Lưu ý tưởng nhân vật do người dùng sửa tay (kể cả nơi lưu từng nhân vật). */
  router.put('/:id/cast', (req, res) => {
    const user = requireUser(req)
    const session = ownedSession(db, user.id, req.params.id)
    const data = castSchema.safeParse(req.body)
    if (!data.success) throw validationError(data.error)

    const previous = currentCast(session)
    const byId = new Map(previous.map((member) => [member.id, member]))
    const cast: CastMember[] = data.data.cast.map((member) => ({
      id: member.id ?? newArtifactId(),
      name: member.name,
      appearance: member.appearance,
      role: member.role,
      voice: (member.voice ?? {}) as CastMember['voice'],
      reuseCharacterId: member.reuseCharacterId,
      storage: member.storage,
      portrait: byId.get(member.id ?? '')?.portrait ?? null,
    }))

    const updated = setStatus(db, session.id, advanceStatus(session.status, 'cast'), {
      castJson: JSON.stringify(cast),
    })
    res.json({ session: sessionPublic(updated, messageCount(db, session.id)) })
  })

  /** AI lên timeline từ kịch bản nháp + danh sách nhân vật. */
  router.post('/:id/timeline', async (req, res) => {
    const user = requireUser(req)
    const session = ownedSession(db, user.id, req.params.id)
    checkChatLimit(user.id)

    const { session: updated } = await runArtifact({
      userId: user.id,
      session,
      target: 'timeline',
      history: historyFor(db, session.id),
      instruction: buildArtifactRequest('timeline'),
    })
    res.json({ session: updated })
  })

  /** Lưu timeline do người dùng sửa tay từng ô. */
  router.put('/:id/timeline', (req, res) => {
    const user = requireUser(req)
    const session = ownedSession(db, user.id, req.params.id)
    const data = timelineSchema.safeParse(req.body)
    if (!data.success) throw validationError(data.error)

    const previous = currentTimeline(session)
    const byId = new Map((previous?.frames ?? []).map((frame) => [frame.id, frame]))
    const frames: TimelineFrame[] = data.data.frames.map((frame) => ({
      id: frame.id ?? newArtifactId(),
      title: frame.title,
      context: frame.context,
      action: frame.action,
      dialogue: frame.dialogue,
      speaker: frame.speaker,
      characters: frame.characters,
      durationSeconds: frame.durationSeconds,
      shotNotes: frame.shotNotes,
      locationId: frame.locationId === undefined ? byId.get(frame.id ?? '')?.locationId ?? null : frame.locationId,
      backgroundLocationRevision: byId.get(frame.id ?? '')?.backgroundLocationRevision ?? null,
      backgroundStale: byId.get(frame.id ?? '')?.backgroundStale ?? false,
      backgroundPrompt: frame.backgroundPrompt ?? frame.context,
      background:
        frame.backgroundUploadId === undefined
          ? byId.get(frame.id ?? '')?.background ?? null
          : frame.backgroundUploadId
            ? { uploadId: frame.backgroundUploadId }
            : null,
      blocking: [],
    }))

    // Blocking gửi lên có thể dùng `castId` (giao diện) hoặc tên (AI), nên đưa nguyên
    // vào rồi để bộ chuẩn hoá phân giải, bỏ nhân vật lạ và đồng bộ `characters`/`speaker`.
    const submitted = data.data.frames
    const normalizedFrames = restrictTimeline({ frames }, currentCast(session)).frames.map(
      (frame, index) => ({
        ...frame,
        blocking: normalizeBlocking(submitted[index] ?? frame, currentCast(session)).blocking,
      }),
    )

    const updated = setStatus(db, session.id, advanceStatus(session.status, 'timeline'), {
      timelineJson: JSON.stringify({ frames: normalizedFrames }),
      clearProject: session.kind === 'planner',
    })
    res.json({ session: sessionPublic(updated, messageCount(db, session.id)) })
  })

  // --- Ảnh chân dung nhân vật (theo yêu cầu từng nhân vật) ---

  router.post('/:id/cast/:castId/portrait', (req, res) => {
    const user = requireUser(req)
    const session = ownedSession(db, user.id, req.params.id)
    const member = currentCast(session).find((item) => item.id === req.params.castId)
    if (!member) throw notFound('Không tìm thấy nhân vật trong phiên')

    // Dùng chung prompt sheet (cận mặt + 4 góc nhìn) với trang Nhân vật.
    const generation = enqueueArtifactImage({
      userId: user.id,
      session,
      prompt: buildCharacterSheetPrompt({ name: member.name, appearance: member.appearance }),
      characterId: member.reuseCharacterId,
    })
    res.status(202).json({ generation })
  })

  router.post('/:id/cast/:castId/portrait/attach', (req, res) => {
    const user = requireUser(req)
    const session = ownedSession(db, user.id, req.params.id)
    const data = attachSchema.safeParse(req.body)
    if (!data.success) throw validationError(data.error)

    const uploadId = adoptImage({ db, env, mediaStore }, user.id, data.data.generationId, data.data.assetId)
    const cast = updateCastMember(session, req.params.castId, (member) => ({
      ...member,
      portrait: { uploadId },
    }))
    const updated = setStatus(db, session.id, session.status, { castJson: JSON.stringify(cast) })
    res.status(201).json({ session: sessionPublic(updated, messageCount(db, session.id)) })
  })

  router.post('/:id/cast/:castId/portrait/upload', rawImage, (req, res) => {
    const user = requireUser(req)
    const session = ownedSession(db, user.id, req.params.id)
    const body = req.body as Buffer | undefined
    if (!body || body.byteLength === 0) throw badRequest('Không nhận được nội dung ảnh')

    const uploadId = saveUpload({ db, env, mediaStore }, user.id, new Uint8Array(body))
    const cast = updateCastMember(session, req.params.castId, (member) => ({
      ...member,
      portrait: { uploadId },
    }))
    const updated = setStatus(db, session.id, session.status, { castJson: JSON.stringify(cast) })
    res.status(201).json({ session: sessionPublic(updated, messageCount(db, session.id)) })
  })

  router.delete('/:id/cast/:castId/portrait', (req, res) => {
    const user = requireUser(req)
    const session = ownedSession(db, user.id, req.params.id)
    const cast = updateCastMember(session, req.params.castId, (member) => ({
      ...member,
      portrait: null,
    }))
    const updated = setStatus(db, session.id, session.status, { castJson: JSON.stringify(cast) })
    res.json({ session: sessionPublic(updated, messageCount(db, session.id)) })
  })

  // --- Ảnh nền cho từng frame timeline ---

  router.post('/:id/timeline/:frameId/background', (req, res) => {
    const user = requireUser(req)
    const session = ownedSession(db, user.id, req.params.id)
    const frame = currentTimeline(session)?.frames.find((item) => item.id === req.params.frameId)
    if (!frame) throw notFound('Không tìm thấy frame trong timeline')

    const cast = currentCast(session)
    const inputs = storyboardInputs(frame, cast, parseLocations(session.locations_json), env.MAX_SOURCE_IMAGES)
    const generation = enqueueArtifactImage({
      userId: user.id,
      session,
      prompt: inputs.prompt,
      size: '1280x720',
      sourceUploadIds: inputs.sourceUploadIds,
    })
    const stored = db.prepare('SELECT prompt_snapshot_json FROM generations WHERE id = ?').get(generation.id) as { prompt_snapshot_json: string | null }
    const metadata = { ...JSON.parse(stored.prompt_snapshot_json ?? '{}'), locationId: inputs.locationId, locationRevision: inputs.locationRevision, sourceRoles: inputs.sourceRoles }
    db.prepare('UPDATE generations SET prompt_snapshot_json = ? WHERE id = ?').run(JSON.stringify(metadata), generation.id)
    res.status(202).json({ generation })
  })

  /**
   * AI sắp xếp lại MỘT frame: xác định lại ai có mặt, hành động riêng và vị trí.
   * Frame khác, ảnh đã gắn và phần người dùng gõ tay đều giữ nguyên.
   */
  router.post('/:id/timeline/:frameId/arrange', async (req, res) => {
    const user = requireUser(req)
    const session = ownedSession(db, user.id, req.params.id)
    const timeline = currentTimeline(session)
    const frame = timeline?.frames.find((item) => item.id === req.params.frameId)
    if (!frame) throw notFound('Không tìm thấy frame trong timeline')
    checkChatLimit(user.id)

    const cast = currentCast(session)
    const targetModel = resolveLlmTarget(db, env, user.id, session.chat_model_id ?? undefined)
    const raw = await chatText(env, targetModel, [
      { role: 'system', content: buildArrangeSystem(cast) },
      buildArrangeRequest(frame),
    ])
    const parsed = parseJsonLoose(raw)
    const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    if (!record) {
      throw badRequest('AI không trả về dữ liệu dàn dựng hợp lệ. Hãy thử lại.')
    }

    const { blocking } = normalizeBlocking(
      { blocking: record.blocking, characters: frame.characters, speaker: frame.speaker },
      cast,
    )
    if (!blocking.length) {
      throw badRequest('AI không xác định được nhân vật cho frame này. Hãy thử lại.')
    }

    const updatedTimeline = updateFrame(session, frame.id, (current) => {
      const aligned = normalizeBlocking({ blocking, characters: frame.characters, speaker: current.speaker }, cast)
      return { ...current, blocking: aligned.blocking, characters: aligned.characters, speaker: aligned.speaker }
    })
    const updated = setStatus(db, session.id, advanceStatus(session.status, 'timeline'), {
      timelineJson: JSON.stringify(updatedTimeline),
      clearProject: session.kind === 'planner',
    })

    res.json({
      session: sessionPublic(updated, messageCount(db, session.id)),
      reply: typeof record.reply === 'string' ? record.reply.trim() : '',
    })
  })

  // --- Batch sinh ảnh storyboard cho cả timeline ---

  /** Tạo batch: mặc định chỉ frame chưa có ảnh, tuỳ chọn làm mới tất cả. */
  router.post('/:id/image-batch', (req, res) => {
    const user = requireUser(req)
    const session = ownedSession(db, user.id, req.params.id)
    const parsed = imageBatchSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw validationError(parsed.error)

    const timeline = currentTimeline(session)
    if (!timeline?.frames.length) {
      throw badRequest('Timeline chưa có frame nào. Hãy lên timeline trước.')
    }

    const batch = createImageBatch(
      { db, env, mediaStore, worker },
      {
        userId: user.id,
        sessionId: session.id,
        imageModelId: session.image_model_id,
        frames: timeline.frames,
        cast: currentCast(session),
        regenerateAll: parsed.data.regenerateAll,
      },
    )
    res.status(202).json({ batch })
  })

  /** Theo dõi batch gần nhất của phiên; có batch đang chạy thì tiến thêm một nhịp. */
  router.get('/:id/image-batch', (req, res) => {
    const user = requireUser(req)
    const session = ownedSession(db, user.id, req.params.id)
    const latest = latestImageBatch(db, user.id, session.id)
    if (!latest) {
      res.json({ batch: null })
      return
    }
    res.json({
      batch:
        latest.status === 'running'
          ? advanceImageBatch({ db, env, mediaStore, worker }, user.id, session.id, latest.id)
          : latest,
    })
  })

  /** Đọc tiến trình một batch; mỗi lần gọi tiến thêm một nhịp. */
  router.get('/:id/image-batch/:batchId', (req, res) => {
    const user = requireUser(req)
    const session = ownedSession(db, user.id, req.params.id)
    res.json({
      batch: advanceImageBatch({ db, env, mediaStore, worker }, user.id, session.id, req.params.batchId),
    })
  })

  /** Dừng batch: không xếp thêm tác vụ mới. */
  router.post('/:id/image-batch/:batchId/stop', (req, res) => {
    const user = requireUser(req)
    const session = ownedSession(db, user.id, req.params.id)
    res.json({
      batch: stopImageBatch({ db, env, mediaStore, worker }, user.id, session.id, req.params.batchId),
    })
  })

  /** Thử lại các frame lỗi hoặc bị dừng. */
  router.post('/:id/image-batch/:batchId/retry', (req, res) => {
    const user = requireUser(req)
    const session = ownedSession(db, user.id, req.params.id)
    res.json({
      batch: retryImageBatch({ db, env, mediaStore, worker }, user.id, session.id, req.params.batchId),
    })
  })

  router.post('/:id/timeline/:frameId/background/attach', (req, res) => {
    const user = requireUser(req)
    const session = ownedSession(db, user.id, req.params.id)
    const data = attachSchema.safeParse(req.body)
    if (!data.success) throw validationError(data.error)

    const uploadId = adoptImage({ db, env, mediaStore }, user.id, data.data.generationId, data.data.assetId)
    const generated = db.prepare('SELECT prompt_snapshot_json FROM generations WHERE id = ? AND user_id = ?').get(data.data.generationId, user.id) as { prompt_snapshot_json: string | null } | undefined
    const snapshot = JSON.parse(generated?.prompt_snapshot_json ?? '{}') as { locationId?: string | null; locationRevision?: number | null }
    const timeline = updateFrame(session, req.params.frameId, (frame) => {
      const location = parseLocations(session.locations_json).find(item => item.id === frame.locationId)
      return {
        ...frame,
        background: { uploadId },
        backgroundLocationRevision: snapshot.locationRevision ?? null,
        backgroundStale: Boolean(frame.locationId && (snapshot.locationId !== frame.locationId || snapshot.locationRevision !== location?.revision)),
      }
    })
    const updated = setStatus(db, session.id, session.status, {
      timelineJson: JSON.stringify(timeline),
    })
    res.status(201).json({ session: sessionPublic(updated, messageCount(db, session.id)) })
  })

  router.post('/:id/timeline/:frameId/background/upload', rawImage, (req, res) => {
    const user = requireUser(req)
    const session = ownedSession(db, user.id, req.params.id)
    const body = req.body as Buffer | undefined
    if (!body || body.byteLength === 0) throw badRequest('Không nhận được nội dung ảnh')

    const uploadId = saveUpload({ db, env, mediaStore }, user.id, new Uint8Array(body))
    const timeline = updateFrame(session, req.params.frameId, (frame) => ({
      ...frame,
      background: { uploadId },
      backgroundLocationRevision: parseLocations(session.locations_json).find(item => item.id === frame.locationId)?.revision ?? null,
      backgroundStale: false,
    }))
    const updated = setStatus(db, session.id, session.status, {
      timelineJson: JSON.stringify(timeline),
    })
    res.status(201).json({ session: sessionPublic(updated, messageCount(db, session.id)) })
  })

  router.delete('/:id/timeline/:frameId/background', (req, res) => {
    const user = requireUser(req)
    const session = ownedSession(db, user.id, req.params.id)
    const timeline = updateFrame(session, req.params.frameId, (frame) => ({
      ...frame,
      background: null,
      backgroundLocationRevision: null,
      backgroundStale: false,
    }))
    const updated = setStatus(db, session.id, session.status, {
      timelineJson: JSON.stringify(timeline),
    })
    res.json({ session: sessionPublic(updated, messageCount(db, session.id)) })
  })

  /**
   * Chốt timeline thành dự án Studio.
   *
   * Cảnh mới luôn ở trạng thái CHƯA duyệt nên chưa tốn tiền; người dùng xem lại
   * cảnh và nhân vật tham chiếu trong Studio rồi mới duyệt để xếp hàng tạo.
   */
  router.post('/:id/apply', (req, res) => {
    const user = requireUser(req)
    const session = ownedSession(db, user.id, req.params.id)
    const data = applySchema.safeParse(req.body ?? {})
    if (!data.success) throw validationError(data.error)

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

    const timeline = currentTimeline(session)
    if (!timeline?.frames.length) {
      throw badRequest('Timeline chưa có frame nào. Hãy lên timeline trước khi chốt.')
    }

    const cast = currentCast(session)
    const result = applyPlan({
      db,
      env,
      userId: user.id,
      session,
      timeline,
      cast,
      apply: data.data,
      mediaStore,
    })

    res.status(201).json(result)
  })

  return router
}
