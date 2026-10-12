import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUpRight,
  BookOpen,
  Image as ImageIcon,
  KeyRound,
  LoaderCircle,
  Plus,
  Settings2,
  Sparkles,
  Upload,
  UserRound,
  Video,
  X,
} from 'lucide-react'
import { ApiError, errorMessage } from '../api/client'
import {
  characterApi,
  generationApi,
  quickSessionApi,
  uploadApi,
  type QuickSession,
  type SourceUpload,
} from '../api/endpoints'
import type { Generation, GenerationParamsInput, ModelInfo, Mode } from '../api/types'
import type { ProjectCharacter } from '../api/projectTypes'
import { CreationCard, SelectControl, GenerationProgress, isGenerationActive } from '../components/Common'
import { AgnesVideoControls, agnesInput, usesAgnes } from '../components/AgnesVideoControls'
import type { Page } from '../components/Sidebar'
import { formatNumber, useTranslation } from '../i18n'
import { studioCatalog, type StudioKey } from '../i18n/catalogs/studio'
import { notification, type Notification } from '../i18n/messages'

type Props = {
  mode: Mode
  onModeChange: (mode: Mode) => void
  models: ModelInfo[]
  onCreated: (generation: Generation) => void
  onDelete: (id: string) => void
  busyId: string | null
  onNavigate: (page: Page) => void
  onNotify: (message: Notification) => void
  /** Phiên đang mở (từ URL); rỗng nghĩa là phiên mới chưa lưu. */
  sessionId?: string
  onSelectSession?: (id: string) => void
}

/** Lựa chọn chỉ giữ `value` (giá trị gửi API) và khoá dịch cho nhãn hiển thị. */
type Option = { value: string; labelKey: StudioKey }

/**
 * Ảnh nguồn của lần tạo: tệp người dùng tải lên hoặc ảnh đã tạo trong phiên.
 * Hai loại gửi lên hai trường khác nhau (`sourceUploadIds` / `sourceAssetIds`).
 */
type QuickSource =
  | { kind: 'upload'; id: string; url: string }
  | { kind: 'asset'; id: string; url: string }

const IMAGE_SIZES: readonly Option[] = [
  { value: '1024x1024', labelKey: 'studioSizeSquare' },
  { value: '1536x1024', labelKey: 'studioSizeLandscape1536' },
  { value: '1024x1536', labelKey: 'studioSizePortrait1024' },
]

const IMAGE_QUALITIES: readonly Option[] = [
  { value: '', labelKey: 'qualityDefault' },
  { value: 'low', labelKey: 'qualityLow' },
  { value: 'medium', labelKey: 'qualityMedium' },
  { value: 'high', labelKey: 'qualityHigh' },
]

const VIDEO_SIZES: readonly Option[] = [
  { value: '1280x720', labelKey: 'studioVideoLandscape' },
  { value: '720x1280', labelKey: 'studioVideoPortrait' },
]

const VIDEO_SECONDS: readonly Option[] = [
  { value: '4', labelKey: 'secondsOption' },
  { value: '8', labelKey: 'secondsOption' },
  { value: '12', labelKey: 'secondsOption' },
]

const PROMPT_MAX_LENGTH = 8000
/** Khớp `MAX_SOURCE_IMAGES` của backend (biến môi trường có thể thấp hơn). */
const MAX_SOURCE_IMAGES = 4
/** Khớp `MAX_SESSION_CHARACTERS` của backend. */
const MAX_SESSION_CHARACTERS = 6
const ACTIVE_POLL_MS = 2000
const IDLE_POLL_MS = 15000

/**
 * Chi tiết thô từ provider/máy chủ, chỉ đặt ở tooltip: `errorMessage()` đã là bản dịch
 * theo ngôn ngữ hiện tại, còn văn bản gốc không bao giờ bị dịch máy.
 */
function rawErrorDetail(cause: unknown): string | undefined {
  if (!(cause instanceof ApiError)) return undefined
  const raw = cause.message.trim()
  return raw && raw !== errorMessage(cause) ? raw : undefined
}

function mergeGenerationResponse(current: Generation[], incoming: Generation[], requestedAt: number): Generation[] {
  const byId = new Map(current.map(generation => [generation.id, generation]))
  const merged = incoming.map(generation => {
    const local = byId.get(generation.id)
    return local && local.updatedAt > generation.updatedAt ? local : generation
  })
  const received = new Set(incoming.map(generation => generation.id))
  return [...merged, ...current.filter(generation => !received.has(generation.id) && generation.createdAt >= requestedAt)]
}

