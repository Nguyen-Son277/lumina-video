import '../styles/scene-workspace.css'
import { SceneResultsModal } from '../components/SceneResultsModal'
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { shortenAppearance } from '../characterDescription'
import {
  ArrowLeft,
  Boxes,
  Check,
  ChevronDown,
  ChevronUp,
  Film,
  Image as ImageIcon,
  ImagePlus,
  Layers3,
  LoaderCircle,
  Mic,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  Users,
  Wand2,
  X,
} from 'lucide-react'
import type { PromptDocument } from '../../shared/promptMentions'
import { OpenAIVideoControls } from '../components/OpenAIVideoControls'
import { BulkVideoSettingsModal } from '../components/BulkVideoSettingsModal'
import { SceneCover, latestSceneVideo, sceneVideoCoverUrl } from '../components/SceneCover'
import { completeSceneVideoParams, switchSceneVideoParams, sceneVideoDurationValid, sceneVideoStyle, validateSceneHiggsfield } from '../../shared/sceneVideoParams'
import { isAgnesFlash } from '../../shared/videoApi'
import { EntityMentionTextarea } from '../components/EntityMentionTextarea'
import { ApiError, assertResponseOk, errorMessage } from '../api/client'
import { characterApi, generationApi, uploadApi, type SourceUpload, type GenerationCreateInput, type GenerationPreview, type LogoOverlay } from '../api/endpoints'
import { EntityGenerationOptions, GenerationPreviewDialog, type EntityGenerationPreview } from '../components/EntityGenerationOptions'
import { LocationReferences } from '../components/LocationReferences'
import { CanvasBoard } from '../components/canvas/CanvasBoard'
import { canvasCatalog } from '../i18n/catalogs/canvas'
import { AgnesVideoControls, agnesInput, usesAgnes } from '../components/AgnesVideoControls'
import { HiggsfieldVideoControls, usesHiggsfield } from '../components/HiggsfieldVideoControls'
import type { GenerationParamsInput } from '../api/types'
import { locationPanelApi, projectLocationsApi, locationReferenceUrl, normalizeLocations, type LocationReference } from '../api/locations'
import { locationsCatalog } from '../i18n/catalogs/locations'
import { projectsApi } from '../api/projects'
import type {
  CharacterInput,
  CharacterVoice,
  Project,
  ProjectCharacter,
  ProjectGeneration,
  ProjectInput,
  ProjectScene,
  PromptPreview,
  SceneBulkInput,
  SceneInput,
} from '../api/projectTypes'
import type { Generation, ModelInfo } from '../api/types'
import { CharacterForm, type CharacterScope } from '../components/CharacterForm'
import { CreationCard } from '../components/Common'
import { ImageLightbox } from '../components/Lightbox'
import { ProjectExportModal } from '../components/ProjectExportModal'
import { SceneEditorModal } from '../components/SceneEditorModal'
import { ProjectTrashDialog } from '../components/ProjectTrashDialog'
import { formatDate, useTranslation, type MessageParams, type Translate } from '../i18n'
import '../styles/studio-beginner.css'
import { studioBeginnerCatalog } from '../i18n/catalogs/studioBeginner'
import { studioCatalog, type StudioKey } from '../i18n/catalogs/studio'
import { shellCatalog } from '../i18n/catalogs/shell'
import { notification, type Notification } from '../i18n/messages'

type Props = {
  models: ModelInfo[]
  initialProjectId?: string
  initialTab?: TabKey
  onNotify: (message: Notification) => void
  onCreated?: (generation: Generation) => void
  onOpenSettings?: () => void
  onOpenTrash?: () => void
}

type TabKey = 'images' | 'characters' | 'scenes' | 'locations' | 'canvas'

/** Lựa chọn chỉ giữ `value` (giá trị gửi API) và khoá dịch cho nhãn hiển thị. */
type Option = { value: string; labelKey: StudioKey }

const IMAGE_SIZES: readonly Option[] = [
  { value: '1024x1024', labelKey: 'projectSizeSquare' },
  { value: '1536x1024', labelKey: 'projectSizeLandscape1536' },
  { value: '1024x1536', labelKey: 'projectSizePortrait1024' },
]

const IMAGE_QUALITIES: readonly Option[] = [
  // Mặc định không gửi `quality`: đây là trường đặc thù GPT Image, nhiều gateway
  // tương thích OpenAI từ chối và trả lỗi 400 nếu nhận được.
  { value: '', labelKey: 'qualityDefault' },
  { value: 'low', labelKey: 'qualityLow' },
  { value: 'medium', labelKey: 'qualityMedium' },
  { value: 'high', labelKey: 'qualityHigh' },
]

const MAX_SOURCE_IMAGES = 4

const isActive = (generation: Generation) =>
  ['queued', 'running', 'downloading'].includes(generation.status)

