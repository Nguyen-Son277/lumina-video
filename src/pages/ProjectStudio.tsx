import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  ArrowLeft,
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
  Play,
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
import { ApiError, assertResponseOk, errorMessage } from '../api/client'
import { characterApi, generationApi, uploadApi, type SourceUpload } from '../api/endpoints'
import { LocationReferences } from '../components/LocationReferences'
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
import { ProjectTrashDialog } from '../components/ProjectTrashDialog'
import { formatDate, useTranslation, type MessageParams, type Translate } from '../i18n'
import { studioCatalog, type StudioKey } from '../i18n/catalogs/studio'
import { notification, type Notification } from '../i18n/messages'

type Props = {
  models: ModelInfo[]
  onNotify: (message: Notification) => void
  onCreated?: (generation: Generation) => void
  onOpenSettings?: () => void
}

type TabKey = 'images' | 'characters' | 'scenes' | 'locations'

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

const VIDEO_SIZES: readonly Option[] = [
  { value: '1280x720', labelKey: 'projectSizeLandscape1280' },
  { value: '720x1280', labelKey: 'projectSizePortrait720' },
]

const MAX_SOURCE_IMAGES = 4

const VIDEO_SECONDS: readonly Option[] = [
  { value: '4', labelKey: 'secondsOption' },
  { value: '8', labelKey: 'secondsOption' },
  { value: '12', labelKey: 'secondsOption' },
]

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
  const value: unknown = JSON.parse(text || '{}')
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalizedError('advancedParamsMustBeObject')
  }
  return value as Record<string, unknown>
}

function firstAsset(generations: ProjectGeneration[]) {
  for (const generation of generations) {
    const asset = generation.assets?.[0]
    if (asset) return { asset, kind: generation.kind }
  }
  return null
}

/**
 * Ảnh bìa của một cảnh: ưu tiên phiên bản đã chọn, rồi tới ảnh minh hoạ timeline,
 * cuối cùng là ô giữ chỗ. Ảnh minh hoạ có thể 404 (upload bị xoá) nên phải bắt
 * `onError` để quay về ô giữ chỗ thay vì làm vỡ trang.
 */
