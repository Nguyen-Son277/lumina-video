import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowUpRight,
  Workflow,
  Clock3,
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
  type GenerationCreateInput,
  type GenerationPreview,
  type LogoOverlay,
} from '../api/endpoints'
import type { Generation, GenerationParamsInput, ModelInfo, Mode } from '../api/types'
import type { ProjectCharacter } from '../api/projectTypes'
import { CreationCard, SelectControl, GenerationProgress, isGenerationActive } from '../components/Common'
import { agnesInput, usesAgnes } from '../components/AgnesVideoControls'
import { usesHiggsfield } from '../components/HiggsfieldVideoControls'
import { EntityMentionTextarea } from '../components/EntityMentionTextarea'
import { EntityGenerationOptions, GenerationPreviewDialog, type EntityGenerationPreview } from '../components/EntityGenerationOptions'
import { insertPromptMention, updatePromptDocument, type PromptDocument } from '../../shared/promptMentions'
import { QuickLibraryPicker, type LibrarySelection } from '../components/QuickLibraryPicker'
import { isAgnesFlash } from '../../shared/videoApi'
import { validVideoSeconds } from '../../shared/videoControls'
import type { Page } from '../components/Sidebar'
import { formatNumber, useTranslation } from '../i18n'
import { studioCatalog, type StudioKey } from '../i18n/catalogs/studio'
import { notification, type Notification } from '../i18n/messages'
import { quickGenerationPreferencesApi, type QuickPreferences, type QuickSettings } from '../api/endpoints'
import { QuickGenerationSettingsModal } from '../components/QuickGenerationSettingsModal'
import { CanvasBoard } from '../components/canvas/CanvasBoard'
import { quickSessionCanvasApi } from '../api/canvas'
import '../styles/quick-studio.css'

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
  view?: 'form' | 'canvas'
  onViewChange?: (view: 'form' | 'canvas') => void
  onRegisterNavigationGuard?: (guard: ((action: () => void) => void) | null) => void
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