const newKey = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`

/** Lỗi do ứng dụng tự sinh: giữ khoá dịch để dịch lại theo ngôn ngữ hiện tại. */
class LocalizedError extends Error {
  constructor(readonly key: StudioKey, readonly params?: MessageParams) {
    super(key)
    this.name = 'LocalizedError'
  }
}

/**
 * Thông báo lỗi hiển thị: lỗi nội bộ giữ descriptor để dịch, còn lỗi từ API/AI/
 * provider giữ nguyên đối tượng `Error` (không định dạng sẵn) để mỗi lần render
 * lại dịch theo ngôn ngữ hiện tại.
 */
type ErrorMessage = { key: StudioKey; params?: MessageParams } | { error: Error }

/** Hàm dịch của catalog `studio`; đổi danh tính khi ngôn ngữ đổi. */
type StudioTranslate = Translate<typeof studioCatalog>

/** Lỗi thô từ API/AI giữ nguyên đối tượng; lỗi nội bộ giữ descriptor để dịch khi render. */
function describeError(cause: unknown): ErrorMessage {
  if (cause instanceof LocalizedError) return { key: cause.key, params: cause.params }
  // Lỗi huỷ/không xác định do ứng dụng tạo ra thì dịch; còn lại giữ nguyên đối tượng lỗi.
  if (cause instanceof Error && cause.name === 'AbortError') return { key: 'requestCancelled' }
  if (!(cause instanceof Error)) return { key: 'unknownError' }
  return { error: cause }
}

/** Thông báo đã bản địa hoá, tính lại theo ngôn ngữ đang chọn ở mỗi lần render. */
function errorTextOf(error: ErrorMessage, t: StudioTranslate): string {
  return 'error' in error ? errorMessage(error.error) : t(error.key, error.params)
}

/**
 * Chi tiết chẩn đoán thô do provider/API/người dùng trả về, giữ nguyên văn để tra
 * cứu; chỉ hiện khi bản dịch khác câu thô (tránh lặp lại thông báo).
 */
function errorDetailOf(error: ErrorMessage): string | undefined {
  if (!('error' in error) || !(error.error instanceof ApiError)) return undefined
  const raw = error.error.message.trim()
  return raw && raw !== errorMessage(error.error) ? raw : undefined
}

function parseParams(text: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(text || '{}') } catch { throw new LocalizedError('advancedParamsMustBeObject') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalizedError('advancedParamsMustBeObject')
  }
  return value as Record<string, unknown>
}

/** Rehydrate only bound IDs + normalized placement fields, never media paths. */
function boundLogoOverlays(value: unknown, document: PromptDocument): LogoOverlay[] {
  const bound = new Set(document.mentions.filter(binding => binding.entity.kind === 'logo').map(binding => binding.entity.id))
  if (!Array.isArray(value)) return []
  return value.flatMap(spec => {
    if (!spec || typeof spec !== 'object' || !bound.has(spec.entityId)
      || !['x', 'y', 'width', 'opacity'].every(key => typeof spec[key] === 'number' && Number.isFinite(spec[key]))) return []
    return [{ entityId: spec.entityId as string, x: spec.x as number, y: spec.y as number, width: spec.width as number, opacity: spec.opacity as number }]
  }).slice(0, 8)
}

function entityDialogPreview(preview: GenerationPreview): EntityGenerationPreview {
  return { ...preview, entities: preview.entities.flatMap(entity => {
    const kind = entity.kind
    return kind === 'character' || kind === 'item' || kind === 'logo' || kind === 'location' ? [{ ...entity, kind }] : []
  }) }
}

function firstAsset(generations: ProjectGeneration[]) {
  for (const generation of generations) {
    const asset = generation.assets?.[0]
    if (asset) return { asset, kind: generation.kind }
  }
  return null
}

function Modal({
  title,
  children,
  onClose,
  busy,
}: {
  title: string
  children: ReactNode
  onClose: () => void
  busy: boolean
}) {
  const { t } = useTranslation(studioCatalog)
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <div className="modal-card project-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="close-button" disabled={busy} onClick={onClose} aria-label={t('close')}>
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' }) {
  return <p className={tone === 'warn' ? 'project-cost-warning' : 'project-hint'}>{children}</p>
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label><span>{label}</span>{children}</label>
}

function ProjectForm({
  project,
  onClose,
  onSave,
}: {
  project?: Project
  onClose: () => void
  onSave: (input: ProjectInput) => Promise<void>
}) {
  const { t } = useTranslation(studioCatalog)
  const { t: help } = useTranslation(studioBeginnerCatalog)
  const [draft, setDraft] = useState<ProjectInput>(
    project
      ? {
          name: project.name,
          description: project.description,
          style: project.style,
          language: project.language,
          archived: project.archived,
        }
      : { name: '', description: '', style: '', language: 'vi', archived: false },
  )
  const [customLanguage, setCustomLanguage] = useState(Boolean(project && !['vi', 'en'].includes(project.language)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ErrorMessage | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await onSave(draft)
      onClose()
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={project ? t('editProject') : t('createProject')} onClose={onClose} busy={busy}>
      <form onSubmit={submit} className="studio-project-form">
        <p className="studio-help">{help('formHint')}</p>
        <fieldset className="modal-form project-fields" disabled={busy}>
          <Field label={t('projectNameLabel')}>
            <span className="studio-field-note" aria-hidden="true">{help('required')}</span>
            <input
              required
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </Field>
          <Field label={t('descriptionLabel')}>
            <span className="studio-field-note" aria-hidden="true">{help('optional')}</span>
            <textarea
              aria-label={t('descriptionLabel')}
              value={draft.description}
              placeholder={t('projectDescriptionPlaceholder')}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </Field>
          <Field label={t('styleLabel')}>
            <span className="studio-field-note" aria-hidden="true">{help('optional')}</span>
            <textarea
              value={draft.style}
              placeholder={t('stylePlaceholder')}
              onChange={(event) => setDraft({ ...draft, style: event.target.value })}
            />
          </Field>
          <Field label={t('projectLanguageLabel')}>
            <span className="studio-field-note" aria-hidden="true">{help('required')}</span>
            <select aria-label={t('projectLanguageLabel')} value={customLanguage ? 'other' : draft.language} onChange={event => {
              const value = event.target.value
              setCustomLanguage(value === 'other')
              setDraft({ ...draft, language: value === 'other' ? '' : value })
            }}>
              <option value="vi">{help('vietnamese')}</option><option value="en">{help('english')}</option>
              <option value="other">{help('otherLanguage')}</option>
            </select>
          </Field>
          {customLanguage && <Field label={help('languageCode')}><input required value={draft.language} onChange={event => setDraft({ ...draft, language: event.target.value })} /></Field>}
          <Notice>{t('projectFormNotice')}</Notice>
        </fieldset>
        {error && <div className="form-error" role="alert" title={errorDetailOf(error)}>{errorTextOf(error, t)}</div>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>
            {t('cancel')}
          </button>
          <button
            className="primary-small-button"
            disabled={busy || !draft.name.trim() || !draft.language.trim()}
          >
            {busy && <LoaderCircle size={14} className="spin" />} {t('saveProject')}
          </button>
        </div>
      </form>
    </Modal>
  )
}

/** Không gian làm việc của một cảnh: soạn bên trái, phiên bản bên phải. */
function SceneWorkspace({
  scene,
  projectId,
  characters,
  locations,
  models,
  revision,
  nextPosition,
  readOnly = false,
  onSaved,
  onCreated,
  onDeleteGeneration,
  onClose,
  onNotify,
}: {
  scene?: ProjectScene
  projectId: string
  characters: ProjectCharacter[]
  locations: LocationReference[]
  models: ModelInfo[]
  revision: number
  nextPosition: number
  /** Dự án đã lưu trữ: chỉ xem, không đổi ảnh minh hoạ hay tạo video. */
  readOnly?: boolean
  onSaved: (scene: ProjectScene) => void
  onCreated: (generation: Generation) => void
  onDeleteGeneration: (id: string) => void
  onClose: () => void
  onNotify: (message: Notification) => void
}) {
  const { t, locale } = useTranslation(studioCatalog)
  const { t: help } = useTranslation(studioBeginnerCatalog)
  const { t: tLocations } = useTranslation(locationsCatalog)
  const videoModels = models.filter((model) => model.enabled && model.kind === 'video')

  const [saved, setSaved] = useState<ProjectScene | undefined>(scene)
  const [draft, setDraft] = useState<SceneInput>(
    scene
      ? {
          title: scene.title,
          prompt: scene.prompt,
          promptDocument: scene.promptDocument ?? null,
          contextDocuments: scene.contextDocuments ?? [],
          characterId: scene.characterId,
          dialogue: scene.dialogue,
          modelId: scene.modelId,
          params: scene.params,
          position: scene.position,
          background: scene.background,
        }
      : {
          title: '',
          prompt: '',
          promptDocument: { version: 1, text: '', mentions: [] },
          contextDocuments: [],
          characterId: characters[0]?.id ?? null,
          dialogue: '',
          modelId: videoModels[0]?.id ?? '',
          params: videoModels[0] ? completeSceneVideoParams(videoModels[0], {}) : {},
          position: nextPosition,
          background: '',
        },
  )
  const [providerId, setProviderId] = useState(() => models.find(model => model.id === draft.modelId)?.providerId ?? '')
  const [params, setParams] = useState(JSON.stringify(draft.params ?? {}, null, 2))
  const [locationId, setLocationId] = useState(scene?.locationId ?? '')
  // Keep only editable content in the baseline; covers/version selections save independently.
  function draftFingerprint(value: SceneInput, paramsText: string, location: string): string {
    let parsed: unknown
    try { parsed = JSON.parse(paramsText) } catch { parsed = paramsText }
    return JSON.stringify({
      title: value.title, prompt: value.prompt, promptDocument: value.promptDocument ?? null,
      contextDocuments: value.contextDocuments ?? [], background: value.background ?? '',
      characterId: value.characterId ?? null, dialogue: value.dialogue, modelId: value.modelId,
      params: parsed, locationId: location || null,
    }, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
  }
  const [persistedDraft, setPersistedDraft] = useState(() => draftFingerprint(draft, params, locationId))
  const [preview, setPreview] = useState<PromptPreview | null>(null)
  const [videoConfigOpen, setVideoConfigOpen] = useState(false)
  const [entityConfirmation, setEntityConfirmation] = useState<{
    preview: EntityGenerationPreview; scene: ProjectScene; epoch: number; action: () => Promise<void>
  } | null>(null)
  const [versions, setVersions] = useState<ProjectGeneration[]>([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState<ErrorMessage | null>(null)
  /** Ảnh minh hoạ storyboard: id upload + URL có xác thực để xem trước. */
  const [illustration, setIllustration] = useState<{ id: string; url: string } | null>(
    scene?.backgroundUploadId && scene.backgroundUrl
      ? { id: scene.backgroundUploadId, url: scene.backgroundUrl }
      : null,
  )
  const [illustrationUploading, setIllustrationUploading] = useState(false)
  const [illustrationZoom, setIllustrationZoom] = useState(false)

  const previewEpoch = useRef(0)
  const idempotency = useRef<string | null>(null)

  /** Mọi thay đổi nội dung đều phải xem trước lại trước khi tạo. */
  function invalidate() {
    previewEpoch.current += 1
    setPreview(null)
    setEntityConfirmation(null)
    idempotency.current = null
  }

  useEffect(() => {
    invalidate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision])

  useEffect(() => {
    if (!saved?.id) return
    let alive = true
    const load = () =>
      projectsApi
        .versions(saved.id)
        .then((result) => {
          if (alive) setVersions(result.generations)
        })
        .catch((cause: unknown) => {
          if (alive) setError(describeError(cause))
        })
    void load()
    const timer = window.setInterval(() => void load(), 4000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [saved?.id])

  const videoModel = videoModels.find((model) => model.id === draft.modelId)
  const speakingCharacter = characters.find((item) => item.id === draft.characterId)
  const activeVersion = versions.find((version) => isActive(version))
  const succeededVersions = versions.filter((version) => version.status === 'succeeded')

  const draftDirty = draftFingerprint(draft, params, locationId) !== persistedDraft

  function change<K extends keyof SceneInput>(field: K, value: SceneInput[K]) {
    invalidate()
    setDraft((current) => ({ ...current, [field]: value }))
  }

  function changeParam(field: string, value: unknown) {
    invalidate()
    const current = parseParamsSafe(params)
    if (!current) { setError({ key: 'advancedParamsMustBeObject' }); return }
    const next = { ...current, [field]: value }
    setParams(JSON.stringify(next, null, 2))
  }

  function parseParamsSafe(text: string): Record<string, unknown> | null {
    try {
      return parseParams(text)
    } catch {
      return null
    }
  }

  // Control bên dưới đọc từ chính chuỗi JSON (nguồn sự thật) thay vì `draft.params`,
  // nên sửa bằng JSON tay hay bằng control đều cho ra cùng một giá trị — và giá trị
  // hiển thị luôn khớp giá trị sẽ gửi cho provider.
  const parsedParams = parseParamsSafe(params)
  const sceneModel = videoModels.find(model => model.id === draft.modelId)
  const agnesScene = usesAgnes(sceneModel)
  const effectiveParams = sceneModel ? completeSceneVideoParams(sceneModel, parsedParams ?? {}) : parsedParams ?? {}
  const providerOptions = [...new Map(videoModels.map(model => [model.providerId, model.providerName])).entries()]
  const filteredModels = videoModels.filter(model => model.providerId === providerId)
  const unavailableModel = Boolean(draft.modelId && !sceneModel)
  const durationInvalid = Boolean(sceneModel && !sceneVideoDurationValid(sceneModel, parsedParams ?? {}))
  const modelAvailabilityFingerprint = JSON.stringify(videoModels.map(model => [model.id, model.providerId, model.modelId, model.videoApiStyle]))
  useEffect(() => { invalidate() }, [modelAvailabilityFingerprint])
  const sceneDocument = draft.promptDocument ?? { version: 1 as const, text: draft.prompt, mentions: [] }
  const sceneLogoOverlays = boundLogoOverlays(parsedParams?.logoOverlays, sceneDocument)
  const sceneAllowsTemporaryMedia = parsedParams?.allowTemporaryMedia === true

  async function persist(): Promise<ProjectScene> {
    if (!sceneModel) throw new LocalizedError(unavailableModel ? 'sceneModelUnavailable' : 'sceneModelRequired')
    const rawParams = completeSceneVideoParams(sceneModel, parseParams(params))
    validateSceneHiggsfield(sceneModel, rawParams, draft.prompt)
    // Application fields stay in scene.params; provider adapters must strip them.
    const { logoOverlays: _logoOverlays, allowTemporaryMedia: _allowTemporaryMedia, ...providerParams } = rawParams
    const applicationParams = {
      logoOverlays: boundLogoOverlays(rawParams.logoOverlays, sceneDocument),
      allowTemporaryMedia: rawParams.allowTemporaryMedia === true,
    }
    const input = { ...draft, params: {
      ...(agnesScene && sceneModel ? agnesInput(providerParams as GenerationParamsInput, sceneModel) : providerParams),
      ...applicationParams,
    }, locationId: locationId || null } as SceneInput
    if (!input.title.trim()) throw new LocalizedError('sceneTitleRequired')
    if (!input.prompt.trim() && !(usesHiggsfield(sceneModel) && providerParams.mode === 'image')) throw new LocalizedError('scenePromptRequired')
    if (!input.modelId) throw new LocalizedError('sceneModelRequired')
    if (input.dialogue.trim() && !input.characterId) {
      throw new LocalizedError('sceneDialogueNeedsCharacter')
    }

    // Position is creation/reorder-only; the strict update schema rejects it.
    const { position: _position, ...updateInput } = input
    const response = saved
      ? await projectsApi.updateScene(projectId, saved.id, updateInput)
      : await projectsApi.createScene(projectId, input)

    const persisted = response.scene
    const persistedInput: SceneInput = {
      title: persisted.title, prompt: persisted.prompt,
      promptDocument: persisted.promptDocument ?? null,
      contextDocuments: persisted.contextDocuments ?? [],
      characterId: persisted.characterId, dialogue: persisted.dialogue,
      modelId: persisted.modelId, params: persisted.params,
      position: persisted.position, background: persisted.background,
    }
    const persistedParams = JSON.stringify(persisted.params ?? {}, null, 2)
    const persistedLocation = persisted.locationId ?? ''
    setSaved(persisted)
    setDraft(persistedInput)
    setParams(persistedParams)
    setLocationId(persistedLocation)
    setPersistedDraft(draftFingerprint(persistedInput, persistedParams, persistedLocation))
    onSaved(persisted)
    return persisted
  }

  async function perform(action: 'save' | 'preview' | 'generate') {
    if (!parsedParams || !sceneModel || durationInvalid) {
      setVideoConfigOpen(true)
      setError({ key: !parsedParams ? 'advancedParamsMustBeObject' : !sceneModel ? (unavailableModel ? 'sceneModelUnavailable' : 'sceneModelRequired') : 'videoSecondsInvalid', params: { max: sceneModel && isAgnesFlash(sceneModel.modelId) ? 12 : 30 } })
      return
    }
    setBusy(action)
    setError(null)
    try {
      if (action === 'generate') {
        if (!saved || draftDirty || readOnly || illustrationUploading) return
        const savedScene = saved
        const epoch = previewEpoch.current
        const action = async (): Promise<void> => {
          if (epoch !== previewEpoch.current) { setEntityConfirmation(null); return }
          setEntityConfirmation(null)
          setBusy('generate')
          setError(null)
          try {
            idempotency.current ??= newKey()
            const { generation } = await projectsApi.generateScene(savedScene.id, idempotency.current)
            idempotency.current = null
            onCreated(generation)
            setVersions(current => [generation, ...current.filter(item => item.id !== generation.id)])
          } catch (cause) {
            setError(describeError(cause))
          } finally {
            setBusy('')
          }
        }
        if (sceneDocument.mentions.length || draft.contextDocuments?.some(document => document.mentions.length)
          || sceneLogoOverlays.length || sceneAllowsTemporaryMedia) {
          const compiled = await projectsApi.preview(savedScene.id) as PromptPreview & Partial<GenerationPreview>
          if (epoch !== previewEpoch.current) return
          // Never invent sent-reference counts or modes when the server omits them.
          if (!compiled.entities || typeof compiled.referenceCount !== 'number' || typeof compiled.maxReferenceCount !== 'number' || !compiled.overlays) {
            throw new LocalizedError('previewBeforeGenerate')
          }
          setEntityConfirmation({ scene: structuredClone(savedScene), epoch, action, preview: entityDialogPreview({
            prompt: compiled.effectivePrompt, entities: compiled.entities, referenceCount: compiled.referenceCount,
            maxReferenceCount: compiled.maxReferenceCount, warnings: compiled.warnings ?? [], overlays: compiled.overlays,
          }) })
        } else await action()
      } else {
        invalidate()
        const epoch = previewEpoch.current
        const result = await persist()
        if (action === 'preview') {
          const response = await projectsApi.preview(result.id)
          if (epoch === previewEpoch.current) setPreview(response)
        } else {
          onNotify(notification('studio', 'notifySceneSaved'))
        }
      }
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy('')
    }
  }

  async function choose(generationId: string) {
    if (!saved) return
    setBusy(generationId)
    setError(null)
    try {
      const response = await projectsApi.selectGeneration(saved.id, generationId)
      setSaved(response.scene)
      onSaved(response.scene)
      onNotify(notification('studio', 'notifyVersionSelected'))
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy('')
    }
  }

  async function retryDownload(generationId: string) {
    setBusy(generationId)
    setError(null)
    try {
      const { generation } = await generationApi.retryDownload(generationId)
      setVersions((current) =>
        current.map((item) => (item.id === generation.id ? generation : item)),
      )
      onCreated(generation)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy('')
    }
  }

  /**
   * Gắn/bỏ ảnh minh hoạ của cảnh đã lưu. Việc này đi qua `updateScene` để server
   * kiểm tra quyền sở hữu upload; ảnh minh hoạ KHÔNG được gửi cho model video.
   */
  async function saveIllustration(uploadId: string | null): Promise<void> {
    if (!saved) throw new LocalizedError('sceneIllustrationSaveFirst')
    invalidate()
    const response = await projectsApi.updateScene(projectId, saved.id, { backgroundUploadId: uploadId })
    setSaved(response.scene)
    setIllustration(
      response.scene.backgroundUploadId && response.scene.backgroundUrl
        ? { id: response.scene.backgroundUploadId, url: response.scene.backgroundUrl }
        : null,
    )
    onSaved(response.scene)
  }

  async function uploadIllustration(file: File) {
    setIllustrationUploading(true)
    setError(null)
    try {
      const upload = await uploadApi.upload(file)
      await saveIllustration(upload.id)
      onNotify(notification('studio', 'notifyIllustrationUpdated'))
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setIllustrationUploading(false)
    }
  }

  async function removeIllustration() {
    setBusy('illustration')
    setError(null)
    try {
      await saveIllustration(null)
      onNotify(notification('studio', 'notifyIllustrationRemoved'))
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy('')
    }
  }

  function requestClose() {
    if (busy || illustrationUploading || illustrationZoom || entityConfirmation) return
    if (draftFingerprint(draft, params, locationId) !== persistedDraft
      && !window.confirm(t('sceneDiscardChangesConfirm'))) return
    onClose()
  }

  return (
    <SceneEditorModal
      title={saved ? `${t('editingScene')} · ${saved.title}` : t('newScene')}
      closeLabel={t('close')}
      closeDisabled={!!busy || illustrationUploading}
      suspended={illustrationZoom || !!entityConfirmation}
      headerActions={<>
        <button type="button" className="secondary-button" disabled={!!busy} onClick={() => void perform('save')}>
          {t('saveScene')}
        </button>
        <button type="button" className={preview ? 'secondary-button' : 'primary-small-button'} disabled={!!busy} onClick={() => void perform('preview')}>
          <Sparkles size={15} /> {t('saveAndPreview')}
        </button>
        <button type="button" className="project-generate-button scene-header-generate"
          disabled={!!busy || !saved || draftDirty || readOnly || illustrationUploading || !videoModel || !parsedParams || durationInvalid}
          onClick={() => void perform('generate')}>
          {busy === 'generate' || activeVersion ? <LoaderCircle size={17} className="spin" /> : <Wand2 size={17} />}
          {activeVersion ? t('generatingVideo') : t('generateOrRetry')}
        </button>
      </>}
      onClose={requestClose}
    >
    <section className="project-scene-editor">
      {entityConfirmation && <GenerationPreviewDialog preview={entityConfirmation.preview} disabled={!!busy}
        onCancel={() => setEntityConfirmation(null)} onConfirm={() => void entityConfirmation.action()} />}

      <div className="project-workspace">
        <div className="project-composer">
          {!videoModels.length && (
            <div className="notice-banner">
              <Settings2 size={18} />
              <div>
                <strong>{t('noVideoModel')}</strong>
                <p>
                  {t('noVideoModelNoticePrefix')}<strong>{t('modeVideo')}</strong>{t('noVideoModelNoticeSuffix')}
                </p>
              </div>
            </div>
          )}

          <fieldset className="modal-form project-fields" disabled={!!busy}>
            <h3 className="studio-group-title">{help('sceneContent')}</h3>
            <Field label={t('sceneTitleLabel')}>
              <input
                value={draft.title}
                placeholder={t('sceneTitlePlaceholder')}
                onChange={(event) => change('title', event.target.value)}
              />
            </Field>

            <Field label={t('scenePromptLabel')}>
              <EntityMentionTextarea
                document={draft.promptDocument ?? { version: 1, text: draft.prompt, mentions: [] }}
                projectId={projectId}
                placeholder={t('scenePromptPlaceholder')}
                maxLength={8000}
                disabled={!!busy || readOnly}
                onChange={(document) => {
                  invalidate()
                  setDraft(current => ({ ...current, prompt: document.text, promptDocument: document }))
                }}
              />
            </Field>
            <button type="button" className="secondary-button scene-config-toggle" aria-expanded={videoConfigOpen} aria-controls="scene-video-config" onClick={() => setVideoConfigOpen(current => !current)}><Settings2 size={16} />{help('videoConfig')}<ChevronDown size={15} /></button>
            {!videoConfigOpen && <p className="project-hint scene-config-summary">{sceneModel ? `${sceneModel.providerName} · ${sceneModel.displayName} · ${String(effectiveParams.duration ?? effectiveParams.seconds ?? '—')}s · ${String(effectiveParams.resolution ?? effectiveParams.size ?? '')}` : t('sceneModelRequired')}</p>}
            <div id="scene-video-config" className="scene-video-config modal-form project-fields" hidden={!videoConfigOpen}>

            <Field label={t('sceneProviderLabel')}>
              <select value={providerId} onChange={event => {
                if (!parsedParams) { setError({ key: 'advancedParamsMustBeObject' }); return }
                invalidate(); setProviderId(event.target.value)
                const nextModel = videoModels.find(model => model.providerId === event.target.value)
                setDraft(current => ({ ...current, modelId: nextModel?.id ?? '' }))
                if (nextModel) setParams(JSON.stringify(switchSceneVideoParams(nextModel, parsedParams), null, 2))
              }}>
                <option value="">{t('sceneChooseProvider')}</option>
                {providerOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            </Field>
            {unavailableModel && <p className="form-error" role="alert">{t('sceneModelUnavailable')}</p>}
            <Field label={t('videoModelLabel')}>
              <select value={draft.modelId} onChange={event => {
                const model = videoModels.find(item => item.id === event.target.value)
                if (!parsedParams) { setError({ key: 'advancedParamsMustBeObject' }); return }
                change('modelId', event.target.value)
                if (model) {
                  const sameProtocol = sceneModel && sceneVideoStyle(sceneModel) === sceneVideoStyle(model)
                  const next = sameProtocol ? completeSceneVideoParams(model, parsedParams) : switchSceneVideoParams(model, parsedParams)
                  setParams(JSON.stringify(next, null, 2))
                }
              }}>
                <option value="">{t('chooseModel')}</option>
                {unavailableModel && <option value={draft.modelId ?? ''}>{t('sceneModelUnavailable')}</option>}
                {filteredModels.map(model => <option key={model.id} value={model.id}>{model.displayName} · {model.providerName} · {model.modelId}</option>)}
              </select>
            </Field>
            {!parsedParams && <p className="form-error" role="alert">{t('advancedParamsMustBeObject')}</p>}
            {sceneModel && parsedParams && (usesHiggsfield(sceneModel) ? <HiggsfieldVideoControls key={sceneModel.id} value={effectiveParams as GenerationParamsInput} onChange={next => {
              invalidate(); setParams(JSON.stringify({ ...next, useCharacterReference: false, logoOverlays: sceneLogoOverlays, allowTemporaryMedia: sceneAllowsTemporaryMedia }, null, 2))
            }} /> : agnesScene ? <AgnesVideoControls model={sceneModel} value={effectiveParams as GenerationParamsInput} onChange={next => {
              invalidate(); setParams(JSON.stringify({ ...next, useCharacterReference: false, logoOverlays: sceneLogoOverlays, allowTemporaryMedia: sceneAllowsTemporaryMedia }, null, 2))
            }} /> : <OpenAIVideoControls value={effectiveParams as GenerationParamsInput} onChange={next => {
              invalidate(); setParams(JSON.stringify(next, null, 2))
            }} />)}

            <details className="project-advanced">
              <summary>{t('advancedJsonSummary')}</summary>
              <textarea
                value={params}
                spellCheck={false}
                onChange={(event) => {
                  invalidate()
                  setParams(event.target.value)
                }}
              />
            </details>
            </div>
            <details className="studio-disclosure" open={scene ? true : undefined}><summary>{help('sceneExtras')}</summary><div className="modal-form project-fields">
            <EntityGenerationOptions document={sceneDocument} overlays={sceneLogoOverlays}
              onOverlaysChange={value => changeParam('logoOverlays', value)}
              allowTemporaryMedia={sceneAllowsTemporaryMedia}
              onAllowTemporaryMediaChange={value => changeParam('allowTemporaryMedia', value)}
              disabled={!!busy || readOnly} projectId={projectId} />

            {/* Bối cảnh do Tạo kịch bản AI sinh ra; phải xem và sửa được ở đây,
                nếu không người dùng không kiểm tra được kịch bản đã đúng ý chưa. */}
            <Field label={t('sceneBackgroundLabel')}>
              <textarea
                value={draft.background}
                placeholder={t('sceneBackgroundPlaceholder')}
                onChange={(event) => change('background', event.target.value)}
              />
            </Field>

            <Field label={t('speakerLabel')}>
              <select
                value={draft.characterId ?? ''}
                onChange={(event) => change('characterId', event.target.value || null)}
              >
                <option value="">{t('noSpeaker')}</option>
                {characters.map((character) => (
                  <option key={character.id} value={character.id}>
                    {character.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label={tLocations('selectLocation')}>
              <select value={locationId} onChange={(event) => { invalidate(); setLocationId(event.target.value) }}>
                <option value="">{tLocations('unassigned')}</option>
                {locationId && !locations.some((location) => location.id === locationId) && (
                  <option value={locationId}>{tLocations('missingLocation')}</option>
                )}
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}{location.stage ? ` · ${location.stage}` : ''}
                  </option>
                ))}
              </select>
              {(() => {
                const location = locations.find((item) => item.id === locationId)
                if (!location) return null
                return location.reference
                  ? <img src={locationReferenceUrl(location)} alt={location.name} style={{ width: 96, maxHeight: 64, objectFit: 'cover' }} />
                  : <span className="project-hint">{tLocations('noReference')}</span>
              })()}
              <span className="project-hint">{tLocations('locationSourceHint')}</span>
            </Field>

            {/* Ảnh minh hoạ storyboard sao chép từ timeline của Tạo kịch bản AI.
                Chỉ để hình dung cảnh; không gửi cho model video. */}
            <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
              <div className="project-field-row">
                <span className="project-hint">{t('sceneIllustrationTitle')}</span>

              </div>
              {illustration ? (
                <button
                  type="button"
                  style={{ padding: 0, border: '1px solid #30333a', borderRadius: 8, overflow: 'hidden', background: 'transparent', width: '100%', maxWidth: 320, cursor: 'zoom-in' }}
                  onClick={() => setIllustrationZoom(true)}
                  aria-label={t('sceneIllustrationPreviewAria', { title: saved?.title || draft.title || t('newScene') })}
                  title={t('sceneIllustrationPreviewAria', { title: saved?.title || draft.title || t('newScene') })}
                >
                  <img
                    src={illustration.url}
                    alt={t('sceneCoverIllustrationAria', { title: saved?.title || draft.title || t('newScene') })}
                    loading="lazy"
                    style={{ display: 'block', width: '100%', height: 'auto' }}
                  />
                </button>
              ) : (
                <p className="project-hint">{t('sceneIllustrationEmpty')}</p>
              )}
              <div className="project-actions">
                <label className="secondary-button">
                  <ImagePlus size={14} />{' '}
                  {illustrationUploading ? t('sceneIllustrationUploading') : t('sceneIllustrationReplace')}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    hidden
                    disabled={readOnly || !saved || illustrationUploading || !!busy}
                    aria-label={t('sceneIllustrationReplace')}
                    onChange={(event) => {
                      const file = event.target.files?.[0]
                      event.target.value = ''
                      if (file) void uploadIllustration(file)
                    }}
                  />
                </label>
                {illustration && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={readOnly || !saved || !!busy || illustrationUploading}
                    onClick={() => void removeIllustration()}
                  >
                    <Trash2 size={14} /> {t('sceneIllustrationRemove')}
                  </button>
                )}
              </div>
              {!saved && <span className="project-hint">{t('sceneIllustrationSaveFirst')}</span>}
              {readOnly && <span className="project-hint">{t('sceneIllustrationReadOnly')}</span>}
            </div>

            {agnesScene && speakingCharacter ? <p className="project-hint">{t('agnesPrivateHint')}</p> : speakingCharacter?.referenceUrl && (
              <label className="project-checkbox">
                <input
                  type="checkbox"
                  checked={(parsedParams ?? {}).useCharacterReference !== false}
                  onChange={(event) => changeParam('useCharacterReference', event.target.checked)}
                />
                <span>
                  {t('sendReferencePrefix')}<strong>{speakingCharacter.name}</strong>{t('sendReferenceSuffixVideo')}
                </span>
              </label>
            )}

            <Field label={t('dialogueLabel')}>
              <textarea
                value={draft.dialogue}
                placeholder={t('dialoguePlaceholder')}
                onChange={(event) => change('dialogue', event.target.value)}
              />
            </Field>

            </div></details>

          </fieldset>

          <Notice>{t('sceneVoiceNotice')}</Notice>

          {error && <div className="form-error" role="alert" title={errorDetailOf(error)}>{errorTextOf(error, t)}</div>}

          {preview && (
            <div className="project-prompt-preview">
              <strong>{t('promptPreviewTitle')}</strong>
              <pre>{preview.effectivePrompt}</pre>
              {preview.warnings?.map((warning, index) => <p className="entity-options__warning" role="alert" key={index}>{warning}</p>) }
            </div>
          )}

          {(!saved || draftDirty) && <p className="studio-help" role="status">{help('saveBeforeCreate')}</p>}
          <Notice tone="warn">{t('costNoteWithModel')}</Notice>
        </div>

        <div className="project-results-panel">
          <div className="project-panel-heading">
            <h3>{t('sceneVersionsTitle')}</h3>
            <span className="project-badge">
              <Layers3 size={13} /> {t('versionCount', { count: versions.length })}
            </span>
          </div>

          {versions.length ? (
            <div className="project-versions">
              {versions.map((version) => (
                <div
                  key={version.id}
                  className={`project-version project-version-card ${
                    saved?.selectedGenerationId === version.id ? 'selected' : ''
                  }`}
                >
                  <div className="project-version-header">
                    <span>{formatDate(version.createdAt, { dateStyle: 'short', timeStyle: 'short' }, locale)}</span>
                    {saved?.selectedGenerationId === version.id && (
                      <span className="connected-pill"><span /> {t('versionSelectedPill')}</span>
                    )}
                  </div>
                  <CreationCard
                    generation={version}
                    onDelete={() => onDeleteGeneration(version.id)}
                    onRetry={() => void retryDownload(version.id)}
                    busy={busy === version.id}
                  />
                  {version.status === 'succeeded' && (
                    <button
                      className="secondary-button"
                      style={{ width: '100%', justifyContent: 'center', marginTop: 12 }}
                      disabled={!!busy || saved?.selectedGenerationId === version.id}
                      onClick={() => void choose(version.id)}
                    >
                      {saved?.selectedGenerationId === version.id ? t('selecting') : t('selectVersion')}
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="project-empty-media">
              <Film size={36} />
              <h3>{t('noVersionsTitle')}</h3>
              <p>
                {t('noVersionsHintPrefix')}<strong>{t('generateOrRetry')}</strong>{t('noVersionsHintSuffix')}
              </p>
            </div>
          )}
        </div>
      </div>

      {illustrationZoom && illustration && (
        <ImageLightbox
          src={illustration.url}
          alt={t('sceneCoverIllustrationAria', { title: saved?.title || draft.title || t('newScene') })}
          onClose={() => setIllustrationZoom(false)}
        />
      )}
    </section>
    </SceneEditorModal>
  )
}

export function ProjectStudio({ models, initialProjectId = '', initialTab = 'images', onNotify, onCreated, onOpenSettings, onOpenTrash }: Props) {
  const { t, locale } = useTranslation(studioCatalog)
  const { t: help } = useTranslation(studioBeginnerCatalog)
  const { t: tShell } = useTranslation(shellCatalog)
  const [projects, setProjects] = useState<Project[]>([])
  const [covers, setCovers] = useState<Record<string, { url: string; kind: 'image' | 'video' }>>({})
  const [selectedId, setSelectedId] = useState(initialProjectId)
  const [characters, setCharacters] = useState<ProjectCharacter[]>([])
  const [scenes, setScenes] = useState<ProjectScene[]>([])
  const [results, setResults] = useState<ProjectGeneration[]>([])
  const [latestSceneVideos, setLatestSceneVideos] = useState<ProjectGeneration[]>([])
  const [bulkSettingsOpen, setBulkSettingsOpen] = useState(false)
  const [bulkSettingsTargets, setBulkSettingsTargets] = useState<string[]>([])
  const [bulkSettingsSelectedCount, setBulkSettingsSelectedCount] = useState(0)
  const [bulkSettingsUsesSelection, setBulkSettingsUsesSelection] = useState(false)
  const [bulkSettingsError, setBulkSettingsError] = useState<ReactNode | null>(null)
  const [tab, setTab] = useState<TabKey>(initialTab)
  useEffect(() => {
    if (!initialProjectId) return
    setSelectedId(initialProjectId)
    setTab(initialTab)
  }, [initialProjectId, initialTab])
  const [locations, setLocations] = useState<LocationReference[]>([])
  const [imageLocationId, setImageLocationId] = useState('')
  const { t: tLocations } = useTranslation(locationsCatalog)
  const { t: tCanvas } = useTranslation(canvasCatalog)

  const [projectModal, setProjectModal] = useState<Project | 'new' | null>(null)
  const [characterModal, setCharacterModal] = useState<ProjectCharacter | 'new' | null>(null)
  const [sceneEdit, setSceneEdit] = useState<ProjectScene | 'new' | null>(null)
  const [advancedScenesOpen, setAdvancedScenesOpen] = useState(false)
  const advancedScenesButtonRef = useRef<HTMLButtonElement>(null)
  const [resultsSceneId, setResultsSceneId] = useState<string | null>(null)
  const [sceneHistory, setSceneHistory] = useState<ProjectGeneration[]>([])
  const [sceneHistoryLoading, setSceneHistoryLoading] = useState(false)
  useEffect(() => {
    if (!resultsSceneId) return
    let alive = true
    setSceneHistory([])
    setSceneHistoryLoading(true)
    const load = async () => {
      try { const response = await projectsApi.versions(resultsSceneId); if (alive) setSceneHistory(response.generations) }
      catch (cause) { if (alive) setError(describeError(cause)) }
      finally { if (alive) setSceneHistoryLoading(false) }
    }
    void load()
    const timer = window.setInterval(() => void load(), 4000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [resultsSceneId])
  /** Hộp thoại xuất video: chỉ mở khi người dùng bấm nút, không tự tạo bản xuất. */
  const [exportOpen, setExportOpen] = useState(false)
  /**
   * `key` ổn định cho trình soạn cảnh. Nếu dùng id cảnh làm key thì khi cảnh mới
   * được lưu, key đổi từ "new" sang id thật và React sẽ gỡ, dựng lại component,
   * làm mất kết quả xem trước prompt vừa tải.
   */
  const [editorKey, setEditorKey] = useState('')

  function openScene(target: ProjectScene | 'new') {
    setSceneEdit(target)
    setEditorKey(target === 'new' ? `new-${newKey()}` : target.id)
  }

  const [search, setSearch] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [showTrash, setShowTrash] = useState(false)
  const [trashProject, setTrashProject] = useState<Project | null>(null)
  const [listRevision, setListRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState<ErrorMessage | null>(null)
  const [revision, setRevision] = useState(0)
  const [locationsRevision, setLocationsRevision] = useState(0)
  /** Cảnh đang chọn cho thao tác hàng loạt (duyệt, gán model, tạo video). */
  const [selectedSceneIds, setSelectedSceneIds] = useState<string[]>([])
  const [bulkModelId, setBulkModelId] = useState('')
  const [bulkProviderId, setBulkProviderId] = useState('')
  const [bulkParams, setBulkParams] = useState('{}')
  /** Ảnh minh hoạ đang phóng to ở danh sách cảnh. */
  const [sceneCoverZoom, setSceneCoverZoom] = useState<{ url: string; title: string } | null>(null)

  const [imageDocument, setImageDocument] = useState<PromptDocument>({ version: 1, text: '', mentions: [] })
  const imagePrompt = imageDocument.text
  const [imageLogoOverlays, setImageLogoOverlays] = useState<LogoOverlay[]>([])
  const [imageAllowTemporaryMedia, setImageAllowTemporaryMedia] = useState(false)
  const [imagePreview, setImagePreview] = useState<{
    input: GenerationCreateInput; preview: EntityGenerationPreview; fingerprint: string; action: () => Promise<void>
  } | null>(null)
  const [imageModel, setImageModel] = useState('')
  const [imageCharacter, setImageCharacter] = useState('')
  const [imageSendReference, setImageSendReference] = useState(true)
  const [imageSize, setImageSize] = useState(IMAGE_SIZES[0].value)
  const [imageQuality, setImageQuality] = useState('')
  const [imageParams, setImageParams] = useState('{}')
  const [sourceImages, setSourceImages] = useState<SourceUpload[]>([])
  const [uploadingImage, setUploadingImage] = useState(false)
  const imageOptionsRef = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    if (imageOptionsRef.current && (imageCharacter || imageLocationId || sourceImages.length || imageLogoOverlays.length || imageParams !== '{}')) imageOptionsRef.current.open = true
  }, [tab, detailLoading])
  const imageKey = useRef<string | null>(null)
  const imageFingerprint = JSON.stringify([selectedId, imageDocument, imageLogoOverlays, imageAllowTemporaryMedia, imageModel,
    imageCharacter, imageSendReference, imageSize, imageQuality, imageParams, imageLocationId, sourceImages])
  const imageFingerprintRef = useRef(imageFingerprint)
  imageFingerprintRef.current = imageFingerprint
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId
  // Invalidates in-flight reads whenever local mutations or a newer read starts.
  const latestSceneVideosEpoch = useRef(0)
  const latestSceneVideosProject = useRef(selectedId)
  if (latestSceneVideosProject.current !== selectedId) {
    latestSceneVideosProject.current = selectedId
    latestSceneVideosEpoch.current += 1
  }

  async function refreshLatestSceneVideos(projectId: string) {
    const requestVersion = ++latestSceneVideosEpoch.current
    try {
      const latest = await projectsApi.latestSceneVideos(projectId)
      if (selectedIdRef.current === projectId && latestSceneVideosProject.current === projectId
        && latestSceneVideosEpoch.current === requestVersion) setLatestSceneVideos(latest.generations)
    } catch {
      // Latest video metadata is supplementary; its failure must not blank Studio.
    }
  }

  function invalidateLatestSceneVideos(projectId: string) {
    if (latestSceneVideosProject.current === projectId) latestSceneVideosEpoch.current += 1
  }

  function mergeLatestSceneVideo(candidate: ProjectGeneration) {
    if (!candidate.sceneId) return
    invalidateLatestSceneVideos(selectedIdRef.current)
    setLatestSceneVideos(current => {
      const winner = latestSceneVideo([...current, candidate], candidate.sceneId!)
      return winner?.id === candidate.id
        ? [candidate, ...current.filter(item => item.sceneId !== candidate.sceneId)]
        : current
    })
  }
  useEffect(() => {
    imageKey.current = null
    setImagePreview(current => current && current.fingerprint !== imageFingerprint ? null : current)
  }, [imageFingerprint])

  const project = projects.find((item) => item.id === selectedId)
  const imageModels = models.filter((model) => model.enabled && model.kind === 'image')
  const videoModels = models.filter((model) => model.enabled && model.kind === 'video')
  const bulkModel = videoModels.find(model => model.id === bulkModelId)
  let parsedBulkParams: Record<string, unknown> | null = null
  try { parsedBulkParams = parseParams(bulkParams) } catch { /* Shown beside the JSON editor. */ }
  const bulkEffectiveParams = bulkModel ? completeSceneVideoParams(bulkModel, parsedBulkParams ?? {}) : {}
  const bulkDurationInvalid = Boolean(bulkModel && !sceneVideoDurationValid(bulkModel, bulkEffectiveParams))
  const bulkSettingsErrorNode = bulkSettingsError
    ?? (!parsedBulkParams ? t('advancedParamsMustBeObject') : bulkModel && bulkDurationInvalid ? t('videoSecondsInvalid', { max: isAgnesFlash(bulkModel.modelId) ? 12 : 30 }) : null)
  const bulkSettingsTargetCount = bulkSettingsTargets.length

  function selectBulkModel(modelId: string, reset = false) {
    const next = videoModels.find(model => model.id === modelId)
    if (!parsedBulkParams) {
      if (bulkSettingsOpen) setBulkSettingsError(t('advancedParamsMustBeObject'))
      else setError({ key: 'advancedParamsMustBeObject' })
      return
    }
    setBulkModelId(modelId)
    if (next) {
      const sameProtocol = !reset && bulkModel && sceneVideoStyle(bulkModel) === sceneVideoStyle(next)
      setBulkParams(JSON.stringify(sameProtocol ? completeSceneVideoParams(next, parsedBulkParams) : switchSceneVideoParams(next, {}), null, 2))
    }
  }

  /** Nhân vật đang gắn cho lần tạo ảnh tiếp theo, nếu còn tồn tại trong dự án. */
  const imageCharacterEntry = characters.find((item) => item.id === imageCharacter) ?? null
  const willSendCharacterReference = Boolean(
    imageCharacterEntry?.referenceUrl && imageSendReference,
  )

  useEffect(() => {
    if (!imageModel) {
      setImageModel(imageModels[0]?.id ?? '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, imageModel])

  // Tải danh sách dự án kèm ảnh bìa lấy từ kết quả gần nhất.
  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    setProjects([])
    setCovers({})
    projectsApi
      .list(showTrash)
      .then(async (result) => {
        if (!alive) return
        setProjects(result.projects)

        const withCover = showTrash ? [] : result.projects.filter((item) => !item.archived).slice(0, 12)
        const pairs = await Promise.all(
          withCover.map(async (item) => {
            try {
              const found = firstAsset((await projectsApi.results(item.id)).generations)
              return found ? ([item.id, { url: found.asset.url, kind: found.kind }] as const) : null
            } catch {
              return null
            }
          }),
        )
        if (!alive) return
        setCovers(Object.fromEntries(pairs.filter(Boolean) as Array<[string, { url: string; kind: 'image' | 'video' }]>))
      })
      .catch((cause: unknown) => {
        if (alive) setError(describeError(cause))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [showTrash, listRevision])

  useEffect(() => {
    setCharacters([])
    setScenes([])
    setResults([])
    setLatestSceneVideos([])
    latestSceneVideosEpoch.current += 1
    latestSceneVideosProject.current = selectedId
    setBulkSettingsOpen(false)
    setAdvancedScenesOpen(false)
    setResultsSceneId(null)
    setBulkSettingsTargets([])
    setBulkSettingsError(null)
    setLocations([])
    setSceneEdit(null)
    setCharacterModal(null)
    setExportOpen(false)
    setSelectedSceneIds([])
    setBulkModelId('')
    setBulkProviderId('')
    setBulkParams('{}')
    setSceneCoverZoom(null)
    setImageCharacter('')
    setImageSendReference(true)
    setImageLogoOverlays([])
    setImageAllowTemporaryMedia(false)
    setImagePreview(null)
    setImageDocument({ version: 1, text: '', mentions: [] })
    setError(null)
    imageKey.current = null
    if (!selectedId) return

    let alive = true
    setDetailLoading(true)
    Promise.all([
      projectsApi.characters(selectedId),
      projectsApi.scenes(selectedId),
      projectsApi.results(selectedId),
      projectLocationsApi(selectedId).list(),
    ])
      .then(([characterResult, sceneResult, generationResult, locationResult]) => {
        if (!alive || selectedIdRef.current !== selectedId) return
        setCharacters(characterResult.characters)
        setScenes(sceneResult.scenes)
        setResults(generationResult.generations)
        setLocations(normalizeLocations(locationResult))
      })
      .catch((cause: unknown) => {
        if (alive) setError(describeError(cause))
      })
      .finally(() => {
        if (alive) setDetailLoading(false)
      })
    void refreshLatestSceneVideos(selectedId)
    return () => {
      alive = false
    }
  }, [selectedId])

  const hasActiveResult = results.some(isActive) || latestSceneVideos.some(isActive)
  /**
   * Sau khi đánh dấu hàng loạt `autoGenerate`, worker xếp hàng trong vài giây nên
   * kết quả có thể còn trống. Giữ làm mới nền trong lúc chờ để thẻ cảnh hiện đúng
   * trạng thái chờ/đang chạy thay vì đứng yên cho tới lần tải lại sau.
   */
  const [awaitingAutoGenerate, setAwaitingAutoGenerate] = useState(false)
  useEffect(() => {
    if (!awaitingAutoGenerate) return
    if (results.some(isActive)) {
      setAwaitingAutoGenerate(false)
      return
    }
    const timer = window.setTimeout(() => setAwaitingAutoGenerate(false), 120_000)
    return () => window.clearTimeout(timer)
  }, [awaitingAutoGenerate, results])

  useEffect(() => {
    if (!selectedId || (!hasActiveResult && !awaitingAutoGenerate)) return
    let alive = true
    const timer = window.setInterval(() => {
      projectsApi.results(selectedId).then(result => {
        if (alive && selectedIdRef.current === selectedId) setResults(result.generations)
      }).catch(() => { /* Ignore transient polling failures. */ })
      void refreshLatestSceneVideos(selectedId)
    }, 4000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [selectedId, hasActiveResult, awaitingAutoGenerate])

  const orderedScenes = useMemo(
    () => [...scenes].sort((a, b) => a.position - b.position),
    [scenes],
  )

  const visibleProjects = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    return projects.filter((item) => {
      if (!showTrash && !showArchived && item.archived) return false
      if (!keyword) return true
      return `${item.name} ${item.description} ${item.style}`.toLowerCase().includes(keyword)
    })
  }, [projects, search, showArchived, showTrash])

  const imageResults = useMemo(
    () => results.filter((generation) => generation.kind === 'image'),
    [results],
  )

  function created(generation: Generation) {
    setResults((current) => [generation, ...current.filter((item) => item.id !== generation.id)])
    if (generation.kind === 'video' && 'sceneId' in generation && generation.sceneId) {
      mergeLatestSceneVideo(generation as ProjectGeneration)
    }
    onCreated?.(generation)
    onNotify(notification('studio', 'notifyRequestQueued'))
  }

  // ── Thao tác hàng loạt trên cảnh (không tự xếp hàng tạo nội dung) ──────────

  /** Thay các cảnh vừa được server trả về, giữ nguyên phần còn lại. */
  function mergeScenes(updated: ProjectScene[]) {
    if (!updated.length) return
    setScenes((current) =>
      current.map((scene) => updated.find((item) => item.id === scene.id) ?? scene),
    )
  }

  async function runBulk(input: SceneBulkInput, notifyKey: StudioKey, onFailure?: (error: ErrorMessage) => void): Promise<boolean> {
    if (!project) return false
    setBusy('scenes-bulk')
    if (!onFailure) setError(null)
    try {
      const result = await projectsApi.bulkScenes(project.id, input)
      if (selectedIdRef.current !== project.id) return false
      mergeScenes(result.scenes)
      invalidateLatestSceneVideos(project.id)
      setSelectedSceneIds([])
      if (input.autoGenerate) setAwaitingAutoGenerate(true)
      onNotify(notification('studio', notifyKey))
      // Ancillary refreshes should never turn a successful bulk save into failure.
      try {
        const generations = await projectsApi.results(project.id)
        if (selectedIdRef.current === project.id) setResults(generations.generations)
      } catch { /* background polling will recover */ }
      void refreshLatestSceneVideos(project.id)
      return true
    } catch (cause) {
      const described = describeError(cause)
      if (onFailure) onFailure(described)
      else setError(described)
      return false
    } finally {
      if (selectedIdRef.current === project.id) setBusy('')
    }
  }

  function bulkSetApproval(approved: boolean) {
    if (!selectedSceneIds.length) {
      setError({ key: 'sceneBulkNeedsSelection' })
      return
    }
    void runBulk(
      { ids: selectedSceneIds, approved },
      approved ? 'notifyScenesApproved' : 'notifyScenesUnapproved',
    )
  }

  /** Open with a stable target snapshot; settings assignment never generates. */
  function openBulkSettings() {
    const targets = selectedSceneIds.length ? [...selectedSceneIds] : orderedScenes.filter(scene => !scene.modelId).map(scene => scene.id)
    setBulkSettingsTargets(targets)
    setBulkSettingsSelectedCount(selectedSceneIds.length)
    setBulkSettingsUsesSelection(selectedSceneIds.length > 0)
    setBulkSettingsError(null)
    setBulkSettingsOpen(true)
  }

  async function applyBulkSettings() {
    if (!bulkModel) { setBulkSettingsError(t('sceneBulkNoModelSelected')); return }
    if (!parsedBulkParams || bulkDurationInvalid) {
      setBulkSettingsError(t(!parsedBulkParams ? 'advancedParamsMustBeObject' : 'videoSecondsInvalid', { max: isAgnesFlash(bulkModel.modelId) ? 12 : 30 }))
      return
    }
    if (!bulkSettingsTargets.length) { setBulkSettingsError(t('sceneBulkNeedsSelection')); return }
    const { logoOverlays: _logos, allowTemporaryMedia: _temporary, useCharacterReference: _reference, ...providerParams } = bulkEffectiveParams
    const params = usesAgnes(bulkModel) ? agnesInput(providerParams as GenerationParamsInput, bulkModel) : providerParams
    const { useCharacterReference: _agnesReference, ...settings } = params
    const succeeded = await runBulk({ ids: bulkSettingsTargets, modelId: bulkModelId, params: settings,
      modelAssignment: bulkSettingsUsesSelection ? 'replace' : 'missing' }, 'notifyScenesVideoSettingsApplied', failure => setBulkSettingsError(errorTextOf(failure, t)))
    if (succeeded) setBulkSettingsOpen(false)
  }

  /** Đánh dấu các cảnh đã duyệt để worker xếp hàng tạo video lần lượt. */
  function bulkGenerateApproved() {
    const approvedIds = orderedScenes.filter((scene) => scene.approved).map((scene) => scene.id)
    const targets = selectedSceneIds.length
      ? selectedSceneIds.filter((id) => approvedIds.includes(id))
      : approvedIds
    if (!targets.length) {
      setError({ key: 'sceneBulkNoApproved' })
      return
    }
    void runBulk({ ids: targets, approved: true, autoGenerate: true }, 'notifyScenesQueued')
  }

  /** Duyệt / bỏ duyệt một cảnh ngay trên thẻ. */
  function toggleSceneApproval(scene: ProjectScene, approved: boolean) {
    void runBulk(
      { ids: [scene.id], approved },
      approved ? 'notifyScenesApproved' : 'notifyScenesUnapproved',
    )
  }

  /** Tạo video cho một cảnh bằng model đã gán; cảnh thiếu model phải chọn trước. */
  async function generateVideoForScene(scene: ProjectScene) {
    const requestProjectId = project?.id
    if (!requestProjectId || !scene.modelId) {
      if (requestProjectId) setError({ key: 'sceneModelRequired' })
      return
    }
    setBusy(`scene-generate:${scene.id}`)
    setError(null)
    try {
      const { generation } = await projectsApi.generateScene(scene.id, newKey())
      if (selectedIdRef.current !== requestProjectId) return
      setResults(current => [generation, ...current.filter(item => item.id !== generation.id)])
      mergeLatestSceneVideo(generation as ProjectGeneration)
      onCreated?.(generation)
      onNotify(notification('studio', 'notifyRequestQueued'))
    } catch (cause) {
      if (selectedIdRef.current === requestProjectId) setError(describeError(cause))
    } finally {
      if (selectedIdRef.current === requestProjectId) setBusy('')
    }
  }

  /** Gán model video cho một cảnh ngay trên thẻ rồi lưu lại. */
  async function assignSceneModel(scene: ProjectScene, modelId: string) {
    if (!project) return
    setBusy(`scene-model:${scene.id}`)
    setError(null)
    try {
      const { scene: updated } = await projectsApi.updateScene(project.id, scene.id, { modelId })
      setScenes((current) => current.map((item) => (item.id === updated.id ? updated : item)))
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy('')
    }
  }

  function toggleSceneSelection(sceneId: string, selected: boolean) {
    setSelectedSceneIds((current) =>
      selected ? [...current, sceneId] : current.filter((id) => id !== sceneId),
    )
  }

  async function moveProjectToTrash(deleteResults: boolean) {
    if (!trashProject) return
    await projectsApi.trash(trashProject.id, deleteResults)
    setProjects((current) => current.filter((item) => item.id !== trashProject.id))
    setSelectedId('')
    setCharacters([])
    setScenes([])
    setResults([])
    setSceneEdit(null)
    setCharacterModal(null)
    setProjectModal(null)
    setSourceImages([])
    setTrashProject(null)
    setListRevision((value) => value + 1)
    onNotify(notification('studio', 'notifyProjectTrashed'))
  }

  async function restoreProject(item: Project) {
    setBusy(`restore:${item.id}`)
    setError(null)
    try {
      await projectsApi.restore(item.id)
      setProjects((current) => current.filter((entry) => entry.id !== item.id))
      setListRevision((value) => value + 1)
      onNotify(notification('studio', 'notifyProjectRestored'))
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy('')
    }
  }

  async function refresh() {
    setBusy('refresh')
    setError(null)
    try {
      const list = await projectsApi.list(showTrash)
      setProjects(list.projects)
      const pairs = await Promise.all((showTrash ? [] : list.projects.slice(0, 12)).map(async (item) => {
        try {
          const found = firstAsset((await projectsApi.results(item.id)).generations)
          return found ? ([item.id, { url: found.asset.url, kind: found.kind }] as const) : null
        } catch { return null }
      }))
      setCovers(Object.fromEntries(pairs.filter(Boolean) as Array<[string, { url: string; kind: 'image' | 'video' }]>))
      if (selectedId) {
        const [characterResult, sceneResult, generationResult] = await Promise.all([
          projectsApi.characters(selectedId),
          projectsApi.scenes(selectedId),
          projectsApi.results(selectedId),
        ])
        setCharacters(characterResult.characters)
        setScenes(sceneResult.scenes)
        setResults(generationResult.generations)
        setRevision((value) => value + 1)
      }
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy('')
    }
  }

  async function saveProject(input: ProjectInput) {
    if (projectModal && projectModal !== 'new') {
      const { project: updated } = await projectsApi.update(projectModal.id, input)
      setProjects((current) => current.map((item) => (item.id === updated.id ? updated : item)))
      onNotify(notification('studio', 'notifyProjectUpdated'))
      return
    }
    const { project: createdProject } = await projectsApi.create(input)
    setProjects((current) => [createdProject, ...current])
    setSelectedId(createdProject.id)
    setTab('images')
    onNotify(notification('studio', 'notifyProjectCreated'))
  }

  /** Lưu nhân vật, sau đó tải lên hoặc xóa ảnh tham chiếu nếu người dùng đổi. */
  async function saveCharacter(
    input: CharacterInput,
    changes: { file?: File; removeReference?: boolean; scope?: CharacterScope } = {},
  ) {
    if (!project) return

    const editing = characterModal && characterModal !== 'new' ? characterModal : null
    // Nhân vật thư viện (projectId null) phải dùng endpoint dùng chung; nhân vật
    // của dự án dùng endpoint project-scoped.
    const library = editing
      ? editing.projectId === null
      : changes.scope === 'library'
    let saved = editing
      ? library
        ? (await characterApi.update(editing.id, input)).character
        : (await projectsApi.updateCharacter(project.id, editing.id, input)).character
      : library
        ? (await characterApi.create(input)).character
        : (await projectsApi.createCharacter(project.id, input)).character

    if (changes.file) {
      saved = library
        ? (await characterApi.uploadReference(saved.id, changes.file)).character
        : (await projectsApi.uploadCharacterReference(project.id, saved.id, changes.file)).character
    } else if (changes.removeReference) {
      saved = library
        ? (await characterApi.removeReference(saved.id)).character
        : (await projectsApi.removeCharacterReference(project.id, saved.id)).character
    }

    setCharacters((current) => {
      const exists = current.some((item) => item.id === saved.id)
      return exists
        ? current.map((item) => (item.id === saved.id ? saved : item))
        : [...current, saved]
    })

    onNotify(
      editing
        ? notification('studio', 'notifyCharacterUpdated')
        : notification('studio', 'notifyCharacterAdded'),
    )
  }

  async function removeCharacter(character: ProjectCharacter) {
    if (!project) return
    setBusy(character.id)
    setError(null)
    try {
      if (character.projectId === null) {
        await characterApi.remove(character.id)
      } else {
        await fetchDeleteCharacter(project.id, character.id)
      }
      setCharacters((current) => current.filter((item) => item.id !== character.id))
      // Nhân vật đang gắn với trình tạo ảnh không còn nữa thì bỏ chọn.
      setImageCharacter((current) => (current === character.id ? '' : current))
      onNotify(notification('studio', 'notifyCharacterDeleted'))
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy('')
    }
  }

  /**
   * Xoá nhân vật của dự án bằng fetch thô (endpoint chưa có trong client) nhưng
   * vẫn dùng `assertResponseOk` để giữ nguyên metadata lỗi ngữ nghĩa
   * (`messageKey`/`messageParams`) thay vì chỉ lấy câu thô.
   */
  async function fetchDeleteCharacter(projectId: string, characterId: string) {
    const response = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/characters/${encodeURIComponent(characterId)}`,
      { method: 'DELETE', credentials: 'include' },
    )
    await assertResponseOk(response)
  }

  async function archive() {
    if (!project) return
    setBusy('archive')
    setError(null)
    try {
      const { project: updated } = await projectsApi.update(project.id, { archived: !project.archived })
      setProjects((current) => current.map((item) => (item.id === updated.id ? updated : item)))
      setSceneEdit(null)
      onNotify(
        updated.archived
          ? notification('studio', 'notifyProjectArchived')
          : notification('studio', 'notifyProjectUnarchived'),
      )
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy('')
    }
  }

  async function move(sceneId: string, direction: number) {
    if (!project) return
    const ordered = [...orderedScenes]
    const index = ordered.findIndex((item) => item.id === sceneId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= ordered.length) return

    const swapped = [...ordered]
    ;[swapped[index], swapped[target]] = [swapped[target], swapped[index]]

    setBusy('reorder')
    setError(null)
    try {
      const response = await projectsApi.reorder(
        project.id,
        swapped.map((item) => item.id),
      )
      setScenes(response.scenes)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy('')
    }
  }

  function saveScene(scene: ProjectScene) {
    setScenes((current) => {
      const exists = current.some((item) => item.id === scene.id)
      return exists
        ? current.map((item) => (item.id === scene.id ? scene : item))
        : [...current, scene]
    })
    setSceneEdit(scene)
  }

  async function generateImage(event: FormEvent) {
    event.preventDefault()
    if (!project || project.archived || busy || !imagePrompt.trim() || !imageModels.some(model => model.id === imageModel)) return
    const projectId = project.id
    const fingerprint = imageFingerprintRef.current
    setBusy('image')
    setError(null)
    try {
      const base = parseParams(imageParams)
      imageKey.current ??= newKey()
      const input: GenerationCreateInput & { locationId?: string } = structuredClone({
        projectId,
        ...(imageCharacter ? { characterId: imageCharacter } : {}),
        modelId: imageModel,
        prompt: imageDocument.text,
        promptDocument: imageDocument,
        logoOverlays: imageLogoOverlays,
        allowTemporaryMedia: imageAllowTemporaryMedia,
        params: { ...base, size: imageSize, ...(imageQuality ? { quality: imageQuality } : {}),
          useCharacterReference: willSendCharacterReference } as GenerationParamsInput,
        idempotencyKey: imageKey.current,
        ...(imageLocationId ? { locationId: imageLocationId } : {}),
        ...(sourceImages.length ? { sourceUploadIds: sourceImages.map(item => item.id) } : {}),
      })
      const action = async (): Promise<void> => {
        if (selectedIdRef.current !== projectId) return
        setImagePreview(null)
        setBusy('image')
        setError(null)
        try {
          const { generation } = await generationApi.create(input)
          imageKey.current = null
          if (selectedIdRef.current === projectId) {
            if (imageFingerprintRef.current === fingerprint) {
              setImageDocument({ version: 1, text: '', mentions: [] })
              setImageLogoOverlays([])
              setImageAllowTemporaryMedia(false)
            }
            created(generation)
          } else onCreated?.(generation)
        } catch (cause) {
          if (selectedIdRef.current === projectId) setError(describeError(cause))
        } finally {
          setBusy('')
        }
      }
      if (imageDocument.mentions.length || imageLogoOverlays.length || imageAllowTemporaryMedia) {
        const { preview } = await generationApi.preview(input)
        if (imageFingerprintRef.current === fingerprint && selectedIdRef.current === projectId) {
          setImagePreview({ input, preview: entityDialogPreview(preview), fingerprint, action })
        }
      } else await action()
    } catch (cause) {
      if (selectedIdRef.current === projectId) setError(describeError(cause))
    } finally {
      setBusy('')
    }
  }

  /** Tải ảnh nguồn lên ngay khi chọn để sẵn sàng cho lần tạo tiếp theo. */
  async function addSourceImages(files: FileList | null) {
    if (!files?.length) return
    setUploadingImage(true)
    setError(null)
    try {
      const uploaded: SourceUpload[] = []
      for (const file of Array.from(files).slice(0, MAX_SOURCE_IMAGES - sourceImages.length)) {
        uploaded.push(await uploadApi.upload(file))
      }
      setSourceImages((current) => [...current, ...uploaded])
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setUploadingImage(false)
    }
  }

  async function removeSourceImage(id: string) {
    setSourceImages((current) => current.filter((item) => item.id !== id))
    try {
      await uploadApi.remove(id)
    } catch {
      // Ảnh sẽ được dọn tự động; không cần chặn người dùng.
    }
  }

  /** Tính lại ảnh bìa của dự án sau khi một kết quả bị xoá. */
  async function refreshCover(projectId: string) {
    try {
      const found = firstAsset((await projectsApi.results(projectId)).generations)
      setCovers((current) => {
        const next = { ...current }
        if (found) next[projectId] = { url: found.asset.url, kind: found.kind }
        else delete next[projectId]
        return next
      })
    } catch {
      // Bìa chỉ là trang trí, không nên chặn thao tác xoá.
    }
  }

  /** Xoá một kết quả ngay trong Studio, không cần sang Thư viện. */
  async function removeResult(id: string) {
    if (!project) return
    const generation = results.find((item) => item.id === id)
    const acknowledgeUnknown = generation?.status === 'unknown' && !generation.providerJobId
    if (acknowledgeUnknown && !window.confirm(tShell(generation.kind === 'video' ? 'confirmTrashUnknownVideo' : 'confirmTrashUnknownImage'))) return
    const requestProjectId = project.id
    setBusy(id)
    setError(null)
    try {
      await generationApi.remove(id, acknowledgeUnknown ? { acknowledgeUnknown: true } : undefined)
      if (selectedIdRef.current !== requestProjectId) return
      setResults(current => current.filter(item => item.id !== id))
      if (generation?.sceneId) {
        invalidateLatestSceneVideos(requestProjectId)
        setLatestSceneVideos(current => current.filter(item => item.id !== id))
      }
      onNotify(notification('studio', 'notifyResultDeleted'))
      // Refresh dependent state independently: a GET failure is not a failed delete.
      if (generation?.sceneId) void refreshLatestSceneVideos(requestProjectId)
      void projectsApi.scenes(requestProjectId).then(sceneResult => {
        if (selectedIdRef.current === requestProjectId) setScenes(sceneResult.scenes)
      }).catch(() => {})
      void refreshCover(requestProjectId)
    } catch (cause) {
      if (selectedIdRef.current === requestProjectId) setError(describeError(cause))
    } finally {
      if (selectedIdRef.current === requestProjectId) setBusy('')
    }
  }

  async function retryDownload(id: string) {
    setBusy(id)
    setError(null)
    try {
      const { generation } = await generationApi.retryDownload(id)
      created(generation)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy('')
    }
  }

  const canGenerateAny = imageModels.length > 0 || videoModels.length > 0

  return (
    <div className={`project-studio${project && tab === 'scenes' ? ' is-scenes-tab' : ''}`}>
      {imagePreview && <GenerationPreviewDialog preview={imagePreview.preview} disabled={!!busy}
        onCancel={() => setImagePreview(null)} onConfirm={() => {
          if (imagePreview.fingerprint !== imageFingerprintRef.current) { setImagePreview(null); return }
          void imagePreview.action()
        }} />}
      {trashProject && <ProjectTrashDialog project={trashProject} onClose={() => setTrashProject(null)} onConfirm={moveProjectToTrash} />}
      {error && <div className="form-error" role="alert" title={errorDetailOf(error)}>{errorTextOf(error, t)}</div>}

      {!project ? (
        <>
          <div className="project-section-header">
            <div>
              <div className="eyebrow">{t('projectStudioEyebrow')}</div>
              <h1>{t('projectStudioTitle')}</h1>
              <p>{t('projectStudioIntro')}</p>
            </div>
            <div className="project-actions">
              <button
                className="secondary-button"
                disabled={!!busy || loading}
                onClick={() => void refresh()}
              >
                <RefreshCw size={15} /> {t('refresh')}
              </button>
              {!showTrash && <button className="primary-small-button" onClick={() => setProjectModal('new')}>
                <Plus size={15} /> {t('createProject')}
              </button>}
            </div>
          </div>

          {!showTrash && !loading && <details className="studio-start-guide" key={projects.length ? 'existing' : 'first'} open={projects.length === 0 || undefined}>
            <summary>{help(projects.length ? 'guide' : 'welcome')}</summary>
            <p>{help('intro')}</p>
            <ol className="studio-start-steps"><li>{help('step1')}</li><li>{help('step2')}</li><li>{help('step3')}</li></ol>
          </details>}

          {!canGenerateAny && (
            <div className="notice-banner">
              <Settings2 size={18} />
              <div>
                <strong>{t('noModelsConfigured')}</strong>
                <p>
                  {t('noModelsConfiguredHint')}
                  {onOpenSettings && (
                    <>
                      {' '}
                      <button className="text-button" onClick={onOpenSettings}>
                        {t('openApiModels')}
                      </button>
                    </>
                  )}
                </p>
              </div>
            </div>
          )}

          <div className="project-dashboard-toolbar">
            <label className="project-search">
              <Search size={16} />
              <input
                value={search}
                placeholder={t('searchProjectsPlaceholder')}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <button className="secondary-button project-trash-filter" aria-pressed={showTrash} disabled={!!busy} onClick={() => {
              setSelectedId('')
              setShowTrash((value) => !value)
            }}><Trash2 size={15} /> {showTrash ? t('projectsTab') : t('trashTab')}</button>
            {!showTrash && <label className="project-archive-toggle">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(event) => setShowArchived(event.target.checked)}
              />
              {t('showArchivedLabel')}
            </label>}
          </div>
          {!showTrash && !loading && projects.length > 0 && visibleProjects.length === 0 && <div className="studio-no-matches" role="status"><p>{help('noMatches')}</p><button type="button" className="secondary-button" onClick={() => { setSearch(''); setShowArchived(true) }}>{help('clearFilters')}</button></div>}
          {showTrash && <p className="project-trash-summary">{t('trashSummary')} {onOpenTrash && <button type="button" className="text-button" onClick={onOpenTrash}>{t('openUnifiedTrash')}</button>}</p>}

          {loading ? (
            <div className="empty-state">
              <LoaderCircle size={26} className="spin" />
              <h3>{t('loadingProjects')}</h3>
            </div>
          ) : (
            <div className="project-dashboard-grid">
              {visibleProjects.map((item) => {
                const cover = covers[item.id]
                return (
                  <article key={item.id} className="project-dashboard-card project-trash-card" data-project-id={item.id}>
                    {showTrash ? <div className="project-card-body"><h3>{item.name}</h3><p>{item.description}</p></div> : <button
                      className="project-card-open"
                      onClick={() => {
                        setSelectedId(item.id)
                        setTab('images')
                      }}
                    >
                    <div className="project-cover">
                      {cover ? (
                        cover.kind === 'video' ? (
                          <video src={cover.url} muted preload="metadata" />
                        ) : (
                          <img src={cover.url} alt="" loading="lazy" />
                        )
                      ) : (
                        <div className="project-cover-placeholder">
                          <Layers3 />
                          <span>{t('noContent')}</span>
                        </div>
                      )}
                    </div>
                    <div className="project-card-body">
                      <h3>{item.name}</h3>
                      <div className="project-card-meta">
                        <span>{item.language || 'vi'}</span>
                        {item.style && <span>{item.style.slice(0, 24)}</span>}
                        {item.archived && <span className="not-connected-pill">{t('archivedBadge')}</span>}
                      </div>
                    </div>
                    </button>}
                    {showTrash && <p className="project-trash-expiry">{t('permanentDeleteAt', { date: item.purgeAfter ? formatDate(item.purgeAfter, { dateStyle: 'short', timeStyle: 'short' }, locale) : t('after30Days') })}<br />{item.deleteResults ? t('purgeDeletesResults') : t('purgeKeepsResults')}</p>}
                    <div className="project-trash-card-actions">
                      {showTrash ? <button className="secondary-button" disabled={!!busy} onClick={() => void restoreProject(item)}>
                        {busy === `restore:${item.id}` && <LoaderCircle size={14} className="spin" />} {t('restore')}
                      </button> : <button className="secondary-button project-trash-danger" disabled={!!busy} onClick={() => setTrashProject(item)}><Trash2 size={14} /> {t('deleteAction')}</button>}
                    </div>
                  </article>
                )
              })}
              {showTrash && visibleProjects.length === 0 && <div className="empty-state"><Trash2 size={26} /><h3>{t('trashEmptyTitle')}</h3><p>{t('trashEmptyHint')}</p></div>}

              {!showTrash && projects.length > 0 && <button className="project-start-card" onClick={() => setProjectModal('new')}>
                <Sparkles size={28} />
                <strong>{t('createNewProject')}</strong>
                <span className="project-hint">
                  {t('startProjectHint')}
                </span>
              </button>}
            </div>
          )}
        </>
      ) : (
        <>
          <button className="project-back" onClick={() => setSelectedId('')}>
            <ArrowLeft size={15} /> {t('projectList')}
          </button>

          <div className="project-detail-header">
            <div>
              <h2>{project.name}</h2>
              <p>{project.description || t('noDescription')}</p>
              <div className="project-card-meta">
                <span className="project-badge">{project.language || 'vi'}</span>
                {project.style && <span className="project-badge">{project.style}</span>}
                <span className="project-badge">
                  <Users size={13} /> {t('characterCount', { count: characters.length })}
                </span>
                <span className="project-badge">
                  <Film size={13} /> {t('sceneCount', { count: orderedScenes.length })}
                </span>
                {project.archived && <span className="not-connected-pill">{t('archivedBadge')}</span>}
              </div>
            </div>
            <div className="project-actions">
              <button className="secondary-button" disabled={!!busy} onClick={() => setTab('images')}>
                <ImagePlus size={15} /> {t('createImageShortcut')}
              </button>
              <button
                className="secondary-button"
                disabled={!!busy || project.archived}
                onClick={() => setExportOpen(true)}
              >
                <Film size={15} /> {t('exportVideoAction')}
              </button>
              <details className="studio-project-manage"><summary>{help('manage')}</summary><div className="project-actions">
              <button className="secondary-button" disabled={!!busy} onClick={() => setProjectModal(project)}>
                <Pencil size={15} /> {t('editProject')}
              </button>
              <button className="secondary-button" disabled={!!busy} onClick={() => void archive()}>
                {project.archived ? t('restore') : t('archiveAction')}
              </button>
              <button className="secondary-button project-trash-danger" disabled={!!busy} onClick={() => setTrashProject(project)}><Trash2 size={15} /> {t('deleteAction')}</button>
              </div></details>
            </div>
          </div>

          {project.archived && (
            <Notice tone="warn">
              {t('archivedProjectNotice')}
            </Notice>
          )}

          {!detailLoading && !project.archived && <details className="studio-start-guide" key={project.id} open={!results.length && !scenes.length || undefined}>
            <summary>{help('guide')}</summary><p>{help('intro')}</p>
            <div className="project-actions"><button type="button" className="secondary-button" onClick={() => { setTab('images'); requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.project-composer textarea')?.focus()) }}><ImageIcon size={16} />{help('firstImage')}</button><button type="button" className="secondary-button" onClick={() => { setTab('scenes'); openScene('new') }}><Film size={16} />{help('firstVideo')}</button></div>
          </details>}
          <div className="project-tabs" role="tablist" aria-label={t('projectStudioTitle')} onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
            const index = buttons.indexOf(event.target as HTMLButtonElement)
            if (index < 0) return
            event.preventDefault()
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
            buttons[next].click(); buttons[next].focus(); buttons[next].scrollIntoView({ block: 'nearest', inline: 'nearest' })
          }}>

            <button
              role="tab"
              aria-label={t('tabImagesAria')}
              id="studio-tab-images"
              aria-controls="studio-active-panel"
              tabIndex={tab === 'images' ? 0 : -1}
              aria-selected={tab === 'images'}
              className={tab === 'images' ? 'active' : ''}
              onClick={() => setTab('images')}
            >
              <ImageIcon size={16} /> {t('tabImagesAria')}
            </button>
            <button
              role="tab"
              aria-label={t('tabCharactersAria')}
              id="studio-tab-characters"
              aria-controls="studio-active-panel"
              tabIndex={tab === 'characters' ? 0 : -1}
              aria-selected={tab === 'characters'}
              className={tab === 'characters' ? 'active' : ''}
              onClick={() => setTab('characters')}
            >
              <Users size={16} /> {t('tabCharactersAria')}
            </button>
            <button
              role="tab"
              aria-label={t('tabScenesAria')}
              id="studio-tab-scenes"
              aria-controls="studio-active-panel"
              tabIndex={tab === 'scenes' ? 0 : -1}
              aria-selected={tab === 'scenes'}
              className={tab === 'scenes' ? 'active' : ''}
              onClick={() => setTab('scenes')}
            >
              <Film size={16} /> {t('tabScenesAria')}
            </button>
            <button
              role="tab"
              aria-label={tLocations('title')}
              id="studio-tab-locations"
              aria-controls="studio-active-panel"
              tabIndex={tab === 'locations' ? 0 : -1}
              aria-selected={tab === 'locations'}
              className={tab === 'locations' ? 'active' : ''}
              onClick={() => setTab('locations')}
            >
              <Layers3 size={16} /> {tLocations('title')}
            </button>
            <button
              role="tab"
              aria-label={tCanvas('tabTitle')}
              id="studio-tab-canvas"
              aria-controls="studio-active-panel"
              tabIndex={tab === 'canvas' ? 0 : -1}
              aria-selected={tab === 'canvas'}
              className={tab === 'canvas' ? 'active' : ''}
              onClick={() => setTab('canvas')}
            >
              <Boxes size={16} /> {tCanvas('tabTitle')}
            </button>
          </div>


          <div id="studio-active-panel" role="tabpanel" aria-labelledby={`studio-tab-${tab}`}>
          {detailLoading ? (
            <div className="empty-state">
              <LoaderCircle size={24} className="spin" />
              <h3>{t('loadingProjectDetails')}</h3>
            </div>
          ) : tab === 'canvas' ? (
            <div className="project-tab-panel project-canvas-panel">
              <CanvasBoard
                projectId={project.id}
                projectName={project.name}
                archived={project.archived}
                characters={characters}
                locations={locations}
                scenes={scenes}
                models={models}
                onNotify={onNotify}
              />
            </div>
          ) : tab === 'images' ? (
            <div className="project-tab-panel project-workspace">
              <form className="project-composer" onSubmit={generateImage}>
                <div className="project-panel-heading">
                  <h3>{t('createProjectImage')}</h3>
                </div>
                <p className="project-hint">{t('tabImagesHint')}</p>
                <fieldset className="modal-form project-fields" disabled={busy === 'image'}>
                  <Field label={t('imagePromptLabel')}>
                    <EntityMentionTextarea
                      document={imageDocument}
                      projectId={project.id}
                      placeholder={t('imagePromptPlaceholder')}
                      maxLength={8000}
                      disabled={!!busy || project.archived}
                      onChange={(document) => {
                        imageKey.current = null
                        setImagePreview(null)
                        setImageDocument(document)
                        setImageLogoOverlays(current => boundLogoOverlays(current, document))
                      }}
                    />
                  </Field>
                  <Field label={t('imageModelLabel')}>
                    <select value={imageModel} onChange={(event) => setImageModel(event.target.value)}>
                      <option value="">{t('chooseModel')}</option>
                      {imageModel && !imageModels.some(model => model.id === imageModel) && <option value={imageModel}>{t('sceneModelUnavailable')}</option>}
                      {imageModels.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.displayName} · {model.providerName}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <div className="project-field-row">
                    <Field label={t('sizeLabel')}>
                      <select value={imageSize} onChange={(event) => setImageSize(event.target.value)}>
                        {IMAGE_SIZES.map((option) => (
                          <option key={option.value} value={option.value}>
                            {t(option.labelKey)}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label={t('qualityLabel')}>
                      <select
                        value={imageQuality}
                        onChange={(event) => setImageQuality(event.target.value)}
                      >
                        {IMAGE_QUALITIES.map((option) => (
                          <option key={option.value} value={option.value}>
                            {t(option.labelKey)}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                </fieldset>

                <Notice tone="warn">
                  {t('costNoteWithModel')}
                </Notice>

                <button
                  className="project-generate-button"
                  disabled={busy === 'image' || !imagePrompt.trim() || !imageModels.some(model => model.id === imageModel) || project.archived}
                >
                  {busy === 'image' ? (
                    <LoaderCircle size={17} className="spin" />
                  ) : (
                    <ImageIcon size={17} />
                  )}
                  {t('generateProjectImage')}
                </button>
                {(!imageModel || !imageModels.some(model => model.id === imageModel)) ? <div className="studio-help" role="status"><p>{help('needModel')}</p>{onOpenSettings && <button type="button" className="text-button" onClick={onOpenSettings}>{t('openApiModels')}</button>}</div> : !imagePrompt.trim() && <p className="studio-help" role="status">{help('needPrompt')}</p>}
                <details className="studio-disclosure" ref={imageOptionsRef}><summary>{help('references')}</summary><fieldset className="modal-form project-fields" disabled={busy === 'image' || project.archived}>
                  <Field label={t('characterOptionalLabel')}>
                    <select
                      value={imageCharacter}
                      onChange={(event) => setImageCharacter(event.target.value)}
                    >
                      <option value="">{t('noCharacterAttached')}</option>
                      {characters.map((character) => (
                        <option key={character.id} value={character.id}>
                          {character.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={tLocations('selectLocation')}>
                    <select value={imageLocationId} onChange={(event) => setImageLocationId(event.target.value)}>
                      <option value="">{tLocations('unassigned')}</option>
                      {locations.map((location) => (
                        <option key={location.id} value={location.id}>
                          {location.name}{location.stage ? ` · ${location.stage}` : ''}
                        </option>
                      ))}
                    </select>
                    <span className="project-hint">{tLocations('locationSourceHint')}</span>
                  </Field>

                  {imageCharacterEntry && (
                    <div className="project-character-sync">
                      <div className="project-character-sync-head">
                        <div className="project-character-avatar">
                          {imageCharacterEntry.referenceUrl ? (
                            <img
                              src={imageCharacterEntry.referenceUrl}
                              alt={t('characterReferenceAlt', { name: imageCharacterEntry.name })}
                              loading="lazy"
                            />
                          ) : (
                            imageCharacterEntry.name.slice(0, 1).toUpperCase()
                          )}
                        </div>
                        <div>
                          <strong>{t('characterSync', { name: imageCharacterEntry.name })}</strong>
                          <p>
                            {imageCharacterEntry.appearance ||
                              t('noCharacterAppearance')}
                          </p>
                        </div>
                      </div>

                      {imageCharacterEntry.referenceUrl ? (
                        <label className="project-checkbox">
                          <input
                            type="checkbox"
                            checked={imageSendReference}
                            onChange={(event) => setImageSendReference(event.target.checked)}
                          />
                          <span>
                            {t('sendReferencePrefix')}<strong>{imageCharacterEntry.name}</strong>{t('sendReferenceSuffixImage')}
                          </span>
                        </label>
                      ) : (
                        <div className="project-character-sync-warning">
                          <span>
                            {t('characterNoReferenceWarning')}
                          </span>
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => setCharacterModal(imageCharacterEntry)}
                          >
                            {t('addReferenceImage')}
                          </button>
                        </div>
                      )}

                      {willSendCharacterReference && (
                        <span className="project-hint">
                          {t('referenceLimitHint', { max: MAX_SOURCE_IMAGES })}
                        </span>
                      )}
                    </div>
                  )}
                  <EntityGenerationOptions document={imageDocument} overlays={imageLogoOverlays}
                    onOverlaysChange={setImageLogoOverlays} allowTemporaryMedia={imageAllowTemporaryMedia}
                    onAllowTemporaryMediaChange={setImageAllowTemporaryMedia} disabled={!!busy || project.archived} projectId={project.id} />
                  <div className="project-source">
                    <span className="project-reference-label">{t('sourceImagesLabel')}</span>
                    <div className="project-source-strip">
                      {sourceImages.map((item) => (
                        <div className="project-source-item" key={item.id}>
                          <img src={item.url} alt="" />
                          <button
                            type="button"
                            className="project-source-remove"
                            aria-label={t('removeSourceImageAria')}
                            onClick={() => void removeSourceImage(item.id)}
                          >
                            <X size={13} />
                          </button>
                        </div>
                      ))}
                      {sourceImages.length < MAX_SOURCE_IMAGES && (
                        <label className="project-source-add">
                          <input
                            type="file"
                            accept="image/png,image/jpeg,image/webp,image/gif"
                            multiple
                            disabled={uploadingImage}
                            onChange={(event) => {
                              void addSourceImages(event.target.files)
                              event.target.value = ''
                            }}
                          />
                          {uploadingImage ? (
                            <LoaderCircle size={18} className="spin" />
                          ) : (
                            <Plus size={18} />
                          )}
                          <span>{t('addImage')}</span>
                        </label>
                      )}
                    </div>
                    <span className="project-hint">
                      {t('sourceImagesHintPrefix', { max: MAX_SOURCE_IMAGES })}
                      <code> /images/edits </code>
                      {t('sourceImagesHintSuffix')}
                    </span>
                  </div>

                  <details className="project-advanced">
                    <summary>{t('advancedJsonSummary')}</summary>
                    <textarea
                      value={imageParams}
                      spellCheck={false}
                      onChange={(event) => setImageParams(event.target.value)}
                    />
                  </details>
                </fieldset></details>
              </form>

              <div className="project-results-panel">
                <div className="project-panel-heading">
                  <h3>{t('projectImagesPanel')}</h3>
                  <span className="project-badge">{t('imageCountBadge', { count: imageResults.length })}</span>
                </div>
                {imageResults.length ? (
                  <div className="project-results">
                    {imageResults.map((generation) => (
                      <CreationCard
                        key={generation.id}
                        generation={generation}
                        onDelete={() => void removeResult(generation.id)}
                        onRetry={() => void retryDownload(generation.id)}
                        busy={busy === generation.id}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="project-empty-media">
                    <ImageIcon size={36} />
                    <h3>{t('noImagesTitle')}</h3>
                    <p>{t('noImagesHint')}</p>
                  </div>
                )}
              </div>
            </div>
          ) : tab === 'locations' ? (
            <div className="project-tab-panel">
              <LocationReferences
                projectId={project.id}
                locations={locations}
                imageModels={imageModels}
                selectedModelId={imageModel}
                api={locationPanelApi(projectLocationsApi(project.id))}
                onChanged={setLocations}
                onNotify={onNotify}
                assignedCounts={Object.fromEntries(locations.map((location) => [location.id, scenes.filter((scene) => scene.locationId === location.id).length]))}
                referenceUrl={(uploadId) => `/api/uploads/${encodeURIComponent(uploadId)}`}
              />
            </div>
          ) : tab === 'characters' ? (
            <div className="project-tab-panel">
              <div className="project-section-header">
                <div>
                  <h3>{t('charactersVoicesTitle')}</h3>
                  <p>{t('charactersVoicesHint')}</p>
                </div>
                <button
                  className="primary-small-button"
                  disabled={project.archived}
                  onClick={() => setCharacterModal('new')}
                >
                  <Plus size={15} /> {t('addCharacter')}
                </button>
              </div>

              {characters.length ? (
                <div className="project-character-list">
                  {characters.map((character) => (
                    <article className="project-character-card" key={character.id}>
                      <div className="project-character-main">
                        <div className="project-character-avatar">
                          {character.referenceUrl ? (
                            <img src={character.referenceUrl} alt="" loading="lazy" />
                          ) : (
                            character.name.slice(0, 1).toUpperCase()
                          )}
                        </div>
                        <div>
                          <h3>{character.name}</h3>
                          <span className="project-character-scope">
                            {character.projectId === null ? t('sharedLibraryScope') : t('projectScope')}
                          </span>
                          {!character.referenceUrl && (
                            <span className="project-hint">{t('noReferenceImage')}</span>
                          )}
                        </div>
                      </div>
                      <p>{shortenAppearance(character.appearance || t('noAppearance'))}</p>
                      <div className="project-voice-summary">
                        <Mic size={14} />{' '}
                        {[
                          character.voice.accent,
                          character.voice.pitch,
                          character.voice.timbre,
                          character.voice.pace,
                        ]
                          .filter(Boolean)
                          .join(' · ') || t('noVoiceProfile')}
                      </div>
                      <div className="project-actions">
                        <button
                          className="secondary-button"
                          disabled={!!busy}
                          onClick={() => setCharacterModal(character)}
                        >
                          <Pencil size={14} /> {t('edit')}
                        </button>
                        <button
                          className="secondary-button"
                          disabled={!!busy}
                          onClick={() => void removeCharacter(character)}
                        >
                          <Trash2 size={14} /> {t('deleteAction')}
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="project-empty-media">
                  <Users size={36} />
                  <h3>{t('noCharactersTitle')}</h3>
                  <p>{t('noCharactersHint')}</p>
                </div>
              )}
            </div>
          ) : (
            <div className="project-tab-panel">
              <div className="project-section-header">
                <div>
                  <h3>{t('videoSceneSequence')}</h3>

                </div>
                <div className="project-actions scene-main-actions">
                  <div className="project-actions">
                    <button
                      className="primary-small-button"
                      disabled={project.archived || !!busy || !videoModels.length}
                      title={videoModels.length ? t('sceneBulkGenerateHint') : t('sceneBulkNoVideoModel')}
                      onClick={bulkGenerateApproved}
                    >
                      <Wand2 size={15} /> {t('sceneBulkGenerate')}
                    </button>
                  </div>
                <button type="button" ref={advancedScenesButtonRef} className="secondary-button" disabled={project.archived || !!busy} onClick={() => setAdvancedScenesOpen(true)}><Settings2 size={15} />{help('bulk')}</button>
                <button
                  className="primary-small-button"
                  disabled={project.archived}
                  onClick={() => openScene('new')}
                >
                  <Plus size={15} /> {t('addScene')}
                </button>
                </div>
              </div>

              {orderedScenes.length ? (
                <>
                  <div className="project-scene-list">
                  {orderedScenes.map((scene, index) => {
                    const chosen = scene.selectedGenerationId
                      ? results.find((item) => item.id === scene.selectedGenerationId)
                      : undefined
                    const latestVideo = latestSceneVideo(latestSceneVideos, scene.id)
                    const videoUrl = sceneVideoCoverUrl(latestVideo)
                    const illustrationUrl = scene.backgroundUrl ?? null
                    const sceneGenerations = results.filter((item) => item.sceneId === scene.id)
                    const activeGeneration = latestVideo && isActive(latestVideo) ? latestVideo : undefined
                    const failedGeneration = latestVideo?.status === 'failed'
                    const selected = selectedSceneIds.includes(scene.id)
                    const cardBusy = busy === `scene-generate:${scene.id}` || busy === `scene-model:${scene.id}`
                    return (
                      <article
                        key={scene.id}
                        className={`project-scene-card ${
                          sceneEdit !== 'new' && sceneEdit?.id === scene.id ? 'active' : ''
                        }`}
                      >
                        <div className="project-scene-thumb">
                          <span className="scene-order-tag">{help('sceneNumber', { number: String(index + 1).padStart(2, '0') })}</span>
                          <button type="button" className="scene-results-open" aria-label={help('viewSceneResults', { title: scene.title })} onClick={() => setResultsSceneId(scene.id)}>

                          <SceneCover
                            videoUrl={videoUrl}
                            illustrationUrl={illustrationUrl}
                            alt={t('sceneCoverIllustrationAria', { title: scene.title })}
                            badge={t('sceneCoverIllustration')}
                          />
                          </button>
                          {!videoUrl && illustrationUrl && (
                            <button
                              type="button"
                              className="text-button"
                              aria-label={t('sceneIllustrationPreviewAria', { title: scene.title })}
                              onClick={() => setSceneCoverZoom({ url: illustrationUrl, title: scene.title })}
                            >
                              <ImageIcon size={13} />
                            </button>
                          )}
                        </div>
                        <div className="project-scene-card-body">
                          <button type="button" className="scene-title-open" onClick={() => setResultsSceneId(scene.id)}>{scene.title}</button>
                          <div>
                            <label className="project-checkbox" style={{ margin: '0 0 8px', padding: '8px 10px' }}>
                              <input
                                type="checkbox"
                                checked={selected}
                                disabled={!!busy}
                                aria-label={t('sceneSelectAria', { title: scene.title })}
                                onChange={(event) => toggleSceneSelection(scene.id, event.target.checked)}
                              />
                              <span>{t('sceneBulkSelected', { count: selected ? 1 : 0 })}</span>
                            </label>
                          </div>
                          <div className="project-card-meta">
                            {scene.characterId ? (
                              <span>
                                {characters.find((item) => item.id === scene.characterId)?.name ??
                                  t('characterFallback')}
                              </span>
                            ) : (
                              <span>{t('noSpeaker')}</span>
                            )}
                            <span className="project-badge">
                              {t('sceneVersionCount', { count: sceneGenerations.length })}
                            </span>
                            {chosen && <span className="connected-pill"><span /> {t('sceneSelectedVersion')}</span>}
                            {activeGeneration && (
                              <span className="project-badge">
                                <LoaderCircle size={12} className="spin" />{' '}
                                {activeGeneration.status === 'queued'
                                  ? t('sceneStatusQueued')
                                  : t('sceneStatusRunning', { progress: activeGeneration.progress ?? 0 })}
                              </span>
                            )}
                            {failedGeneration && <span className="project-badge">{t('sceneStatusFailed')}</span>}
                          </div>

                          {!scene.modelId && (
                            <label className="plan-cell">
                              <span>{t('sceneChooseModel')}</span>
                              <select
                                value=""
                                disabled={project.archived || !!busy}
                                onChange={(event) => void assignSceneModel(scene, event.target.value)}
                              >
                                <option value="">{t('sceneChooseModel')}</option>
                                {videoModels.map((model) => (
                                  <option key={model.id} value={model.id}>
                                    {model.displayName}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}

                          <label className="project-checkbox">
                            <input
                              type="checkbox"
                              checked={!!scene.approved}
                              disabled={project.archived || !!busy}
                              aria-label={t('sceneApprovalAria', { title: scene.title })}
                              onChange={(event) => toggleSceneApproval(scene, event.target.checked)}
                            />
                            <span>
                              <Check size={13} /> {t('sceneApprovedLabel')}
                            </span>
                          </label>
                          {!scene.approved && <span className="project-hint">{t('sceneWaitingApproval')}</span>}

                          <div className="project-actions">
                            <button
                              className="primary-small-button"
                              disabled={project.archived || !!busy || !scene.modelId || !!activeGeneration}
                              title={scene.modelId ? t('sceneGenerateVideo') : t('sceneChooseModel')}
                              onClick={() => void generateVideoForScene(scene)}
                            >
                              {cardBusy ? <LoaderCircle size={13} className="spin" /> : <Wand2 size={13} />}{' '}
                              {t('sceneGenerateVideo')}
                            </button>
                            <button
                              className="secondary-button"
                              onClick={() => openScene(scene)}
                              aria-label={t('editSceneAria', { title: scene.title })}
                            >
                              <Pencil size={13} /> {t('edit')}
                            </button>
                            <button
                              className="secondary-button"
                              disabled={!!busy || index === 0}
                              onClick={() => void move(scene.id, -1)}
                              aria-label={t('moveSceneUpAria', { title: scene.title })}
                            >
                              <ChevronUp size={13} />
                            </button>
                            <button
                              className="secondary-button"
                              disabled={!!busy || index === orderedScenes.length - 1}
                              onClick={() => void move(scene.id, 1)}
                              aria-label={t('moveSceneDownAria', { title: scene.title })}
                            >
                              <ChevronDown size={13} />
                            </button>
                          </div>
                        </div>
                      </article>
                    )
                  })}
                  </div>
                </>
              ) : (
                <div className="project-empty-media">
                  <Film size={36} />
                  <h3>{t('noScenesTitle')}</h3>
                  <p>
                    {videoModels.length
                      ? t('noScenesHint')
                      : t('noVideoModelHint')}
                  </p>
                </div>
              )}

              {advancedScenesOpen && <SceneEditorModal title={help('bulk')} closeLabel={t('close')} closeDisabled={!!busy} onClose={() => setAdvancedScenesOpen(false)}><div className="scene-advanced-popup">

                  <div className="project-section-header">
                    <div>
                      <h3>{t('sceneBulkTitle')}</h3>
                      <p>{t('sceneBulkSelected', { count: selectedSceneIds.length })}</p>
                    </div>
                    <div className="project-actions">
                      <button
                        className="secondary-button"
                        disabled={project.archived || !!busy || !selectedSceneIds.length}
                        onClick={() => bulkSetApproval(true)}
                      >
                        <Check size={14} /> {t('sceneBulkApprove')}
                      </button>
                      <button
                        className="secondary-button"
                        disabled={project.archived || !!busy || !selectedSceneIds.length}
                        onClick={() => bulkSetApproval(false)}
                      >
                        {t('sceneBulkUnapprove')}
                      </button>
                    </div>
                  </div>

                  <button className="secondary-button" disabled={project.archived || !!busy} onClick={() => { setAdvancedScenesOpen(false); openBulkSettings() }}>
                    <Settings2 size={14} /> {t('sceneBulkVideoSettings')}
                  </button>
                  <p className="project-hint">{t('sceneBulkGenerateSavedSettingsHint')}</p>
                  <p className="project-hint">{t('sceneBulkGenerateHint')}</p>

                  {!videoModels.length ? (
                    <Notice tone="warn">{t('sceneBulkNoVideoModel')}</Notice>
                  ) : (
                    <Notice tone="warn">{t('sceneBulkCostWarning')}</Notice>
                  )}


              </div></SceneEditorModal>}
              {resultsSceneId && scenes.find(item => item.id === resultsSceneId) && <SceneResultsModal
                scene={scenes.find(item => item.id === resultsSceneId)!}
                generations={sceneHistory} loading={sceneHistoryLoading} busy={!!busy || project.archived}
                onClose={() => setResultsSceneId(null)}
                onEdit={() => { const target = scenes.find(item => item.id === resultsSceneId); setResultsSceneId(null); if (target) openScene(target) }}
                onSelect={async generationId => { setBusy('select-version'); try { const response = await projectsApi.selectGeneration(resultsSceneId, generationId); mergeScenes([response.scene]); invalidateLatestSceneVideos(project.id); void refreshLatestSceneVideos(project.id) } catch (cause) { setError(describeError(cause)) } finally { setBusy('') } }}
              />}
              {bulkSettingsOpen && project && tab === 'scenes' && (
                <BulkVideoSettingsModal
                  models={videoModels}
                  providerId={bulkProviderId}
                  modelId={bulkModelId}
                  params={bulkParams}
                  onProviderChange={(id: string) => {
                    if (!parsedBulkParams) { setBulkSettingsError(t('advancedParamsMustBeObject')); return }
                    setBulkProviderId(id)
                    selectBulkModel(videoModels.find(model => model.providerId === id)?.id ?? '', true)
                  }}
                  onModelChange={selectBulkModel}
                  onParamsChange={setBulkParams}
                  onApply={() => void applyBulkSettings()}
                  onClose={() => { setBulkSettingsOpen(false); requestAnimationFrame(() => advancedScenesButtonRef.current?.focus()) }}
                  busy={busy === 'scenes-bulk'}
                  readOnly={project.archived}
                  error={bulkSettingsErrorNode}
                  targetCount={bulkSettingsTargetCount}
                  selectedCount={bulkSettingsSelectedCount}
                />
              )}

              {sceneEdit && (
                <SceneWorkspace
                  key={editorKey}
                  scene={sceneEdit === 'new' ? undefined : sceneEdit}
                  projectId={project.id}
                  characters={characters}
                  locations={locations}
                  models={models}
                  revision={revision}
                  nextPosition={orderedScenes.length}
                  readOnly={project.archived}
                  onSaved={saveScene}
                  onCreated={created}
                  onDeleteGeneration={(id) => void removeResult(id)}
                  onClose={() => setSceneEdit(null)}
                  onNotify={onNotify}
                />
              )}
            </div>
          )}
          </div>
        </>
      )}

      {projectModal && (
        <ProjectForm
          project={projectModal === 'new' ? undefined : projectModal}
          onClose={() => setProjectModal(null)}
          onSave={saveProject}
        />
      )}

      {characterModal && project && (
        <CharacterForm
          character={characterModal === 'new' ? undefined : characterModal}
          language={project.language || 'vi'}
          allowLibraryScope
          onClose={() => setCharacterModal(null)}
          onSave={saveCharacter}
        />
      )}

      {exportOpen && project && (
        <ProjectExportModal projectId={project.id} onClose={() => setExportOpen(false)} />
      )}

      {sceneCoverZoom && (
        <ImageLightbox
          src={sceneCoverZoom.url}
          alt={t('sceneCoverIllustrationAria', { title: sceneCoverZoom.title })}
          onClose={() => setSceneCoverZoom(null)}
        />
      )}
    </div>
  )
}
