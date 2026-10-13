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
  type GenerationCreateInput,
  type GenerationPreview,
  type LogoOverlay,
} from '../api/endpoints'
import type { Generation, GenerationParamsInput, ModelInfo, Mode } from '../api/types'
import type { ProjectCharacter } from '../api/projectTypes'
import { CreationCard, SelectControl, GenerationProgress, isGenerationActive } from '../components/Common'
import { AgnesVideoControls, agnesInput, usesAgnes } from '../components/AgnesVideoControls'
import { EntityMentionTextarea } from '../components/EntityMentionTextarea'
import { EntityGenerationOptions, GenerationPreviewDialog, type EntityGenerationPreview } from '../components/EntityGenerationOptions'
import type { PromptDocument } from '../../shared/promptMentions'
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

/** Restore only the public placement spec, never server-owned paths from snapshots. */
function restoreLogoOverlays(value: unknown, document: PromptDocument): LogoOverlay[] {
  const bound = new Set(document.mentions.filter(binding => binding.entity.kind === 'logo').map(binding => binding.entity.id))
  if (!Array.isArray(value)) return []
  return value.flatMap(spec => {
    if (!spec || typeof spec !== 'object' || !bound.has(spec.entityId)
      || !['x', 'y', 'width', 'opacity'].every(key => typeof spec[key] === 'number' && Number.isFinite(spec[key]))) return []
    return [{ entityId: spec.entityId as string, x: spec.x as number, y: spec.y as number, width: spec.width as number, opacity: spec.opacity as number }]
  }).slice(0, 8)
}

function dialogPreview(preview: GenerationPreview): EntityGenerationPreview {
  return { ...preview, entities: preview.entities.flatMap(entity => {
    const kind = entity.kind
    return kind === 'character' || kind === 'item' || kind === 'logo' ? [{ ...entity, kind }] : []
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
}: Props) {
  const { t, locale } = useTranslation(studioCatalog)
  const [promptDocument, setPromptDocument] = useState<PromptDocument>({ version: 1, text: '', mentions: [] })
  const prompt = promptDocument.text
  const [logoOverlays, setLogoOverlays] = useState<LogoOverlay[]>([])
  const [allowTemporaryMedia, setAllowTemporaryMedia] = useState(false)
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
        if (currentIdRef.current === pending.sessionId) setError(cause)
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
    const lifecycle = lifecycleRef.current
    setLoading(true)
    quickSessionApi
      .list()
      .then((result) => {
        if (!alive) return
        setSessions(result.sessions)
        if (lifecycleRef.current !== lifecycle) return
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
    if (sessionId && sessionId !== currentId) {
      flushPromptDocument()
      lifecycleRef.current++
      preserveDocumentSessionRef.current = null
      currentIdRef.current = sessionId
      setHydrating(true)
      setPendingPreview(null)
      setLogoOverlays([])
      setAllowTemporaryMedia(false)
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
  const composerFingerprint = JSON.stringify([mode, promptDocument, modelId, size, videoSize, agnesParams, quality, seconds, count, cast, sendReference, sources, logoOverlays, allowTemporaryMedia])
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
    // Chọn "phiên chưa có tên" nghĩa là bắt đầu phiên mới chưa lưu.
    if (!id) {
      startNewSession()
      return
    }
    flushPromptDocument()
    lifecycleRef.current++
    preserveDocumentSessionRef.current = null
    currentIdRef.current = id
    setHydrating(true)
    setEditingFrom(null)
    setPendingPreview(null)
    setLogoOverlays([])
    setAllowTemporaryMedia(false)
    setCurrentId(id)
    onSelectSession?.(id)
  }

  /** Bắt đầu phiên mới: chưa ghi database, phiên được tạo ở lần tạo nội dung đầu tiên. */
  function startNewSession(): void {
    flushPromptDocument()
    lifecycleRef.current++
    documentRevisionRef.current++
    currentIdRef.current = ''
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
    setAllowTemporaryMedia(false)
    onSelectSession?.('')
  }

  async function removeSession(): Promise<void> {
    if (!currentId) return
    const removedId = currentId
    flushPromptDocument()
    try {
      await documentSaveChainRef.current
      await quickSessionApi.remove(removedId)
      const remaining = sessions.filter((item) => item.id !== removedId)
      setSessions(remaining)
      if (currentIdRef.current !== removedId) return
      const next = remaining[0]?.id ?? ''
      lifecycleRef.current++
      currentIdRef.current = next
      setHydrating(Boolean(next))
      setPendingPreview(null)
      setLogoOverlays([])
      setAllowTemporaryMedia(false)
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
    const document = (generation as Generation & { promptDocument?: PromptDocument | null }).promptDocument
      ?? { version: 1 as const, text: generation.prompt, mentions: [] }
    changePromptDocument(document)
    const params = (generation.params ?? {}) as Record<string, unknown>
    setPendingPreview(null)
    setLogoOverlays(restoreLogoOverlays(params.logoOverlays, document))
    setAllowTemporaryMedia(params.allowTemporaryMedia === true)
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
    // Freeze every input before any async work. Keep UTF-16 mention spans exact.
    const document = structuredClone(promptDocumentRef.current)
    const lifecycle = lifecycleRef.current
    const fingerprint = composerFingerprintRef.current
    const params: GenerationParamsInput = mode === 'image'
      ? { size, ...(quality ? { quality } : {}), n: count }
      : isAgnes ? agnesInput(agnesParams, selectedModel) : { size: videoSize, seconds }
    const uploadIds = sources.filter(item => item.kind === 'upload').map(item => item.id)
    const assetIds = sources.filter(item => item.kind === 'asset').map(item => item.id)
    const input: GenerationCreateInput = structuredClone({
      modelId: selectedModel.id,
      prompt: document.text,
      promptDocument: document,
      logoOverlays,
      allowTemporaryMedia,
      params: { ...params, ...(cast.length ? { useCharacterReference: !isAgnes && willSendReference } : {}) },
      ...(cast[0] ? { characterId: cast[0] } : {}),
      ...(cast.length ? { characterIds: cast } : {}),
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

  return (
    <div className="page-content studio-page">
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
              <EntityMentionTextarea
                id="prompt"
                onBlur={flushPromptDocument}
                document={promptDocument}
                onChange={changePromptDocument}
                placeholder={t('promptPlaceholder')}
                disabled={loading || hydrating}
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

            <EntityGenerationOptions document={promptDocument} overlays={logoOverlays}
              onOverlaysChange={setLogoOverlays} allowTemporaryMedia={allowTemporaryMedia}
              onAllowTemporaryMediaChange={setAllowTemporaryMedia} disabled={busy || loading || hydrating} />

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
