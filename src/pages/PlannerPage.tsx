import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  FileText,
  GalleryHorizontalEnd,
  Layers,
  LoaderCircle,
  Menu,
  Plus,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react'
import {
  plannerApi,
  type PlanMessage,
  type PlanSession,
  type PlanSurface,
  type PlanTarget,
  type ProposalChange,
} from '../api/planner'
import type { ModelInfo } from '../api/types'
import { ArtifactDrawer } from '../components/planner/ArtifactDrawer'
import { plannerErrorText } from '../components/planner/ArtifactPanels'
import { PlanChat } from '../components/planner/PlanChat'
import { SurfaceChatDrawer } from '../components/planner/SurfaceChatDrawer'
import { LocationReferences } from '../components/LocationReferences'
import { locationPanelApi, planLocationsApi } from '../api/locations'
import { locationsCatalog } from '../i18n/catalogs/locations'
import { plannerCatalog } from '../i18n/catalogs/planner'
import { notification, type Notification } from '../i18n/messages'
import { useTranslation } from '../i18n/useTranslation'

/** Khoá dịch cho từng trạng thái phiên; dịch tại chỗ render để đổi ngôn ngữ là đổi ngay. */
const STATUS_KEYS = {
  setup: 'statusSetup',
  scripting: 'statusScripting',
  script_ready: 'statusScriptReady',
  cast_ready: 'statusCastReady',
  timeline_ready: 'statusTimelineReady',
  applied: 'statusApplied',
} as const satisfies Record<PlanSession['status'], string>

/** Hai artifact còn mở trong drawer; Timeline đã thành trang riêng. */
type DrawerArtifact = Extract<PlanTarget, 'script' | 'cast'>

const ARTIFACT_ENTRIES = [
  { key: 'script', labelKey: 'targetScript' },
  { key: 'cast', labelKey: 'targetCast' },
] as const satisfies ReadonlyArray<{ key: DrawerArtifact; labelKey: string }>

/** Khoá localStorage cho panel artifact đang mở. */
const PANEL_KEY = 'lumina.planner-panel'

