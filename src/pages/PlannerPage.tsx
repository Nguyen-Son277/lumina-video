import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  GalleryHorizontalEnd,
  Layers,
  LoaderCircle,
  Menu,
  Plus,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react'
import { errorMessage } from '../api/client'
import { plannerApi, type PlanMessage, type PlanSession, type PlanTarget } from '../api/planner'
import type { ModelInfo } from '../api/types'
import { ArtifactDrawer } from '../components/planner/ArtifactDrawer'
import { PlanChat } from '../components/planner/PlanChat'

const STATUS_LABELS: Record<PlanSession['status'], string> = {
  setup: 'Chưa chọn model',
  scripting: 'Đang trao đổi',
  script_ready: 'Có kịch bản nháp',
  cast_ready: 'Có nhân vật',
  timeline_ready: 'Có timeline',
  applied: 'Đã tạo dự án',
}

/** Hai artifact còn mở trong drawer; Timeline đã thành trang riêng. */
type DrawerArtifact = Extract<PlanTarget, 'script' | 'cast'>

const ARTIFACTS: Array<{ key: DrawerArtifact; label: string }> = [
  { key: 'script', label: 'Kịch bản nháp' },
  { key: 'cast', label: 'Nhân vật' },
]

/** Khoá localStorage cho panel artifact đang mở. */
const PANEL_KEY = 'lumina.planner-panel'

function readPanel(): DrawerArtifact | null {
  try {
    const value = localStorage.getItem(PANEL_KEY)
    // 'timeline' là giá trị cũ của drawer; nay Timeline là trang riêng nên bỏ qua.
    return value === 'script' || value === 'cast' ? value : null
  } catch {
    return null
  }
}

/**
 * Trang Tạo kịch bản AI.
 *
 * Chat là bề mặt mặc định và lớn nhất: chọn model ở icon cấu hình, nhắn trực tiếp
 * cho AI, và mở drawer kịch bản nháp / nhân vật / timeline khi cần xem hoặc sửa tay.
 */
