import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
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
import { errorMessage } from '../api/client'
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

const POSITIONS: Array<{ value: FramePosition; label: string }> = [
  { value: 'left', label: 'Bên trái' },
  { value: 'center', label: 'Chính giữa' },
  { value: 'right', label: 'Bên phải' },
  { value: 'background', label: 'Phía sau' },
]

const POSITION_LABEL = new Map(POSITIONS.map((item) => [item.value, item.label]))

const POLL_MS = 1500
const MAX_WAIT_MS = 4 * 60 * 1000

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
  onNotify: (message: string) => void
  onSelectSession: (sessionId: string) => void
  onBackToChat: (sessionId: string) => void
  onOpenSettings: () => void
  onOpenProject: () => void
  onProjectsChanged: () => void | Promise<void>
}) {
  const [session, setSession] = useState<PlanSession | null>(null)
  const [messages, setMessages] = useState<PlanMessage[]>([])
  const [sessions, setSessions] = useState<PlanSession[]>([])
  const [frames, setFrames] = useState<TimelineFrame[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [busyFrameId, setBusyFrameId] = useState('')
  const [error, setError] = useState('')
  const [dirty, setDirty] = useState(false)
  const [zoom, setZoom] = useState<{ url: string; alt: string } | null>(null)
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
  const batchNotified = useRef('')
  const cancelled = useRef(false)

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
      setError('')
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
        setError(errorMessage(cause))
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
            `Sinh ảnh storyboard xong: ${next.done}/${next.total}${
              next.failed ? `, ${next.failed} frame lỗi` : ''
            }.`,
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
    setError('')
    try {
      await action()
    } catch (cause) {
      setError(errorMessage(cause))
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
      onNotify('Mọi nhân vật trong phiên đã có mặt ở frame này.')
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
        title: `${source.title} (bản sao)`,
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
      title: `Frame ${frames.length + 1}`,
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
    setError('')
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
          onNotify('Đã gắn ảnh storyboard mới cho frame.')
          return
        }
        if (current.status === 'failed' || current.status === 'unknown') {
          throw new Error(current.errorMessage ?? 'Tạo ảnh storyboard thất bại.')
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      }
      throw new Error('Tạo ảnh quá lâu. Hãy thử lại.')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusyFrameId('')
    }
  }

  async function uploadImage(frame: TimelineFrame, file: File): Promise<void> {
    if (!session) return
    setBusyFrameId(frame.id)
    setError('')
    try {
      if (dirty) await saveFrames()
      const result = await plannerApi.uploadBackground(session.id, frame.id, file)
      applySession(result.session)
    } catch (cause) {
      setError(errorMessage(cause))
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
    setError('')
    try {
      if (dirty) await saveFrames()
      const result = await plannerApi.sendMessage(targetId, content, 'timeline')
      if (sessionId !== targetId) return
      applySession(result.session)
      setMessages(result.messages)
      setChatDraft('')
    } catch (cause) {
      setError(errorMessage(cause))
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
      onNotify(result.reply || 'AI đã sắp xếp lại frame.')
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
    await run('batch', async () => {
      if (dirty) await saveFrames()
      const result = await plannerApi.imageBatch.create(session.id, { regenerateAll })
      batchNotified.current = ''
      applyBatch(result.batch)
      setBatchPanelOpen(false)
      setRegenerateAll(false)
      onNotify(`Đã xếp hàng sinh ${result.batch.total} ảnh storyboard.`)
    })
  }

  async function stopBatch(): Promise<void> {
    if (!session || !batch) return
    await run('batch-stop', async () => {
      const result = await plannerApi.imageBatch.stop(session.id, batch.id)
      applyBatch(result.batch)
      onNotify('Đã dừng batch. Tác vụ đã gửi provider vẫn có thể xong và vẫn tính phí.')
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
      onNotify('Đã tạo dự án Studio từ timeline.')
    })
  }

  if (!sessionId) {
    return (
      <div className="page-content board-page">
        <div className="empty-state">
          <GalleryIcon />
          <strong>Chưa chọn phiên kịch bản</strong>
          <p>Mở một phiên trong Tạo kịch bản AI rồi bấm “Lên timeline”, hoặc chọn phiên bên dưới.</p>
          <div className="board-session-picker">
            {sessions.map((item) => (
              <button key={item.id} type="button" className="secondary-button" onClick={() => onSelectSession(item.id)}>
                {item.title || 'Phiên chưa đặt tên'}
              </button>
            ))}
          </div>
          <button type="button" className="primary-small-button" onClick={() => onBackToChat('')}>
            <ArrowLeft size={15} /> Về Tạo kịch bản AI
          </button>
        </div>
      </div>
    )
  }

  if (loading && !session) {
    return (
      <div className="page-content board-page">
        <div className="empty-state">
          <LoaderCircle size={22} className="spin" /> Đang tải timeline…
        </div>
      </div>
    )
  }

  if (!session) {
    return (
      <div className="page-content board-page">
        <div className="empty-state">
          <strong>Không mở được phiên này</strong>
          <p>{error || 'Phiên có thể đã bị xoá.'}</p>
          <button type="button" className="primary-small-button" onClick={() => onBackToChat('')}>
            <ArrowLeft size={15} /> Về Tạo kịch bản AI
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
          <button
            type="button"
            className="text-button"
            onClick={() => onBackToChat(session.id)}
          >
            <ArrowLeft size={14} /> Về chat Tạo kịch bản AI
          </button>
          <h1>Timeline</h1>
          <p>
            {session.title || 'Phiên chưa đặt tên'} · {frames.length} frame · tổng{' '}
            {formatClock(totalSeconds)} · mỗi thẻ cho biết ai có mặt và làm gì.
          </p>
        </div>
        <div className="board-heading-actions">
          <label className="board-field">
            <span>Model ảnh</span>
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
              <option value="">Chưa chọn model ảnh</option>
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
                onNotify('AI đã cập nhật timeline từ kịch bản nháp.')
              })
            }
          >
            <ActionLabel busy={busy === 'timeline'} idle="AI lên timeline" working="Đang lên timeline…" />
          </button>
          <button
            type="button"
            className="primary-small-button"
            disabled={busy !== '' || !dirty}
            onClick={() => void run('save', async () => { await saveFrames() })}
          >
            <ActionLabel busy={busy === 'save'} idle="Lưu thay đổi" working="Đang lưu…" />
          </button>
          <button
            type="button"
            className="primary-small-button"
            disabled={busy !== '' || !imageModelId || batch?.status === 'running'}
            title={imageModelId ? 'Sinh ảnh storyboard cho cả timeline' : 'Chọn model ảnh trước'}
            onClick={() => setBatchPanelOpen(true)}
          >
            <Images size={15} /> Sinh tất cả ảnh
          </button>
          <button type="button" className="secondary-button" onClick={() => { setProjectOpen(false); setError(''); setChatOpen(true) }}>
            <Send size={15} /> {chatOpen ? 'Ẩn chat' : 'Chat với AI'}
          </button>
          <button type="button" className="primary-small-button" disabled={busy !== '' || loading || !frames.length || Boolean(busyFrameId)} onClick={() => { setChatOpen(false); setError(''); setProjectOpen(true) }}>
            <ArrowUpRight size={15} /> Chốt & tạo dự án
          </button>
        </div>
      </div>

      {error && <div className="form-error" role="alert">{error}</div>}

      {batchPanelOpen && (
        <div className="board-batch-panel">
          <div>
            <strong>Sinh ảnh storyboard cho timeline</strong>
            <p>
              Sẽ tạo ảnh cho <strong>{batchTargets}</strong> frame
              {regenerateAll ? '' : ' chưa có ảnh'} bằng model “{imageModel?.displayName ?? 'đã chọn'}”,
              chạy lần lượt từng frame. Ảnh dùng API key của bạn nên có thể phát sinh chi phí.
            </p>
            <label className="plan-check">
              <input
                type="checkbox"
                checked={regenerateAll}
                onChange={(event) => setRegenerateAll(event.target.checked)}
              />
              Tạo lại cả ảnh đã có (thay ảnh hiện tại)
            </label>
            {missingPortraits.length > 0 && (
              <p className="board-batch-warning">
                {missingPortraits.length} nhân vật chưa có ảnh chân dung (
                {missingPortraits.map((member) => member.name).join(', ')}): ảnh vẫn được tạo theo mô
                tả nhưng khuôn mặt có thể kém nhất quán. Gắn chân dung ở panel Nhân vật để cải thiện.
              </p>
            )}
          </div>
          <div className="board-batch-panel-actions">
            <button type="button" className="secondary-button" onClick={() => setBatchPanelOpen(false)}>
              Huỷ
            </button>
            <button
              type="button"
              className="primary-small-button"
              disabled={busy !== '' || batchTargets === 0}
              onClick={() => void startBatch()}
            >
              <ActionLabel busy={busy === 'batch'} idle={`Bắt đầu sinh ${batchTargets} ảnh`} working="Đang xếp hàng…" />
            </button>
          </div>
        </div>
      )}

      {batch && (
        <div className="board-batch-status">
          <div className="board-batch-bar" role="progressbar" aria-label="Tiến trình sinh ảnh">
            <span style={{ width: `${batch.total ? Math.round(((batch.done + batch.failed) / batch.total) * 100) : 0}%` }} />
          </div>
          <span className="board-batch-count">
            {batch.done}/{batch.total} ảnh xong
            {batch.failed ? ` · ${batch.failed} lỗi` : ''}
            {batch.status === 'running' ? ' · đang chạy' : batch.status === 'stopped' ? ' · đã dừng' : ' · hoàn tất'}
          </span>
          {batch.status === 'running' && (
            <button
              type="button"
              className="secondary-button"
              disabled={busy !== ''}
              onClick={() => void stopBatch()}
            >
              <Square size={13} /> Dừng
            </button>
          )}
          {(batch.failed > 0 || batch.items.some((item) => item.status === 'stopped')) && (
            <button
              type="button"
              className="secondary-button"
              disabled={busy !== ''}
              onClick={() => void retryBatch()}
            >
              Thử lại frame lỗi
            </button>
          )}
          {batch.items
            .filter((item) => item.error)
            .slice(0, 4)
            .map((item) => (
              <span key={item.id} className="board-batch-error">
                {item.title || item.frameId}: {item.error}
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
            <ChevronLeft size={15} /> Phiên trước
          </button>
          <select value={session.id} onChange={(event) => onSelectSession(event.target.value)}>
            {sessions.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title || 'Phiên chưa đặt tên'}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="secondary-button"
            disabled={sessionIndex < 0 || sessionIndex >= sessions.length - 1}
            onClick={() => onSelectSession(sessions[sessionIndex + 1]!.id)}
          >
            Phiên sau <ChevronRight size={15} />
          </button>
        </div>
      )}

      {frames.length === 0 ? (
        <div className="empty-state">
          <Clapperboard size={22} />
          <strong>Chưa có frame nào</strong>
          <p>Bấm “AI lên timeline” để chia kịch bản nháp thành từng frame, hoặc thêm frame thủ công.</p>
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
              <Sparkles size={15} /> AI lên timeline
            </button>
            <button type="button" className="secondary-button" onClick={addFrame}>
              <Plus size={15} /> Thêm frame
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="board-strip" role="list" aria-label="Storyboard">
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
                    <span className="board-index">Frame {index + 1}</span>
                    <span className="board-time">
                      {formatClock(span.start)}–{formatClock(span.end)}
                    </span>
                    <span className="board-duration">{frame.durationSeconds}s</span>
                  </header>
                  {batchItem && batchItem.status !== 'done' && (
                    <span className={`board-item-status is-${batchItem.status}`}>
                      {batchItem.status === 'pending'
                        ? 'Đang chờ tới lượt'
                        : batchItem.status === 'running'
                          ? 'Đang tạo ảnh…'
                          : batchItem.status === 'error'
                            ? 'Lỗi ảnh'
                            : 'Đã dừng'}
                    </span>
                  )}

                  <div className="board-image">
                    {frame.background ? (
                      <button
                        type="button"
                        className="illustration-zoom"
                        title="Xem ảnh phóng to"
                        aria-label={`Xem ảnh phóng to của frame ${index + 1}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          setZoom({
                            url: uploadUrl(frame.background!.uploadId),
                            alt: `Ảnh storyboard frame ${index + 1}`,
                          })
                        }}
                      >
                        <img
                          src={uploadUrl(frame.background.uploadId)}
                          alt={`Ảnh storyboard frame ${index + 1}`}
                          loading="lazy"
                        />
                      </button>
                    ) : (
                      <div className="board-image-empty">
                        <ImagePlus size={20} />
                        <span>Chưa có ảnh storyboard</span>
                      </div>
                    )}
                    {frameBusy && <AsyncOverlay label="Đang tạo ảnh storyboard" />}
                  </div>

                  <div className="board-card-body">
                    <div className="board-card-title">
                      <strong>{frame.title || `Frame ${index + 1}`}</strong>
                      <span>{frame.blocking.length} người</span>
                    </div>
                    {frame.context && <p>{frame.context}</p>}
                    <div className="board-chips">
                      {frame.blocking.length === 0 && <span className="is-muted">Chưa xác định nhân vật</span>}
                      {frame.blocking.map((entry, entryIndex) => {
                        const name =
                          cast.find((member) => member.id === entry.castId)?.name ?? entry.castId
                        return (
                          <span key={`${entry.castId}-${entryIndex}`}>
                            <strong>{name}</strong>
                            {POSITION_LABEL.get(entry.position) ?? ''}
                            {entry.action ? ` · ${entry.action}` : ''}
                          </span>
                        )
                      })}
                    </div>
                    {frame.speaker && <span className="board-speaker">Người nói: {frame.speaker}</span>}
                  </div>

                  <div className="board-card-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={frameBusy || busy !== '' || !imageModelId}
                      title={imageModelId ? 'Tạo ảnh storyboard cho frame này' : 'Chọn model ảnh trước'}
                      onClick={(event) => {
                        event.stopPropagation()
                        void generateImage(frame)
                      }}
                    >
                      {frameBusy ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}
                      {frame.background ? 'Tạo lại ảnh' : 'Sinh ảnh'}
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
                        <Trash2 size={14} /> Xoá ảnh
                      </button>
                    )}
                  </div>
                </article>
              )
            })}
            <article className="board-card board-card-add">
              <button type="button" onClick={addFrame}>
                <Plus size={18} /> Thêm frame
              </button>
            </article>
          </div>

          <div className="board-legend">
            <span>
              <Wand2 size={13} /> Sửa nội dung ở khung dưới, hoặc bấm “AI sắp xếp frame” để AI chia
              lại ai đứng đâu, làm gì.
            </span>
            <button
              type="button"
              className="secondary-button"
              disabled={busy !== '' || !dirty}
              onClick={() => void run('save', async () => { await saveFrames() })}
            >
              <Save size={14} /> Lưu thay đổi
            </button>
          </div>

          {selected && (
            <section className="board-editor" aria-label={`Sửa ${selected.title || 'frame'}`}>
              <header className="board-editor-head">
                <div>
                  <div className="eyebrow"><span className="eyebrow-dot" /> Frame đang chọn</div>
                  <h2>{selected.title || 'Frame chưa đặt tên'}</h2>
                </div>
                <div className="board-editor-nav">
                  <button
                    type="button"
                    className="secondary-button"
                    aria-label="Chuyển frame sang trái"
                    onClick={() => moveFrame(selected.id, -1)}
                  >
                    <ChevronLeft size={15} /> Sang trái
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    aria-label="Chuyển frame sang phải"
                    onClick={() => moveFrame(selected.id, 1)}
                  >
                    Sang phải <ChevronRight size={15} />
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy !== ''}
                    onClick={() => void arrangeFrame(selected)}
                  >
                    <ActionLabel
                      busy={busy === 'arrange'}
                      idle="AI sắp xếp frame"
                      working="AI đang sắp xếp…"
                    />
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => duplicateFrame(selected.id)}
                  >
                    Nhân bản
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      removeFrame(selected.id)
                      onNotify('Đã xoá frame khỏi timeline. Bấm “Lưu thay đổi” để ghi lại.')
                    }}
                  >
                    <Trash2 size={14} /> Xoá frame
                  </button>
                </div>
              </header>

              <div className="board-editor-grid">
                <label className="plan-cell">
                  <span>Tiêu đề frame</span>
                  <input
                    value={selected.title}
                    aria-label="Tiêu đề frame đang chọn"
                    onChange={(event) => patchFrame(selected.id, { title: event.target.value })}
                  />
                </label>
                <label className="plan-cell">
                  <span>Thời lượng (giây)</span>
                  <input
                    type="number"
                    min={1}
                    max={600}
                    value={selected.durationSeconds}
                    aria-label="Thời lượng frame đang chọn"
                    onChange={(event) =>
                      patchFrame(selected.id, { durationSeconds: Number(event.target.value) || 1 })
                    }
                  />
                </label>
                <label className="plan-cell">
                  <span>Người nói</span>
                  <select
                    value={selected.speaker}
                    aria-label="Người nói của frame"
                    onChange={(event) => patchFrame(selected.id, { speaker: event.target.value })}
                  >
                    <option value="">Không có lời thoại</option>
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
                  <span>Góc máy / ghi chú hình</span>
                  <input
                    value={selected.shotNotes}
                    aria-label="Góc máy của frame đang chọn"
                    onChange={(event) => patchFrame(selected.id, { shotNotes: event.target.value })}
                  />
                </label>
                <label className="plan-cell board-editor-wide">
                  <span>Bối cảnh (dùng cho ảnh storyboard)</span>
                  <textarea
                    rows={2}
                    value={selected.context}
                    aria-label="Bối cảnh frame đang chọn"
                    onChange={(event) =>
                      patchFrame(selected.id, {
                        context: event.target.value,
                        backgroundPrompt: event.target.value,
                      })
                    }
                  />
                </label>
                <label className="plan-cell board-editor-wide">
                  <span>Hành động chung của frame</span>
                  <textarea
                    rows={2}
                    value={selected.action}
                    aria-label="Hành động frame đang chọn"
                    onChange={(event) => patchFrame(selected.id, { action: event.target.value })}
                  />
                </label>
                <label className="plan-cell board-editor-wide">
                  <span>Lời thoại</span>
                  <textarea
                    rows={2}
                    value={selected.dialogue}
                    aria-label="Lời thoại frame đang chọn"
                    onChange={(event) => patchFrame(selected.id, { dialogue: event.target.value })}
                  />
                </label>
              </div>

              <div className="board-people">
                <div className="board-people-head">
                  <strong>Nhân vật trong frame ({selected.blocking.length})</strong>
                  <button type="button" className="secondary-button" onClick={() => addBlocking(selected.id)}>
                    <Plus size={14} /> Thêm nhân vật
                  </button>
                </div>
                {selected.blocking.length === 0 && (
                  <p className="board-people-empty">
                    Frame chưa có nhân vật. Thêm nhân vật hoặc bấm “AI sắp xếp frame”.
                  </p>
                )}
                {selected.blocking.map((entry, index) => (
                  <div className="board-person" key={`${entry.castId}-${index}`}>
                    <label className="plan-cell">
                      <span>Nhân vật</span>
                      <select
                        value={entry.castId}
                        aria-label={`Nhân vật ${index + 1} của frame`}
                        onChange={(event) => updateBlocking(selected.id, index, { castId: event.target.value })}
                      >
                        <option value="">— chọn nhân vật —</option>
                        {cast.map((member) => (
                          <option key={member.id} value={member.id}>
                            {member.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="plan-cell">
                      <span>Hành động riêng trong frame</span>
                      <input
                        value={entry.action}
                        placeholder="Ví dụ: mở cửa bước vào"
                        aria-label={`Hành động của nhân vật ${index + 1}`}
                        onChange={(event) => updateBlocking(selected.id, index, { action: event.target.value })}
                      />
                    </label>
                    <label className="plan-cell">
                      <span>Vị trí trong khung</span>
                      <select
                        value={entry.position}
                        aria-label={`Vị trí của nhân vật ${index + 1}`}
                        onChange={(event) =>
                          updateBlocking(selected.id, index, {
                            position: event.target.value as FramePosition,
                          })
                        }
                      >
                        {POSITIONS.map((position) => (
                          <option key={position.value} value={position.value}>
                            {position.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      className="secondary-button"
                      aria-label={`Xoá nhân vật ${index + 1} khỏi frame`}
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
        <TimelineOverlay title="Chat với AI về Timeline" drawer onClose={() => setChatOpen(false)}>
          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="board-chat-log" ref={chatLogRef} aria-live="polite">
            {messages.length === 0 ? (
              <p className="board-chat-empty">
                Nhắn cho AI để đổi timeline, ví dụ “tách frame 2 thành hai frame” hoặc “thêm nhân vật
                Chi vào frame 3”.
              </p>
            ) : (
              messages.map((message) => (
                <div key={message.id} className={`planner-bubble ${message.role === 'user' ? 'is-user' : 'is-assistant'}`}>
                  <div className="planner-bubble-role">{message.role === 'user' ? 'Bạn' : 'Kịch bản AI'}</div>
                  <div className="planner-bubble-body">{message.content}</div>
                </div>
              ))
            )}
          </div>
          {busy === 'chat' && <div className="timeline-thinking"><LoaderCircle size={14} className="spin" /> AI đang soạn…</div>}
          <div className="planner-composer">
            <textarea
              ref={chatInputRef}
              value={chatDraft}
              disabled={busy !== ''}
              maxLength={8000}
              aria-label="Nội dung tin nhắn timeline"
              placeholder="Nhắn cho AI về timeline… (Enter để gửi, Shift+Enter để xuống dòng)"
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
              {busy === 'chat' ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />} Gửi
            </button>
          </div>
        </TimelineOverlay>
      )}

      {projectOpen && <TimelineOverlay title="Chốt & tạo dự án" locked={busy === 'apply'} onClose={() => setProjectOpen(false)}>
              <div className="timeline-project-form">
                <label className="plan-cell">
                  <span>Tên dự án mới</span>
                  <input
                    value={projectName}
                    onChange={(event) => setProjectName(event.target.value)}
                    placeholder="Tên dự án Studio"
                  />
                </label>
                <label className="plan-cell">
                  <span>Model video</span>
                  <select value={videoModelId} onChange={(event) => setVideoModelId(event.target.value)}>
                    <option value="">Chọn sau trong Studio</option>
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
                  Tự động xếp hàng tạo video cho mọi cảnh sau khi duyệt
                </label>
                <button
                  type="button"
                  className="primary-small-button"
                  disabled={busy !== '' || !frames.length || (autoGenerate && !videoModelId)}
                  onClick={() => void applyToStudio()}
                >
                  <ActionLabel
                    busy={busy === 'apply'}
                    idle="Xác nhận tạo dự án"
                    working="Đang tạo dự án…"
                  />
                  <ArrowUpRight size={15} />
                </button>
                <p className="timeline-project-note">Cảnh mới vẫn chưa duyệt. Chỉ sau khi duyệt trong Studio, hệ thống mới xếp hàng tạo video; tác vụ video dùng API key của bạn và có thể tính phí.</p>
                {autoGenerate && !videoModelId && <p className="form-error">Chọn model video để bật xếp hàng tự động.</p>}
                {error && <div className="form-error" role="alert">{error}</div>}
                <button type="button" className="secondary-button" disabled={busy === 'apply'} onClick={() => setProjectOpen(false)}>Huỷ</button>
              </div>
      </TimelineOverlay>}

      <div className="board-hint">
        <Sparkles size={13} /> Ảnh storyboard dùng API key của bạn và tốn phí: mỗi lần bấm chỉ tạo ảnh
        cho đúng một frame nên bạn kiểm soát được chi phí. Nhân vật có ảnh chân dung sẽ được gửi kèm
        làm ảnh tham chiếu.
      </div>

      {zoom && (
        <ImageLightbox
          src={zoom.url}
          alt={zoom.alt}
          downloadHref={zoom.url}
          onClose={() => setZoom(null)}
        />
      )}


    </div>
  )
}

function GalleryIcon() {
  return <ArrowRight size={22} />
}
