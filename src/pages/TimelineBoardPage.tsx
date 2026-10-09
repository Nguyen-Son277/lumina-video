import { LocationReferences } from '../components/LocationReferences'
import { locationPanelApi, planLocationsApi, locationReferenceUrl, type LocationReference } from '../api/locations'
import { locationsCatalog } from '../i18n/catalogs/locations'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  GalleryHorizontalEnd,
  ImagePlus,
  Images,
  LoaderCircle,
  Plus,
  Save,
  Send,
  Square,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from 'lucide-react'
import { ApiError, storedErrorMessage } from '../api/client'
import { generationApi } from '../api/endpoints'
import {
  plannerApi,
  uploadUrl,
  type CastMember,
  type FrameBlocking,
  type FramePosition,
  type ImageBatch,
  type PlanMessage,
  type PlanSession,
  type TimelineFrame,
} from '../api/planner'
import type { ModelInfo } from '../api/types'
import { ImageLightbox } from '../components/Lightbox'
import { TimelineOverlay } from '../components/planner/TimelineOverlay'
import { ActionLabel, AsyncOverlay } from '../components/planner/PlannerLoading'
import { localizedPlannerError, plannerErrorText } from '../components/planner/ArtifactPanels'
import { plannerCatalog } from '../i18n/catalogs/planner'
import { notification, type Notification } from '../i18n/messages'
import { formatDate } from '../i18n/translate'
import { useTranslation } from '../i18n/useTranslation'

const POSITIONS: Array<{
  value: FramePosition
  labelKey: 'positionLeft' | 'positionCenter' | 'positionRight' | 'positionBackground'
}> = [
  { value: 'left', labelKey: 'positionLeft' },
  { value: 'center', labelKey: 'positionCenter' },
  { value: 'right', labelKey: 'positionRight' },
  { value: 'background', labelKey: 'positionBackground' },
]

const POSITION_LABEL = new Map(POSITIONS.map((item) => [item.value, item.labelKey]))

/** Khoá dịch cho từng trạng thái phiên; dịch tại chỗ render để đổi ngôn ngữ là đổi ngay. */
const STATUS_KEYS = {
  setup: 'statusSetup',
  scripting: 'statusScripting',
  script_ready: 'statusScriptReady',
  cast_ready: 'statusCastReady',
  timeline_ready: 'statusTimelineReady',
  applied: 'statusApplied',
} as const satisfies Record<PlanSession['status'], string>

/** Ảnh bìa của một phiên: frame đầu tiên đã có ảnh storyboard. */
function sessionCover(session: PlanSession): string | null {
  const frame = (session.timeline?.frames ?? []).find((item) => item.background)
  return frame?.background?.uploadId ?? null
}

/** Tổng thời lượng phiên, cùng quy tắc cộng dồn với dải storyboard. */
function sessionSeconds(session: PlanSession): number {
  return (session.timeline?.frames ?? []).reduce(
    (total, frame) => total + Math.max(1, frame.durationSeconds),
    0,
  )
}

const POLL_MS = 1500
const MAX_WAIT_MS = 4 * 60 * 1000

/**
 * Tiêu đề lỗi đã dịch của một item batch; chi tiết thô của provider nằm ở tooltip.
 *
 * Server (`ImageBatchItemPublic`) trả `error` (câu thô) kèm `errorMessageKey` và
 * `errorMessageParams` — hiện chưa trả `errorCode`. `ImageBatch` trong
 * `src/api/planner.ts` chưa khai báo các trường này nên đọc qua kiểu hẹp tại đây
 * (đọc `errorCode` dự phòng để tự dùng khi backend bổ sung).
 */
function batchItemErrorHeading(item: ImageBatch['items'][number]): string {
  const { errorCode, errorMessageKey, errorMessageParams } = item as {
    errorCode?: string | null
    errorMessageKey?: string | null
    errorMessageParams?: Record<string, string | number> | null
  }
  return storedErrorMessage({
    errorMessage: item.error,
    errorCode,
    errorMessageKey,
    errorMessageParams,
  })
}