export function StudioPage({
  mode, onModeChange, models, onCreated, onDelete, busyId, onNavigate, onNotify, sessionId = '', onSelectSession,
}: Props) {
  const { t, locale } = useTranslation(studioCatalog)
  const [prompt, setPrompt] = useState('')
  const [modelId, setModelId] = useState('')
  const [size, setSize] = useState(IMAGE_SIZES[0].value)
  const [videoSize, setVideoSize] = useState(VIDEO_SIZES[0].value)
  const [agnesParams, setAgnesParams] = useState<GenerationParamsInput>({ mode: 'text', seconds: '5', size: '720P', aspectRatio: '16:9' })
  const [quality, setQuality] = useState('')
  const [seconds, setSeconds] = useState(VIDEO_SECONDS[0].value)
  const [count, setCount] = useState(1)
  const [busy, setBusy] = useState(false)
  const [sendingVideo, setSendingVideo] = useState(false)
  const [sendingPrompt, setSendingPrompt] = useState('')
  /**
   * Lỗi được lưu dưới dạng đối tượng gốc, không định dạng sẵn: `errorMessage()` đọc
   * ngôn ngữ tại thời điểm render nên thông báo tự dịch lại khi đổi en/vi.
   */
  const [error, setError] = useState<unknown>(null)

  // Nhân vật dùng chung của thư viện; danh sách nhân vật thuộc phiên giữ trong `cast`.
  const [characters, setCharacters] = useState<ProjectCharacter[]>([])
  const [cast, setCast] = useState<string[]>([])
  const [sendReference, setSendReference] = useState(true)

  // Phiên: danh sách, phiên đang mở và nội dung của phiên.
  const [sessions, setSessions] = useState<QuickSession[]>([])
  const [currentId, setCurrentId] = useState(sessionId)
  const currentIdRef = useRef(currentId)
  currentIdRef.current = currentId
  const [session, setSession] = useState<QuickSession | null>(null)
  const [sessionGenerations, setSessionGenerations] = useState<Generation[]>([])
  const [titleDraft, setTitleDraft] = useState('')
  const [loading, setLoading] = useState(true)
  /** Đang đọc phiên từ server: chặn sửa dàn nhân vật để không ghi đè danh sách cũ. */
  const [hydrating, setHydrating] = useState(false)
  /** Model cần khôi phục sau khi đổi chế độ ảnh/video (nút "Sửa mô tả"). */
  const pendingModelRef = useRef<string | null>(null)

  // Ảnh nguồn: tải lên thủ công hoặc lấy từ ảnh đã tạo trong phiên.
  const [sources, setSources] = useState<QuickSource[]>([])
  const [uploadingSource, setUploadingSource] = useState(false)
  /** Nội dung đang được sửa; chỉ là thông tin hiển thị, bản cũ vẫn giữ nguyên. */
  const [editingFrom, setEditingFrom] = useState<Generation | null>(null)

  // Thư viện nhân vật chỉ là tùy chọn; không chặn việc tạo nội dung.
  useEffect(() => {
    let alive = true
    characterApi
      .list()
      .then((result) => {
        if (alive) setCharacters(result.characters)
      })
      .catch(() => {
        // Bỏ qua: vẫn tạo được nội dung khi không tải được thư viện.
      })
    return () => {
      alive = false
    }
  }, [])

  // Danh sách phiên + phiên cần mở (ưu tiên phiên trên URL, sau đó phiên mới nhất).
  useEffect(() => {
    let alive = true
    setLoading(true)
    quickSessionApi
      .list()
      .then((result) => {
        if (!alive) return
        setSessions(result.sessions)
        const wanted = sessionId && result.sessions.some((item) => item.id === sessionId)
          ? sessionId
          : result.sessions[0]?.id ?? ''
        setCurrentId(wanted)
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
    // Chỉ chạy khi mở trang: `sessionId` đổi sau đó do người dùng chọn phiên.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Điều hướng Back/Forward đổi phiên trên URL.
  useEffect(() => {
    if (sessionId && sessionId !== currentId) setCurrentId(sessionId)
  }, [sessionId, currentId])

  // Nạp phiên đang mở kèm nội dung của phiên.
  useEffect(() => {
    if (!currentId) {
      setSession(null)
      setSessionGenerations([])
      return
    }
    let alive = true
    const requestedAt = Date.now()
    setHydrating(true)
    Promise.all([
      quickSessionApi.get(currentId),
      generationApi.list({ quickSessionId: currentId, limit: 100 }),
    ])
      .then(([sessionResult, generationResult]) => {
        if (!alive) return
        setSession(sessionResult.session)
        setTitleDraft(sessionResult.session.title)
        setCast(sessionResult.session.characterIds)
        setSessionGenerations(current => mergeGenerationResponse(current.filter(generation => generation.quickSessionId === currentId), generationResult.generations, requestedAt))
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause)
      })
      .finally(() => {
        if (alive) setHydrating(false)
      })
    return () => {
      alive = false
    }
  }, [currentId])

  const hasActive = sessionGenerations.some(
    (item) => item.status === 'queued' || item.status === 'running' || item.status === 'downloading',
  )

  // Làm mới nội dung của phiên để cập nhật tiến trình; nhanh hơn khi có tác vụ đang chạy.
  useEffect(() => {
    if (!currentId) return
    let alive = true
    let inFlight = false
    const interval = window.setInterval(
      () => {
        if (inFlight) return
        inFlight = true
        const requestedAt = Date.now()
        generationApi
          .list({ quickSessionId: currentId, limit: 100 })
          .then((result) => {
            if (alive && currentIdRef.current === currentId) setSessionGenerations(current => mergeGenerationResponse(current, result.generations, requestedAt))
          })
          .catch(() => {
            // Bỏ qua lỗi tạm thời khi làm mới nền.
          })
          .finally(() => { inFlight = false })
      },
      hasActive ? ACTIVE_POLL_MS : IDLE_POLL_MS,
    )
    return () => { alive = false; window.clearInterval(interval) }
  }, [currentId, hasActive])

  const primaryCharacter = characters.find((item) => item.id === cast[0]) ?? null
  const castHasReference = cast.some(
    (id) => Boolean(characters.find((item) => item.id === id)?.referenceUrl),
  )
  const willSendReference = castHasReference && sendReference

  const modelsForMode = useMemo(
    () => models.filter((model) => model.kind === mode && model.enabled),
    [models, mode],
  )

  const providerOptions = useMemo(
    () => Array.from(new Map(modelsForMode.map((model) => [model.providerId, model.providerName])).entries())
      .map(([value, label]) => ({ value, label })),
    [modelsForMode],
  )

  const [providerId, setProviderId] = useState('')
  useEffect(() => {
    // "Sửa mô tả" đặt model cần khôi phục trước khi đổi chế độ; tôn trọng lựa chọn đó.
    const pending = pendingModelRef.current
    const restored = pending ? modelsForMode.find((model) => model.id === pending) : undefined
    if (restored) {
      pendingModelRef.current = null
      setProviderId(restored.providerId)
      setModelId(restored.id)
      return
    }
    // A catalog update must not reset a valid user-selected model.
    const first = modelsForMode.find(model => model.id === modelId) ?? modelsForMode[0]
    setProviderId(first?.providerId ?? '')
    setModelId(first?.id ?? '')
  }, [modelsForMode])

  const providerModels = useMemo(
    () => modelsForMode.filter((model) => model.providerId === providerId),
    [modelsForMode, providerId],
  )

  const selectedModel = modelsForMode.find((model) => model.id === modelId)
  const isAgnes = mode === 'video' && usesAgnes(selectedModel)
  const [visibleCount, setVisibleCount] = useState(6)
  const resultsRef = useRef<HTMLElement>(null)
  const modeResults = useMemo(() => sessionGenerations
    .filter(generation => generation.kind === mode && generation.quickSessionId === currentId)
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)), [sessionGenerations, mode, currentId])
  useEffect(() => { setVisibleCount(6) }, [currentId, mode])
  const activeVideos = modeResults.filter(generation => generation.kind === 'video' && isGenerationActive(generation))
  const activeVideo = activeVideos[0]

  /** Ghi danh sách nhân vật vào phiên đang mở; chưa có phiên thì giữ tạm ở state. */
  function persistCast(next: string[]): void {
    setCast(next)
    // Chưa có phiên thì lưu tạm; đang đọc phiên thì bỏ qua để không ghi đè danh sách cũ.
    if (!currentId || hydrating) return
    quickSessionApi
      .update(currentId, { characterIds: next })
      .then((result) => {
        setSession(result.session)
        setSessions((current) =>
          current.map((item) => (item.id === result.session.id ? result.session : item)),
        )
      })
      .catch((cause: unknown) => setError(cause))
  }

  function addCharacter(id: string): void {
    if (!id || cast.includes(id)) return
    if (cast.length >= MAX_SESSION_CHARACTERS) {
      onNotify(notification('studio', 'notifyCharacterLimit', { max: MAX_SESSION_CHARACTERS }))
      return
    }
    persistCast([...cast, id])
  }

  function removeCharacter(id: string): void {
    persistCast(cast.filter((item) => item !== id))
  }

  function selectSession(id: string): void {
    // Chọn "phiên chưa có tên" nghĩa là bắt đầu phiên mới chưa lưu.
    if (!id) {
      startNewSession()
      return
    }
    setCurrentId(id)
    onSelectSession?.(id)
  }

  /** Bắt đầu phiên mới: chưa ghi database, phiên được tạo ở lần tạo nội dung đầu tiên. */
  function startNewSession(): void {
    setCurrentId('')
    setSession(null)
    setSessionGenerations([])
    setCast([])
    setTitleDraft('')
    setEditingFrom(null)
    onSelectSession?.('')
  }

  async function removeSession(): Promise<void> {
    if (!currentId) return
    try {
      await quickSessionApi.remove(currentId)
      const remaining = sessions.filter((item) => item.id !== currentId)
      setSessions(remaining)
      const next = remaining[0]?.id ?? ''
      setCurrentId(next)
      if (!next) {
        // Không còn phiên nào: composer trở về trạng thái phiên mới.
        setSession(null)
        setSessionGenerations([])
        setCast([])
        setTitleDraft('')
      }
      onSelectSession?.(next)
      onNotify(notification('studio', 'notifySessionDeleted'))
    } catch (cause) {
      setError(cause)
    }
  }

  /** Lưu tên phiên khi rời ô nhập; bỏ qua khi chưa có phiên hoặc tên không đổi. */
  function saveTitle(): void {
    if (!currentId || !session || titleDraft.trim() === session.title) return
    const title = titleDraft.trim()
    quickSessionApi
      .update(currentId, { title })
      .then((result) => {
        setSession(result.session)
        setSessions((current) =>
          current.map((item) => (item.id === result.session.id ? result.session : item)),
        )
        onNotify(notification('studio', 'notifySessionRenamed'))
      })
      .catch((cause: unknown) => setError(cause))
  }

  function addSource(source: QuickSource): void {
    setSources((current) => {
      if (current.some((item) => item.kind === source.kind && item.id === source.id)) return current
      if (current.length >= MAX_SOURCE_IMAGES) {
        onNotify(notification('studio', 'notifySourceLimit', { max: MAX_SOURCE_IMAGES }))
        return current
      }
      return [...current, source]
    })
  }

  function removeSource(source: QuickSource): void {
    setSources((current) =>
      current.filter((item) => !(item.kind === source.kind && item.id === source.id)),
    )
    if (source.kind === 'upload') {
      void uploadApi.remove(source.id).catch(() => {
        // Ảnh nguồn không xoá được cũng không chặn lần tạo tiếp theo.
      })
    }
  }

  async function addSourceFiles(files: FileList | null): Promise<void> {
    if (!files?.length) return
    setUploadingSource(true)
    setError(null)
    try {
      const room = MAX_SOURCE_IMAGES - sources.length
      const uploaded: SourceUpload[] = []
      for (const file of Array.from(files).slice(0, Math.max(room, 0))) {
        uploaded.push(await uploadApi.upload(file))
      }
      setSources((current) => [
        ...current,
        ...uploaded.map((item): QuickSource => ({ kind: 'upload', id: item.id, url: item.url })),
      ])
    } catch (cause) {
      setError(cause)
    } finally {
      setUploadingSource(false)
    }
  }

  /**
   * Nạp lại mô tả và tham số của nội dung cũ để sửa.
   *
   * Chỉ điền vào composer; bấm Tạo sẽ sinh thêm một nội dung mới trong cùng phiên,
   * còn nội dung cũ vẫn được giữ nguyên.
   */
  function editFrom(generation: Generation): void {
    setEditingFrom(generation)
    onModeChange(generation.kind)
    setPrompt(generation.prompt)
    const params = (generation.params ?? {}) as Record<string, unknown>
    if (typeof params.size === 'string') {
      if (generation.kind === 'image') setSize(params.size)
      else if (VIDEO_SIZES.some(option => option.value === params.size)) setVideoSize(params.size)
    }
    if (generation.kind === 'video') setAgnesParams(params as GenerationParamsInput)
    if (generation.kind === 'image') {
      if (typeof params.quality === 'string') setQuality(params.quality)
      if (typeof params.n === 'number') setCount(params.n)
    } else if (params.seconds !== undefined) {
      setSeconds(String(params.seconds))
    }
    if (typeof params.useCharacterReference === 'boolean') setSendReference(params.useCharacterReference)
    pendingModelRef.current = generation.modelId ?? null
    const model = models.find((item) => item.id === generation.modelId)
    if (model) {
      setProviderId(model.providerId)
      setModelId(model.id)
    }
  }

  async function generate(): Promise<void> {
    if (busy || hydrating || !prompt.trim() || !selectedModel) return

    setError(null)
    setBusy(true)
    setSendingVideo(mode === 'video')
    setSendingPrompt(prompt.trim())
    try {
      // Phiên được tạo ở lần tạo đầu tiên, kèm dàn nhân vật đang chọn.
      let id = currentId
      if (!id) {
        const created = await quickSessionApi.create({
          title: prompt.trim().slice(0, 60),
          characterIds: cast,
        })
        id = created.session.id
        setSessions((current) => [created.session, ...current])
        setSession(created.session)
        setTitleDraft(created.session.title)
        currentIdRef.current = id
        setCurrentId(id)
        onSelectSession?.(id)
      }

      const params: GenerationParamsInput =
        mode === 'image'
          ? { size, ...(quality ? { quality } : {}), n: count }
          : isAgnes && selectedModel ? agnesInput(agnesParams, selectedModel) : { size: videoSize, seconds }

      const uploadIds = sources.filter((item) => item.kind === 'upload').map((item) => item.id)
      const assetIds = sources.filter((item) => item.kind === 'asset').map((item) => item.id)

      const result = await generationApi.create({
        modelId: selectedModel.id,
        prompt: prompt.trim(),
        // Gửi ảnh tham chiếu nhân vật để model bám đúng ngoại hình.
        params: { ...params, ...(cast.length ? { useCharacterReference: !isAgnes && willSendReference } : {}) },
        ...(cast[0] ? { characterId: cast[0] } : {}),
        ...(cast.length ? { characterIds: cast } : {}),
        // Ảnh nguồn chỉ áp cho model tạo ảnh.
        ...(mode === 'image' && uploadIds.length ? { sourceUploadIds: uploadIds } : {}),
        ...(mode === 'image' && assetIds.length ? { sourceAssetIds: assetIds } : {}),
        quickSessionId: id,
        // Khóa chống gửi trùng cho lần bấm này.
        idempotencyKey: crypto.randomUUID(),
      })
      if (currentIdRef.current === id) setSessionGenerations(current => [result.generation, ...current.filter(generation => generation.id !== result.generation.id)])
      onCreated(result.generation)
      onNotify(notification('studio', 'notifyRequestSent'))
      setEditingFrom(null)
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy(false)
      setSendingVideo(false)
    }
  }

  return (
    <div className="page-content studio-page">
      <section className="page-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-dot" /> {t('studioEyebrow')}</div>
          <h1>{t('studioHeadingLead')}<em>{t('studioHeadingEmphasis')}</em></h1>
          <p>{t('studioIntro')}</p>
        </div>
        <button className="secondary-button" onClick={() => onNavigate('library')}>
          <BookOpen size={16} /> {t('openLibrary')} <ArrowUpRight size={15} />
        </button>
      </section>

      <div className="studio-grid">
        <section className="composer-card panel-card">
          <div className="quick-session-bar">
            <SelectControl
              label={t('sessionLabel')}
              value={currentId}
              options={[
                { value: '', label: t('sessionUntitled') },
                ...sessions.map((item) => ({
                  value: item.id,
                  label: `${item.title || t('sessionUntitled')} · ${item.generationCount}`,
                })),
              ]}
              onChange={selectSession}
            />
            <input
              className="quick-session-title"
              value={titleDraft}
              placeholder={t('sessionTitlePlaceholder')}
              aria-label={t('sessionTitleLabel')}
              disabled={!currentId}
              onChange={(event) => setTitleDraft(event.target.value)}
              onBlur={saveTitle}
            />
            <button type="button" className="secondary-button" onClick={startNewSession}>
              <Plus size={15} /> {t('sessionNew')}
            </button>
            {currentId && (
              <button
                type="button"
                className="text-button quick-session-delete"
                title={t('sessionDeleteHint')}
                onClick={() => void removeSession()}
              >
                {t('sessionDelete')}
              </button>
            )}
          </div>

          <div className="mode-tabs">
            <button className={mode === 'image' ? 'active' : ''} onClick={() => onModeChange('image')}>
              <ImageIcon size={17} /> {t('modeImage')}
            </button>
            <button className={mode === 'video' ? 'active' : ''} onClick={() => onModeChange('video')}>
              <Video size={17} /> {t('modeVideo')} <span className="beta-pill">{t('betaBadge')}</span>
            </button>
          </div>

          <button type="button" className="text-button quick-results-shortcut" onClick={() => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
            {t('quickViewResults', { count: modeResults.length })} <ArrowUpRight size={14} />
          </button>
          <div className="composer-body">
            {editingFrom && (
              <div className="quick-edit-banner">
                <div>
                  <strong>{t('editBannerPrefix')}</strong>
                  <span>{editingFrom.prompt.slice(0, 80)}</span>
                  <em>{t('editBannerNotice')}</em>
                </div>
                <button type="button" className="text-button" onClick={() => setEditingFrom(null)}>
                  {t('editCancel')}
                </button>
              </div>
            )}

            <div className="field-label-row">
              <label htmlFor="prompt">{t('promptLabel')}</label>
              <span className="counter">
                {t('promptCounter', {
                  count: prompt.length,
                  max: formatNumber(PROMPT_MAX_LENGTH, {}, locale),
                })}
              </span>
            </div>
            <div className="prompt-box">
              <textarea
                id="prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={t('promptPlaceholder')}
                maxLength={PROMPT_MAX_LENGTH}
              />
              <div className="prompt-footer">
                <button className="attach-button" onClick={() => onNavigate('characters')}>
                  <Upload size={15} /> {t('manageReferences')}
                </button>
              </div>
            </div>

            <div className="control-section">
              <div className="section-title">{t('configSection')}</div>
              {modelsForMode.length ? (
                <div className="controls-grid">
                  <SelectControl
                    label={t('providerLabel')}
                    value={providerId}
                    options={providerOptions}
                    onChange={(value) => {
                      setProviderId(value)
                      const first = modelsForMode.find((model) => model.providerId === value)
                      if (first) setModelId(first.id)
                    }}
                  />
                  <SelectControl
                    label={t('modelLabel')}
                    value={selectedModel?.id ?? ''}
                    options={providerModels.map((model) => ({ value: model.id, label: model.displayName }))}
                    onChange={setModelId}
                  />
                  {mode === 'image' ? (
                    <>
                      <SelectControl
                        label={t('sizeLabel')}
                        value={size}
                        options={IMAGE_SIZES.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
                        onChange={setSize}
                      />
                      <SelectControl
                        label={t('qualityLabel')}
                        value={quality}
                        options={IMAGE_QUALITIES.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
                        onChange={setQuality}
                      />
                      <SelectControl
                        label={t('imageCountLabel')}
                        value={String(count)}
                        options={[1, 2, 3, 4].map((value) => ({
                          value: String(value),
                          label: t('imageCountOption', { count: value }),
                        }))}
                        onChange={(value) => setCount(Number(value))}
                      />
                    </>
                  ) : isAgnes && selectedModel ? (
                    <AgnesVideoControls model={selectedModel} value={agnesParams} onChange={setAgnesParams} />
                  ) : (
                    <>
                      <SelectControl
                        label={t('sizeLabel')}
                        value={videoSize}
                        options={VIDEO_SIZES.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
                        onChange={setVideoSize}
                      />
                      <SelectControl
                        label={t('durationLabel')}
                        value={seconds}
                        options={VIDEO_SECONDS.map((option) => ({
                          value: option.value,
                          label: t('secondsOption', { count: Number(option.value) }),
                        }))}
                        onChange={setSeconds}
                      />
                    </>
                  )}
                </div>
              ) : (
                <div className="empty-config">
                  <KeyRound size={20} />
                  <strong>{mode === 'image' ? t('noImageModel') : t('noVideoModel')}</strong>
                  <span>{t('noModelsHint')}</span>
                  <button className="text-button" onClick={() => onNavigate('settings')}>
                    {t('openApiModels')} <ArrowUpRight size={14} />
                  </button>
                </div>
              )}
            </div>

            {mode === 'image' && (
              <div className="project-source quick-source">
                <span className="project-reference-label">{t('sourceImagesLabel')}</span>
                <div className="project-source-strip">
                  {sources.map((item) => (
                    <div className="project-source-item" key={`${item.kind}-${item.id}`}>
                      <img src={item.url} alt="" />
                      <button
                        type="button"
                        className="project-source-remove"
                        aria-label={t('removeSourceImageAria')}
                        onClick={() => removeSource(item)}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                  {sources.length < MAX_SOURCE_IMAGES && (
                    <label className="project-source-add">
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        multiple
                        disabled={uploadingSource}
                        onChange={(event) => {
                          void addSourceFiles(event.target.files)
                          event.target.value = ''
                        }}
                      />
                      {uploadingSource ? <LoaderCircle size={18} className="spin" /> : <Plus size={18} />}
                      <span>{t('addImage')}</span>
                    </label>
                  )}
                </div>
                <span className="project-hint">
                  {t('sourceImagesHintPrefix', { max: MAX_SOURCE_IMAGES })}
                  <code> /images/edits </code>
                  {t('sourceImagesHintSuffix')}
                </span>
                {sources.some((item) => item.kind === 'asset') && (
                  <span className="project-hint">{t('useAsSourceHint')}</span>
                )}
              </div>
            )}

            <div className="quick-character">
              <div className="field-label-row">
                <label htmlFor="quick-character">{t('sessionCharactersLabel')}</label>
                <span className="counter">
                  {characters.length
                    ? t('charactersInLibrary', { count: characters.length })
                    : t('charactersLibraryEmpty')}
                </span>
              </div>
              <SelectControl
                label={t('characterLabel')}
                value=""
                disabled={hydrating}
                options={[
                  { value: '', label: t('noCharacterAttached') },
                  ...characters
                    .filter((character) => !cast.includes(character.id))
                    .map((character) => ({
                      value: character.id,
                      label: character.referenceUrl
                        ? t('characterWithReference', { name: character.name })
                        : t('characterDescriptionOnly', { name: character.name }),
                    })),
                ]}
                onChange={addCharacter}
              />
              {cast.length > 0 && (
                <div className="quick-cast-list">
                  {cast.map((id) => {
                    const character = characters.find((item) => item.id === id)
                    if (!character) return null
                    return (
                      <span className="quick-cast-chip" key={id}>
                        <span className="quick-cast-avatar">
                          {character.referenceUrl ? (
                            <img src={character.referenceUrl} alt="" loading="lazy" />
                          ) : (
                            character.name.slice(0, 1).toUpperCase()
                          )}
                        </span>
                        {character.name}
                        <button
                          type="button"
                          disabled={hydrating}
                          aria-label={t('sessionRemoveCharacter', { name: character.name })}
                          onClick={() => removeCharacter(id)}
                        >
                          <X size={12} />
                        </button>
                      </span>
                    )
                  })}
                </div>
              )}
              <span className="project-hint">
                {t('sessionCharactersHint')} {t('sessionCharacterLimit', { max: MAX_SESSION_CHARACTERS })}
              </span>
              {primaryCharacter && (
                <div className="quick-character-preview">
                  <div className="project-character-avatar">
                    {primaryCharacter.referenceUrl ? (
                      <img
                        src={primaryCharacter.referenceUrl}
                        alt={t('characterReferenceAlt', { name: primaryCharacter.name })}
                        loading="lazy"
                      />
                    ) : (
                      primaryCharacter.name.slice(0, 1).toUpperCase()
                    )}
                  </div>
                  <div>
                    <strong>{primaryCharacter.name}</strong>
                    <p>{primaryCharacter.appearance || t('noAppearance')}</p>
                  </div>
                </div>
              )}
              {isAgnes && cast.length ? (
                <span className="project-hint">{t('agnesPrivateHint')}</span>
              ) : castHasReference ? (
                <label className="project-checkbox">
                  <input
                    type="checkbox"
                    checked={sendReference}
                    onChange={(event) => setSendReference(event.target.checked)}
                  />
                  <span>{t('sessionSendReference')}</span>
                </label>
              ) : cast.length ? (
                <span className="project-hint">{t('noReferenceHint')}</span>
              ) : (
                <span className="project-hint">
                  <UserRound size={13} /> {t('createCharacterHint')}
                </span>
              )}
            </div>

            {error != null && (
              <div className="form-error" role="alert" title={rawErrorDetail(error)}>
                {errorMessage(error)}
              </div>
            )}

            <div className="advanced-row">
              <button onClick={() => onNotify(notification('studio', 'advancedNotice'))}>
                <Settings2 size={15} /> {t('advancedParams')}
              </button>
              <span>
                <span className={`status-dot ${selectedModel ? 'ok' : ''}`} />
                {selectedModel ? t('statusReady') : t('statusNoApi')}
              </span>
            </div>

            <button
              className="generate-button"
              onClick={generate}
              disabled={busy || hydrating || !prompt.trim() || !selectedModel}
            >
              {busy ? <LoaderCircle size={18} className="spin" /> : <Sparkles size={18} />}
              {busy ? t('sending') : mode === 'image' ? t('generateImage') : t('generateVideo')}
            </button>
            {mode === 'video' && (sendingVideo || activeVideo) && <div className="quick-video-activity" role="status" aria-live="polite">
              <div className="quick-video-activity-heading"><LoaderCircle size={24} className="spin" aria-hidden="true" />
                <strong>{sendingVideo ? t('videoSending') : t('videoActiveCount', { count: activeVideos.length })}</strong>
              </div>
              <p>{sendingVideo ? sendingPrompt : activeVideo?.prompt}</p>
              {sendingVideo ? <div className="card-progress is-indeterminate"><span /></div> : activeVideo && <GenerationProgress generation={activeVideo} />}
              <button type="button" className="text-button" onClick={() => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{t('videoViewProgress')} <ArrowUpRight size={14} /></button>
            </div>}
            <p className="cost-note">
              {selectedModel ? t('costNoteWithModel') : t('costNoteNoModel')}
            </p>
          </div>
        </section>

        <section className="preview-column quick-session-results" ref={resultsRef} tabIndex={-1} aria-label={t(mode === 'image' ? 'quickImagesTitle' : 'quickVideosTitle')}>
          <div className="preview-header">
            <div>
              <div className="section-kicker">{t('recentResults')} · {t('quickNewestFirst')}</div>
              <h2>{t(mode === 'image' ? 'quickImagesTitle' : 'quickVideosTitle')} <span className="quick-results-count">{modeResults.length}</span></h2>
            </div>
            <button className="text-button" onClick={() => onNavigate('library')}>
              {t('openLibrary')} <ArrowUpRight size={14} />
            </button>
          </div>
          {loading || hydrating ? (
            <div className="empty-state"><LoaderCircle size={26} className="spin" /><h3>{t('loadingShort')}</h3></div>
          ) : modeResults.length ? (
            <>
              <div className="creation-strip quick-results-list">
                {modeResults.slice(0, visibleCount).map(generation => (
                  <CreationCard
                    key={generation.id}
                    generation={generation}
                    onDelete={() => {
                      setSessionGenerations(current => current.filter(item => item.id !== generation.id))
                      onDelete(generation.id)
                    }}
                    onEdit={() => editFrom(generation)}
                    {...(generation.status === 'succeeded' && generation.kind === 'image' && generation.assets[0] ? {
                      onUseAsSource: () => addSource({ kind: 'asset', id: generation.assets[0].id, url: generation.assets[0].url }),
                    } : {})}
                    busy={busyId === generation.id}
                  />
                ))}
              </div>
              {visibleCount < modeResults.length && <button type="button" className="secondary-button quick-results-more" onClick={() => setVisibleCount(count => count + 6)}>{t('quickShowMore')}</button>}
            </>
          ) : (
            <div className="empty-state">
              {mode === 'image' ? <ImageIcon size={28} /> : <Video size={28} />}
              <h3>{t(mode === 'image' ? 'quickImagesEmpty' : 'quickVideosEmpty')}</h3>
              <p>{t('studioEmptyHint')}</p>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