function SceneCover({
  videoUrl,
  illustrationUrl,
  alt,
  badge,
}: {
  videoUrl: string | null
  illustrationUrl: string | null
  alt: string
  badge: string
}) {
  const [failed, setFailed] = useState(false)
  if (videoUrl) return <video src={videoUrl} muted preload="metadata" />
  if (illustrationUrl && !failed) {
    return (
      <div style={{ position: 'relative', width: '100%', height: '100%' }}>
        <img src={illustrationUrl} alt={alt} loading="lazy" onError={() => setFailed(true)} />
        <span
          style={{
            position: 'absolute',
            left: 6,
            bottom: 6,
            padding: '2px 6px',
            borderRadius: 6,
            background: 'rgba(12, 13, 16, .82)',
            color: '#e4d9c6',
            fontSize: 9,
            lineHeight: 1.4,
          }}
        >
          {badge}
        </span>
      </div>
    )
  }
  return <Play size={20} />
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
          <button className="close-button" disabled={busy} onClick={onClose} aria-label={t('close')}>
            <X size={18} />
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

function Field({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <label>
      {label}
      {children}
    </label>
  )
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
      <form onSubmit={submit}>
        <fieldset className="modal-form project-fields" disabled={busy}>
          <Field label={t('projectNameLabel')}>
            <input
              required
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </Field>
          <Field label={t('descriptionLabel')}>
            <textarea
              value={draft.description}
              placeholder={t('projectDescriptionPlaceholder')}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </Field>
          <Field label={t('styleLabel')}>
            <textarea
              value={draft.style}
              placeholder={t('stylePlaceholder')}
              onChange={(event) => setDraft({ ...draft, style: event.target.value })}
            />
          </Field>
          <Field label={t('projectLanguageLabel')}>
            <input
              required
              value={draft.language}
              placeholder="vi"
              onChange={(event) => setDraft({ ...draft, language: event.target.value })}
            />
          </Field>
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
  const { t: tLocations } = useTranslation(locationsCatalog)
  const videoModels = models.filter((model) => model.enabled && model.kind === 'video')

  const [saved, setSaved] = useState<ProjectScene | undefined>(scene)
  const [draft, setDraft] = useState<SceneInput>(
    scene
      ? {
          title: scene.title,
          prompt: scene.prompt,
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
          characterId: characters[0]?.id ?? null,
          dialogue: '',
          modelId: videoModels[0]?.id ?? '',
          params: {},
          position: nextPosition,
          background: '',
        },
  )
  const [params, setParams] = useState(JSON.stringify(draft.params, null, 2))
  const [locationId, setLocationId] = useState(scene?.locationId ?? '')
  const [preview, setPreview] = useState<PromptPreview | null>(null)
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

  const step = !saved ? 1 : !preview ? 2 : 3

  function change<K extends keyof SceneInput>(field: K, value: SceneInput[K]) {
    invalidate()
    setDraft((current) => ({ ...current, [field]: value }))
  }

  function changeParam(field: string, value: unknown) {
    invalidate()
    const next = { ...(parseParamsSafe(params) ?? {}), [field]: value }
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
  const sizeValue = typeof parsedParams?.size === 'string' ? parsedParams.size : VIDEO_SIZES[0].value
  const secondsValue = String(parsedParams?.seconds ?? VIDEO_SECONDS[0].value)

  async function persist(): Promise<ProjectScene> {
    const input = { ...draft, params: parseParams(params), locationId: locationId || null } as SceneInput
    if (!input.title.trim()) throw new LocalizedError('sceneTitleRequired')
    if (!input.prompt.trim()) throw new LocalizedError('scenePromptRequired')
    if (!input.modelId) throw new LocalizedError('sceneModelRequired')
    if (input.dialogue.trim() && !input.characterId) {
      throw new LocalizedError('sceneDialogueNeedsCharacter')
    }

    const response = saved
      ? await projectsApi.updateScene(projectId, saved.id, input)
      : await projectsApi.createScene(projectId, input)

    setSaved(response.scene)
    onSaved(response.scene)
    return response.scene
  }

  async function perform(action: 'save' | 'preview' | 'generate') {
    setBusy(action)
    setError(null)
    try {
      if (action === 'generate') {
        if (!saved || !preview) throw new LocalizedError('previewBeforeGenerate')
        idempotency.current ??= newKey()
        const { generation } = await projectsApi.generateScene(saved.id, idempotency.current)
        idempotency.current = null
        onCreated(generation)
        setVersions((current) => [generation, ...current.filter((item) => item.id !== generation.id)])
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

  return (
    <section className="project-scene-editor">
      <div className="project-steps">
        <span className={`project-step ${step >= 1 ? 'active' : ''} ${saved ? 'done' : ''}`}>
          {t('stepSceneContent')}
        </span>
        <span className={`project-step ${step === 2 ? 'active' : ''} ${preview ? 'done' : ''}`}>
          {t('stepPreviewPrompt')}
        </span>
        <span className={`project-step ${step === 3 ? 'active' : ''}`}>{t('stepGenerateVideo')}</span>
      </div>

      <div className="project-workspace">
        <div className="project-composer">
          <div className="project-panel-heading">
            <h3>{saved ? t('editingScene') : t('newScene')}</h3>
            <button className="secondary-button" disabled={!!busy} onClick={onClose}>
              {t('close')}
            </button>
          </div>

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
            <Field label={t('sceneTitleLabel')}>
              <input
                value={draft.title}
                placeholder={t('sceneTitlePlaceholder')}
                onChange={(event) => change('title', event.target.value)}
              />
            </Field>

            <Field label={t('scenePromptLabel')}>
              <textarea
                value={draft.prompt}
                placeholder={t('scenePromptPlaceholder')}
                onChange={(event) => change('prompt', event.target.value)}
              />
            </Field>

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
                <span className="project-badge">{t('sceneIllustrationHint')}</span>
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

            {speakingCharacter?.referenceUrl && (
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

            <Field label={t('videoModelLabel')}>
              <select
                value={draft.modelId}
                onChange={(event) => change('modelId', event.target.value)}
              >
                <option value="">{t('chooseModel')}</option>
                {videoModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.displayName}
                  </option>
                ))}
              </select>
            </Field>

            <div className="project-field-row">
              <Field label={t('sizeLabel')}>
                <select
                  value={sizeValue}
                  onChange={(event) => changeParam('size', event.target.value)}
                >
                  {VIDEO_SIZES.map((option) => (
                    <option key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('durationLabel')}>
                <select
                  value={secondsValue}
                  onChange={(event) => changeParam('seconds', event.target.value)}
                >
                  {VIDEO_SECONDS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {t('secondsOption', { count: Number(option.value) })}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

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
          </fieldset>

          <Notice>{t('sceneVoiceNotice')}</Notice>

          {error && <div className="form-error" role="alert" title={errorDetailOf(error)}>{errorTextOf(error, t)}</div>}

          {preview && (
            <div className="project-prompt-preview">
              <strong>{t('promptPreviewTitle')}</strong>
              <pre>{preview.effectivePrompt}</pre>
            </div>
          )}

          <div className="project-actions">
            <button
              className="secondary-button"
              disabled={!!busy}
              onClick={() => void perform('preview')}
            >
              <Sparkles size={15} /> {t('saveAndPreview')}
            </button>
            <button
              className="secondary-button"
              disabled={!!busy}
              onClick={() => void perform('save')}
            >
              {t('saveScene')}
            </button>
          </div>

          <button
            className="project-generate-button"
            disabled={!!busy || !preview || !videoModel}
            onClick={() => void perform('generate')}
          >
            {busy === 'generate' ? (
              <LoaderCircle size={17} className="spin" />
            ) : activeVersion ? (
              <LoaderCircle size={17} className="spin" />
            ) : (
              <Wand2 size={17} />
            )}
            {activeVersion ? t('generatingVideo') : t('generateOrRetry')}
          </button>

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
  )
}

export function ProjectStudio({ models, onNotify, onCreated, onOpenSettings }: Props) {
  const { t, locale } = useTranslation(studioCatalog)
  const [projects, setProjects] = useState<Project[]>([])
  const [covers, setCovers] = useState<Record<string, { url: string; kind: 'image' | 'video' }>>({})
  const [selectedId, setSelectedId] = useState('')
  const [characters, setCharacters] = useState<ProjectCharacter[]>([])
  const [scenes, setScenes] = useState<ProjectScene[]>([])
  const [results, setResults] = useState<ProjectGeneration[]>([])
  const [tab, setTab] = useState<TabKey>('images')
  const [locations, setLocations] = useState<LocationReference[]>([])
  const [imageLocationId, setImageLocationId] = useState('')
  const { t: tLocations } = useTranslation(locationsCatalog)

  const [projectModal, setProjectModal] = useState<Project | 'new' | null>(null)
  const [characterModal, setCharacterModal] = useState<ProjectCharacter | 'new' | null>(null)
  const [sceneEdit, setSceneEdit] = useState<ProjectScene | 'new' | null>(null)
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
  /** Ảnh minh hoạ đang phóng to ở danh sách cảnh. */
  const [sceneCoverZoom, setSceneCoverZoom] = useState<{ url: string; title: string } | null>(null)

  const [imagePrompt, setImagePrompt] = useState('')
  const [imageModel, setImageModel] = useState('')
  const [imageCharacter, setImageCharacter] = useState('')
  const [imageSendReference, setImageSendReference] = useState(true)
  const [imageSize, setImageSize] = useState(IMAGE_SIZES[0].value)
  const [imageQuality, setImageQuality] = useState('')
  const [imageParams, setImageParams] = useState('{}')
  const [sourceImages, setSourceImages] = useState<SourceUpload[]>([])
  const [uploadingImage, setUploadingImage] = useState(false)
  const imageKey = useRef<string | null>(null)

  const project = projects.find((item) => item.id === selectedId)
  const imageModels = models.filter((model) => model.enabled && model.kind === 'image')
  const videoModels = models.filter((model) => model.enabled && model.kind === 'video')
  /** Nhân vật đang gắn cho lần tạo ảnh tiếp theo, nếu còn tồn tại trong dự án. */
  const imageCharacterEntry = characters.find((item) => item.id === imageCharacter) ?? null
  const willSendCharacterReference = Boolean(
    imageCharacterEntry?.referenceUrl && imageSendReference,
  )

  useEffect(() => {
    if (!imageModels.some((model) => model.id === imageModel)) {
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
    setLocations([])
    setSceneEdit(null)
    setCharacterModal(null)
    setExportOpen(false)
    setSelectedSceneIds([])
    setBulkModelId('')
    setSceneCoverZoom(null)
    setImageCharacter('')
    setImageSendReference(true)
    setImagePrompt('')
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
        if (!alive) return
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
    return () => {
      alive = false
    }
  }, [selectedId])

  const hasActiveResult = results.some(isActive)
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
      projectsApi
        .results(selectedId)
        .then((result) => {
          if (alive) setResults(result.generations)
        })
        .catch(() => {
          /* bỏ qua lỗi tạm thời khi làm mới nền */
        })
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

  async function runBulk(input: SceneBulkInput, notifyKey: StudioKey) {
    if (!project) return
    setBusy('scenes-bulk')
    setError(null)
    try {
      const result = await projectsApi.bulkScenes(project.id, input)
      mergeScenes(result.scenes)
      setSelectedSceneIds([])
      // Nạp lại kết quả ngay: duyệt/xếp hàng hàng loạt đổi trạng thái thẻ, và
      // vòng làm mới 4 giây chỉ chạy khi đã biết có tác vụ đang hoạt động.
      const generations = await projectsApi.results(project.id)
      setResults(generations.generations)
      if (input.autoGenerate) setAwaitingAutoGenerate(true)
      onNotify(notification('studio', notifyKey))
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy('')
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

  /** Gán model cho cảnh đã chọn, hoặc cho mọi cảnh chưa có model nếu không chọn. */
  function bulkAssignModel() {
    if (!bulkModelId) {
      setError({ key: 'sceneBulkNoModelSelected' })
      return
    }
    const targets = selectedSceneIds.length
      ? selectedSceneIds
      : orderedScenes.filter((scene) => !scene.modelId).map((scene) => scene.id)
    if (!targets.length) {
      setError({ key: 'sceneBulkNeedsSelection' })
      return
    }
    void runBulk({ ids: targets, modelId: bulkModelId }, 'notifyScenesModelAssigned')
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
    if (!scene.modelId) {
      setError({ key: 'sceneModelRequired' })
      return
    }
    setBusy(`scene-generate:${scene.id}`)
    setError(null)
    try {
      const { generation } = await projectsApi.generateScene(scene.id, newKey())
      setResults((current) => [generation, ...current.filter((item) => item.id !== generation.id)])
      onCreated?.(generation)
      onNotify(notification('studio', 'notifyRequestQueued'))
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy('')
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
    if (!project) return
    setBusy('image')
    setError(null)
    try {
      const base = parseParams(imageParams)
      const params = {
        ...base,
        size: imageSize,
        // Chỉ gửi quality khi người dùng chủ động chọn.
        ...(imageQuality ? { quality: imageQuality } : {}),
      }
      imageKey.current ??= newKey()
      const { generation } = await projectsApi.generateImage({
        projectId: project.id,
        ...(imageCharacter ? { characterId: imageCharacter } : {}),
        modelId: imageModel,
        prompt: imagePrompt,
        // Gửi ảnh tham chiếu nhân vật kèm ảnh để model bám đúng ngoại hình.
        // Provider không hỗ trợ thì người dùng tắt tùy chọn này.
        params: { ...params, useCharacterReference: willSendCharacterReference },
        idempotencyKey: imageKey.current,
        ...(imageLocationId ? { locationId: imageLocationId } : {}),
        ...(sourceImages.length ? { sourceUploadIds: sourceImages.map((item) => item.id) } : {}),
      } as Parameters<typeof projectsApi.generateImage>[0])
      imageKey.current = null
      setImagePrompt('')
      created(generation)
    } catch (cause) {
      setError(describeError(cause))
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
    setBusy(id)
    setError(null)
    try {
      await generationApi.remove(id)
      setResults((current) => current.filter((item) => item.id !== id))
      // Cảnh có thể đang chọn chính phiên bản này; backend đã bỏ chọn nên nạp lại.
      const sceneResult = await projectsApi.scenes(project.id)
      setScenes(sceneResult.scenes)
      await refreshCover(project.id)
      onNotify(notification('studio', 'notifyResultDeleted'))
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy('')
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
    <div className="project-studio">
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
          {showTrash && <p className="project-trash-summary">{t('trashSummary')}</p>}

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

              {!showTrash && <button className="project-start-card" onClick={() => setProjectModal('new')}>
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
              <button className="secondary-button" disabled={!!busy} onClick={() => setProjectModal(project)}>
                <Pencil size={15} /> {t('editProject')}
              </button>
              <button
                className="secondary-button"
                disabled={!!busy || project.archived}
                onClick={() => setExportOpen(true)}
              >
                <Film size={15} /> {t('exportVideoAction')}
              </button>
              <button className="secondary-button" disabled={!!busy} onClick={() => void archive()}>
                {project.archived ? t('restore') : t('archiveAction')}
              </button>
              <button className="secondary-button project-trash-danger" disabled={!!busy} onClick={() => setTrashProject(project)}><Trash2 size={15} /> {t('deleteAction')}</button>
            </div>
          </div>

          {project.archived && (
            <Notice tone="warn">
              {t('archivedProjectNotice')}
            </Notice>
          )}

          <div className="project-tabs" role="tablist">
            <button
              role="tab"
              aria-label={t('tabImagesAria')}
              aria-selected={tab === 'images'}
              className={tab === 'images' ? 'active' : ''}
              onClick={() => setTab('images')}
            >
              <ImageIcon size={16} /> {t('tabImagesAria')}
            </button>
            <button
              role="tab"
              aria-label={t('tabCharactersAria')}
              aria-selected={tab === 'characters'}
              className={tab === 'characters' ? 'active' : ''}
              onClick={() => setTab('characters')}
            >
              <Users size={16} /> {t('tabCharactersAria')}
            </button>
            <button
              role="tab"
              aria-label={t('tabScenesAria')}
              aria-selected={tab === 'scenes'}
              className={tab === 'scenes' ? 'active' : ''}
              onClick={() => setTab('scenes')}
            >
              <Film size={16} /> {t('tabScenesAria')}
            </button>
            <button
              role="tab"
              aria-label={tLocations('title')}
              aria-selected={tab === 'locations'}
              className={tab === 'locations' ? 'active' : ''}
              onClick={() => setTab('locations')}
            >
              <Layers3 size={16} /> {tLocations('title')}
            </button>
          </div>

          {detailLoading ? (
            <div className="empty-state">
              <LoaderCircle size={24} className="spin" />
              <h3>{t('loadingProjectDetails')}</h3>
            </div>
          ) : tab === 'images' ? (
            <div className="project-tab-panel project-workspace">
              <form className="project-composer" onSubmit={generateImage}>
                <div className="project-panel-heading">
                  <h3>{t('createProjectImage')}</h3>
                </div>
                <p className="project-hint">{t('tabImagesHint')}</p>
                <fieldset className="modal-form project-fields" disabled={busy === 'image'}>
                  <Field label={t('imageModelLabel')}>
                    <select value={imageModel} onChange={(event) => setImageModel(event.target.value)}>
                      <option value="">{t('chooseModel')}</option>
                      {imageModels.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.displayName}
                        </option>
                      ))}
                    </select>
                  </Field>
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
                  <Field label={t('imagePromptLabel')}>
                    <textarea
                      value={imagePrompt}
                      placeholder={t('imagePromptPlaceholder')}
                      onChange={(event) => setImagePrompt(event.target.value)}
                    />
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
                </fieldset>

                <Notice tone="warn">
                  {t('costNoteWithModel')}
                </Notice>

                <button
                  className="project-generate-button"
                  disabled={busy === 'image' || !imagePrompt.trim() || !imageModel || project.archived}
                >
                  {busy === 'image' ? (
                    <LoaderCircle size={17} className="spin" />
                  ) : (
                    <ImageIcon size={17} />
                  )}
                  {t('generateProjectImage')}
                </button>
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
                      <p>{character.appearance || t('noAppearance')}</p>
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
                  <p>{t('videoSceneSequenceHint')}</p>
                </div>
                <button
                  className="primary-small-button"
                  disabled={project.archived}
                  onClick={() => openScene('new')}
                >
                  <Plus size={15} /> {t('addScene')}
                </button>
              </div>

              {orderedScenes.length ? (
                <>
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

                  <div className="project-actions">
                    <label className="plan-cell">
                      <span>{t('videoModelLabel')}</span>
                      <select
                        value={bulkModelId}
                        disabled={project.archived || !!busy}
                        onChange={(event) => setBulkModelId(event.target.value)}
                      >
                        <option value="">{t('sceneChooseModel')}</option>
                        {videoModels.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.displayName}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="secondary-button"
                      disabled={project.archived || !!busy || !bulkModelId}
                      onClick={bulkAssignModel}
                    >
                      {t('sceneBulkAssignModel')}
                    </button>
                    <button
                      className="primary-small-button"
                      disabled={project.archived || !!busy || !videoModels.length}
                      title={videoModels.length ? t('sceneBulkGenerateHint') : t('sceneBulkNoVideoModel')}
                      onClick={bulkGenerateApproved}
                    >
                      <Wand2 size={15} /> {t('sceneBulkGenerate')}
                    </button>
                  </div>
                  <p className="project-hint">{t('sceneBulkAssignModelHint')}</p>
                  <p className="project-hint">{t('sceneBulkGenerateHint')}</p>

                  {!videoModels.length ? (
                    <Notice tone="warn">{t('sceneBulkNoVideoModel')}</Notice>
                  ) : (
                    <Notice tone="warn">{t('sceneBulkCostWarning')}</Notice>
                  )}

                  <div className="project-scene-list">
                  {orderedScenes.map((scene, index) => {
                    const chosen = scene.selectedGenerationId
                      ? results.find((item) => item.id === scene.selectedGenerationId)
                      : undefined
                    const cover = chosen ? firstAsset([chosen]) : null
                    const videoUrl = cover?.kind === 'video' ? cover.asset.url : null
                    const illustrationUrl = scene.backgroundUrl ?? null
                    const sceneGenerations = results.filter((item) => item.sceneId === scene.id)
                    const activeGeneration = sceneGenerations.find(isActive)
                    const failedGeneration = !activeGeneration
                      && sceneGenerations.some((item) => item.status === 'failed')
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
                          <SceneCover
                            videoUrl={videoUrl}
                            illustrationUrl={illustrationUrl}
                            alt={t('sceneCoverIllustrationAria', { title: scene.title })}
                            badge={t('sceneCoverIllustration')}
                          />
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
                          <div>
                            <label className="project-checkbox" style={{ margin: '0 0 8px', padding: '8px 10px' }}>
                              <input
                                type="checkbox"
                                checked={selected}
                                disabled={!!busy}
                                aria-label={t('sceneSelectAria', { title: scene.title })}
                                onChange={(event) => toggleSceneSelection(scene.id, event.target.checked)}
                              />
                              <strong>
                                {index + 1}. {scene.title}
                              </strong>
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