const formatClock = (seconds: number): string => {
  const total = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

/**
 * Giữ `characters` và `speaker` khớp với blocking ngay trên giao diện.
 *
 * Server chuẩn hoá lại lần nữa khi lưu, nhưng đồng bộ tại chỗ giúp thẻ frame và số
 * người đổi ngay khi người dùng thêm/xoá/đổi nhân vật.
 */
function syncFrame(frame: TimelineFrame, cast: CastMember[]): TimelineFrame {
  const blocking = frame.blocking.filter((entry) => entry.castId)
  const characters = blocking.map(
    (entry) => cast.find((member) => member.id === entry.castId)?.name ?? entry.castId,
  )
  const speaker = characters.find((name) => name === frame.speaker) ?? characters[0] ?? ''
  return { ...frame, blocking, characters, speaker }
}

/**
 * Trang Timeline: storyboard nằm ngang như video brief.
 *
 * Mỗi thẻ là một frame: khoảng thời gian, ảnh storyboard (có nhân vật), số người
 * và từng người làm gì ở đâu. Chọn một thẻ để sửa chi tiết bên dưới. Đây là trang
 * riêng thay cho drawer dọc trước đây nên xem được nhiều frame cùng lúc.
 */
export function TimelineBoardPage({
  sessionId,
  llmModels,
  models,
  onNotify,
  onSelectSession,
  onBackToChat,
  onOpenSettings,
  onOpenProject,
  onProjectsChanged,
}: {
  sessionId: string
  llmModels: ModelInfo[]
  models: ModelInfo[]
  onNotify: (message: Notification) => void
  onSelectSession: (sessionId: string) => void
  onBackToChat: (sessionId: string) => void
  onOpenSettings: () => void
  onOpenProject: () => void
  onProjectsChanged: () => void | Promise<void>
}) {
  const [session, setSession] = useState<PlanSession | null>(null)
  const [messages, setMessages] = useState<PlanMessage[]>([])
  const [sessions, setSessions] = useState<PlanSession[]>([])
  /** Danh sách phiên đang tải: tránh hiện "chưa có timeline nào" khi còn chờ API. */
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [frames, setFrames] = useState<TimelineFrame[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [busyFrameId, setBusyFrameId] = useState('')
  /**
   * Lỗi đang giữ ở dạng thô (Error/ApiError của API, descriptor khoá dịch, hoặc
   * đối tượng lỗi đã lưu trên server) — không phải câu đã dịch.
   */
  const [error, setError] = useState<unknown>(null)
  const [dirty, setDirty] = useState(false)
  /** Ảnh đang xem lớn: giữ url + chỉ số frame thô, dịch alt khi render. */
  const [zoom, setZoom] = useState<{ url: string; index: number } | null>(null)
  const [chatDraft, setChatDraft] = useState('')
  const [chatOpen, setChatOpen] = useState(false)
  const [projectOpen, setProjectOpen] = useState(false)
  const chatInputRef = useRef<HTMLTextAreaElement>(null)
  const chatLogRef = useRef<HTMLDivElement>(null)
  const [projectName, setProjectName] = useState('')
  const [videoModelId, setVideoModelId] = useState('')
  const [autoGenerate, setAutoGenerate] = useState(false)
  const [batch, setBatch] = useState<ImageBatch | null>(null)
  const [batchPanelOpen, setBatchPanelOpen] = useState(false)
  const [regenerateAll, setRegenerateAll] = useState(false)
  const [locationsOpen, setLocationsOpen] = useState(false)
  const [assignmentIds, setAssignmentIds] = useState<string[]>([])
  const [assignmentLocationId, setAssignmentLocationId] = useState('')
  const { t: tLocations } = useTranslation(locationsCatalog)
  const batchNotified = useRef('')
  const cancelled = useRef(false)
  const { t, locale } = useTranslation(plannerCatalog)
  /** Câu lỗi hiển thị theo ngôn ngữ hiện tại; nội dung thô từ API/provider giữ nguyên. */
  const errorText = plannerErrorText(error, t)
  // Giữ `t` mới nhất qua ref để đổi ngôn ngữ không đổi identity của `applyBatch`
  // (nếu không, effect poll batch bị tháo/lắp lại mỗi lần đổi ngôn ngữ).
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])

  const videoModels = models.filter((model) => model.kind === 'video' && model.enabled)
  const imageModelId = session?.imageModelId ?? ''
  const cast = useMemo(() => session?.cast ?? [], [session])
  const selected = frames.find((frame) => frame.id === selectedId) ?? frames[0] ?? null

  useEffect(() => {
    const el = chatInputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`
  }, [chatDraft, chatOpen])

  useEffect(() => {
    const el = chatLogRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, busy, chatOpen])

  /** Thời điểm bắt đầu/kết thúc của mỗi frame, tính cộng dồn từ thời lượng. */
  const spans = useMemo(() => {
    let cursor = 0
    return frames.map((frame) => {
      const start = cursor
      cursor += Math.max(1, frame.durationSeconds)
      return { start, end: cursor }
    })
  }, [frames])
  const totalSeconds = spans.length ? spans[spans.length - 1]!.end : 0

  useEffect(() => {
    cancelled.current = false
    return () => {
      cancelled.current = true
    }
  }, [])

  const loadSession = useCallback(
    async (id: string) => {
      if (!id) {
        setSession(null)
        setFrames([])
        return
      }
      setLoading(true)
      setError(null)
      try {
        const result = await plannerApi.get(id)
        setSession(result.session)
        setMessages(result.messages)
        setFrames(result.session.timeline?.frames ?? [])
        setSelectedId((current) =>
          result.session.timeline?.frames.some((frame) => frame.id === current)
            ? current
            : result.session.timeline?.frames[0]?.id ?? '',
        )
        setProjectName(result.session.title || '')
        setVideoModelId(result.session.videoModelId ?? '')
        setDirty(false)
      } catch (cause) {
        setError(cause)
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    void loadSession(sessionId)
  }, [sessionId, loadSession])

  useEffect(() => {
    plannerApi
      .list({ kind: 'planner' })
      .then((result) => setSessions(result.sessions))
      .catch(() => setSessions([]))
      .finally(() => setSessionsLoading(false))
  }, [])

  // Batch gần nhất của phiên: tải lại trang vẫn thấy đúng tiến trình đang chạy.
  useEffect(() => {
    if (!sessionId) {
      setBatch(null)
      return
    }
    let alive = true
    plannerApi.imageBatch
      .latest(sessionId)
      .then((result) => {
        if (alive) setBatch(result.batch)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [sessionId])

  /** Cập nhật tiến trình; ảnh xong thì nạp lại timeline nếu người dùng không sửa tay. */
  const applyBatch = useCallback(
    (next: ImageBatch) => {
      setBatch(next)
      if (!dirty && next.done > 0) void loadSession(next.sessionId)
      const key = `${next.status}:${next.done}:${next.failed}`
      if (batchNotified.current !== key) {
        batchNotified.current = key
        if (next.status !== 'running') {
          onNotify(
            notification('planner', 'batchFinishedNotice', {
              done: next.done,
              total: next.total,
              failed: next.failed
                ? next.failed === 1
                  ? tRef.current('batchFinishedFailedOne', { count: next.failed })
                  : tRef.current('batchFinishedFailedOther', { count: next.failed })
                : '',
            }),
          )
        }
      }
    },
    [dirty, loadSession, onNotify],
  )

  // Tiến batch bằng cách hỏi server theo nhịp; server đối soát và xếp hàng item kế tiếp.
  useEffect(() => {
    if (!batch || batch.status !== 'running' || !sessionId) return
    const batchId = batch.id
    let alive = true
    const timer = window.setInterval(() => {
      plannerApi.imageBatch
        .get(sessionId, batchId)
        .then((result) => {
          if (alive) applyBatch(result.batch)
        })
        .catch(() => undefined)
    }, POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [batch?.id, batch?.status, sessionId, applyBatch])

  function applySession(next: PlanSession): void {
    setSession(next)
    setFrames(next.timeline?.frames ?? [])
    setDirty(false)
  }

  async function run(tag: string, action: () => Promise<void>): Promise<void> {
    setBusy(tag)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy('')
    }
  }

  function patchFrame(frameId: string, patch: Partial<TimelineFrame>): void {
    setFrames((current) =>
      current.map((frame) => (frame.id === frameId ? syncFrame({ ...frame, ...patch }, cast) : frame)),
    )
    setDirty(true)
  }

  function updateBlocking(frameId: string, index: number, patch: Partial<FrameBlocking>): void {
    setFrames((current) =>
      current.map((frame) =>
        frame.id === frameId
          ? syncFrame(
              {
                ...frame,
                blocking: frame.blocking.map((entry, i) =>
                  i === index ? { ...entry, ...patch } : entry,
                ),
              },
              cast,
            )
          : frame,
      ),
    )
    setDirty(true)
  }

  function addBlocking(frameId: string): void {
    const frame = frames.find((item) => item.id === frameId)
    if (!frame) return
    const used = new Set(frame.blocking.map((entry) => entry.castId))
    const next = cast.find((member) => !used.has(member.id))
    if (!next) {
      onNotify(notification('planner', 'allCastInFrame'))
      return
    }
    patchFrame(frameId, { blocking: [...frame.blocking, { castId: next.id, action: '', position: 'center' }] })
  }

  function removeBlocking(frameId: string, index: number): void {
    const frame = frames.find((item) => item.id === frameId)
    if (!frame) return
    patchFrame(frameId, { blocking: frame.blocking.filter((_, i) => i !== index) })
  }

  function moveFrame(frameId: string, direction: -1 | 1): void {
    setFrames((current) => {
      const index = current.findIndex((frame) => frame.id === frameId)
      const target = index + direction
      if (index < 0 || target < 0 || target >= current.length) return current
      const next = [...current]
      const [moved] = next.splice(index, 1)
      next.splice(target, 0, moved!)
      return next
    })
    setDirty(true)
  }

  function duplicateFrame(frameId: string): void {
    setFrames((current) => {
      const index = current.findIndex((frame) => frame.id === frameId)
      if (index < 0) return current
      const source = current[index]!
      const copy: TimelineFrame = {
        ...source,
        id: `draft-${crypto.randomUUID()}`,
        title: `${source.title}${t('frameCopySuffix')}`,
        background: null,
        backgroundPrompt: source.backgroundPrompt,
        blocking: source.blocking.map((entry) => ({ ...entry })),
      }
      const next = [...current]
      next.splice(index + 1, 0, copy)
      return next
    })
    setDirty(true)
  }

  function removeFrame(frameId: string): void {
    setFrames((current) => current.filter((frame) => frame.id !== frameId))
    setDirty(true)
  }

  function addFrame(): void {
    const last = frames[frames.length - 1]
    const frame: TimelineFrame = {
      id: `draft-${crypto.randomUUID()}`,
      title: t('frameIndex', { index: frames.length + 1 }),
      context: last?.context ?? '',
      action: '',
      dialogue: '',
      speaker: '',
      characters: [],
      durationSeconds: last?.durationSeconds ?? 8,
      shotNotes: '',
      backgroundPrompt: '',
      background: null,
      blocking: [],
    }
    setFrames((current) => [...current, frame])
    setSelectedId(frame.id)
    setDirty(true)
  }

  function locationsChanged(locations: LocationReference[]): void {
    setSession((current) => current ? { ...current, locations } : current)
    setFrames((current) => current.map((frame) => {
      const location = locations.find((item) => item.id === frame.locationId)
      return { ...frame, backgroundStale: Boolean(frame.background && frame.locationId && (!location || frame.backgroundLocationRevision !== location.revision)) }
    }))
  }

  async function saveFrames(next = frames): Promise<PlanSession | null> {
    if (!session) return null
    const result = await plannerApi.saveTimeline(session.id, next)
    applySession(result.session)
    onProjectsChanged()
    return result.session
  }

  /** Sinh ảnh storyboard cho một frame rồi gắn vào frame đó. */
  async function generateImage(frame: TimelineFrame): Promise<void> {
    if (!session || !imageModelId) return
    setBusyFrameId(frame.id)
    setError(null)
    try {
      // Lưu trước để ảnh dùng đúng nhân vật/hành động người dùng vừa sửa.
      if (dirty) await saveFrames()
      const created = await plannerApi.generateBackground(session.id, frame.id)
      const generationId = created.generation.id
      const deadline = Date.now() + MAX_WAIT_MS
      while (!cancelled.current && Date.now() < deadline) {
        const current = (await generationApi.get(generationId)).generation
        if (current.status === 'succeeded') {
          const result = await plannerApi.attachBackground(session.id, frame.id, generationId)
          applySession(result.session)
          onNotify(notification('planner', 'backgroundAttached'))
          return
        }
        if (current.status === 'failed' || current.status === 'unknown') {
          // Lỗi đã lưu kèm khoá ngữ nghĩa thì giữ nguyên đối tượng để dịch khi render;
          // provider không trả nội dung nào thì dùng khoá dịch dự phòng.
          setError(
            current.errorMessage || current.errorMessageKey || current.errorCode
              ? current
              : localizedPlannerError('backgroundFailed'),
          )
          return
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      }
      setError(localizedPlannerError('imageTooLongRetry'))
    } catch (cause) {
      setError(cause)
    } finally {
      setBusyFrameId('')
    }
  }

  async function uploadImage(frame: TimelineFrame, file: File): Promise<void> {
    if (!session) return
    setBusyFrameId(frame.id)
    setError(null)
    try {
      if (dirty) await saveFrames()
      const result = await plannerApi.uploadBackground(session.id, frame.id, file)
      applySession(result.session)
    } catch (cause) {
      setError(cause)
    } finally {
      setBusyFrameId('')
    }
  }

  async function removeImage(frame: TimelineFrame): Promise<void> {
    if (!session) return
    await run('remove-image', async () => {
      const result = await plannerApi.removeBackground(session.id, frame.id)
      applySession(result.session)
    })
  }

  /** Chat trong trang Timeline: AI sửa timeline rồi trả về bản mới. */
  async function sendChat(): Promise<void> {
    const content = chatDraft.trim()
    if (!session || !content || busy) return
    const targetId = session.id
    setBusy('chat')
    setError(null)
    try {
      if (dirty) await saveFrames()
      const result = await plannerApi.sendMessage(targetId, content, 'timeline')
      if (sessionId !== targetId) return
      applySession(result.session)
      setMessages(result.messages)
      setChatDraft('')
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy('')
    }
  }

  async function arrangeFrame(frame: TimelineFrame): Promise<void> {
    if (!session) return
    await run('arrange', async () => {
      if (dirty) await saveFrames()
      const result = await plannerApi.arrangeFrame(session.id, frame.id)
      applySession(result.session)
      // `reply` là nội dung AI sinh: giữ nguyên văn, chỉ dùng descriptor khi rỗng.
      onNotify(result.reply ? result.reply : notification('planner', 'arrangeFallback'))
    })
  }

  const batchTargets = regenerateAll
    ? frames.length
    : frames.filter((frame) => !frame.background).length
  const imageModel = models.find((model) => model.id === imageModelId)
  // Nhân vật có mặt trong timeline nhưng chưa có ảnh chân dung: ảnh storyboard vẫn
  // tạo được theo mô tả, nhưng khuôn mặt sẽ kém nhất quán hơn.
  const missingPortraits = cast.filter(
    (member) =>
      !member.portrait &&
      frames.some((frame) => frame.blocking.some((entry) => entry.castId === member.id)),
  )

  async function startBatch(): Promise<void> {
    if (!session) return
    if (batch?.status === 'running') {
      setBatchPanelOpen(false)
      onNotify(notification('planner', 'batchAlreadyRunningNotice'))
      return
    }
    await run('batch', async () => {
      if (dirty) await saveFrames()
      try {
        const result = await plannerApi.imageBatch.create(session.id, { regenerateAll })
        batchNotified.current = ''
        applyBatch(result.batch)
        setBatchPanelOpen(false)
        setRegenerateAll(false)
        onNotify(notification('planner', 'batchQueued', { count: result.batch.total }))
      } catch (cause) {
        // Tab khác vừa tạo batch: nạp lại batch đang chạy để người dùng theo dõi/dừng
        // thay vì hiển thị lỗi cụt.
        const conflict = cause instanceof ApiError && cause.messageKey === 'planner.image_batch_running'
        if (!conflict) throw cause
        const latest = await plannerApi.imageBatch.latest(session.id)
        if (latest.batch) applyBatch(latest.batch)
        setBatchPanelOpen(false)
        onNotify(notification('planner', 'batchAlreadyRunningNotice'))
      }
    })
  }

  async function stopBatch(): Promise<void> {
    if (!session || !batch) return
    await run('batch-stop', async () => {
      const result = await plannerApi.imageBatch.stop(session.id, batch.id)
      applyBatch(result.batch)
      onNotify(notification('planner', 'batchStoppedNotice'))
    })
  }

  async function retryBatch(): Promise<void> {
    if (!session || !batch) return
    await run('batch-retry', async () => {
      const result = await plannerApi.imageBatch.retry(session.id, batch.id)
      batchNotified.current = ''
      applyBatch(result.batch)
    })
  }

  async function applyToStudio(): Promise<void> {
    if (!session || busy || !frames.length || (autoGenerate && !videoModelId)) return
    await run('apply', async () => {
      if (dirty) await saveFrames()
      await plannerApi.apply(session.id, {
        ...(projectName.trim() ? { newProjectName: projectName.trim() } : {}),
        ...(videoModelId ? { modelId: videoModelId } : {}),
        autoGenerate,
      })
      await onProjectsChanged()
      onOpenProject()
      onNotify(notification('planner', 'projectCreated'))
    })
  }

  if (!sessionId) {
    return (
      <div className="page-content board-page">
        <div className="page-heading board-heading">
          <div>
            <button type="button" className="text-button" onClick={() => onBackToChat('')}>
              <ArrowLeft size={14} /> {t('backToPlanner')}
            </button>
            <h1>{t('boardListTitle')}</h1>
            <p>{t('boardListIntro')}</p>
          </div>
        </div>

        {sessionsLoading ? (
          <div className="empty-state">
            <LoaderCircle size={22} className="spin" /> {t('loadingTimeline')}
          </div>
        ) : sessions.length ? (
          <div className="project-dashboard-grid board-session-grid">
            {sessions.map((item) => {
              const title = item.title || t('untitledSession')
              const cover = sessionCover(item)
              const frameCount = item.timeline?.frames.length ?? 0
              const castCount = item.cast.length
              return (
                <article
                  key={item.id}
                  className="project-dashboard-card board-session-card"
                  data-session-id={item.id}
                >
                  <button
                    type="button"
                    className="board-session-open"
                    aria-label={t('boardOpenSessionAria', { title })}
                    onClick={() => onSelectSession(item.id)}
                  >
                    <div className="project-cover">
                      {cover ? (
                        <img src={uploadUrl(cover)} alt="" loading="lazy" />
                      ) : (
                        <div className="project-cover-placeholder">
                          <GalleryHorizontalEnd />
                          <span>{t('noStoryboardImage')}</span>
                        </div>
                      )}
                    </div>
                    <div className="project-card-body">
                      <h3>{title}</h3>
                      <div className="project-card-meta">
                        <span className="board-session-status">{t(STATUS_KEYS[item.status])}</span>
                        <span>
                          {frameCount === 1
                            ? t('boardCardFramesOne', { count: frameCount })
                            : t('boardCardFramesOther', { count: frameCount })}
                        </span>
                        <span>
                          {castCount === 1
                            ? t('boardCardCastOne', { count: castCount })
                            : t('boardCardCastOther', { count: castCount })}
                        </span>
                        <span>{t('boardCardDuration', { total: formatClock(sessionSeconds(item)) })}</span>
                        <span>
                          {t('boardCardUpdated', {
                            date: formatDate(
                              item.updatedAt,
                              { dateStyle: 'short', timeStyle: 'short' },
                              locale,
                            ),
                          })}
                        </span>
                      </div>
                    </div>
                  </button>
                </article>
              )
            })}
          </div>
        ) : (
          <div className="empty-state">
            <GalleryHorizontalEnd size={22} />
            <strong>{t('boardListEmptyTitle')}</strong>
            <p>{t('boardListEmptyBody')}</p>
            <button type="button" className="primary-small-button" onClick={() => onBackToChat('')}>
              <ArrowLeft size={15} /> {t('backToPlanner')}
            </button>
          </div>
        )}
      </div>
    )
  }

  if (loading && !session) {
    return (
      <div className="page-content board-page">
        <div className="empty-state">
          <LoaderCircle size={22} className="spin" /> {t('loadingTimeline')}
        </div>
      </div>
    )
  }

  if (!session) {
    return (
      <div className="page-content board-page">
        <div className="empty-state">
          <strong>{t('sessionOpenFailed')}</strong>
          <p>{errorText || t('sessionMaybeDeleted')}</p>
          <button type="button" className="primary-small-button" onClick={() => onBackToChat('')}>
            <ArrowLeft size={15} /> {t('backToPlanner')}
          </button>
        </div>
      </div>
    )
  }

  const sessionIndex = sessions.findIndex((item) => item.id === session.id)

  return (
    <div className="page-content board-page">
      <div className="page-heading board-heading">
        <div>
          <div className="board-heading-links">
            <button
              type="button"
              className="text-button"
              onClick={() => onBackToChat(session.id)}
            >
              <ArrowLeft size={14} /> {t('backToPlannerChat')}
            </button>
            {/* Danh sách thẻ chỉ hiện khi không gắn phiên: giữ một lối quay lại. */}
            <button type="button" className="text-button" onClick={() => onSelectSession('')}>
              <GalleryHorizontalEnd size={14} /> {t('backToTimelineList')}
            </button>
          </div>
          <h1>{t('targetTimeline')}</h1>
          <p>
            {frames.length === 1
              ? t('boardSubtitleOne', {
                  title: session.title || t('untitledSession'),
                  frames: frames.length,
                  total: formatClock(totalSeconds),
                })
              : t('boardSubtitleOther', {
                  title: session.title || t('untitledSession'),
                  frames: frames.length,
                  total: formatClock(totalSeconds),
                })}
          </p>
        </div>
        <div className="board-heading-actions">
          <label className="board-field">
            <span>{t('boardImageModelLabel')}</span>
            <select
              value={imageModelId}
              disabled={busy !== ''}
              onChange={(event) =>
                void run('setup', async () => {
                  const result = await plannerApi.setup(session.id, {
                    imageModelId: event.target.value || null,
                  })
                  applySession(result.session)
                })
              }
            >
              <option value="">{t('boardNoImageModel')}</option>
              {models
                .filter((model) => model.kind === 'image' && model.enabled)
                .map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.displayName} · {model.providerName}
                  </option>
                ))}
            </select>
          </label>
          <button
            type="button"
            className="secondary-button"
            disabled={busy !== ''}
            onClick={() =>
              void run('timeline', async () => {
                const result = await plannerApi.generateTimeline(session.id)
                applySession(result.session)
                onNotify(notification('planner', 'timelineUpdatedByAi'))
              })
            }
          >
            <ActionLabel busy={busy === 'timeline'} idle={t('aiBuildTimeline')} working={t('buildingTimeline')} />
          </button>
          <button
            type="button"
            className="primary-small-button"
            disabled={busy !== '' || !dirty}
            onClick={() => void run('save', async () => { await saveFrames() })}
          >
            <ActionLabel busy={busy === 'save'} idle={t('saveChanges')} working={t('saving')} />
          </button>
          <button
            type="button"
            className="primary-small-button"
            disabled={busy !== '' || !imageModelId || batch?.status === 'running'}
            title={imageModelId ? t('generateAllImagesTitle') : t('chooseImageModelFirst')}
            onClick={() => setBatchPanelOpen(true)}
          >
            <Images size={15} /> {t('generateAllImages')}
          </button>
          <button type="button" className="secondary-button" onClick={() => setLocationsOpen((open) => !open)}>{tLocations('title')}</button>
          <button type="button" className="secondary-button" onClick={() => { setProjectOpen(false); setError(null); setChatOpen(true) }}>
            <Send size={15} /> {chatOpen ? t('hideChat') : t('chatWithAi')}
          </button>
          <button type="button" className="primary-small-button" disabled={busy !== '' || loading || !frames.length || Boolean(busyFrameId)} onClick={() => { setChatOpen(false); setError(null); setProjectOpen(true) }}>
            <ArrowUpRight size={15} /> {t('finalizeProject')}
          </button>
        </div>
      </div>

      {errorText && <div className="form-error" role="alert">{errorText}</div>}

      {locationsOpen && <section className="board-batch-panel">
        {dirty && <p className="project-hint">{tLocations('preserveDraftWarning')}</p>}
        <LocationReferences sessionId={session.id} locations={session.locations ?? []}
          imageModels={models.filter((model) => model.kind === 'image' && model.enabled)} selectedModelId={imageModelId}
          api={locationPanelApi(planLocationsApi(session.id))} onChanged={locationsChanged} onNotify={onNotify}
          assignedCounts={Object.fromEntries((session.locations ?? []).map((location) => [location.id, frames.filter((frame) => frame.locationId === location.id).length]))} />
        <fieldset>
          <legend>{tLocations('selectFrames')}</legend>
          <div className="board-chips">{frames.map((frame, index) => <label key={frame.id}>
            <input type="checkbox" checked={assignmentIds.includes(frame.id)} onChange={(event) => setAssignmentIds((ids) => event.target.checked ? [...ids, frame.id] : ids.filter((id) => id !== frame.id))} />
            {index + 1}: {frame.title}
          </label>)}</div>
          <label className="plan-cell"><span>{tLocations('selectLocation')}</span>
            <select value={assignmentLocationId} onChange={(event) => setAssignmentLocationId(event.target.value)}>
              <option value="">{tLocations('unassigned')}</option>
              {(session.locations ?? []).map((location) => <option key={location.id} value={location.id}>{location.name}{location.stage ? ` · ${location.stage}` : ''}</option>)}
            </select>
          </label>
          <button type="button" className="secondary-button" disabled={!assignmentIds.length} onClick={() => {
            setFrames((current) => current.map((frame) => assignmentIds.includes(frame.id) ? { ...frame, locationId: assignmentLocationId || null, backgroundStale: Boolean(frame.background) } : frame))
            setDirty(true)
          }}>{tLocations('assignSelected')}</button>
        </fieldset>
      </section>}

      {batchPanelOpen && (
        <div className="board-batch-panel">
          <div>
            <strong>{t('batchPanelTitle')}</strong>
            <p>
              {t('batchIntroPrefix')}<strong>{batchTargets}</strong>
              {batchTargets === 1 ? t('batchIntroFrameOne') : t('batchIntroFrameOther')}
              {regenerateAll ? '' : t('batchIntroNoImage')}
              {t('batchIntroTail', { model: imageModel?.displayName ?? t('chosenModel') })}
            </p>
            <label className="plan-check">
              <input
                type="checkbox"
                checked={regenerateAll}
                onChange={(event) => setRegenerateAll(event.target.checked)}
              />
              {t('batchRegenerateCheckbox')}
            </label>
            {missingPortraits.length > 0 && (
              <p className="board-batch-warning">
                {missingPortraits.length === 1
                  ? t('batchMissingPortraitsOne', { count: missingPortraits.length })
                  : t('batchMissingPortraitsOther', { count: missingPortraits.length })}
                {missingPortraits.map((member) => member.name).join(', ')}
                {t('batchMissingPortraitsTail')}
              </p>
            )}
          </div>
          <div className="board-batch-panel-actions">
            <button type="button" className="secondary-button" onClick={() => setBatchPanelOpen(false)}>
              {t('cancel')}
            </button>
            <button
              type="button"
              className="primary-small-button"
              disabled={busy !== '' || batchTargets === 0 || batch?.status === 'running'}
              onClick={() => void startBatch()}
            >
              <ActionLabel
                busy={busy === 'batch'}
                idle={
                  batchTargets === 1
                    ? t('startBatchOne', { count: batchTargets })
                    : t('startBatchOther', { count: batchTargets })
                }
                working={t('queuing')}
              />
            </button>
          </div>
        </div>
      )}

      {batch && (
        <div className="board-batch-status">
          <div className="board-batch-bar" role="progressbar" aria-label={t('batchProgressLabel')}>
            <span style={{ width: `${batch.total ? Math.round(((batch.done + batch.failed) / batch.total) * 100) : 0}%` }} />
          </div>
          <span className="board-batch-count">
            {t('batchProgressDone', { done: batch.done, total: batch.total })}
            {batch.failed ? t('batchProgressFailed', { count: batch.failed }) : ''}
            {batch.status === 'running'
              ? t('batchStatusRunning')
              : batch.status === 'stopped'
                ? t('batchStatusStopped')
                : t('batchStatusFinished')}
          </span>
          {batch.status === 'running' && (
            <button
              type="button"
              className="secondary-button"
              disabled={busy !== ''}
              onClick={() => void stopBatch()}
            >
              <Square size={13} /> {t('stop')}
            </button>
          )}
          {(batch.failed > 0 || batch.items.some((item) => item.status === 'stopped')) && (
            <button
              type="button"
              className="secondary-button"
              disabled={busy !== ''}
              onClick={() => void retryBatch()}
            >
              {t('retryFailedFrames')}
            </button>
          )}
          {batch.items
            .filter((item) => item.error)
            .slice(0, 4)
            .map((item) => (
              <span
                key={item.id}
                className="board-batch-error"
                title={item.error ?? undefined}
              >
                {item.title || item.frameId}: {batchItemErrorHeading(item)}
              </span>
            ))}
        </div>
      )}

      {sessions.length > 1 && (
        <div className="board-session-bar">
          <button
            type="button"
            className="secondary-button"
            disabled={sessionIndex <= 0}
            onClick={() => onSelectSession(sessions[sessionIndex - 1]!.id)}
          >
            <ChevronLeft size={15} /> {t('previousSession')}
          </button>
          <select value={session.id} onChange={(event) => onSelectSession(event.target.value)}>
            {sessions.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title || t('untitledSession')}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="secondary-button"
            disabled={sessionIndex < 0 || sessionIndex >= sessions.length - 1}
            onClick={() => onSelectSession(sessions[sessionIndex + 1]!.id)}
          >
            {t('nextSession')} <ChevronRight size={15} />
          </button>
        </div>
      )}

      {frames.length === 0 ? (
        <div className="empty-state">
          <Clapperboard size={22} />
          <strong>{t('noFramesTitle')}</strong>
          <p>{t('noFramesBody')}</p>
          <div className="board-empty-actions">
            <button
              type="button"
              className="primary-small-button"
              disabled={busy !== ''}
              onClick={() =>
                void run('timeline', async () => {
                  const result = await plannerApi.generateTimeline(session.id)
                  applySession(result.session)
                })
              }
            >
              <Sparkles size={15} /> {t('aiBuildTimeline')}
            </button>
            <button type="button" className="secondary-button" onClick={addFrame}>
              <Plus size={15} /> {t('addFrame')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="board-strip" role="list" aria-label={t('storyboardLabel')}>
            {frames.map((frame, index) => {
              const span = spans[index]!
              const isSelected = selected?.id === frame.id
              const batchItem = batch?.items.find((item) => item.frameId === frame.id)
              const frameBusy = busyFrameId === frame.id || batchItem?.status === 'running'
              return (
                <article
                  key={frame.id}
                  role="listitem"
                  aria-current={isSelected ? 'true' : undefined}
                  className={`board-card ${isSelected ? 'is-selected' : ''}`}
                  onClick={() => setSelectedId(frame.id)}
                >
                  <header className="board-card-head">
                    <span className="board-index">{t('frameIndex', { index: index + 1 })}</span>
                    <span className="board-time">
                      {formatClock(span.start)}–{formatClock(span.end)}
                    </span>
                    <span className="board-duration">
                      {t('frameDurationShort', { seconds: frame.durationSeconds })}
                    </span>
                  </header>
                  {batchItem && batchItem.status !== 'done' && (
                    <span className={`board-item-status is-${batchItem.status}`}>
                      {batchItem.status === 'pending'
                        ? t('batchItemPending')
                        : batchItem.status === 'running'
                          ? t('batchItemRunning')
                          : batchItem.status === 'error'
                            ? t('batchItemError')
                            : t('batchItemStopped')}
                    </span>
                  )}

                  <div className="board-image">
                    {frame.background ? (
                      <button
                        type="button"
                        className="illustration-zoom"
                        title={t('zoomImage')}
                        aria-label={t('zoomFrameImage', { index: index + 1 })}
                        onClick={(event) => {
                          event.stopPropagation()
                          setZoom({
                            url: uploadUrl(frame.background!.uploadId),
                            index: index + 1,
                          })
                        }}
                      >
                        <img
                          src={uploadUrl(frame.background.uploadId)}
                          alt={t('storyboardFrameAlt', { index: index + 1 })}
                          loading="lazy"
                        />
                      </button>
                    ) : (
                      <div className="board-image-empty">
                        <ImagePlus size={20} />
                        <span>{t('noStoryboardImage')}</span>
                      </div>
                    )}
                    {frameBusy && <AsyncOverlay label={t('generatingStoryboardImage')} />}
                  </div>

                  <div className="board-card-body">
                    <div className="board-card-title">
                      <strong>{frame.title || t('frameIndex', { index: index + 1 })}</strong>
                      <span>
                        {frame.blocking.length === 1
                          ? t('peopleCountOne', { count: frame.blocking.length })
                          : t('peopleCountOther', { count: frame.blocking.length })}
                      </span>
                    </div>
                    {frame.context && <p>{frame.context}</p>}
                    <div className="board-chips">
                      {frame.blocking.length === 0 && <span className="is-muted">{t('noCharactersInFrame')}</span>}
                      {frame.blocking.map((entry, entryIndex) => {
                        const name =
                          cast.find((member) => member.id === entry.castId)?.name ?? entry.castId
                        const positionKey = POSITION_LABEL.get(entry.position)
                        return (
                          <span key={`${entry.castId}-${entryIndex}`}>
                            <strong>{name}</strong>
                            {positionKey ? t(positionKey) : ''}
                            {entry.action ? ` · ${entry.action}` : ''}
                          </span>
                        )
                      })}
                    </div>
                    {frame.speaker && (
                      <span className="board-speaker">{t('speakerWithName', { name: frame.speaker })}</span>
                    )}
                  </div>

                  <div className="board-card-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={frameBusy || busy !== '' || !imageModelId}
                      title={imageModelId ? t('generateFrameImageTitle') : t('chooseImageModelFirst')}
                      onClick={(event) => {
                        event.stopPropagation()
                        void generateImage(frame)
                      }}
                    >
                      {frameBusy ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}
                      {frame.background ? t('regenerateImage') : t('generateImage')}
                    </button>
                    {frame.background && (
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={busy !== ''}
                        onClick={(event) => {
                          event.stopPropagation()
                          void removeImage(frame)
                        }}
                      >
                        <Trash2 size={14} /> {t('removeImage')}
                      </button>
                    )}
                  </div>
                </article>
              )
            })}
            <article className="board-card board-card-add">
              <button type="button" onClick={addFrame}>
                <Plus size={18} /> {t('addFrame')}
              </button>
            </article>
          </div>

          <div className="board-legend">
            <span>
              <Wand2 size={13} /> {t('boardLegend')}
            </span>
            <button
              type="button"
              className="secondary-button"
              disabled={busy !== '' || !dirty}
              onClick={() => void run('save', async () => { await saveFrames() })}
            >
              <Save size={14} /> {t('saveChanges')}
            </button>
          </div>

          {selected && (
            <section className="board-editor" aria-label={t('editFrameAria', { title: selected.title || t('untitledFrame') })}>
              <header className="board-editor-head">
                <div>
                  <div className="eyebrow"><span className="eyebrow-dot" /> {t('selectedFrame')}</div>
                  <h2>{selected.title || t('untitledFrame')}</h2>
                </div>
                <div className="board-editor-nav">
                  <button
                    type="button"
                    className="secondary-button"
                    aria-label={t('moveFrameLeftAria')}
                    onClick={() => moveFrame(selected.id, -1)}
                  >
                    <ChevronLeft size={15} /> {t('moveLeft')}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    aria-label={t('moveFrameRightAria')}
                    onClick={() => moveFrame(selected.id, 1)}
                  >
                    {t('moveRight')} <ChevronRight size={15} />
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy !== ''}
                    onClick={() => void arrangeFrame(selected)}
                  >
                    <ActionLabel
                      busy={busy === 'arrange'}
                      idle={t('aiArrangeFrame')}
                      working={t('aiArranging')}
                    />
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => duplicateFrame(selected.id)}
                  >
                    {t('duplicate')}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      removeFrame(selected.id)
                      onNotify(notification('planner', 'frameRemoved'))
                    }}
                  >
                    <Trash2 size={14} /> {t('removeFrame')}
                  </button>
                </div>
              </header>

              <div className="board-editor-grid">
                <label className="plan-cell">
                  <span>{tLocations('selectLocation')}</span>
                  <select value={selected.locationId ?? ''} onChange={(event) => patchFrame(selected.id, { locationId: event.target.value || null, backgroundStale: Boolean(selected.background) })}>
                    <option value="">{tLocations('unassigned')}</option>
                    {selected.locationId && !(session.locations ?? []).some((location) => location.id === selected.locationId) && <option value={selected.locationId}>{tLocations('missingLocation')}</option>}
                    {(session.locations ?? []).map((location) => <option key={location.id} value={location.id}>{location.name}{location.stage ? ` · ${location.stage}` : ''}</option>)}
                  </select>
                  {!selected.locationId && <small>{tLocations('unassigned')}</small>}
                  {selected.backgroundStale && <small>{tLocations('staleBackground')}</small>}
                  {(() => { const location = (session.locations ?? []).find((item) => item.id === selected.locationId); return location?.reference ? <img src={locationReferenceUrl(location)} alt={location.name} style={{ width: 96, maxHeight: 64, objectFit: 'cover' }} /> : location ? <small>{tLocations('noReference')}</small> : null })()}
                </label>
                <label className="plan-cell">
                  <span>{t('frameTitleLabel')}</span>
                  <input
                    value={selected.title}
                    aria-label={t('frameTitleSelectedAria')}
                    onChange={(event) => patchFrame(selected.id, { title: event.target.value })}
                  />
                </label>
                <label className="plan-cell">
                  <span>{t('frameDurationLabel')}</span>
                  <input
                    type="number"
                    min={1}
                    max={600}
                    value={selected.durationSeconds}
                    aria-label={t('frameDurationSelectedAria')}
                    onChange={(event) =>
                      patchFrame(selected.id, { durationSeconds: Number(event.target.value) || 1 })
                    }
                  />
                </label>
                <label className="plan-cell">
                  <span>{t('fieldSpeaker')}</span>
                  <select
                    value={selected.speaker}
                    aria-label={t('frameSpeakerAria')}
                    onChange={(event) => patchFrame(selected.id, { speaker: event.target.value })}
                  >
                    <option value="">{t('noDialogue')}</option>
                    {selected.blocking.map((entry) => {
                      const name = cast.find((member) => member.id === entry.castId)?.name
                      return name ? (
                        <option key={entry.castId} value={name}>
                          {name}
                        </option>
                      ) : null
                    })}
                  </select>
                </label>
                <label className="plan-cell">
                  <span>{t('shotNotesLabel')}</span>
                  <input
                    value={selected.shotNotes}
                    aria-label={t('shotNotesAria')}
                    onChange={(event) => patchFrame(selected.id, { shotNotes: event.target.value })}
                  />
                </label>
                <label className="plan-cell board-editor-wide">
                  <span>{t('frameContextLabel')}</span>
                  <textarea
                    rows={2}
                    value={selected.context}
                    aria-label={t('frameContextAria')}
                    onChange={(event) =>
                      patchFrame(selected.id, {
                        context: event.target.value,
                        backgroundPrompt: event.target.value,
                      })
                    }
                  />
                </label>
                <label className="plan-cell board-editor-wide">
                  <span>{t('frameActionLabel')}</span>
                  <textarea
                    rows={2}
                    value={selected.action}
                    aria-label={t('frameActionAria')}
                    onChange={(event) => patchFrame(selected.id, { action: event.target.value })}
                  />
                </label>
                <label className="plan-cell board-editor-wide">
                  <span>{t('fieldDialogue')}</span>
                  <textarea
                    rows={2}
                    value={selected.dialogue}
                    aria-label={t('frameDialogueAria')}
                    onChange={(event) => patchFrame(selected.id, { dialogue: event.target.value })}
                  />
                </label>
              </div>

              <div className="board-people">
                <div className="board-people-head">
                  <strong>{t('frameCharactersHeading', { count: selected.blocking.length })}</strong>
                  <button type="button" className="secondary-button" onClick={() => addBlocking(selected.id)}>
                    <Plus size={14} /> {t('addCharacter')}
                  </button>
                </div>
                {selected.blocking.length === 0 && (
                  <p className="board-people-empty">{t('frameNoCharacters')}</p>
                )}
                {selected.blocking.map((entry, index) => (
                  <div className="board-person" key={`${entry.castId}-${index}`}>
                    <label className="plan-cell">
                      <span>{t('fieldCharacter')}</span>
                      <select
                        value={entry.castId}
                        aria-label={t('characterOfFrameAria', { index: index + 1 })}
                        onChange={(event) => updateBlocking(selected.id, index, { castId: event.target.value })}
                      >
                        <option value="">{t('chooseCharacter')}</option>
                        {cast.map((member) => (
                          <option key={member.id} value={member.id}>
                            {member.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="plan-cell">
                      <span>{t('characterActionLabel')}</span>
                      <input
                        value={entry.action}
                        placeholder={t('characterActionPlaceholder')}
                        aria-label={t('characterActionAria', { index: index + 1 })}
                        onChange={(event) => updateBlocking(selected.id, index, { action: event.target.value })}
                      />
                    </label>
                    <label className="plan-cell">
                      <span>{t('positionLabel')}</span>
                      <select
                        value={entry.position}
                        aria-label={t('characterPositionAria', { index: index + 1 })}
                        onChange={(event) =>
                          updateBlocking(selected.id, index, {
                            position: event.target.value as FramePosition,
                          })
                        }
                      >
                        {POSITIONS.map((position) => (
                          <option key={position.value} value={position.value}>
                            {t(position.labelKey)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      className="secondary-button"
                      aria-label={t('removeCharacterFromFrameAria', { index: index + 1 })}
                      onClick={() => removeBlocking(selected.id, index)}
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>


            </section>
          )}
        </>
      )}

      {chatOpen && (
        <TimelineOverlay title={t('timelineChatTitle')} drawer onClose={() => setChatOpen(false)}>
          {errorText && <div className="form-error" role="alert">{errorText}</div>}
          <div className="board-chat-log" ref={chatLogRef} aria-live="polite">
            {messages.length === 0 ? (
              <p className="board-chat-empty">{t('timelineChatEmpty')}</p>
            ) : (
              messages.map((message) => (
                <div key={message.id} className={`planner-bubble ${message.role === 'user' ? 'is-user' : 'is-assistant'}`}>
                  <div className="planner-bubble-role">
                    {message.role === 'user' ? t('senderYou') : t('eyebrowAiScript')}
                  </div>
                  <div className="planner-bubble-body">{message.content}</div>
                </div>
              ))
            )}
          </div>
          {busy === 'chat' && <div className="timeline-thinking"><LoaderCircle size={14} className="spin" /> {t('aiTyping')}</div>}
          <div className="planner-composer">
            <textarea
              ref={chatInputRef}
              value={chatDraft}
              disabled={busy !== ''}
              maxLength={8000}
              aria-label={t('timelineMessageAria')}
              placeholder={t('timelineComposerPlaceholder')}
              onChange={(event) => setChatDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void sendChat()
                }
              }}
            />
            <button
              type="button"
              className="generate-button"
              disabled={busy !== '' || !chatDraft.trim()}
              onClick={() => void sendChat()}
            >
              {busy === 'chat' ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />} {t('send')}
            </button>
          </div>
        </TimelineOverlay>
      )}

      {projectOpen && <TimelineOverlay title={t('finalizeProjectTitle')} locked={busy === 'apply'} onClose={() => setProjectOpen(false)}>
              <div className="timeline-project-form">
                <label className="plan-cell">
                  <span>{t('newProjectName')}</span>
                  <input
                    value={projectName}
                    onChange={(event) => setProjectName(event.target.value)}
                    placeholder={t('projectNamePlaceholder')}
                  />
                </label>
                <label className="plan-cell">
                  <span>{t('videoModelLabel')}</span>
                  <select value={videoModelId} onChange={(event) => setVideoModelId(event.target.value)}>
                    <option value="">{t('chooseLaterInStudio')}</option>
                    {videoModels.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.displayName} · {model.providerName}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="plan-check">
                  <input
                    type="checkbox"
                    checked={autoGenerate}
                    onChange={(event) => setAutoGenerate(event.target.checked)}
                  />
                  {t('autoGenerateCheckbox')}
                </label>
                <button
                  type="button"
                  className="primary-small-button"
                  disabled={busy !== '' || !frames.length || (autoGenerate && !videoModelId)}
                  onClick={() => void applyToStudio()}
                >
                  <ActionLabel
                    busy={busy === 'apply'}
                    idle={t('confirmCreateProject')}
                    working={t('creatingProject')}
                  />
                  <ArrowUpRight size={15} />
                </button>
                <p className="timeline-project-note">{t('projectNote')}</p>
                {autoGenerate && !videoModelId && <p className="form-error">{t('chooseVideoModelForAuto')}</p>}
                {errorText && <div className="form-error" role="alert">{errorText}</div>}
                <button type="button" className="secondary-button" disabled={busy === 'apply'} onClick={() => setProjectOpen(false)}>{t('cancel')}</button>
              </div>
      </TimelineOverlay>}

      <div className="board-hint">
        <Sparkles size={13} /> {t('boardHint')}
      </div>

      {zoom && (
        <ImageLightbox
          src={zoom.url}
          alt={t('storyboardFrameAlt', { index: zoom.index })}
          downloadHref={zoom.url}
          onClose={() => setZoom(null)}
        />
      )}


    </div>
  )
}