const IMAGE_QUALITIES: readonly Option[] = [
  { value: '', labelKey: 'qualityDefault' },
  { value: 'low', labelKey: 'qualityLow' },
  { value: 'medium', labelKey: 'qualityMedium' },
  { value: 'high', labelKey: 'qualityHigh' },
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

/** Restore only the public placement spec, never server-owned paths from snapshots. */
function restoreLogoOverlays(value: unknown, document: PromptDocument): LogoOverlay[] {
  const bound = new Set(document.mentions.filter(binding => binding.entity.kind === 'logo').map(binding => binding.entity.id))
  if (!Array.isArray(value)) return []
  return value.flatMap(spec => {
    if (!spec || typeof spec !== 'object' || !bound.has(spec.entityId)
      || !['x', 'y', 'width', 'opacity'].every(key => typeof spec[key] === 'number' && Number.isFinite(spec[key]))) return []
    const anchor = ['top-left', 'top-center', 'top-right', 'middle-left', 'center', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right'].includes(spec.anchor) ? spec.anchor as NonNullable<LogoOverlay['anchor']> : undefined
    return [{ entityId: spec.entityId as string, x: spec.x as number, y: spec.y as number, width: spec.width as number, opacity: spec.opacity as number, ...(anchor ? { anchor } : {}) }]
  }).slice(0, 8)
}

function dialogPreview(preview: GenerationPreview): EntityGenerationPreview {
  return { ...preview, entities: preview.entities.flatMap(entity => {
    const kind = entity.kind
    return kind === 'character' || kind === 'item' || kind === 'logo' || kind === 'location' ? [{ ...entity, kind }] : []
  }) }
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
  view = 'form', onViewChange, onRegisterNavigationGuard,
}: Props) {
  const { t, locale } = useTranslation(studioCatalog)
  const [promptDocument, setPromptDocument] = useState<PromptDocument>({ version: 1, text: '', mentions: [] })
  const prompt = promptDocument.text
  const [logoOverlays, setLogoOverlays] = useState<LogoOverlay[]>([])
  const [allowTemporaryMedia, setAllowTemporaryMedia] = useState(true)
  const [pendingPreview, setPendingPreview] = useState<{
    input: GenerationCreateInput; preview: EntityGenerationPreview; action: () => Promise<void>; fingerprint: string; lifecycle: number
  } | null>(null)
  const promptDocumentRef = useRef(promptDocument)
  promptDocumentRef.current = promptDocument
  const pendingDocumentSaveRef = useRef<{ sessionId: string; document: PromptDocument } | null>(null)
  const documentSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const documentSaveChainRef = useRef<Promise<void>>(Promise.resolve())
  const lifecycleRef = useRef(0)
  const documentRevisionRef = useRef(0)
  const preserveDocumentSessionRef = useRef<string | null>(null)

  /** Serialize draft writes so a slow older save cannot overwrite a newer edit. */
  function flushPromptDocument(): void {
    if (documentSaveTimerRef.current !== null) clearTimeout(documentSaveTimerRef.current)
    documentSaveTimerRef.current = null
    const pending = pendingDocumentSaveRef.current
    pendingDocumentSaveRef.current = null
    if (!pending) return
    documentSaveChainRef.current = documentSaveChainRef.current.then(async () => {
      try {
        const result = await quickSessionApi.update(pending.sessionId, { promptDocument: pending.document })
        setSessions(current => current.map(item => item.id === result.session.id ? result.session : item))
        if (currentIdRef.current === pending.sessionId) setSession(result.session)
      } catch (cause) {
        if (mountedRef.current && currentIdRef.current === pending.sessionId) setError(cause)
      }
    })
  }

  function changePromptDocument(document: PromptDocument): void {
    documentRevisionRef.current++
    promptDocumentRef.current = document
    setPromptDocument(document)
    setPendingPreview(null)
    setLogoOverlays(current => restoreLogoOverlays(current, document))
    if (!currentIdRef.current || hydrating) return
    pendingDocumentSaveRef.current = { sessionId: currentIdRef.current, document }
    if (documentSaveTimerRef.current !== null) clearTimeout(documentSaveTimerRef.current)
    documentSaveTimerRef.current = setTimeout(flushPromptDocument, 400)
  }

  useEffect(() => () => { flushPromptDocument() }, [])
  const [modelId, setModelId] = useState('')
  const [quickPreferences, setQuickPreferences] = useState<QuickPreferences>({ image: null, video: null })
  const [preferencesLoaded, setPreferencesLoaded] = useState(false)
  const [preferencesError, setPreferencesError] = useState<unknown>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsBusyRef = useRef(false)
  const mountedRef = useRef(true)
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])
  const modeRef = useRef(mode)
  const priorModeRef = useRef(mode)
  useEffect(() => {
    if (priorModeRef.current !== mode) setSettingsOpen(false)
    priorModeRef.current = mode
  }, [mode])
  modeRef.current = mode
  const preferencesRequestRef = useRef(0)
  const mediaPreferenceKeys = ['prompt', 'firstFrame', 'lastFrame', 'referenceImages', 'referenceAudios', 'imageUrl', 'endImageUrl', 'imageUploadId', 'endImageUploadId', 'imageAssetId', 'endImageAssetId', 'useCharacterReference', 'characterReference', 'cast', 'logo', 'consent', 'purpose', 'source']
  const videoMediaPreferenceParams = (params: GenerationParamsInput): Record<string, unknown> => Object.fromEntries(Object.entries(params).filter(([key]) => mediaPreferenceKeys.includes(key)))
  const stripMediaPreferenceKeys = <T extends Record<string, unknown>>(params: T): T => Object.fromEntries(Object.entries(params).filter(([key]) => !mediaPreferenceKeys.includes(key))) as T
  const modeSettingsRef = useRef<Record<'image' | 'video', QuickSettings | null>>({ image: null, video: null })
  const savedModelIdsRef = useRef<Record<'image' | 'video', string | null>>({ image: null, video: null })
  const historyEditRef = useRef(false)
  const pendingSettingsRef = useRef<{ settings: QuickSettings; media?: Record<string, unknown>; mode: Mode } | null>(null)
  const [size, setSize] = useState('1024x1024')
  const [videoSize, setVideoSize] = useState('1280x720')
  const [agnesParams, setAgnesParams] = useState<GenerationParamsInput>({ mode: 'text', seconds: '5', size: '720P', aspectRatio: '16:9' })
  const [purposeKind, setPurposeKind] = useState<'none' | 'item' | 'logo' | 'location'>('none')
  const [purposeName, setPurposeName] = useState('')
  const [purposeDescription, setPurposeDescription] = useState('')
  const [librarySelections, setLibrarySelections] = useState<Array<LibrarySelection & { bindingId: string; slot?: 'image' | 'endImage' }>>([])
  const [referenceSlot, setReferenceSlot] = useState<'image' | 'endImage'>('image')
  const [quality, setQuality] = useState('')
  const [seconds, setSeconds] = useState('4')
  const [count, setCount] = useState(1)
  const [busy, setBusy] = useState(false)
  const [openingCanvas, setOpeningCanvas] = useState(false)
  const canvasNavigationGuard = useRef<((action: () => void) => void) | null>(null)
  const registerCanvasGuard = useCallback((guard: ((action: () => void) => void) | null) => {
    canvasNavigationGuard.current = guard
    onRegisterNavigationGuard?.(guard)
  }, [onRegisterNavigationGuard])
  const leaveCanvas = (action: () => void) => {
    if (view === 'canvas' && canvasNavigationGuard.current) canvasNavigationGuard.current(action)
    else action()
  }
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
  const [failedCoverAssets, setFailedCoverAssets] = useState<Set<string>>(() => new Set())
  /** Không tự mở phiên mới khi vào tab; người dùng chủ động chọn phiên hoặc tạo phiên mới. */
  const [showSessionBrowser, setShowSessionBrowser] = useState(!sessionId)
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
  const [videoSource, setVideoSource] = useState<QuickSource | null>(null)
  /** Nội dung đang được sửa; chỉ là thông tin hiển thị, bản cũ vẫn giữ nguyên. */
  const [editingFrom, setEditingFrom] = useState<Generation | null>(null)
  const referencesGroupRef = useRef<HTMLDetailsElement>(null)
  const charactersGroupRef = useRef<HTMLDetailsElement>(null)
  const optionsGroupRef = useRef<HTMLDetailsElement>(null)

  // Reveal restored/added content without closing the disclosure when its last item is removed.
  useEffect(() => {
    if ((sources.length || librarySelections.length || videoSource) && referencesGroupRef.current) referencesGroupRef.current.open = true
  }, [sources.length, librarySelections.length, videoSource, showSessionBrowser])
  useEffect(() => {
    if (cast.length && charactersGroupRef.current) charactersGroupRef.current.open = true
  }, [cast.length, showSessionBrowser])
  useEffect(() => {
    if ((purposeKind !== 'none' || logoOverlays.length || !allowTemporaryMedia) && optionsGroupRef.current) optionsGroupRef.current.open = true
  }, [purposeKind, logoOverlays.length, allowTemporaryMedia, showSessionBrowser])

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

  async function retryPreferences(): Promise<void> {
    const request = ++preferencesRequestRef.current
    const controller = new AbortController()
    setPreferencesError(null)
    setPreferencesLoaded(false)
    try {
      const { preferences } = await quickGenerationPreferencesApi.get(controller.signal)
      if (!mountedRef.current || request !== preferencesRequestRef.current || controller.signal.aborted) return
      setQuickPreferences(preferences)
      modeSettingsRef.current = { image: preferences.image, video: preferences.video }
      savedModelIdsRef.current = { image: preferences.image?.modelId ?? null, video: preferences.video?.modelId ?? null }
      if (preferences[modeRef.current] && !historyEditRef.current) {
        const settings = preferences[modeRef.current]!
        applySettings(settings)
      }
      setPreferencesLoaded(true)
    } catch (cause) {
      if (mountedRef.current && request === preferencesRequestRef.current && !controller.signal.aborted) setPreferencesError(cause)
    }
  }

  // Load account-scoped defaults once for this mounted authenticated page.
  useEffect(() => {
    const request = ++preferencesRequestRef.current
    const controller = new AbortController()
    let alive = true
    setPreferencesLoaded(false)
    setPreferencesError(null)
    quickGenerationPreferencesApi.get(controller.signal).then(({ preferences }) => {
      if (!alive || request !== preferencesRequestRef.current) return
      setQuickPreferences(preferences)
      modeSettingsRef.current = { image: preferences.image, video: preferences.video }
      savedModelIdsRef.current = { image: preferences.image?.modelId ?? null, video: preferences.video?.modelId ?? null }
      if (preferences[modeRef.current] && !historyEditRef.current) {
        const settings = preferences[modeRef.current]!
        applySettings(settings)
      }
      setPreferencesLoaded(true)
    }).catch(cause => {
      if (alive && !controller.signal.aborted) setPreferencesError(cause)
    })
    return () => { alive = false; controller.abort() }
  }, [])

  // Danh sách phiên + phiên cần mở (ưu tiên phiên trên URL, sau đó phiên mới nhất).
  useEffect(() => {
    let alive = true
    const lifecycle = lifecycleRef.current
    setLoading(true)
    quickSessionApi
      .list()
      .then((result) => {
        if (!alive) return
        setSessions(result.sessions)
        if (lifecycleRef.current !== lifecycle) return
        // Không tự chọn phiên đầu tiên: khi vào tab, người dùng cần thấy danh sách
        // và tự chọn phiên cũ hoặc bấm tạo phiên mới.
        if (sessionId && result.sessions.some((item) => item.id === sessionId)) {
          setCurrentId(sessionId)
          setShowSessionBrowser(false)
        } else {
          setCurrentId('')
          setShowSessionBrowser(true)
          if (sessionId) onSelectSession?.('')
        }
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

  // Điều hướng Back/Forward đổi phiên trên URL; URL quick không có session
  // luôn đại diện cho danh sách, không giữ composer của phiên vừa mở.
  useEffect(() => {
    if (!sessionId) {
      if (currentId) {
        flushPromptDocument()
        setShowSessionBrowser(true)
        setPendingPreview(null)
      }
      return
    }
    if (sessionId !== currentId) {
      flushPromptDocument()
      lifecycleRef.current++
      preserveDocumentSessionRef.current = null
      currentIdRef.current = sessionId
      setShowSessionBrowser(false)
      setHydrating(true)
      setPendingPreview(null)
      clearSessionMedia()
      setLogoOverlays([])
      setAllowTemporaryMedia(true)
      setCurrentId(sessionId)
    }
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
    const documentRevision = documentRevisionRef.current
    setHydrating(true)
    // A just-flushed edit must reach the server before revisiting that session.
    documentSaveChainRef.current.then(() => Promise.all([
      quickSessionApi.get(currentId),
      generationApi.list({ quickSessionId: currentId, limit: 100 }),
    ]))
      .then(([sessionResult, generationResult]) => {
        if (!alive || currentIdRef.current !== currentId) return
        setSession(sessionResult.session)
        if (documentRevisionRef.current === documentRevision && preserveDocumentSessionRef.current !== currentId) {
          const document = sessionResult.session.promptDocument ?? { version: 1 as const, text: '', mentions: [] }
          promptDocumentRef.current = document
          setPromptDocument(document)
        }
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

  function applySettings(settings: QuickSettings, media?: Record<string, unknown>, targetMode: Mode = 'size' in settings ? 'image' : 'video'): void {
    const targetModel = models.find(item => item.id === settings.modelId)
    if (!targetModel) {
      pendingSettingsRef.current = { settings, media, mode: targetMode }
      setModelId(settings.modelId)
      return
    }
    pendingSettingsRef.current = null
    if (targetModel.kind !== targetMode) {
      pendingSettingsRef.current = { settings, media, mode: targetMode }
      setModelId(settings.modelId)
      return
    }
    if (targetModel) setProviderId(targetModel.providerId)
    if ('size' in settings) {
      setModelId(settings.modelId); setSize(settings.size); setQuality(settings.quality); setCount(settings.count)
    } else {
      setModelId(settings.modelId)
      const params = { ...settings.params, ...(media ?? {}) } as GenerationParamsInput
      if (typeof params.size === 'string') setVideoSize(params.size)
      if (typeof params.seconds === 'string' || typeof params.seconds === 'number') setSeconds(String(params.seconds))
      if (usesAgnes(models.find(item => item.id === settings.modelId))) setAgnesParams(params)
      else if (usesHiggsfield(models.find(item => item.id === settings.modelId))) setHfParams(params)
    }
  }

  useEffect(() => {
    const pending = pendingSettingsRef.current
    if (!pending || pending.mode !== mode || historyEditRef.current) return
    if (!models.some(item => item.id === pending.settings.modelId)) return
    pendingSettingsRef.current = null
    applySettings(pending.settings, pending.media)
  }, [models, mode])

  function switchMode(next: Mode): void {
    if (next === mode || busy || hydrating || settingsOpen || settingsBusyRef.current) return
    historyEditRef.current = false
    setEditingFrom(null)
    if (mode === 'image') modeSettingsRef.current.image = { modelId, size, quality, count }
    else modeSettingsRef.current.video = { modelId, params: stripMediaPreferenceKeys(isHiggsfield ? hfParams : isAgnes ? agnesParams : { size: videoSize, seconds }) }
    const settings = modeSettingsRef.current[next]
    if (settings) applySettings(settings, undefined, next)
    else if (quickPreferences[next]) applySettings(quickPreferences[next]!, undefined, next)
    else setModelId('')
    setSettingsOpen(false)
    onModeChange(next)
  }

  const modelsForMode = useMemo(
    () => models.filter((model) => model.kind === mode && model.enabled),
    [models, mode],
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
    // Keep unavailable saved/history models selected; generation remains blocked until explicit choice.
    if (modelId && !modelsForMode.some(model => model.id === modelId)
      && (savedModelIdsRef.current[mode] === modelId || historyEditRef.current)) return
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
  const isHiggsfield = mode === 'video' && usesHiggsfield(selectedModel)
  const [hfParams, setHfParams] = useState<GenerationParamsInput>({ mode: 'text', duration: 5, resolution: '720p', bitrateMode: 'high', generateAudio: true, aspectRatio: '16:9', outputFormat: 'mp4' })
  const maxVideoSeconds = isAgnes && selectedModel && isAgnesFlash(selectedModel.modelId) ? 12 : 30
  const invalidVideoSeconds = mode === 'video' && !isHiggsfield && !validVideoSeconds(isAgnes ? agnesParams.seconds ?? '5' : seconds, maxVideoSeconds)
  const imageReferenceDisabled = mode === 'image' && selectedModel?.imageReferenceSupport === 'no'
  const canOmitPrompt = isHiggsfield && hfParams.mode === 'image'
  const [visibleCount, setVisibleCount] = useState(6)
  const resultsRef = useRef<HTMLElement>(null)
  const modeResults = useMemo(() => sessionGenerations
    .filter(generation => generation.kind === mode && generation.quickSessionId === currentId)
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)), [sessionGenerations, mode, currentId])
  useEffect(() => { setVisibleCount(6) }, [currentId, mode])
  const activeVideos = modeResults.filter(generation => generation.kind === 'video' && isGenerationActive(generation))
  const activeVideo = activeVideos[0]
  const composerFingerprint = JSON.stringify([currentId, mode, promptDocument, modelId, size, videoSize, agnesParams, hfParams, quality, seconds, count, cast, sendReference, sources, logoOverlays, allowTemporaryMedia, purposeKind, purposeName, purposeDescription, videoSource])
  const composerFingerprintRef = useRef(composerFingerprint)
  composerFingerprintRef.current = composerFingerprint
  useEffect(() => {
    setPendingPreview(current => current && (current.fingerprint !== composerFingerprint || current.lifecycle !== lifecycleRef.current) ? null : current)
  }, [composerFingerprint, currentId])


  /** Ghi danh sách nhân vật vào phiên đang mở; chưa có phiên thì giữ tạm ở state. */
  function persistCast(next: string[]): void {
    setCast(next)
    // Chưa có phiên thì lưu tạm; đang đọc phiên thì bỏ qua để không ghi đè danh sách cũ.
    if (!currentId || hydrating) return
    quickSessionApi
      .update(currentId, { characterIds: next })
      .then((result) => {
        if (currentIdRef.current === result.session.id) setSession(result.session)
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
    if (busy || hydrating || settingsOpen || settingsBusyRef.current) return
    historyEditRef.current = false
    const defaults = quickPreferences[mode]
    if (defaults) applySettings(defaults)
    // Chọn "phiên chưa có tên" nghĩa là bắt đầu phiên mới chưa lưu.
    if (!id) {
      startNewSession()
      return
    }
    setShowSessionBrowser(false)
    flushPromptDocument()
    lifecycleRef.current++
    preserveDocumentSessionRef.current = null
    currentIdRef.current = id
    clearSessionMedia()
    setHydrating(true)
    setEditingFrom(null)
    setPendingPreview(null)
    setLogoOverlays([])
    setAllowTemporaryMedia(true)
    setCurrentId(id)
    onSelectSession?.(id)
  }

  /** Bắt đầu phiên mới: chưa ghi database, phiên được tạo ở lần tạo nội dung đầu tiên. */
  function startNewSession(): void {
    if (busy || hydrating || settingsOpen || settingsBusyRef.current) return
    historyEditRef.current = false
    const defaults = quickPreferences[mode]
    if (defaults) applySettings(defaults)
    setShowSessionBrowser(false)
    flushPromptDocument()
    lifecycleRef.current++
    documentRevisionRef.current++
    currentIdRef.current = ''
    clearSessionMedia()
    const document: PromptDocument = { version: 1, text: '', mentions: [] }
    promptDocumentRef.current = document
    setPromptDocument(document)
    setHydrating(false)
    setCurrentId('')
    setSession(null)
    setSessionGenerations([])
    setCast([])
    setTitleDraft('')
    setEditingFrom(null)
    setPendingPreview(null)
    setLogoOverlays([])
    setAllowTemporaryMedia(true)
    onSelectSession?.('')
  }

  function openSessionBrowser(): void {
    if (busy || hydrating || settingsOpen || settingsBusyRef.current) return
    flushPromptDocument()
    setPendingPreview(null)
    setShowSessionBrowser(true)
    onSelectSession?.('')
    // A generation may have completed while the composer was open; refresh its
    // session cover/count before returning to the browser.
    void quickSessionApi.list().then(result => setSessions(result.sessions)).catch(() => {})
  }

  async function removeSession(): Promise<void> {
    if (!currentId || busy || hydrating || settingsOpen || settingsBusyRef.current) return
    const removedId = currentId
    flushPromptDocument()
    try {
      await documentSaveChainRef.current
      await quickSessionApi.remove(removedId)
      const remaining = sessions.filter((item) => item.id !== removedId)
      setSessions(remaining)
      if (currentIdRef.current !== removedId) return
      const next = ''
      lifecycleRef.current++
      currentIdRef.current = next
      setHydrating(Boolean(next))
      setPendingPreview(null)
      setLogoOverlays([])
      setAllowTemporaryMedia(true)
      setCurrentId(next)
      if (!next) {
        // Không còn phiên nào: composer trở về trạng thái phiên mới.
        setSession(null)
        setSessionGenerations([])
        setCast([])
        setTitleDraft('')
        const document: PromptDocument = { version: 1, text: '', mentions: [] }
        promptDocumentRef.current = document
        setPromptDocument(document)
        setEditingFrom(null)
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
        if (currentIdRef.current === result.session.id) setSession(result.session)
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

  const uploadScope = useRef(0)
  function clearSessionMedia(): void {
    uploadScope.current += 1
    setSources([])
    setVideoSource(null)
    setLibrarySelections([])
    setUploadingSource(false)
    setAgnesParams(current => stripMediaPreferenceKeys(current))
    setHfParams(current => stripMediaPreferenceKeys(current))
    const savedVideoSettings = modeSettingsRef.current.video
    if (savedVideoSettings && 'params' in savedVideoSettings) {
      modeSettingsRef.current.video = { ...savedVideoSettings, params: stripMediaPreferenceKeys(savedVideoSettings.params) }
    }
    setPurposeKind('none')
    setPurposeName('')
    setPurposeDescription('')
  }
  const preserveCanvasComposerMedia = useRef(false)
  useEffect(() => {
    if (preserveCanvasComposerMedia.current) { preserveCanvasComposerMedia.current = false; return }
    clearSessionMedia()
  }, [currentId, mode])
  useEffect(() => {
    setLibrarySelections(items => items.filter(item => promptDocument.mentions.some(binding => binding.id === item.bindingId)))
  }, [promptDocument])

  function selectLibraryReference(selection: LibrarySelection) {
    const { entity, uploadId } = selection
    if (librarySelections.some(item => item.entity.id === entity.id && item.entity.kind === entity.kind)) return
    if (mode === 'video' && (!entity.reference || !uploadId)) { setError(new Error(t('referenceMissing'))); return }
    if (mode === 'image' && sources.length + librarySelections.length >= MAX_SOURCE_IMAGES) { setError(new Error(t('referenceLimit'))); return }
    let slot: 'image' | 'endImage' | undefined
    if (mode === 'video' && isHiggsfield) {
      if (hfParams.mode !== 'image' && !window.confirm(t('switchImageMode'))) return
      slot = referenceSlot
      if (hfParams[`${slot}UploadId`] || hfParams[`${slot}AssetId`] || hfParams[`${slot}Url`]) { setError(new Error(t('oneVideoReference'))); return }
      const next = { ...hfParams, mode: 'image' as const }
      delete next.aspectRatio; delete next.outputFormat
      delete next[`${slot}AssetId`]; delete next[`${slot}Url`]
      next[`${slot}UploadId`] = uploadId
      setHfParams(next)
    } else if (mode === 'video' && !isAgnes) {
      if (videoSource) { setError(new Error(t('oneVideoReference'))); return }
      setVideoSource({ kind: 'upload', id: uploadId!, url: `/api/uploads/${encodeURIComponent(uploadId!)}` })
    } else if (mode === 'video' && isAgnes) {
      if (!allowTemporaryMedia && !window.confirm(t('temporaryMediaConfirm'))) return
      setAllowTemporaryMedia(true)
      setAgnesParams(current => ({ ...current, mode: 'reference' }))
    }
    const current = promptDocumentRef.current
    const spaced = current.text && !/\s$/.test(current.text) ? updatePromptDocument(current, `${current.text} `) : current
    const next = insertPromptMention(spaced, spaced.text.length, spaced.text.length, { kind: entity.kind, id: entity.id, ...(entity.kind === 'location' && uploadId ? { viewUploadId: uploadId } : {}) }, entity.handle)
    const bindingId = next.mentions.find(binding => !current.mentions.some(old => old.id === binding.id))!.id
    changePromptDocument(next)
    setLibrarySelections(items => [...items, { ...selection, bindingId, slot }])
  }

  function removeLibraryReference(selection: typeof librarySelections[number]) {
    const current = promptDocumentRef.current
    const binding = current.mentions.find(item => item.id === selection.bindingId)
    if (binding) changePromptDocument(updatePromptDocument(current, current.text.slice(0,binding.start)+current.text.slice(binding.end)))
    if (mode === 'video' && selection.slot) setHfParams(current => {
      const next = { ...current }; const key = `${selection.slot!}UploadId` as 'imageUploadId'|'endImageUploadId'; if (next[key] === selection.uploadId) delete next[key]; return next
    })
    else if (mode === 'video' && !isAgnes && videoSource?.id === selection.uploadId) setVideoSource(null)
    setLibrarySelections(items => items.filter(item => item.bindingId !== selection.bindingId))
  }

  async function addSourceFiles(files: FileList | null): Promise<void> {
    if (!files?.length || imageReferenceDisabled) return
    const scope = uploadScope.current
    setUploadingSource(true)
    setError(null)
    try {
      const room = MAX_SOURCE_IMAGES - sources.length - librarySelections.length
      if (files.length > room) throw new Error(t('referenceLimit'))
      const uploaded: SourceUpload[] = []
      for (const file of Array.from(files).slice(0, Math.max(room, 0))) {
        uploaded.push(await uploadApi.upload(file))
      }
      if (scope !== uploadScope.current) return
      setSources((current) => [
        ...current,
        ...uploaded.map((item): QuickSource => ({ kind: 'upload', id: item.id, url: item.url })),
      ])
    } catch (cause) {
      if (scope === uploadScope.current) setError(cause)
    } finally {
      if (scope === uploadScope.current) setUploadingSource(false)
    }
  }

  /**
   * Nạp lại mô tả và tham số của nội dung cũ để sửa.
   *
   * Chỉ điền vào composer; bấm Tạo sẽ sinh thêm một nội dung mới trong cùng phiên,
   * còn nội dung cũ vẫn được giữ nguyên.
   */
  function editFrom(generation: Generation): void {
    historyEditRef.current = true
    setEditingFrom(generation)
    setPurposeKind(generation.imagePurpose?.kind ?? 'none')
    setPurposeName(generation.imagePurpose?.name ?? '')
    setPurposeDescription(generation.imagePurpose?.description ?? '')
    onModeChange(generation.kind)
    const document = (generation as Generation & { promptDocument?: PromptDocument | null }).promptDocument
      ?? { version: 1 as const, text: generation.prompt, mentions: [] }
    changePromptDocument(document)
    const params = (generation.params ?? {}) as Record<string, unknown>
    setPendingPreview(null)
    setLogoOverlays(restoreLogoOverlays(params.logoOverlays, document))
    setAllowTemporaryMedia(params.allowTemporaryMedia !== false)
    if (typeof params.size === 'string') {
      if (generation.kind === 'image') setSize(params.size)
      else setVideoSize(params.size)
    }
    if (generation.kind === 'video') {
      setAgnesParams(params as GenerationParamsInput)
      if (generation.model.startsWith('bytedance/seedance-2.5')) setHfParams(params as GenerationParamsInput)
    }
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
    if (busy || hydrating || !preferencesLoaded || preferencesError || settingsOpen || settingsBusyRef.current || invalidVideoSeconds || (mode === 'image' && purposeKind !== 'none' && !purposeName.trim()) || (!prompt.trim() && !canOmitPrompt) || !selectedModel) return
    // Freeze every input before any async work. Keep UTF-16 mention spans exact.
    const document = structuredClone(promptDocumentRef.current)
    const lifecycle = lifecycleRef.current
    const fingerprint = composerFingerprintRef.current
    const params: GenerationParamsInput = mode === 'image'
      ? { size, ...(quality ? { quality } : {}), n: count }
      : isHiggsfield ? { ...hfParams, useCharacterReference: false } : isAgnes ? agnesInput(agnesParams, selectedModel) : { size: videoSize, seconds }
    const uploadIds = sources.filter(item => item.kind === 'upload').map(item => item.id)
    const assetIds = sources.filter(item => item.kind === 'asset').map(item => item.id)
    const input: GenerationCreateInput = structuredClone({
      modelId: selectedModel.id,
      ...(mode === 'image' && purposeKind !== 'none' ? { imagePurpose: { kind: purposeKind, name: purposeName.trim(), description: purposeDescription.trim() } } : {}),
      prompt: document.text,
      promptDocument: document,
      logoOverlays,
      allowTemporaryMedia,
      params: { ...params, ...(cast.length ? { useCharacterReference: !isAgnes && !isHiggsfield && willSendReference } : {}) },
      ...(cast[0] ? { characterId: cast[0] } : {}),
      ...(cast.length ? { characterIds: cast } : {}),
      ...(mode === 'video' && !isHiggsfield && videoSource ? { videoInput: videoSource.kind === 'upload' ? { uploadId: videoSource.id } : { assetId: videoSource.id } } : {}),
      ...(mode === 'image' && uploadIds.length ? { sourceUploadIds: uploadIds } : {}),
      ...(mode === 'image' && assetIds.length ? { sourceAssetIds: assetIds } : {}),
      ...(currentId ? { quickSessionId: currentId } : {}),
      idempotencyKey: crypto.randomUUID(),
    })
    const video = mode === 'video'
    const action = async (): Promise<void> => {
      if (lifecycleRef.current !== lifecycle) return
      setPendingPreview(null)
      setError(null)
      setBusy(true)
      setSendingVideo(video)
      setSendingPrompt(document.text)
      flushPromptDocument()
      try {
        await documentSaveChainRef.current
        let id = input.quickSessionId
        if (!id) {
          const created = await quickSessionApi.create({
            title: document.text.trim().slice(0, 60), characterIds: input.characterIds ?? [], promptDocument: document,
          })
          id = created.session.id
          setSessions(current => [created.session, ...current])
          if (lifecycleRef.current !== lifecycle) return
          setSession(created.session)
          setTitleDraft(created.session.title)
          preserveDocumentSessionRef.current = id
          currentIdRef.current = id
          setCurrentId(id)
          onSelectSession?.(id)
        }
        if (lifecycleRef.current !== lifecycle) return
        if (JSON.stringify(promptDocumentRef.current) !== JSON.stringify(document)) changePromptDocument(promptDocumentRef.current)
        const result = await generationApi.create({ ...input, quickSessionId: id })
        if (currentIdRef.current === id) setSessionGenerations(current => [result.generation, ...current.filter(generation => generation.id !== result.generation.id)])
        onCreated(result.generation)
        onNotify(notification('studio', 'notifyRequestSent'))
        if (lifecycleRef.current === lifecycle && currentIdRef.current === id) setEditingFrom(null)
      } catch (cause) {
        if (lifecycleRef.current === lifecycle) setError(cause)
      } finally {
        setBusy(false)
        setSendingVideo(false)
      }
    }
    if (!document.mentions.length && !logoOverlays.length && !allowTemporaryMedia) {
      await action() // Legacy plain prompts remain single-click.
      return
    }
    setError(null)
    setBusy(true)
    try {
      const { preview } = await generationApi.preview(input)
      if (lifecycleRef.current === lifecycle && composerFingerprintRef.current === fingerprint) {
        setPendingPreview({ input, preview: dialogPreview(preview), action, fingerprint, lifecycle })
      }
    } catch (cause) {
      if (lifecycleRef.current === lifecycle) setError(cause)
    } finally {
      setBusy(false)
    }
  }

  async function openCanvas(): Promise<void> {
    if (busy || hydrating || openingCanvas || settingsOpen || settingsBusyRef.current) return
    const hasUnsupportedCanvasMedia = mode === 'video' && (
      (isHiggsfield && (['imageUrl', 'endImageUrl', 'endImageUploadId', 'endImageAssetId'] as const).some(key => Boolean(hfParams[key])))
      || (isAgnes && (['firstFrame', 'lastFrame', 'referenceImages', 'referenceAudios'] as const).some(key => Boolean(agnesParams[key]) && (!Array.isArray(agnesParams[key]) || (agnesParams[key] as unknown[]).length > 0)))
    )
    if (hasUnsupportedCanvasMedia && !window.confirm(t('quickCanvasMediaNotice'))) return
    const lifecycle = lifecycleRef.current
    const document = structuredClone(promptDocumentRef.current)
    const canvasVideoInput = videoSource ? (videoSource.kind === 'upload' ? { uploadId: videoSource.id } : { assetId: videoSource.id })
      : mode === 'video' && isHiggsfield ? (typeof hfParams.imageUploadId === 'string' ? { uploadId: hfParams.imageUploadId } : typeof hfParams.imageAssetId === 'string' ? { assetId: hfParams.imageAssetId } : undefined) : undefined
    const draft = {
      promptDocument: document, kind: mode, ...(modelId ? { modelId } : {}),
      ...(mode === 'image' ? { imageSettings: { size, ...(quality ? { quality } : {}), n: count } } : modelId ? {
        videoSettings: { modelId, params: stripMediaPreferenceKeys(isHiggsfield ? hfParams : isAgnes ? agnesParams : { size: videoSize, seconds }) },
      } : {}),
      ...(mode === 'image' && purposeKind !== 'none' && purposeName.trim() ? { imagePurpose: { kind: purposeKind, name: purposeName.trim(), description: purposeDescription } } : {}),
      sourceUploadIds: [...new Set([...sources.filter(item => item.kind === 'upload').map(item => item.id), ...(mode === 'image' ? librarySelections.flatMap(item => item.uploadId ? [item.uploadId] : []) : [])])],
      sourceAssetIds: sources.filter(item => item.kind === 'asset').map(item => item.id),
      ...(canvasVideoInput ? { videoInput: canvasVideoInput } : {}),
      logoOverlays: structuredClone(logoOverlays), allowTemporaryMedia,
    }
    setOpeningCanvas(true)
    setError(null)
    try {
      flushPromptDocument()
      await documentSaveChainRef.current
      let id = currentIdRef.current
      if (!id) {
        const result = await quickSessionApi.create({ title: titleDraft.trim() || document.text.trim().slice(0, 60), characterIds: cast, promptDocument: document })
        if (!mountedRef.current || lifecycleRef.current !== lifecycle) return
        id = result.session.id
        setSessions(current => [result.session, ...current])
        setSession(result.session)
        setTitleDraft(result.session.title)
        preserveDocumentSessionRef.current = id
        preserveCanvasComposerMedia.current = true
        currentIdRef.current = id
        setCurrentId(id)
        onSelectSession?.(id)
      } else {
        // A failed debounced draft write must not be silently ignored on navigation.
        await quickSessionApi.update(id, { promptDocument: document })
      }
      const api = quickSessionCanvasApi(id)
      const result = await api.get()
      if (result.canvas.revision === 0) await api.sync(0, draft)
      if (!mountedRef.current || currentIdRef.current !== id) return
      setPendingPreview(null)
      onViewChange?.('canvas')
    } catch (cause) {
      if (mountedRef.current) setError(cause)
    } finally {
      if (mountedRef.current) setOpeningCanvas(false)
    }
  }

  function focusResults() {
    const target = resultsRef.current
    if (!target) return
    target.focus({ preventScroll: true })
    target.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })
  }

  const formatSessionDate = (timestamp: number): string => new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(timestamp))

  if (showSessionBrowser) {
    const orderedSessions = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))
    return (
      <div className="page-content studio-page" data-testid="quick-session-browser">
        <section className="page-heading">
          <div>
            <div className="eyebrow"><span className="eyebrow-dot" /> {t('studioEyebrow')}</div>
            <h1>{t('sessionBrowserTitle')}</h1>
            <p>{t('sessionBrowserIntro')}</p>
          </div>
          <button type="button" className="primary-small-button" data-testid="quick-new-session" onClick={startNewSession}>
            <Plus size={16} /> {t('sessionNew')}
          </button>
        </section>
        {loading ? (
          <div className="empty-state"><LoaderCircle size={26} className="spin" /><h3>{t('loadingShort')}</h3></div>
        ) : orderedSessions.length ? (
          <section className="quick-session-grid" aria-label={t('sessionBrowserTitle')}>
            {orderedSessions.map(item => {
              const coverSrc = item.coverAssetId ? `/api/assets/${encodeURIComponent(item.coverAssetId)}` : null
              const coverFailed = Boolean(item.coverAssetId && failedCoverAssets.has(item.coverAssetId))
              const isVideoCover = item.coverMimeType?.startsWith('video/') ?? false
              return (
                <article className="quick-session-card" key={item.id}>
                  <button type="button" className="quick-session-open" onClick={() => selectSession(item.id)} aria-label={t('sessionOpen', { title: item.title || t('sessionUntitled') })}>
                    <div className="quick-session-cover">
                      {coverSrc && !coverFailed ? (
                        isVideoCover ? (
                          <video src={coverSrc} muted playsInline loop autoPlay preload="metadata" aria-hidden="true"
                            onError={() => setFailedCoverAssets(current => new Set(current).add(item.coverAssetId!))} />
                        ) : (
                          <img src={coverSrc} alt="" loading="lazy"
                            onError={() => setFailedCoverAssets(current => new Set(current).add(item.coverAssetId!))} />
                        )
                      ) : (
                        <div className="quick-session-placeholder" aria-hidden="true"><Sparkles size={25} /></div>
                      )}
                      <div className="quick-session-cover-shade" />
                      <div className="quick-session-cover-copy">
                        <h3>{item.title || t('sessionUntitled')}</h3>
                        <div className="quick-session-meta">
                          <span>{t('sessionContentCount', { count: item.generationCount })}</span>
                          {item.activeCount > 0 && <span className="quick-session-status">{t('sessionActiveCount', { count: item.activeCount })}</span>}
                        </div>
                        <span className="quick-session-updated"><Clock3 size={12} /> {formatSessionDate(item.updatedAt)}</span>
                      </div>
                    </div>
                  </button>
                </article>
              )
            })}
          </section>
        ) : (
          <div className="empty-state" data-testid="quick-session-empty">
            <Sparkles size={28} />
            <h3>{t('sessionBrowserEmptyTitle')}</h3>
            <p>{t('sessionBrowserEmptyHint')}</p>
            <button type="button" className="secondary-button" onClick={() => leaveCanvas(() => { onViewChange?.('form'); startNewSession() })}><Plus size={15} /> {t('sessionNew')}</button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="page-content studio-page">
      {settingsOpen && preferencesLoaded && <QuickGenerationSettingsModal models={models} mode={mode} initialSettings={mode === 'image' ? { modelId, size, quality, count } : { modelId, params: isHiggsfield ? hfParams : isAgnes ? agnesParams : { size: videoSize, seconds } }} initialMediaParams={mode === 'video' ? videoMediaPreferenceParams(isHiggsfield ? hfParams : isAgnes ? agnesParams : {}) : undefined} onClose={() => setSettingsOpen(false)} onSave={async (settings, media) => {
        const saveMode = mode
        settingsBusyRef.current = true
        try {
          const saved = await quickGenerationPreferencesApi.save(saveMode, settings)
          if (!mountedRef.current) return
          const result = saved.settings
          setQuickPreferences(current => ({ ...current, [saveMode]: result } as QuickPreferences))
          modeSettingsRef.current[saveMode] = result
          savedModelIdsRef.current[saveMode] = result.modelId
          if (modeRef.current === saveMode) applySettings(result, media)
        } finally { settingsBusyRef.current = false }
      }} />}
      {pendingPreview && <GenerationPreviewDialog preview={pendingPreview.preview} disabled={busy}
        onCancel={() => setPendingPreview(null)} onConfirm={() => {
          if (pendingPreview.fingerprint !== composerFingerprintRef.current || pendingPreview.lifecycle !== lifecycleRef.current) {
            setPendingPreview(null)
            return
          }
          void pendingPreview.action()
        }} />}
      <section className="page-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-dot" /> {t('studioEyebrow')}</div>
          <h1>{t('studioHeadingLead')}<em>{t('studioHeadingEmphasis')}</em></h1>
          <p>{t('studioIntro')}</p>
        </div>
        <button type="button" className="secondary-button" data-testid="quick-canvas-toggle" disabled={openingCanvas || busy || hydrating || settingsOpen} onClick={() => view === 'canvas' ? leaveCanvas(() => onViewChange?.('form')) : void openCanvas()}>
          {openingCanvas ? <LoaderCircle size={16} className="spin" /> : <Workflow size={16} />} {t(view === 'canvas' ? 'quickBackToForm' : 'quickOpenCanvas')} <ArrowUpRight size={15} />
        </button>
      </section>

      <section className="quick-workspace-toolbar" aria-label={t('sessionLabel')}>
          <div className="quick-session-navigation">
            <button type="button" className="quick-session-back-button" data-testid="quick-session-back" onClick={() => leaveCanvas(openSessionBrowser)}>
              <ArrowLeft size={15} /> {t('sessionBackToList')}
            </button>
          </div>
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
              onChange={id => leaveCanvas(() => { if (!id) onViewChange?.('form'); selectSession(id) })}
            />
            <label className="quick-session-name"><span>{t('sessionTitleLabel')}</span><input
              className="quick-session-title"
              value={titleDraft}
              placeholder={t('sessionTitlePlaceholder')}
              aria-label={t('sessionTitleLabel')}
              disabled={!currentId}
              onChange={(event) => setTitleDraft(event.target.value)}
              onBlur={saveTitle}
            /></label>
            <button type="button" className="secondary-button" onClick={() => leaveCanvas(() => { onViewChange?.('form'); startNewSession() })}>
              <Plus size={15} /> {t('sessionNew')}
            </button>
            {currentId && (
              <button
                type="button"
                className="text-button quick-session-delete"
                title={t('sessionDeleteHint')}
                onClick={() => leaveCanvas(() => { onViewChange?.('form'); void removeSession() })}
              >
                {t('sessionDelete')}
              </button>
            )}
          </div>

      </section>

      {view === 'canvas' && currentId && <section className="quick-canvas-workspace" data-testid="quick-canvas-workspace">
        <CanvasBoard key={currentId} quickSessionId={currentId} contextMode="quick" projectName={titleDraft || t('sessionUntitled')} models={models} onNotify={onNotify} onBack={() => leaveCanvas(() => onViewChange?.('form'))} onRegisterNavigationGuard={registerCanvasGuard} />
      </section>}
      {view === 'canvas' && !currentId && <div className="empty-state"><button type="button" className="secondary-button" disabled={openingCanvas || hydrating} onClick={() => void openCanvas()}>{t('quickOpenCanvas')}</button></div>}
      <div className="studio-grid" hidden={view === 'canvas'}>
        <section className="composer-card panel-card">
          <div className="mode-tabs" role="group" aria-label={t('configSection')}>
            <button type="button" aria-pressed={mode === 'image'} className={mode === 'image' ? 'active' : ''} onClick={() => switchMode('image')}>
              <ImageIcon size={17} /> {t('modeImage')}
            </button>
            <button type="button" aria-pressed={mode === 'video'} className={mode === 'video' ? 'active' : ''} onClick={() => switchMode('video')}>
              <Video size={17} /> {t('modeVideo')} <span className="beta-pill">{t('betaBadge')}</span>
            </button>
          </div>

          <button type="button" className="text-button quick-results-shortcut" onClick={() => focusResults()}>
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
              <EntityMentionTextarea
                id="prompt"
                onBlur={flushPromptDocument}
                document={promptDocument}
                onChange={changePromptDocument}
                placeholder={t('promptPlaceholder')}
                disabled={loading || hydrating}
                maxLength={PROMPT_MAX_LENGTH}
              />

            </div>

            <div className="control-section quick-config-card">
              <div><div className="section-title">{t('configSection')}</div><p className="quick-config-hint">{t('quickConfigHint')}</p></div>
              {preferencesLoaded ? <button type="button" className="secondary-button quick-config-trigger" disabled={busy || hydrating || settingsBusyRef.current} onClick={() => { if (!busy && !hydrating && !settingsBusyRef.current) setSettingsOpen(true) }}><Settings2 size={16}/>{t('quickConfigTitle')}</button> : preferencesError ? <div role="alert" className="form-error">{t('quickConfigLoadFailed')} <button type="button" className="text-button" onClick={() => void retryPreferences()}>{t('quickConfigRetry')}</button></div> : <p>{t('quickConfigLoading')}</p>}
              {editingFrom && editingFrom.kind === mode && (!editingFrom.modelId || !models.some(item => item.id === editingFrom.modelId && item.enabled && item.kind === mode)) && <p className="form-error" role="alert">{t('quickConfigUnavailable')}</p>}
              {preferencesLoaded && (() => {
                const currentModel = models.find(item => item.id === modelId)
                if (!modelId && !currentModel) return <p className="quick-config-summary">{t('statusNoApi')}</p>
                const unavailable = !currentModel || !currentModel.enabled || currentModel.kind !== mode
                const name = currentModel ? `${currentModel.providerName} · ${currentModel.displayName}` : modelId
                const details = mode === 'image'
                  ? `${size.replace('x', ' × ')} px · ${quality ? t(IMAGE_QUALITIES.find(item => item.value === quality)?.labelKey ?? 'qualityDefault') : t('qualityDefault')} · ${t('imageCountOption', { count })}`
                  : isHiggsfield
                    ? `${String(hfParams.duration ?? hfParams.seconds ?? '—')}s · ${String(hfParams.resolution ?? hfParams.size ?? '')}`.trim()
                    : isAgnes
                      ? `${String(agnesParams.seconds ?? seconds)}s · ${String(agnesParams.size ?? videoSize)}`.trim()
                      : `${seconds}s · ${videoSize}`
                return <><p className="quick-config-summary">{t('quickConfigSummary', { model: name, details })}</p>{unavailable && <p className="form-error" role="alert">{t('quickConfigUnavailable')}</p>}</>
              })()}
            </div>

            <div className="quick-create-actions">
            {error != null && (
              <div className="form-error" role="alert" title={rawErrorDetail(error)}>
                {errorMessage(error)}
              </div>
            )}
            <button
              type="button"
              aria-describedby="quick-create-help"
              className="generate-button"
              onClick={generate}
              disabled={busy || hydrating || !preferencesLoaded || !!preferencesError || settingsOpen || settingsBusyRef.current || invalidVideoSeconds || (mode === 'image' && purposeKind !== 'none' && !purposeName.trim()) || (!prompt.trim() && !canOmitPrompt) || !selectedModel}
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
              <button type="button" className="text-button" onClick={() => focusResults()}>{t('videoViewProgress')} <ArrowUpRight size={14} /></button>
            </div>}
            <p className="cost-note">
              {selectedModel ? t('costNoteWithModel') : t('costNoteNoModel')}
            </p>
            <p id="quick-create-help" className="quick-create-help" role="status">
              {busy ? t('sending') : loading || hydrating ? t('loadingShort') : preferencesError ? t('quickConfigLoadFailed') : !preferencesLoaded ? t('quickConfigLoading') : !selectedModel ? t('statusNoApi') : invalidVideoSeconds ? t('quickDurationInvalid') : mode === 'image' && purposeKind !== 'none' && !purposeName.trim() ? t('quickPurposeRequired') : !prompt.trim() && !canOmitPrompt ? t('quickPromptRequired') : t('statusReady')}
            </p>
            </div>
            <p className="quick-optional-intro">{t('quickOptionalHint')}</p>
            <details className="quick-option-group" ref={referencesGroupRef}>
              <summary>{t('quickReferences')}<span>{sources.length + librarySelections.length + (videoSource ? 1 : 0)}</span></summary>
              <div className="quick-option-body">
              {mode === 'video' && isHiggsfield && <label className="select-control"><span>{t('referenceSlot')}</span><select value={referenceSlot} onChange={e=>setReferenceSlot(e.target.value as 'image'|'endImage')}><option value="image">{t('hfStartFrame')}</option><option value="endImage">{t('hfEndFrame')}</option></select></label>}
              <QuickLibraryPicker disabled={loading || hydrating || busy} selectedKeys={librarySelections.map(item=>`${item.entity.kind}:${item.entity.id}`)} onSelect={selectLibraryReference} />
              <div className="project-source-strip">{librarySelections.map(selection=><div className="project-source-item" key={selection.bindingId}>
                {selection.uploadId && <img src={`/api/uploads/${encodeURIComponent(selection.uploadId)}`} alt={selection.entity.name}/>}
                <span>{selection.entity.name}{selection.label ? ` · ${selection.label}` : ''}</span>
                <button type="button" aria-label={t('removeSourceImageAria')} onClick={()=>removeLibraryReference(selection)}><X size={13}/></button>
              </div>)}</div>
              <div className="prompt-footer">
                <button className="attach-button" onClick={() => onNavigate('characters')}>
                  <Upload size={15} /> {t('manageReferences')}
                </button>
              </div>
            {mode === 'video' && !isHiggsfield && <div className="control-section">
              <label className="select-control"><span>{t('videoInputImage')}</span><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy || uploadingSource} onChange={async e => {
                const file=e.target.files?.[0];e.target.value='';if(!file)return;const scope=uploadScope.current;setUploadingSource(true)
                try {const upload=await uploadApi.upload(file);if(scope!==uploadScope.current)return;setVideoSource({kind:'upload',id:upload.id,url:upload.url});if(isAgnes)setAgnesParams(current=>({...current,mode:'keyframe'}))}catch(cause){if(scope===uploadScope.current)setError(cause)}finally{if(scope===uploadScope.current)setUploadingSource(false)}
              }} /></label>
              {videoSource && <div><img src={videoSource.url} alt="" style={{maxWidth:160,maxHeight:120}}/><button type="button" className="secondary-button" onClick={()=>setVideoSource(null)}>{t('removeSourceImageAria')}</button></div>}
              <p className="project-hint">{t(isAgnes ? 'videoInputAgnesHint' : 'videoInputOpenaiHint')}</p>
            </div>}
            {mode === 'image' && (
              <div className="project-source quick-source">
                <span className="project-reference-label">{t('sourceImagesLabel')}</span>
                <p className="project-hint">{t(imageReferenceDisabled ? 'imageReferencesUnsupported' : 'imageReferencesCapabilityHint')}</p>
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
                        disabled={uploadingSource || imageReferenceDisabled}
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
                <details className="quick-reference-help">
                  <summary>{t('sourceImagesLabel')}</summary>
                  <p className="project-hint">
                    {t('sourceImagesHintPrefix', { max: MAX_SOURCE_IMAGES })}
                    <code> /images/edits </code>
                    {t('sourceImagesHintSuffix')}
                  </p>
                </details>
                {sources.some((item) => item.kind === 'asset') && (
                  <span className="project-hint">{t('useAsSourceHint')}</span>
                )}
              </div>
            )}

              </div>
            </details>
            <details className="quick-option-group" ref={charactersGroupRef}>
              <summary>{t('sessionCharactersLabel')}<span>{cast.length}</span></summary>
              <div className="quick-option-body">
            <div className="quick-character">
              <div className="field-label-row">
                <span className="section-title">{t('sessionCharactersLabel')}</span>
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

              </div>
            </details>
            <details className="quick-option-group" ref={optionsGroupRef}>
              <summary>{t('quickOptional')}</summary>
              <div className="quick-option-body">
            {mode === 'image' && <div className="control-section">
              <label className="select-control"><span>{t('imagePurposeLabel')}</span><select value={purposeKind} onChange={e => setPurposeKind(e.target.value as typeof purposeKind)}>
                {(['none','item','location','logo'] as const).map(kind => <option key={kind} value={kind}>{t(`imagePurpose_${kind}`)}</option>)}
              </select></label>
              {purposeKind !== 'none' && <label className="select-control"><span>{t('imagePurposeName')}</span><input maxLength={200} value={purposeName} onChange={e => setPurposeName(e.target.value)} /></label>}
              {purposeKind !== 'none' && <label className="select-control"><span>{t('imagePurposeDescription')}</span><textarea maxLength={5000} value={purposeDescription} onChange={e=>setPurposeDescription(e.target.value)} /></label>}
              <p className="project-hint">{t('imagePurposeHint')}</p>
            </div>}
            <EntityGenerationOptions document={promptDocument} overlays={logoOverlays}
              onOverlaysChange={setLogoOverlays} allowTemporaryMedia={allowTemporaryMedia}
              onAllowTemporaryMediaChange={setAllowTemporaryMedia} disabled={busy || loading || hydrating} />

              </div>
            </details>

          </div>
        </section>

        <section className="preview-column quick-session-results" ref={resultsRef} tabIndex={-1} aria-label={t(mode === 'image' ? 'quickImagesTitle' : 'quickVideosTitle')}>
          <div className="preview-header">
            <div>
              <div className="section-kicker">{t('recentResults')} · {t('quickNewestFirst')}</div>
              <h2>{t(mode === 'image' ? 'quickImagesTitle' : 'quickVideosTitle')} <span className="quick-results-count">{modeResults.length}</span></h2>
            </div>
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
                    onUpdated={updated => setSessionGenerations(current => current.map(item => item.id === updated.id ? updated : item))}
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
