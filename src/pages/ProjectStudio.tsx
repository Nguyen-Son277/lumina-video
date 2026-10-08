import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Film,
  Image as ImageIcon,
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
import { errorMessage } from '../api/client'
import { generationApi, uploadApi, type SourceUpload } from '../api/endpoints'
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
  SceneInput,
} from '../api/projectTypes'
import type { Generation, ModelInfo } from '../api/types'
import { CreationCard } from '../components/Common'

type Props = {
  models: ModelInfo[]
  onNotify: (message: string) => void
  onCreated?: (generation: Generation) => void
  onOpenSettings?: () => void
}

type TabKey = 'images' | 'characters' | 'scenes'

const VOICE_FIELDS: Array<keyof CharacterVoice> = [
  'language', 'accent', 'pitch', 'timbre', 'pace', 'articulation', 'habits',
]

const VOICE_LABELS: Record<keyof CharacterVoice, string> = {
  language: 'Ngôn ngữ',
  accent: 'Giọng vùng miền',
  pitch: 'Cao độ',
  timbre: 'Âm sắc',
  pace: 'Tốc độ',
  articulation: 'Phát âm',
  habits: 'Thói quen nói',
}

const VOICE_PLACEHOLDERS: Record<keyof CharacterVoice, string> = {
  language: 'vi',
  accent: 'Miền Bắc',
  pitch: 'Trung trầm',
  timbre: 'Ấm, hơi khàn',
  pace: 'Vừa phải',
  articulation: 'Rõ ràng, không nuốt chữ',
  habits: 'Ngắt nghỉ nhẹ cuối câu',
}

const IMAGE_SIZES = [
  { value: '1024x1024', label: '1024×1024 · Vuông' },
  { value: '1536x1024', label: '1536×1024 · Ngang' },
  { value: '1024x1536', label: '1024×1536 · Dọc' },
]

const IMAGE_QUALITIES = [
  // Mặc định không gửi `quality`: đây là trường đặc thù GPT Image, nhiều gateway
  // tương thích OpenAI từ chối và trả lỗi 400 nếu nhận được.
  { value: '', label: 'Mặc định của model (không gửi)' },
  { value: 'low', label: 'Thấp · Nhanh' },
  { value: 'medium', label: 'Trung bình' },
  { value: 'high', label: 'Cao' },
]

const VIDEO_SIZES = [
  { value: '1280x720', label: '1280×720 · Ngang' },
  { value: '720x1280', label: '720×1280 · Dọc' },
]

const MAX_SOURCE_IMAGES = 4

const VIDEO_SECONDS = [
  { value: '4', label: '4 giây' },
  { value: '8', label: '8 giây' },
  { value: '12', label: '12 giây' },
]

const isActive = (generation: Generation) =>
  ['queued', 'running', 'downloading'].includes(generation.status)