function readPanel(): DrawerArtifact | null {
  try {
    const value = localStorage.getItem(PANEL_KEY)
    // 'timeline' là giá trị cũ của drawer; nay Timeline là trang riêng nên bỏ qua.
    return value === 'script' ? value : null
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
  sessionId = '',
  onSelectSession,
  onOpenCharacters,
  llmModels,
  models,
  onNotify,
  onOpenSettings,
  onOpenProject,
  onProjectsChanged,
  onOpenTimeline,
}: {
  sessionId?: string
  onSelectSession?: (id: string) => void
  onOpenCharacters: (id: string) => void
  /** Model văn bản (kind = 'llm') đang bật, dùng để chat và sinh kịch bản. */
  llmModels: ModelInfo[]
  models: ModelInfo[]
  onNotify: (message: Notification) => void
  onOpenSettings: () => void
  onOpenProject: () => void
  onProjectsChanged: () => void | Promise<void>
  /** Mở trang Timeline (storyboard ngang) cho phiên đang làm. */
  onOpenTimeline: (sessionId: string) => void
}) {
  const [sessions, setSessions] = useState<PlanSession[]>([])
  const [selectedId, setSelectedId] = useState(sessionId)
  const [session, setSession] = useState<PlanSession | null>(null)
  const [messages, setMessages] = useState<PlanMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  /**
   * Lỗi đang giữ ở dạng thô (Error/ApiError của API hoặc descriptor khoá dịch),
   * KHÔNG phải câu đã dịch: đổi ngôn ngữ là `plannerErrorText` dịch lại khi render.
   */
  const [error, setError] = useState<unknown>(null)
  const [active, setActive] = useState<PlanTarget>('script')
  const [panel, setPanel] = useState<DrawerArtifact | null>(() => readPanel())
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)
  const [locationsOpen, setLocationsOpen] = useState(false)
  /** Cửa sổ chat sửa timeline/bối cảnh (mở từ nút trong khu bối cảnh). */
  const [surfaceChat, setSurfaceChat] = useState<PlanSurface | null>(null)
  const [surfaceDraft, setSurfaceDraft] = useState('')
  const [surfaceBusy, setSurfaceBusy] = useState(false)
  const [surfaceApplying, setSurfaceApplying] = useState(false)
  const [pendingProposal, setPendingProposal] = useState<{
    surface: PlanSurface
    summary: string
    changes: ProposalChange[]
    payload: { locations?: unknown; frames?: unknown }
    baseStamp: string
  } | null>(null)
  const { t: tLocations } = useTranslation(locationsCatalog)
  const selectedIdRef = useRef('')
  const { t } = useTranslation(plannerCatalog)
  /** Câu lỗi hiển thị theo ngôn ngữ hiện tại; nội dung thô từ API/provider giữ nguyên. */
  const errorText = plannerErrorText(error, t)

  useEffect(() => { if (sessionId) setSelectedId(sessionId) }, [sessionId])
  useEffect(() => { if (selectedId && selectedId !== sessionId) onSelectSession?.(selectedId) }, [selectedId, sessionId, onSelectSession])

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
        if (alive) setError(cause)
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
    setError(null)
    plannerApi
      .get(selectedId)
      .then((result) => {
        if (!alive) return
        setSession(result.session)
        setMessages(result.messages)
      })
      .catch((cause) => {
        if (alive) setError(cause)
      })
    return () => {
      alive = false
    }
  }, [selectedId])

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

  /**
   * Tạo phiên mới KHÔNG tự gán model chat.
   *
   * Người dùng phải chủ động chọn cấu hình model trước khi nhắn, nên cổng cấu hình
   * được mở sẵn ngay sau khi tạo phiên.
   */
  async function createSession(): Promise<void> {
    await run('create', async () => {
      const created = await plannerApi.create({ kind: 'planner' })
      await loadSessions()
      setSelectedId(created.session.id)
      setSession(created.session)
      setMessages([])
      setSessionsOpen(false)
      setSetupOpen(true)
      setActive('script')
      onNotify(notification('planner', 'sessionCreated'))
    })
  }

  async function removeSession(id: string): Promise<void> {
    await run('remove', async () => {
      await plannerApi.remove(id)
      const list = await loadSessions()
      if (selectedId === id) setSelectedId(list[0]?.id ?? '')
      onNotify(notification('planner', 'sessionDeleted'))
    })
  }

  /** Chat trong mục đang chọn: AI trả lời, cập nhật artifact và có thể tự chạy một bước. */
  async function chat(content: string): Promise<void> {
    if (!session) return
    const targetId = session.id
    const target = active
    setBusy(`chat:${target}`)
    setError(null)
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
          onNotify(notification('planner', 'aiRanTimelineOpening'))
          onOpenTimeline(targetId)
        } else if (result.ran === 'cast') {
          onOpenCharacters(targetId)
        } else {
          const entry = ARTIFACT_ENTRIES.find((item) => item.key === result.ran)
          const label = entry ? t(entry.labelKey) : result.ran
          setPanel(result.ran)
          setActive(result.ran)
          onNotify(notification('planner', 'aiRanStep', { step: label }))
        }
      }
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy('')
    }
  }

  /** Chip hành động nhanh: gọi thẳng bước tương ứng. */
  async function quickAction(target: PlanTarget): Promise<void> {
    if (!session) return
    const targetId = session.id
    setBusy(`quick:${target}`)
    setError(null)
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
        onNotify(notification('planner', 'aiFinishedTimeline'))
        onOpenTimeline(targetId)
        return
      }
      if (target === 'cast') { onOpenCharacters(targetId); return }
      setActive(target)
      setPanel(target)
      const entry = ARTIFACT_ENTRIES.find((item) => item.key === target)
      const label = entry ? t(entry.labelKey) : target
      onNotify(notification('planner', 'aiFinishedStep', { step: label }))
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy('')
    }
  }

  /**
   * Nhắn trong chat bề mặt (timeline / bối cảnh).
   *
   * Server CHỈ đề xuất; kết quả được giữ ở `pendingProposal` để người dùng xem
   * danh sách thay đổi rồi mới xác nhận áp dụng.
   */
  async function sendSurfaceChat(): Promise<void> {
    if (!session || !surfaceChat || surfaceBusy) return
    const content = surfaceDraft.trim()
    if (!content) return
    const targetId = session.id
    const surface = surfaceChat
    setSurfaceBusy(true)
    setError(null)
    try {
      const result = await plannerApi.proposeChange(targetId, surface, content)
      if (selectedIdRef.current !== targetId) return
      setSession(result.session)
      setMessages(result.messages)
      setSurfaceDraft('')
      setPendingProposal({
        surface,
        summary: result.summary,
        changes: result.changes,
        payload: result.proposal.payload,
        baseStamp: result.proposal.baseStamp,
      })
    } catch (cause) {
      setError(cause)
    } finally {
      setSurfaceBusy(false)
    }
  }

  /** Chỉ ghi khi người dùng đã xác nhận đề xuất đang chờ. */
  async function applySurfaceProposal(): Promise<void> {
    if (!session || !pendingProposal || surfaceApplying) return
    const targetId = session.id
    const pending = pendingProposal
    setSurfaceApplying(true)
    setError(null)
    try {
      const result = await plannerApi.applyProposal(targetId, {
        surface: pending.surface,
        baseStamp: pending.baseStamp,
        ...(pending.surface === 'locations'
          ? { locations: pending.payload.locations as never }
          : { frames: pending.payload.frames as never }),
      })
      if (selectedIdRef.current !== targetId) return
      setSession(result.session)
      setPendingProposal(null)
      onNotify(notification('planner', 'proposalApplied'))
    } catch (cause) {
      setError(cause)
    } finally {
      setSurfaceApplying(false)
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
    if (target === 'cast') { onOpenCharacters(selectedId); return }
    setActive(target)
    setPanel((current) => (current === target ? null : target))
  }

  if (loading && !sessions.length) {
    return (
      <div className="page-content">
        <div className="empty-state">
          <LoaderCircle size={22} className="spin" /> {t('loadingSessions')}
        </div>
      </div>
    )
  }

  return (
    <div className="page-content planner-page">
      <div className="page-heading">
        <h1>{t('plannerPageTitle')}</h1>
        <p>{t('plannerPageIntro')}</p>
        <div className="heading-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busy !== ''}
            onClick={() => void createSession()}
          >
            {busy === 'create' ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />} {t('newSession')}
          </button>
        </div>
      </div>

      {errorText && <div className="form-error" role="alert">{errorText}</div>}

      {!session ? (
        <div className="empty-state">
          <strong>{t('noSessionsTitle')}</strong>
          <p>{t('noSessionsBody')}</p>
          <button type="button" className="primary-small-button" onClick={() => void createSession()}>
            <Plus size={15} /> {t('newSession')}
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
                title={t('sessionListTitle')}
                aria-label={t('sessionListTitle')}
                onClick={() => {
                  setSessionsOpen((open) => !open)
                  setSetupOpen(false)
                }}
              >
                <Menu size={16} />
                <span>{t('sessionsShort')}</span>
                <em>{sessions.length}</em>
              </button>
              <button
                type="button"
                className={`planner-bar-button ${setupOpen ? 'is-open' : ''}`}
                aria-expanded={setupOpen}
                title={t('modelSetup')}
                onClick={() => {
                  setSetupOpen((open) => !open)
                  setSessionsOpen(false)
                }}
              >
                <SlidersHorizontal size={16} />
                <span>{t('modelSetup')}</span>
                <em className={ready ? 'is-ok' : 'is-warn'}>{ready ? '✓' : '!'}</em>
              </button>
            </div>

            <div className="planner-bar-group">
              {ARTIFACT_ENTRIES.map((item) => {
                const hasData = item.key === 'script' ? Boolean(session.script) : session.cast.length > 0
                return (
                  <button
                    key={item.key}
                    type="button"
                    className={`planner-bar-button ${item.key === 'script' ? 'is-primary' : ''} ${panel === item.key ? 'is-open' : ''} ${active === item.key ? 'is-active' : ''}`}
                    aria-pressed={panel === item.key}
                    title={t(panel === item.key ? 'closeArtifactTitle' : 'openArtifactTitle', {
                      artifact: t(item.labelKey),
                    })}
                    onClick={() => togglePanel(item.key)}
                  >
                    <Layers size={16} />
                    <span>{t(item.labelKey)}</span>
                    {hasData && <em className="is-ok">•</em>}
                  </button>
                )
              })}
              <button type="button" className="planner-bar-button" title={tLocations('title')} onClick={() => setLocationsOpen((open) => !open)}>
                <Layers size={16} /><span>{tLocations('title')}</span>
                {Boolean(session.locations?.length) && <em className="is-ok">•</em>}
              </button>
              <button
                type="button"
                className="planner-bar-button"
                title={t('openTimelinePage')}
                onClick={() => onOpenTimeline(session.id)}
              >
                <GalleryHorizontalEnd size={16} />
                <span>{t('targetTimeline')}</span>
                {Boolean(session.timeline?.frames.length) && <em className="is-ok">•</em>}
              </button>
            </div>

            {sessionsOpen && (
              <div className="planner-popover planner-popover-sessions" role="dialog" aria-label={t('sessionListTitle')}>
                <div className="planner-popover-head">
                  <strong>{t('sessionsHeading')}</strong>
                  <button type="button" className="row-more" onClick={() => setSessionsOpen(false)} aria-label={t('closeSessionList')}>
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
                        <strong>{item.title || t('untitledSessionShort')}</strong>
                        <span>{t(STATUS_KEYS[item.status])}</span>
                      </button>
                      <button
                        type="button"
                        className="row-more"
                        aria-label={t('deleteSession')}
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
                  <Plus size={15} /> {t('newSession')}
                </button>
              </div>
            )}

            {setupOpen && (
              <div className="planner-popover planner-popover-setup" role="dialog" aria-label={t('modelSetup')}>
                <div className="planner-popover-head">
                  <strong>{t('modelsForSession')}</strong>
                  <button type="button" className="row-more" onClick={() => setSetupOpen(false)} aria-label={t('closeModelSetup')}>
                    <ChevronDown size={15} />
                  </button>
                </div>
                <label className="plan-setup-field">
                  <span>{t('chatModelLabel')}</span>
                  <select
                    value={session.chatModelId ?? ''}
                    disabled={busy !== ''}
                    onChange={(event) => void saveSetup({ chatModelId: event.target.value || null })}
                  >
                    <option value="">{t('chooseLlmChatModel')}</option>
                    {llmModels.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.displayName} · {model.providerName}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="plan-setup-field">
                  <span>{t('imageModelLabel')}</span>
                  <select
                    value={session.imageModelId ?? ''}
                    disabled={busy !== ''}
                    onChange={(event) => void saveSetup({ imageModelId: event.target.value || null })}
                  >
                    <option value="">{t('chooseImageModel')}</option>
                    {imageModels.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.displayName} · {model.providerName}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="plan-setup-field">
                  <span>{t('videoModelLabel')}</span>
                  <select
                    value={session.videoModelId ?? ''}
                    disabled={busy !== ''}
                    onChange={(event) => void saveSetup({ videoModelId: event.target.value || null })}
                  >
                    <option value="">{t('chooseVideoModel')}</option>
                    {videoModels.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.displayName} · {model.providerName}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" className="secondary-button" onClick={onOpenSettings}>
                  {t('addModelsInSettings')}
                </button>
              </div>
            )}
          </div>

          {!ready && (
            <div className="model-gate" role="region" aria-label={t('modelGateTitle')}>
              <SlidersHorizontal size={20} />
              <div className="model-gate-body">
                <strong>{t('modelGateTitle')}</strong>
                <p>{t('modelGateBody')}</p>
                {llmModels.length > 0 ? (
                  <label className="plan-setup-field">
                    <span>{t('modelGateChatLabel')}</span>
                    <select
                      value={session.chatModelId ?? ''}
                      disabled={busy !== ''}
                      aria-label={t('modelGateChatLabel')}
                      onChange={(event) => void saveSetup({ chatModelId: event.target.value || null })}
                    >
                      <option value="">{t('modelGatePick')}</option>
                      {llmModels.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.displayName} · {model.providerName}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <p className="model-gate-warning">{t('modelGateMissingModels')}</p>
                )}
                <button type="button" className="secondary-button" onClick={() => setSetupOpen(true)}>
                  <SlidersHorizontal size={15} /> {t('modelGateOpenSetup')}
                </button>
              </div>
            </div>
          )}

          {locationsOpen && <LocationReferences
            key={session.id}
            sessionId={session.id}
            locations={session.locations ?? []}
            imageModels={imageModels}
            selectedModelId={session.imageModelId}
            api={locationPanelApi(planLocationsApi(session.id))}
            onChanged={(locations) => setSession((current) => current ? { ...current, locations } : current)}
            onNotify={onNotify}
            assignedCounts={Object.fromEntries((session.locations ?? []).map((location) => [location.id, (session.timeline?.frames ?? session.script?.scenes ?? []).filter((scene) => scene.locationId === location.id).length]))}
            onChatClick={() => { setSurfaceChat('locations'); setPendingProposal(null) }}
          />}

          <div className="script-cta">
            <div className="script-cta-copy">
              <strong>{session.script ? t('scriptCtaView') : t('scriptCtaEmptyTitle')}</strong>
              <p>
                {session.script
                  ? t('scriptCtaScenes', { count: session.script.scenes.length })
                  : t('scriptCtaEmptyBody')}
              </p>
            </div>
            <button
              type="button"
              className="generate-button"
              disabled={busy !== '' || (!session.script && !ready)}
              aria-label={t('scriptCtaAria')}
              onClick={() => {
                if (!session.script) { void quickAction('script'); return }
                setActive('script')
                setPanel((current) => (current === 'script' ? null : 'script'))
              }}
            >
              <FileText size={16} /> {session.script ? t('scriptCtaView') : t('scriptCtaWrite')}
            </button>
          </div>

          <PlanChat
            session={session}
            messages={messages}
            busy={busy}
            active={active}
            blocked={!ready}
            onSend={(content) => void chat(content)}
            onQuickAction={(target) => void quickAction(target)}
          />

          <SurfaceChatDrawer
            open={surfaceChat !== null}
            surface={surfaceChat ?? 'timeline'}
            onSurfaceChange={setSurfaceChat}
            title={surfaceChat === 'locations' ? t('proposalSurfaceLocations') : t('timelineChatTitle')}
            messages={messages}
            busy={surfaceBusy}
            blocked={!ready}
            draft={surfaceDraft}
            onDraftChange={setSurfaceDraft}
            onSend={() => void sendSurfaceChat()}
            pending={pendingProposal
              ? { surface: pendingProposal.surface, summary: pendingProposal.summary, changes: pendingProposal.changes }
              : null}
            applying={surfaceApplying}
            onApply={() => void applySurfaceProposal()}
            onDiscard={() => setPendingProposal(null)}
            onClose={() => setSurfaceChat(null)}
            errorText={errorText}
          />

          <ArtifactDrawer
            artifact={panel}
            session={session}
            busy={busy}
            error={errorText}
            onClose={() => setPanel(null)}
            onSession={setSession}
            onReload={loadSessions}
            onNotify={onNotify}
            onError={setError}
            onSwitch={(target) => {
              if (target === 'cast') { onOpenCharacters(session.id); return }
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