export function PlannerPage({
  llmModels,
  models,
  onNotify,
  onOpenSettings,
  onOpenProject,
  onProjectsChanged,
  onOpenTimeline,
}: {
  /** Model văn bản (kind = 'llm') đang bật, dùng để chat và sinh kịch bản. */
  llmModels: ModelInfo[]
  models: ModelInfo[]
  onNotify: (message: string) => void
  onOpenSettings: () => void
  onOpenProject: () => void
  onProjectsChanged: () => void | Promise<void>
  /** Mở trang Timeline (storyboard ngang) cho phiên đang làm. */
  onOpenTimeline: (sessionId: string) => void
}) {
  const [sessions, setSessions] = useState<PlanSession[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [session, setSession] = useState<PlanSession | null>(null)
  const [messages, setMessages] = useState<PlanMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [active, setActive] = useState<PlanTarget>('script')
  const [panel, setPanel] = useState<DrawerArtifact | null>(() => readPanel())
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)
  const selectedIdRef = useRef('')

  const imageModels = models.filter((model) => model.kind === 'image' && model.enabled)
  const videoModels = models.filter((model) => model.kind === 'video' && model.enabled)
  const ready = Boolean(session?.chatModelId)

  useEffect(() => {
    try {
      localStorage.setItem(PANEL_KEY, panel ?? 'closed')
    } catch {
      // Không lưu được cũng không ảnh hưởng chức năng.
    }
  }, [panel])

  const loadSessions = useCallback(async () => {
    const result = await plannerApi.list()
    setSessions(result.sessions)
    return result.sessions
  }, [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    loadSessions()
      .then((list) => {
        if (alive) setSelectedId((current) => current || list[0]?.id || '')
      })
      .catch((cause) => {
        if (alive) setError(errorMessage(cause))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [loadSessions])

  useEffect(() => {
    selectedIdRef.current = selectedId
    if (!selectedId) {
      setSession(null)
      setMessages([])
      return
    }
    let alive = true
    setError('')
    plannerApi
      .get(selectedId)
      .then((result) => {
        if (!alive) return
        setSession(result.session)
        setMessages(result.messages)
      })
      .catch((cause) => {
        if (alive) setError(errorMessage(cause))
      })
    return () => {
      alive = false
    }
  }, [selectedId])

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

  async function createSession(): Promise<void> {
    await run('create', async () => {
      const preferred = llmModels[0]
      const created = await plannerApi.create({
        kind: 'planner',
        ...(preferred ? { chatModelId: preferred.id } : {}),
      })
      await loadSessions()
      setSelectedId(created.session.id)
      setSession(created.session)
      setMessages([])
      setSessionsOpen(false)
      setActive('script')
      onNotify('Đã tạo phiên kịch bản mới.')
    })
  }

  async function removeSession(id: string): Promise<void> {
    await run('remove', async () => {
      await plannerApi.remove(id)
      const list = await loadSessions()
      if (selectedId === id) setSelectedId(list[0]?.id ?? '')
      onNotify('Đã xoá phiên kịch bản.')
    })
  }

  /** Chat trong mục đang chọn: AI trả lời, cập nhật artifact và có thể tự chạy một bước. */
  async function chat(content: string): Promise<void> {
    if (!session) return
    const targetId = session.id
    const target = active
    setBusy(`chat:${target}`)
    setError('')
    try {
      const result = await plannerApi.sendMessage(targetId, content, target)
      // Người dùng đã đổi phiên trong lúc chờ: bỏ qua kết quả của phiên cũ.
      if (selectedIdRef.current !== targetId) return
      setSession(result.session)
      setMessages(result.messages)
      await loadSessions()
      if (result.ran) {
        if (result.ran === 'timeline') {
          // Timeline là trang riêng: mở luôn storyboard ngang cho người dùng xem.
          onNotify('AI đã tự lên timeline. Đang mở trang Timeline.')
          onOpenTimeline(targetId)
        } else {
          const label = ARTIFACTS.find((item) => item.key === result.ran)?.label ?? result.ran
          setPanel(result.ran)
          setActive(result.ran)
          onNotify(`AI đã tự chạy bước: ${label}.`)
        }
      }
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy('')
    }
  }

  /** Chip hành động nhanh: gọi thẳng bước tương ứng. */
  async function quickAction(target: PlanTarget): Promise<void> {
    if (!session) return
    const targetId = session.id
    setBusy(`quick:${target}`)
    setError('')
    try {
      const result =
        target === 'script'
          ? await plannerApi.rewriteScript(targetId)
          : target === 'cast'
            ? await plannerApi.generateCast(targetId)
            : await plannerApi.generateTimeline(targetId)
      if (selectedIdRef.current !== targetId) return
      setSession(result.session)
      await loadSessions()
      if (target === 'timeline') {
        onNotify('AI đã xong: Timeline.')
        onOpenTimeline(targetId)
        return
      }
      setActive(target)
      setPanel(target)
      const label = ARTIFACTS.find((item) => item.key === target)?.label ?? target
      onNotify(`AI đã xong: ${label}.`)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy('')
    }
  }

  /** Chọn model ở icon cấu hình; lưu ngay khi đổi. */
  async function saveSetup(patch: {
    chatModelId?: string | null
    imageModelId?: string | null
    videoModelId?: string | null
  }): Promise<void> {
    if (!session) return
    await run('setup', async () => {
      const result = await plannerApi.setup(session.id, patch)
      setSession(result.session)
      await loadSessions()
    })
  }

  function togglePanel(target: DrawerArtifact): void {
    setActive(target)
    setPanel((current) => (current === target ? null : target))
  }

  if (loading && !sessions.length) {
    return (
      <div className="page-content">
        <div className="empty-state">
          <LoaderCircle size={22} className="spin" /> Đang tải phiên kịch bản…
        </div>
      </div>
    )
  }

  return (
    <div className="page-content planner-page">
      <div className="page-heading">
        <h1>Tạo kịch bản AI</h1>
        <p>
          Chọn model, nhắn trực tiếp cho AI để viết kịch bản nháp, chốt nhân vật và lên timeline
          từng frame. Mở panel bên phải khi muốn xem hoặc sửa tay.
        </p>
        <div className="heading-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busy !== ''}
            onClick={() => void createSession()}
          >
            {busy === 'create' ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />} Phiên mới
          </button>
        </div>
      </div>

      {error && <div className="form-error" role="alert">{error}</div>}

      {!session ? (
        <div className="empty-state">
          <strong>Chưa có phiên kịch bản</strong>
          <p>Bấm “Phiên mới” để bắt đầu một kịch bản mới.</p>
          <button type="button" className="primary-small-button" onClick={() => void createSession()}>
            <Plus size={15} /> Phiên mới
          </button>
        </div>
      ) : (
        <>
          <div className="planner-bar">
            <div className="planner-bar-group">
              <button
                type="button"
                className={`planner-bar-button ${sessionsOpen ? 'is-open' : ''}`}
                aria-expanded={sessionsOpen}
                disabled={busy !== ''}
                title="Danh sách phiên"
                aria-label="Danh sách phiên"
                onClick={() => {
                  setSessionsOpen((open) => !open)
                  setSetupOpen(false)
                }}
              >
                <Menu size={16} />
                <span>Phiên</span>
                <em>{sessions.length}</em>
              </button>
              <button
                type="button"
                className={`planner-bar-button ${setupOpen ? 'is-open' : ''}`}
                aria-expanded={setupOpen}
                title="Cấu hình model"
                onClick={() => {
                  setSetupOpen((open) => !open)
                  setSessionsOpen(false)
                }}
              >
                <SlidersHorizontal size={16} />
                <span>Cấu hình model</span>
                <em className={ready ? 'is-ok' : 'is-warn'}>{ready ? '✓' : '!'}</em>
              </button>
            </div>

            <div className="planner-bar-group">
              {ARTIFACTS.map((item) => {
                const hasData = item.key === 'script' ? Boolean(session.script) : session.cast.length > 0
                return (
                  <button
                    key={item.key}
                    type="button"
                    className={`planner-bar-button ${panel === item.key ? 'is-open' : ''} ${active === item.key ? 'is-active' : ''}`}
                    aria-pressed={panel === item.key}
                    title={`${panel === item.key ? 'Đóng' : 'Mở'} ${item.label}`}
                    onClick={() => togglePanel(item.key)}
                  >
                    <Layers size={16} />
                    <span>{item.label}</span>
                    {hasData && <em className="is-ok">•</em>}
                  </button>
                )
              })}
              <button
                type="button"
                className="planner-bar-button"
                title="Mở trang Timeline (storyboard ngang)"
                onClick={() => onOpenTimeline(session.id)}
              >
                <GalleryHorizontalEnd size={16} />
                <span>Timeline</span>
                {Boolean(session.timeline?.frames.length) && <em className="is-ok">•</em>}
              </button>
            </div>

            {sessionsOpen && (
              <div className="planner-popover planner-popover-sessions" role="dialog" aria-label="Danh sách phiên">
                <div className="planner-popover-head">
                  <strong>Phiên kịch bản</strong>
                  <button type="button" className="row-more" onClick={() => setSessionsOpen(false)} aria-label="Đóng danh sách phiên">
                    <ChevronDown size={15} />
                  </button>
                </div>
                <div className="planner-popover-list">
                  {sessions.map((item) => (
                    <div key={item.id} className={`planner-session ${item.id === selectedId ? 'active' : ''}`}>
                      <button
                        type="button"
                        className="planner-session-main"
                        disabled={busy !== ''}
                        onClick={() => {
                          setSelectedId(item.id)
                          setSessionsOpen(false)
                        }}
                      >
                        <strong>{item.title || 'Chưa đặt tên'}</strong>
                        <span>{STATUS_LABELS[item.status]}</span>
                      </button>
                      <button
                        type="button"
                        className="row-more"
                        aria-label="Xoá phiên"
                        disabled={busy !== ''}
                        onClick={() => void removeSession(item.id)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy !== ''}
                  onClick={() => void createSession()}
                >
                  <Plus size={15} /> Phiên mới
                </button>
              </div>
            )}

            {setupOpen && (
              <div className="planner-popover planner-popover-setup" role="dialog" aria-label="Cấu hình model">
                <div className="planner-popover-head">
                  <strong>Model cho phiên này</strong>
                  <button type="button" className="row-more" onClick={() => setSetupOpen(false)} aria-label="Đóng cấu hình model">
                    <ChevronDown size={15} />
                  </button>
                </div>
                <label className="plan-setup-field">
                  <span>Model chat AI</span>
                  <select
                    value={session.chatModelId ?? ''}
                    disabled={busy !== ''}
                    onChange={(event) => void saveSetup({ chatModelId: event.target.value || null })}
                  >
                    <option value="">Chọn model LLM &amp; Chat</option>
                    {llmModels.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.displayName} · {model.providerName}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="plan-setup-field">
                  <span>Model AI hình ảnh</span>
                  <select
                    value={session.imageModelId ?? ''}
                    disabled={busy !== ''}
                    onChange={(event) => void saveSetup({ imageModelId: event.target.value || null })}
                  >
                    <option value="">Chọn model tạo ảnh</option>
                    {imageModels.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.displayName} · {model.providerName}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="plan-setup-field">
                  <span>Model video</span>
                  <select
                    value={session.videoModelId ?? ''}
                    disabled={busy !== ''}
                    onChange={(event) => void saveSetup({ videoModelId: event.target.value || null })}
                  >
                    <option value="">Chọn model tạo video</option>
                    {videoModels.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.displayName} · {model.providerName}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" className="secondary-button" onClick={onOpenSettings}>
                  Thêm model trong API &amp; Models
                </button>
              </div>
            )}
          </div>

          {!ready && (
            <div className="notice-banner">
              <SlidersHorizontal size={18} />
              <div>
                <strong>Chưa chọn model chat AI</strong>
                <p>
                  Bấm icon <em>Cấu hình model</em> để chọn một model <em>LLM &amp; Chat</em> đang bật;
                  chat chỉ hoạt động sau khi có model.
                </p>
              </div>
            </div>
          )}

          <PlanChat
            session={session}
            messages={messages}
            busy={busy}
            active={active}
            onSend={(content) => void chat(content)}
            onQuickAction={(target) => void quickAction(target)}
          />

          <ArtifactDrawer
            artifact={panel}
            session={session}
            busy={busy}
            error={error}
            onClose={() => setPanel(null)}
            onSession={setSession}
            onReload={loadSessions}
            onNotify={onNotify}
            onError={setError}
            onSwitch={(target) => {
              setActive(target)
              setPanel(target)
            }}
            onOpenTimeline={() => onOpenTimeline(session.id)}
          />
        </>
      )}
    </div>
  )
}