const newKey = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`

function parseParams(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text || '{}')
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tham số nâng cao phải là một JSON object.')
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
          <button className="close-button" disabled={busy} onClick={onClose} aria-label="Đóng">
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
  const [error, setError] = useState('')

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await onSave(draft)
      onClose()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={project ? 'Sửa dự án' : 'Tạo dự án'} onClose={onClose} busy={busy}>
      <form onSubmit={submit}>
        <fieldset className="modal-form project-fields" disabled={busy}>
          <Field label="Tên dự án">
            <input
              required
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </Field>
          <Field label="Mô tả">
            <textarea
              value={draft.description}
              placeholder="Một câu chuyện ngắn về…"
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </Field>
          <Field label="Phong cách chung">
            <textarea
              value={draft.style}
              placeholder="Điện ảnh màu nước, ánh sáng ấm…"
              onChange={(event) => setDraft({ ...draft, style: event.target.value })}
            />
          </Field>
          <Field label="Ngôn ngữ">
            <input
              required
              value={draft.language}
              placeholder="vi"
              onChange={(event) => setDraft({ ...draft, language: event.target.value })}
            />
          </Field>
          <Notice>
            Phong cách và ngôn ngữ được ghép vào prompt của mọi ảnh và cảnh trong dự án, giúp giữ
            tính nhất quán.
          </Notice>
        </fieldset>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>
            Hủy
          </button>
          <button
            className="primary-small-button"
            disabled={busy || !draft.name.trim() || !draft.language.trim()}
          >
            {busy && <LoaderCircle size={14} className="spin" />} Lưu dự án
          </button>
        </div>
      </form>
    </Modal>
  )
}

function CharacterForm({
  character,
  language,
  onSave,
  onClose,
}: {
  character?: ProjectCharacter
  language: string
  onSave: (
    input: CharacterInput,
    changes: { file?: File; removeReference?: boolean },
  ) => Promise<void>
  onClose: () => void
}) {
  const emptyVoice: CharacterVoice = {
    language,
    accent: '',
    pitch: '',
    timbre: '',
    pace: '',
    articulation: '',
    habits: '',
  }
  const [draft, setDraft] = useState<CharacterInput>(
    character
      ? {
          name: character.name,
          appearance: character.appearance,
          voice: { ...emptyVoice, ...character.voice },
        }
      : { name: '', appearance: '', voice: emptyVoice },
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const [file, setFile] = useState<File | null>(null)
  const [removeReference, setRemoveReference] = useState(false)
  const [localPreview, setLocalPreview] = useState('')

  // Thu hồi blob URL khi đổi tệp hoặc đóng form để không rò rỉ bộ nhớ.
  useEffect(() => {
    if (!file) {
      setLocalPreview('')
      return
    }
    const url = URL.createObjectURL(file)
    setLocalPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const existingReference = character?.referenceUrl && !removeReference ? character.referenceUrl : ''
  const preview = localPreview || existingReference

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await onSave(draft, {
        ...(file ? { file } : {}),
        ...(removeReference ? { removeReference: true } : {}),
      })
      onClose()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={character ? 'Sửa nhân vật / giọng nói' : 'Thêm nhân vật'}
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit}>
        <fieldset className="modal-form project-fields" disabled={busy}>
          <div className="project-character-form-grid">
            <section className="project-form-section">
              <h3>Nhân vật</h3>
              <Field label="Tên">
                <input
                  required
                  value={draft.name}
                  placeholder="An"
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </Field>
              <Field label="Ngoại hình">
                <textarea
                  value={draft.appearance}
                  placeholder="Áo xanh, tóc ngắn, dáng thư sinh…"
                  onChange={(event) => setDraft({ ...draft, appearance: event.target.value })}
                />
              </Field>

              <div className="project-reference">
                <span className="project-reference-label">Ảnh tham chiếu nhân vật</span>
                <div className="project-reference-body">
                  <div className="project-reference-preview">
                    {preview ? (
                      <img src={preview} alt={`Ảnh tham chiếu của ${draft.name || 'nhân vật'}`} />
                    ) : (
                      <ImageIcon size={22} />
                    )}
                  </div>
                  <div className="project-reference-controls">
                    <label className="project-file-button">
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        onChange={(event) => {
                          setFile(event.target.files?.[0] ?? null)
                          setRemoveReference(false)
                        }}
                      />
                      {preview ? 'Chọn ảnh khác' : 'Chọn ảnh'}
                    </label>
                    {preview && (
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => {
                          setFile(null)
                          setRemoveReference(true)
                        }}
                      >
                        <Trash2 size={14} /> Xóa ảnh
                      </button>
                    )}
                    <span className="project-hint">
                      PNG, JPEG, WebP hoặc GIF, tối đa 5 MB. Ảnh được lưu riêng tư và gửi kèm khi tạo
                      video để model bám đúng ngoại hình.
                    </span>
                  </div>
                </div>
              </div>
            </section>

            <section className="project-form-section">
              <h3>Hồ sơ giọng nói</h3>
              <div className="project-voice-grid">
                {VOICE_FIELDS.map((field) => (
                  <Field key={field} label={VOICE_LABELS[field]}>
                    <input
                      value={draft.voice[field]}
                      placeholder={VOICE_PLACEHOLDERS[field]}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          voice: { ...draft.voice, [field]: event.target.value },
                        })
                      }
                    />
                  </Field>
                ))}
              </div>
            </section>
          </div>

          <Notice tone="warn">
            Hồ sơ giọng nói chỉ là mô tả trong prompt, dùng chung cho mọi cảnh của nhân vật này.
            Ứng dụng không dùng dịch vụ giọng nói bên thứ ba và không bảo đảm giọng giống tuyệt đối.
          </Notice>
        </fieldset>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>
            Hủy
          </button>
          <button className="primary-small-button" disabled={busy || !draft.name.trim()}>
            {busy && <LoaderCircle size={14} className="spin" />} Lưu nhân vật
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
  models,
  revision,
  nextPosition,
  onSaved,
  onCreated,
  onDeleteGeneration,
  onClose,
  onNotify,
}: {
  scene?: ProjectScene
  projectId: string
  characters: ProjectCharacter[]
  models: ModelInfo[]
  revision: number
  nextPosition: number
  onSaved: (scene: ProjectScene) => void
  onCreated: (generation: Generation) => void
  onDeleteGeneration: (id: string) => void
  onClose: () => void
  onNotify: (message: string) => void
}) {
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
        }
      : {
          title: '',
          prompt: '',
          characterId: characters[0]?.id ?? null,
          dialogue: '',
          modelId: videoModels[0]?.id ?? '',
          params: {},
          position: nextPosition,
        },
  )
  const [params, setParams] = useState(JSON.stringify(draft.params, null, 2))
  const [preview, setPreview] = useState<PromptPreview | null>(null)
  const [versions, setVersions] = useState<ProjectGeneration[]>([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

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
          if (alive) setError(errorMessage(cause))
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

  const sizeValue = typeof draft.params.size === 'string' ? draft.params.size : VIDEO_SIZES[0].value
  const secondsValue = String(draft.params.seconds ?? VIDEO_SECONDS[0].value)

  async function persist(): Promise<ProjectScene> {
    const input: SceneInput = { ...draft, params: parseParams(params) }
    if (!input.title.trim()) throw new Error('Điền tên cảnh.')
    if (!input.prompt.trim()) throw new Error('Điền mô tả / hành động cho cảnh.')
    if (!input.modelId) throw new Error('Chọn model video cho cảnh.')
    if (input.dialogue.trim() && !input.characterId) {
      throw new Error('Cảnh có lời thoại cần chọn một nhân vật nói.')
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
    setError('')
    try {
      if (action === 'generate') {
        if (!saved || !preview) throw new Error('Hãy xem trước prompt trước khi tạo video.')
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
          onNotify('Đã lưu cảnh.')
        }
      }
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy('')
    }
  }

  async function choose(generationId: string) {
    if (!saved) return
    setBusy(generationId)
    setError('')
    try {
      const response = await projectsApi.selectGeneration(saved.id, generationId)
      setSaved(response.scene)
      onSaved(response.scene)
      onNotify('Đã chọn phiên bản chính cho cảnh.')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy('')
    }
  }

  async function retryDownload(generationId: string) {
    setBusy(generationId)
    setError('')
    try {
      const { generation } = await generationApi.retryDownload(generationId)
      setVersions((current) =>
        current.map((item) => (item.id === generation.id ? generation : item)),
      )
      onCreated(generation)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="project-scene-editor">
      <div className="project-steps">
        <span className={`project-step ${step >= 1 ? 'active' : ''} ${saved ? 'done' : ''}`}>
          1 · Nội dung cảnh
        </span>
        <span className={`project-step ${step === 2 ? 'active' : ''} ${preview ? 'done' : ''}`}>
          2 · Xem trước prompt
        </span>
        <span className={`project-step ${step === 3 ? 'active' : ''}`}>3 · Tạo video</span>
      </div>

      <div className="project-workspace">
        <div className="project-composer">
          <div className="project-panel-heading">
            <h3>{saved ? 'Cảnh đang sửa' : 'Cảnh mới'}</h3>
            <button className="secondary-button" disabled={!!busy} onClick={onClose}>
              Đóng
            </button>
          </div>

          {!videoModels.length && (
            <div className="notice-banner">
              <Settings2 size={18} />
              <div>
                <strong>Chưa có model video</strong>
                <p>
                  Thêm provider và phân loại ít nhất một model thành <strong>Tạo video</strong>{' '}
                  trong API &amp; Models để tạo được cảnh.
                </p>
              </div>
            </div>
          )}

          <fieldset className="modal-form project-fields" disabled={!!busy}>
            <Field label="Tên cảnh">
              <input
                value={draft.title}
                placeholder="Buổi sáng ở Đà Lạt"
                onChange={(event) => change('title', event.target.value)}
              />
            </Field>

            <Field label="Mô tả / hành động">
              <textarea
                value={draft.prompt}
                placeholder="An đi qua rừng thông, sương sớm, máy quay theo chân…"
                onChange={(event) => change('prompt', event.target.value)}
              />
            </Field>

            <Field label="Một nhân vật nói">
              <select
                value={draft.characterId ?? ''}
                onChange={(event) => change('characterId', event.target.value || null)}
              >
                <option value="">Không có người nói</option>
                {characters.map((character) => (
                  <option key={character.id} value={character.id}>
                    {character.name}
                  </option>
                ))}
              </select>
            </Field>

            {speakingCharacter?.referenceUrl && (
              <label className="project-checkbox">
                <input
                  type="checkbox"
                  checked={draft.params.useCharacterReference !== false}
                  onChange={(event) => changeParam('useCharacterReference', event.target.checked)}
                />
                <span>
                  Gửi ảnh tham chiếu của <strong>{speakingCharacter.name}</strong> kèm video
                </span>
              </label>
            )}

            <Field label="Lời thoại">
              <textarea
                value={draft.dialogue}
                placeholder="Chào Đà Lạt."
                onChange={(event) => change('dialogue', event.target.value)}
              />
            </Field>

            <Field label="Model video">
              <select
                value={draft.modelId}
                onChange={(event) => change('modelId', event.target.value)}
              >
                <option value="">Chọn model</option>
                {videoModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.displayName}
                  </option>
                ))}
              </select>
            </Field>

            <div className="project-field-row">
              <Field label="Kích thước">
                <select
                  value={sizeValue}
                  onChange={(event) => changeParam('size', event.target.value)}
                >
                  {VIDEO_SIZES.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Thời lượng">
                <select
                  value={secondsValue}
                  onChange={(event) => changeParam('seconds', event.target.value)}
                >
                  {VIDEO_SECONDS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <details className="project-advanced">
              <summary>Tham số nâng cao (JSON)</summary>
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

          <Notice>
            Mỗi cảnh chỉ có một nhân vật nói. Model sẽ nhận đúng hồ sơ giọng của nhân vật đó, nhưng
            prompt không khóa được danh tính giọng và không bảo đảm khớp miệng.
          </Notice>

          {error && <div className="form-error" role="alert">{error}</div>}

          {preview && (
            <div className="project-prompt-preview">
              <strong>Prompt sẽ gửi cho provider</strong>
              <pre>{preview.effectivePrompt}</pre>
            </div>
          )}

          <div className="project-actions">
            <button
              className="secondary-button"
              disabled={!!busy}
              onClick={() => void perform('preview')}
            >
              <Sparkles size={15} /> Lưu &amp; xem trước prompt
            </button>
            <button
              className="secondary-button"
              disabled={!!busy}
              onClick={() => void perform('save')}
            >
              Lưu cảnh
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
            {activeVersion ? 'Đang tạo video…' : 'Tạo / thử lại phiên bản mới'}
          </button>

          <Notice tone="warn">
            Mỗi lần tạo sẽ dùng API key của bạn và có thể phát sinh chi phí từ provider.
          </Notice>
        </div>

        <div className="project-results-panel">
          <div className="project-panel-heading">
            <h3>Phiên bản của cảnh</h3>
            <span className="project-badge">
              <Layers3 size={13} /> {versions.length} phiên bản
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
                    <span>{new Date(version.createdAt).toLocaleString('vi-VN')}</span>
                    {saved?.selectedGenerationId === version.id && (
                      <span className="connected-pill"><span /> Đã chọn phiên bản</span>
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
                      {saved?.selectedGenerationId === version.id ? 'Đang chọn' : 'Chọn phiên bản này'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="project-empty-media">
              <Film size={36} />
              <h3>Chưa có phiên bản nào</h3>
              <p>
                Xem trước prompt rồi bấm <strong>Tạo / thử lại phiên bản mới</strong>. Kết quả sẽ
                xuất hiện ở đây.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

export function ProjectStudio({ models, onNotify, onCreated, onOpenSettings }: Props) {
  const [projects, setProjects] = useState<Project[]>([])
  const [covers, setCovers] = useState<Record<string, { url: string; kind: 'image' | 'video' }>>({})
  const [selectedId, setSelectedId] = useState('')
  const [characters, setCharacters] = useState<ProjectCharacter[]>([])
  const [scenes, setScenes] = useState<ProjectScene[]>([])
  const [results, setResults] = useState<ProjectGeneration[]>([])
  const [tab, setTab] = useState<TabKey>('images')

  const [projectModal, setProjectModal] = useState<Project | 'new' | null>(null)
  const [characterModal, setCharacterModal] = useState<ProjectCharacter | 'new' | null>(null)
  const [sceneEdit, setSceneEdit] = useState<ProjectScene | 'new' | null>(null)
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
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)

  const [imagePrompt, setImagePrompt] = useState('')
  const [imageModel, setImageModel] = useState('')
  const [imageCharacter, setImageCharacter] = useState('')
  const [imageSize, setImageSize] = useState(IMAGE_SIZES[0].value)
  const [imageQuality, setImageQuality] = useState('')
  const [imageParams, setImageParams] = useState('{}')
  const [sourceImages, setSourceImages] = useState<SourceUpload[]>([])
  const [uploadingImage, setUploadingImage] = useState(false)
  const imageKey = useRef<string | null>(null)

  const project = projects.find((item) => item.id === selectedId)
  const imageModels = models.filter((model) => model.enabled && model.kind === 'image')
  const videoModels = models.filter((model) => model.enabled && model.kind === 'video')

  useEffect(() => {
    if (!imageModels.some((model) => model.id === imageModel)) {
      setImageModel(imageModels[0]?.id ?? '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, imageModel])

  // Tải danh sách dự án kèm ảnh bìa lấy từ kết quả gần nhất.
  useEffect(() => {
    let alive = true
    projectsApi
      .list()
      .then(async (result) => {
        if (!alive) return
        setProjects(result.projects)

        const withCover = result.projects.filter((item) => !item.archived).slice(0, 12)
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
        if (alive) setError(errorMessage(cause))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    setCharacters([])
    setScenes([])
    setResults([])
    setSceneEdit(null)
    setCharacterModal(null)
    setImageCharacter('')
    setImagePrompt('')
    setError('')
    imageKey.current = null
    if (!selectedId) return

    let alive = true
    setDetailLoading(true)
    Promise.all([
      projectsApi.characters(selectedId),
      projectsApi.scenes(selectedId),
      projectsApi.results(selectedId),
    ])
      .then(([characterResult, sceneResult, generationResult]) => {
        if (!alive) return
        setCharacters(characterResult.characters)
        setScenes(sceneResult.scenes)
        setResults(generationResult.generations)
      })
      .catch((cause: unknown) => {
        if (alive) setError(errorMessage(cause))
      })
      .finally(() => {
        if (alive) setDetailLoading(false)
      })
    return () => {
      alive = false
    }
  }, [selectedId])

  const hasActiveResult = results.some(isActive)
  useEffect(() => {
    if (!selectedId || !hasActiveResult) return
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
  }, [selectedId, hasActiveResult])

  const orderedScenes = useMemo(
    () => [...scenes].sort((a, b) => a.position - b.position),
    [scenes],
  )

  const visibleProjects = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    return projects.filter((item) => {
      if (!showArchived && item.archived) return false
      if (!keyword) return true
      return `${item.name} ${item.description} ${item.style}`.toLowerCase().includes(keyword)
    })
  }, [projects, search, showArchived])

  const imageResults = useMemo(
    () => results.filter((generation) => generation.kind === 'image'),
    [results],
  )

  function created(generation: Generation) {
    setResults((current) => [generation, ...current.filter((item) => item.id !== generation.id)])
    onCreated?.(generation)
    onNotify('Đã gửi yêu cầu tạo. Kết quả sẽ tự cập nhật.')
  }

  async function refresh() {
    setBusy('refresh')
    setError('')
    try {
      const list = await projectsApi.list()
      setProjects(list.projects)
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
      setError(errorMessage(cause))
    } finally {
      setBusy('')
    }
  }

  async function saveProject(input: ProjectInput) {
    if (projectModal && projectModal !== 'new') {
      const { project: updated } = await projectsApi.update(projectModal.id, input)
      setProjects((current) => current.map((item) => (item.id === updated.id ? updated : item)))
      onNotify('Đã cập nhật dự án.')
      return
    }
    const { project: createdProject } = await projectsApi.create(input)
    setProjects((current) => [createdProject, ...current])
    setSelectedId(createdProject.id)
    setTab('images')
    onNotify('Đã tạo dự án. Thêm nhân vật để giữ giọng nói nhất quán.')
  }

  /** Lưu nhân vật, sau đó tải lên hoặc xóa ảnh tham chiếu nếu người dùng đổi. */
  async function saveCharacter(
    input: CharacterInput,
    changes: { file?: File; removeReference?: boolean } = {},
  ) {
    if (!project) return

    const editing = characterModal && characterModal !== 'new' ? characterModal : null
    let saved = editing
      ? (await projectsApi.updateCharacter(project.id, editing.id, input)).character
      : (await projectsApi.createCharacter(project.id, input)).character

    if (changes.file) {
      saved = (await projectsApi.uploadCharacterReference(project.id, saved.id, changes.file))
        .character
    } else if (changes.removeReference) {
      saved = (await projectsApi.removeCharacterReference(project.id, saved.id)).character
    }

    setCharacters((current) => {
      const exists = current.some((item) => item.id === saved.id)
      return exists
        ? current.map((item) => (item.id === saved.id ? saved : item))
        : [...current, saved]
    })

    onNotify(
      editing
        ? 'Đã cập nhật nhân vật. Các cảnh đã tạo vẫn giữ prompt cũ.'
        : 'Đã thêm nhân vật.',
    )
  }

  async function removeCharacter(character: ProjectCharacter) {
    if (!project) return
    setBusy(character.id)
    setError('')
    try {
      await fetchDeleteCharacter(project.id, character.id)
      setCharacters((current) => current.filter((item) => item.id !== character.id))
      onNotify('Đã xóa nhân vật.')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy('')
    }
  }

  async function fetchDeleteCharacter(projectId: string, characterId: string) {
    const response = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/characters/${encodeURIComponent(characterId)}`,
      { method: 'DELETE', credentials: 'include' },
    )
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null
      throw new Error(payload?.error?.message ?? 'Không xóa được nhân vật.')
    }
  }

  async function archive() {
    if (!project) return
    setBusy('archive')
    setError('')
    try {
      const { project: updated } = await projectsApi.update(project.id, { archived: !project.archived })
      setProjects((current) => current.map((item) => (item.id === updated.id ? updated : item)))
      setSceneEdit(null)
      onNotify(updated.archived ? 'Đã lưu trữ dự án.' : 'Đã khôi phục dự án.')
    } catch (cause) {
      setError(errorMessage(cause))
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
    setError('')
    try {
      const response = await projectsApi.reorder(
        project.id,
        swapped.map((item) => item.id),
      )
      setScenes(response.scenes)
    } catch (cause) {
      setError(errorMessage(cause))
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
    setError('')
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
        params,
        idempotencyKey: imageKey.current,
        ...(sourceImages.length ? { sourceUploadIds: sourceImages.map((item) => item.id) } : {}),
      })
      imageKey.current = null
      setImagePrompt('')
      created(generation)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy('')
    }
  }

  /** Tải ảnh nguồn lên ngay khi chọn để sẵn sàng cho lần tạo tiếp theo. */
  async function addSourceImages(files: FileList | null) {
    if (!files?.length) return
    setUploadingImage(true)
    setError('')
    try {
      const uploaded: SourceUpload[] = []
      for (const file of Array.from(files).slice(0, MAX_SOURCE_IMAGES - sourceImages.length)) {
        uploaded.push(await uploadApi.upload(file))
      }
      setSourceImages((current) => [...current, ...uploaded])
    } catch (cause) {
      setError(errorMessage(cause))
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
    setError('')
    try {
      await generationApi.remove(id)
      setResults((current) => current.filter((item) => item.id !== id))
      // Cảnh có thể đang chọn chính phiên bản này; backend đã bỏ chọn nên nạp lại.
      const sceneResult = await projectsApi.scenes(project.id)
      setScenes(sceneResult.scenes)
      await refreshCover(project.id)
      onNotify('Đã xóa kết quả khỏi dự án.')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy('')
    }
  }

  async function retryDownload(id: string) {
    setBusy(id)
    setError('')
    try {
      const { generation } = await generationApi.retryDownload(id)
      created(generation)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy('')
    }
  }

  const canGenerateAny = imageModels.length > 0 || videoModels.length > 0

  return (
    <div className="project-studio">
      {error && <div className="form-error" role="alert">{error}</div>}

      {!project ? (
        <>
          <div className="project-section-header">
            <div>
              <div className="eyebrow">Project studio</div>
              <h1>Dự án sáng tạo</h1>
              <p>
                Mỗi dự án giữ phong cách, nhân vật và giọng nói dùng chung cho mọi ảnh và video.
              </p>
            </div>
            <div className="project-actions">
              <button
                className="secondary-button"
                disabled={!!busy || loading}
                onClick={() => void refresh()}
              >
                <RefreshCw size={15} /> Làm mới
              </button>
              <button className="primary-small-button" onClick={() => setProjectModal('new')}>
                <Plus size={15} /> Tạo dự án
              </button>
            </div>
          </div>

          {!canGenerateAny && (
            <div className="notice-banner">
              <Settings2 size={18} />
              <div>
                <strong>Chưa có model nào được cấu hình</strong>
                <p>
                  Thêm provider và phân loại model trước khi tạo nội dung.
                  {onOpenSettings && (
                    <>
                      {' '}
                      <button className="text-button" onClick={onOpenSettings}>
                        Mở API &amp; Models
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
                placeholder="Tìm dự án…"
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <label className="project-archive-toggle">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(event) => setShowArchived(event.target.checked)}
              />
              Hiện dự án lưu trữ
            </label>
          </div>

          {loading ? (
            <div className="empty-state">
              <LoaderCircle size={26} className="spin" />
              <h3>Đang tải dự án…</h3>
            </div>
          ) : (
            <div className="project-dashboard-grid">
              {visibleProjects.map((item) => {
                const cover = covers[item.id]
                return (
                  <button
                    key={item.id}
                    className="project-dashboard-card"
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
                          <span>Chưa có nội dung</span>
                        </div>
                      )}
                    </div>
                    <div className="project-card-body">
                      <h3>{item.name}</h3>
                      <div className="project-card-meta">
                        <span>{item.language || 'vi'}</span>
                        {item.style && <span>{item.style.slice(0, 24)}</span>}
                        {item.archived && <span className="not-connected-pill">Đã lưu trữ</span>}
                      </div>
                    </div>
                  </button>
                )
              })}

              <button className="project-start-card" onClick={() => setProjectModal('new')}>
                <Sparkles size={28} />
                <strong>Tạo dự án mới</strong>
                <span className="project-hint">
                  Bắt đầu một câu chuyện, thêm nhân vật và giữ giọng nói xuyên suốt.
                </span>
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <button className="project-back" onClick={() => setSelectedId('')}>
            <ArrowLeft size={15} /> Danh sách dự án
          </button>

          <div className="project-detail-header">
            <div>
              <h2>{project.name}</h2>
              <p>{project.description || 'Chưa có mô tả.'}</p>
              <div className="project-card-meta">
                <span className="project-badge">{project.language || 'vi'}</span>
                {project.style && <span className="project-badge">{project.style}</span>}
                <span className="project-badge">
                  <Users size={13} /> {characters.length} nhân vật
                </span>
                <span className="project-badge">
                  <Film size={13} /> {orderedScenes.length} cảnh
                </span>
                {project.archived && <span className="not-connected-pill">Đã lưu trữ</span>}
              </div>
            </div>
            <div className="project-actions">
              <button className="secondary-button" disabled={!!busy} onClick={() => setProjectModal(project)}>
                <Pencil size={15} /> Sửa dự án
              </button>
              <button className="secondary-button" disabled={!!busy} onClick={() => void archive()}>
                {project.archived ? 'Khôi phục' : 'Lưu trữ'}
              </button>
            </div>
          </div>

          {project.archived && (
            <Notice tone="warn">
              Dự án đang ở trạng thái lưu trữ. Khôi phục trước khi tạo nội dung mới.
            </Notice>
          )}

          <div className="project-tabs" role="tablist">
            <button
              role="tab"
              aria-label="Ảnh"
              aria-selected={tab === 'images'}
              className={tab === 'images' ? 'active' : ''}
              onClick={() => setTab('images')}
            >
              <ImageIcon size={16} /> Ảnh
            </button>
            <button
              role="tab"
              aria-label="Nhân vật"
              aria-selected={tab === 'characters'}
              className={tab === 'characters' ? 'active' : ''}
              onClick={() => setTab('characters')}
            >
              <Users size={16} /> Nhân vật
            </button>
            <button
              role="tab"
              aria-label="Cảnh video"
              aria-selected={tab === 'scenes'}
              className={tab === 'scenes' ? 'active' : ''}
              onClick={() => setTab('scenes')}
            >
              <Film size={16} /> Cảnh video
            </button>
          </div>

          {detailLoading ? (
            <div className="empty-state">
              <LoaderCircle size={24} className="spin" />
              <h3>Đang tải nội dung dự án…</h3>
            </div>
          ) : tab === 'images' ? (
            <div className="project-tab-panel project-workspace">
              <form className="project-composer" onSubmit={generateImage}>
                <div className="project-panel-heading">
                  <h3>Tạo ảnh trong dự án</h3>
                </div>
                <fieldset className="modal-form project-fields" disabled={busy === 'image'}>
                  <Field label="Model ảnh">
                    <select value={imageModel} onChange={(event) => setImageModel(event.target.value)}>
                      <option value="">Chọn model</option>
                      {imageModels.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.displayName}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Nhân vật (tùy chọn)">
                    <select
                      value={imageCharacter}
                      onChange={(event) => setImageCharacter(event.target.value)}
                    >
                      <option value="">Không gắn nhân vật</option>
                      {characters.map((character) => (
                        <option key={character.id} value={character.id}>
                          {character.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Mô tả ảnh">
                    <textarea
                      value={imagePrompt}
                      placeholder="Khu rừng thông buổi sớm, sương mù…"
                      onChange={(event) => setImagePrompt(event.target.value)}
                    />
                  </Field>
                  <div className="project-field-row">
                    <Field label="Kích thước">
                      <select value={imageSize} onChange={(event) => setImageSize(event.target.value)}>
                        {IMAGE_SIZES.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Chất lượng">
                      <select
                        value={imageQuality}
                        onChange={(event) => setImageQuality(event.target.value)}
                      >
                        {IMAGE_QUALITIES.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <div className="project-source">
                    <span className="project-reference-label">Ảnh nguồn (tạo ảnh từ ảnh)</span>
                    <div className="project-source-strip">
                      {sourceImages.map((item) => (
                        <div className="project-source-item" key={item.id}>
                          <img src={item.url} alt="" />
                          <button
                            type="button"
                            className="project-source-remove"
                            aria-label="Xóa ảnh nguồn"
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
                          <span>Thêm ảnh</span>
                        </label>
                      )}
                    </div>
                    <span className="project-hint">
                      Tối đa {MAX_SOURCE_IMAGES} ảnh. Khi có ảnh nguồn, ứng dụng gọi
                      <code> /images/edits </code> để tạo ảnh mới từ ảnh đó. Model phải hỗ trợ endpoint
                      này.
                    </span>
                  </div>

                  <details className="project-advanced">
                    <summary>Tham số nâng cao (JSON)</summary>
                    <textarea
                      value={imageParams}
                      spellCheck={false}
                      onChange={(event) => setImageParams(event.target.value)}
                    />
                  </details>
                </fieldset>

                <Notice tone="warn">
                  Mỗi lần tạo sẽ dùng API key của bạn và có thể phát sinh chi phí từ provider.
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
                  Tạo ảnh
                </button>
              </form>

              <div className="project-results-panel">
                <div className="project-panel-heading">
                  <h3>Ảnh trong dự án</h3>
                  <span className="project-badge">{imageResults.length} ảnh</span>
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
                    <h3>Chưa có ảnh nào</h3>
                    <p>Nhập mô tả và bấm Tạo ảnh. Ảnh sẽ giữ phong cách chung của dự án.</p>
                  </div>
                )}
              </div>
            </div>
          ) : tab === 'characters' ? (
            <div className="project-tab-panel">
              <div className="project-section-header">
                <div>
                  <h3>Nhân vật và giọng nói</h3>
                  <p>Giọng nói được lưu một lần cho mỗi nhân vật và dùng lại ở mọi cảnh.</p>
                </div>
                <button
                  className="primary-small-button"
                  disabled={project.archived}
                  onClick={() => setCharacterModal('new')}
                >
                  <Plus size={15} /> Thêm nhân vật
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
                          {!character.referenceUrl && (
                            <span className="project-hint">Chưa có ảnh tham chiếu</span>
                          )}
                        </div>
                      </div>
                      <p>{character.appearance || 'Chưa mô tả ngoại hình.'}</p>
                      <div className="project-voice-summary">
                        <Mic size={14} />{' '}
                        {[
                          character.voice.accent,
                          character.voice.pitch,
                          character.voice.timbre,
                          character.voice.pace,
                        ]
                          .filter(Boolean)
                          .join(' · ') || 'Chưa có hồ sơ giọng nói'}
                      </div>
                      <div className="project-actions">
                        <button
                          className="secondary-button"
                          disabled={!!busy}
                          onClick={() => setCharacterModal(character)}
                        >
                          <Pencil size={14} /> Sửa
                        </button>
                        <button
                          className="secondary-button"
                          disabled={!!busy}
                          onClick={() => void removeCharacter(character)}
                        >
                          <Trash2 size={14} /> Xóa
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="project-empty-media">
                  <Users size={36} />
                  <h3>Chưa có nhân vật</h3>
                  <p>
                    Thêm nhân vật kèm ngoại hình và hồ sơ giọng nói để dùng chung cho các cảnh video.
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="project-tab-panel">
              <div className="project-section-header">
                <div>
                  <h3>Chuỗi cảnh video</h3>
                  <p>Sắp xếp thứ tự cảnh, mỗi cảnh một nhân vật nói và một hồ sơ giọng cố định.</p>
                </div>
                <button
                  className="primary-small-button"
                  disabled={project.archived}
                  onClick={() => openScene('new')}
                >
                  <Plus size={15} /> Thêm cảnh
                </button>
              </div>

              {orderedScenes.length ? (
                <div className="project-scene-list">
                  {orderedScenes.map((scene, index) => {
                    const chosen = scene.selectedGenerationId
                      ? results.find((item) => item.id === scene.selectedGenerationId)
                      : undefined
                    const cover = chosen ? firstAsset([chosen]) : null
                    return (
                      <article
                        key={scene.id}
                        className={`project-scene-card ${
                          sceneEdit !== 'new' && sceneEdit?.id === scene.id ? 'active' : ''
                        }`}
                      >
                        <div className="project-scene-thumb">
                          {cover ? (
                            cover.kind === 'video' ? (
                              <video src={cover.asset.url} muted preload="metadata" />
                            ) : (
                              <img src={cover.asset.url} alt="" loading="lazy" />
                            )
                          ) : (
                            <Play size={20} />
                          )}
                        </div>
                        <div className="project-scene-card-body">
                          <h3>
                            {index + 1}. {scene.title}
                          </h3>
                          <div className="project-card-meta">
                            {scene.characterId ? (
                              <span>
                                {characters.find((item) => item.id === scene.characterId)?.name ??
                                  'Nhân vật'}
                              </span>
                            ) : (
                              <span>Không có người nói</span>
                            )}
                            {chosen && <span className="connected-pill"><span /> Đã chọn phiên bản</span>}
                          </div>
                          <div className="project-actions">
                            <button
                              className="secondary-button"
                              onClick={() => openScene(scene)}
                              aria-label={`Sửa cảnh ${scene.title}`}
                            >
                              <Pencil size={13} /> Sửa
                            </button>
                            <button
                              className="secondary-button"
                              disabled={!!busy || index === 0}
                              onClick={() => void move(scene.id, -1)}
                              aria-label={`Đưa cảnh ${scene.title} lên`}
                            >
                              <ChevronUp size={13} />
                            </button>
                            <button
                              className="secondary-button"
                              disabled={!!busy || index === orderedScenes.length - 1}
                              onClick={() => void move(scene.id, 1)}
                              aria-label={`Đưa cảnh ${scene.title} xuống`}
                            >
                              <ChevronDown size={13} />
                            </button>
                          </div>
                        </div>
                      </article>
                    )
                  })}
                </div>
              ) : (
                <div className="project-empty-media">
                  <Film size={36} />
                  <h3>Chưa có cảnh nào</h3>
                  <p>
                    {videoModels.length
                      ? 'Thêm cảnh đầu tiên, chọn nhân vật nói và nhập lời thoại.'
                      : 'Cần ít nhất một model video đã phân loại trong API & Models.'}
                  </p>
                </div>
              )}

              {sceneEdit && (
                <SceneWorkspace
                  key={editorKey}
                  scene={sceneEdit === 'new' ? undefined : sceneEdit}
                  projectId={project.id}
                  characters={characters}
                  models={models}
                  revision={revision}
                  nextPosition={orderedScenes.length}
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
          onClose={() => setCharacterModal(null)}
          onSave={saveCharacter}
        />
      )}
    </div>
  )
}
