import { useCallback, useEffect, useState } from 'react'
import { BrainCircuit, LoaderCircle, Plus, Trash2 } from 'lucide-react'
import { errorMessage } from '../api/client'
import { plannerApi, type PlanMessage, type PlanSession } from '../api/planner'
import type { LlmConnection, ModelInfo } from '../api/types'
import { PlannerChat } from '../components/planner/PlannerChat'
import { PlanReview } from '../components/planner/PlanReview'

const STATUS_LABELS: Record<PlanSession['status'], string> = {
  chatting: 'Đang trao đổi',
  ideas_ready: 'Có ý kiến chờ duyệt',
  ideas_approved: 'Đã duyệt ý kiến',
  plan_ready: 'Có kịch bản',
  applied: 'Đã tạo dự án',
}

/**
 * Trang Trợ lý AI.
 *
 * Người dùng chat để chốt ý tưởng, duyệt đề xuất ý kiến, rồi cho AI viết kịch bản
 * + nhân vật + timeline. Bước cuối tạo dự án trong Studio với cảnh ở trạng thái
 * chưa duyệt, nên chưa phát sinh chi phí cho tới khi người dùng duyệt từng cảnh.
 */
export function PlannerPage({
  llmConnections,
  models,
  onNotify,
  onOpenSettings,
  onOpenProject,
  onProjectsChanged,
}: {
  llmConnections: LlmConnection[]
  models: ModelInfo[]
  onNotify: (message: string) => void
  onOpenSettings: () => void
  onOpenProject: () => void
  onProjectsChanged: () => void | Promise<void>
}) {
  const [sessions, setSessions] = useState<PlanSession[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [session, setSession] = useState<PlanSession | null>(null)
  const [messages, setMessages] = useState<PlanMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  // Model mặc định là model video đầu tiên đang bật.
  const [applyModelId, setApplyModelId] = useState('')
  const [autoGenerate, setAutoGenerate] = useState(true)

  const videoModels = models.filter((model) => model.kind === 'video' && model.enabled)
  const hasConnection = llmConnections.length > 0

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

  /** Bọc thao tác có trạng thái đang chạy và thông báo lỗi thống nhất. */
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

  async function createSession() {
    await run('create', async () => {
      const preferred = llmConnections.find((item) => item.status === 'connected') ?? llmConnections[0]
      const created = await plannerApi.create({
        kind: 'planner',
        ...(preferred ? { connectionId: preferred.id } : {}),
      })
      await loadSessions()
      setSelectedId(created.session.id)
      setSession(created.session)
      setMessages([])
      onNotify('Đã tạo phiên trò chuyện mới.')
    })
  }

  async function removeSession(id: string) {
    await run('remove', async () => {
      await plannerApi.remove(id)
      const list = await loadSessions()
      if (selectedId === id) setSelectedId(list[0]?.id ?? '')
      onNotify('Đã xoá phiên trò chuyện.')
    })
  }

  async function sendMessage(content: string) {
    if (!session) return
    // Hiện tin nhắn của người dùng ngay để chat không bị khựng.
    setMessages((current) => [
      ...current,
      { id: `local-${Date.now()}`, role: 'user', content, createdAt: Date.now() },
    ])
    await run('send', async () => {
      const result = await plannerApi.sendMessage(session.id, content)
      setSession(result.session)
      setMessages(result.messages)
      await loadSessions()
    })
  }

  async function generateIdeas() {
    if (!session) return
    await run('ideas', async () => {
      const result = await plannerApi.ideas(session.id)
      setSession(result.session)
      await loadSessions()
      onNotify('AI đã tổng hợp đề xuất ý kiến.')
    })
  }

  async function approveIdeas() {
    if (!session) return
    await run('approve', async () => {
      const result = await plannerApi.approveIdeas(session.id)
      setSession(result.session)
      onNotify('Đã duyệt ý kiến. Giờ có thể lên kịch bản.')
    })
  }

  async function generatePlan() {
    if (!session) return
    await run('plan', async () => {
      const result = await plannerApi.plan(session.id)
      setSession(result.session)
      await loadSessions()
      onNotify(`AI đã tạo kịch bản ${result.plan.scenes.length} cảnh.`)
    })
  }

  async function apply() {
    if (!session) return
    await run('apply', async () => {
      const result = await plannerApi.apply(session.id, {
        ...(applyModelId ? { modelId: applyModelId } : {}),
        autoGenerate,
      })

      setSession((current) => (current ? { ...current, status: 'applied', projectId: result.project.id } : current))
      await loadSessions()
      await onProjectsChanged()

      if (result.alreadyApplied) {
        onNotify(`Dự án "${result.project.name}" đã được tạo trước đó.`)
      } else {
        onNotify(
          autoGenerate
            ? `Đã tạo dự án "${result.project.name}" với ${result.scenes.length} cảnh. Cảnh sẽ được tạo sau khi bạn duyệt trong Studio.`
            : `Đã tạo dự án "${result.project.name}" với ${result.scenes.length} cảnh.`,
        )
      }
    })
  }

  const hasUserMessage = messages.some((message) => message.role === 'user')

  if (!hasConnection) {
    return (
      <div className="page-content">
        <div className="page-heading">
          <h1>Trợ lý AI</h1>
          <p>Chat với AI để lên kịch bản và timeline cho video hoàn chỉnh.</p>
        </div>
        <div className="character-ai-empty">
          <BrainCircuit size={22} />
          <strong>Chưa có kết nối LLM</strong>
          <span>
            Cần một kết nối LLM (Base URL + API key) để trò chuyện và tạo kịch bản. Thêm trong
            API &amp; Models trước.
          </span>
          <button className="primary-small-button" onClick={onOpenSettings}>
            Mở API &amp; Models
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="page-content">
      <div className="page-heading">
        <h1>Trợ lý AI</h1>
        <p>Chat để chốt ý tưởng, duyệt đề xuất, rồi để AI viết kịch bản và timeline.</p>
        <div className="heading-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busy !== ''}
            onClick={() => void createSession()}
          >
            {busy === 'create' ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}
            Phiên mới
          </button>
        </div>
      </div>

      {error && <div className="form-error" role="alert">{error}</div>}

      <div className="planner-layout">
        <aside className="planner-sessions">
          {loading ? (
            <p className="planner-hint">Đang tải…</p>
          ) : sessions.length === 0 ? (
            <p className="planner-hint">Chưa có phiên nào. Bấm “Phiên mới” để bắt đầu.</p>
          ) : (
            sessions.map((item) => (
              <div
                key={item.id}
                className={`planner-session ${item.id === selectedId ? 'active' : ''}`}
              >
                <button
                  type="button"
                  className="planner-session-main"
                  onClick={() => setSelectedId(item.id)}
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
            ))
          )}
        </aside>

        <section className="planner-body">
          {!session ? (
            <div className="empty-state">Chọn hoặc tạo một phiên trò chuyện để bắt đầu.</div>
          ) : (
            <>
              <PlannerChat
                messages={messages}
                busy={busy === 'send'}
                onSend={(content) => void sendMessage(content)}
              />
              <PlanReview
                session={session}
                videoModels={videoModels}
                busy={busy}
                applyModelId={applyModelId}
                autoGenerate={autoGenerate}
                onApplyModelChange={setApplyModelId}
                onAutoGenerateChange={setAutoGenerate}
                onGenerateIdeas={() => void generateIdeas()}
                onApproveIdeas={() => void approveIdeas()}
                onGeneratePlan={() => void generatePlan()}
                onApply={() => (session.status === 'applied' ? onOpenProject() : void apply())}
                canApply={hasUserMessage}
              />
            </>
          )}
        </section>
      </div>
    </div>
  )
}
