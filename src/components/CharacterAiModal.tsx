import { useEffect, useRef, useState } from 'react'
import {
  BrainCircuit,
  ImagePlus,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Square,
  X,
} from 'lucide-react'
import { errorMessage } from '../api/client'
import { characterApi, generationApi } from '../api/endpoints'
import type { GeneratedCharacter } from '../api/projectTypes'
import type { ModelInfo } from '../api/types'
import { ImageLightbox } from './Lightbox'

const COUNT_OPTIONS = [1, 2, 3, 4, 5, 6]
/** Số ảnh chạy song song; khớp trần tác vụ đồng thời mỗi người của backend. */
const POOL_SIZE = 2
const POLL_MS = 1500
const MAX_WAIT_MS = 4 * 60 * 1000

const VOICE_LABELS: Array<{ key: keyof GeneratedCharacter['voice']; label: string }> = [
  { key: 'accent', label: 'Giọng' },
  { key: 'pitch', label: 'Cao độ' },
  { key: 'timbre', label: 'Âm sắc' },
  { key: 'pace', label: 'Tốc độ' },
]

type CardStatus = 'idle' | 'imaging' | 'saving' | 'saved' | 'error'

type CardState = {
  status: CardStatus
  /** Phần trăm tác vụ tạo ảnh, null khi provider không trả tiến trình. */
  progress: number | null
  generationId?: string
  assetUrl?: string
  characterId?: string
  error?: string
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Kiểm tra lỗi do chạm trần tác vụ đồng thời để thử lại thay vì báo lỗi cứng. */
function isBusyLimit(message: string): boolean {
  return /đang có \d+ tác vụ/i.test(message)
}

/**
 * Modal sinh nhân vật mẫu bằng AI.
 *
 * Một nút chạy cả loạt: AI sinh mô tả cho N nhân vật rồi lần lượt tạo ảnh sheet
 * (cận mặt + 4 góc nhìn) và — nếu bật "Lưu ngay" — ghi thẳng vào thư viện kèm ảnh
 * tham chiếu. Ảnh chạy theo pool nhỏ nên không phải bấm từng thẻ như trước.
 */
export function CharacterAiModal({
  llmModels,
  models,
  onClose,
  onAdded,
  onOpenSettings,
  onNotify,
}: {
  /** Model văn bản (kind = 'llm') đang bật, dùng để sinh nhân vật mẫu. */
  llmModels: ModelInfo[]
  /** Model tạo ảnh hiện có, dùng để sinh ảnh sheet. */
  models: ModelInfo[]
  onClose: () => void
  onAdded: (name: string) => void
  onOpenSettings: () => void
  onNotify: (message: string) => void
}) {
  const imageModels = models.filter((model) => model.kind === 'image' && model.enabled)

  const [description, setDescription] = useState('')
  const [count, setCount] = useState(3)
  const [llmModelId, setLlmModelId] = useState(llmModels[0]?.id ?? '')
  const [imageModelId, setImageModelId] = useState(imageModels[0]?.id ?? '')
  const [autoSave, setAutoSave] = useState(true)

  const [candidates, setCandidates] = useState<GeneratedCharacter[]>([])
  const [states, setStates] = useState<Record<string, CardState>>({})
  const [busy, setBusy] = useState('')
  const [progressCount, setProgressCount] = useState({ done: 0, total: 0 })
  const [error, setError] = useState('')
  const [zoom, setZoom] = useState<{ url: string; name: string } | null>(null)

  const cancelled = useRef(false)
  useEffect(() => {
    cancelled.current = false
    return () => {
      cancelled.current = true
    }
  }, [])

  const hasLlmModel = llmModels.length > 0
  const canGenerate = hasLlmModel && Boolean(description.trim()) && busy === ''

  function patchState(name: string, patch: Partial<CardState>): void {
    setStates((current) => ({
      ...current,
      [name]: { ...(current[name] ?? { status: 'idle' as CardStatus, progress: null }), ...patch },
    }))
  }

  /**
   * Chờ tác vụ ảnh xong.
   *
   * Nếu backend báo đang chạm trần tác vụ đồng thời thì chờ rồi thử lại: pool của
   * giao diện có thể va vào tác vụ khác người dùng đang chạy ở Studio.
   */
  async function createSheet(candidate: GeneratedCharacter): Promise<{ generationId: string; assetUrl: string }> {
    let generationId = ''
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const created = await characterApi.illustrate({
          modelId: imageModelId,
          name: candidate.name,
          appearance: candidate.appearance,
        })
        generationId = created.generation.id
        break
      } catch (cause) {
        const message = errorMessage(cause)
        if (attempt < 39 && isBusyLimit(message)) {
          await sleep(1500)
          continue
        }
        throw new Error(message)
      }
    }

    const deadline = Date.now() + MAX_WAIT_MS
    while (!cancelled.current && Date.now() < deadline) {
      const current = (await generationApi.get(generationId)).generation
      if (current.status === 'succeeded') {
        const asset = current.assets[0]
        if (!asset) throw new Error('Tác vụ hoàn tất nhưng không có ảnh nào để dùng.')
        return { generationId, assetUrl: asset.url }
      }
      if (current.status === 'failed' || current.status === 'unknown') {
        throw new Error(current.errorMessage ?? 'Tạo ảnh tham chiếu thất bại.')
      }
      patchState(candidate.name, { status: 'imaging', progress: current.progress ?? null })
      await sleep(POLL_MS)
    }

    if (cancelled.current) throw new Error('Đã huỷ.')
    throw new Error('Tạo ảnh quá lâu. Hãy thử lại.')
  }

  /** Lưu nhân vật và gắn ảnh sheet vừa tạo làm ảnh tham chiếu. */
  async function saveCandidate(
    candidate: GeneratedCharacter,
    illustration?: { generationId: string; assetUrl: string },
  ): Promise<string> {
    const created = (await characterApi.create(candidate)).character
    if (illustration) {
      await characterApi.attachReferenceFromGeneration(created.id, illustration.generationId)
    }
    return created.id
  }

  /** Một ứng viên: tạo ảnh rồi (tuỳ lựa chọn) lưu ngay. */
  async function processCandidate(candidate: GeneratedCharacter, savedNames: string[]): Promise<void> {
    patchState(candidate.name, { status: 'imaging', progress: null, error: undefined })
    try {
      const illustration = await createSheet(candidate)
      if (cancelled.current) return
      patchState(candidate.name, {
        status: 'saving',
        progress: 100,
        generationId: illustration.generationId,
        assetUrl: illustration.assetUrl,
      })

      if (!autoSave) {
        patchState(candidate.name, { status: 'idle' })
        return
      }

      const characterId = await saveCandidate(candidate, illustration)
      savedNames.push(candidate.name)
      patchState(candidate.name, { status: 'saved', characterId })
    } catch (cause) {
      const message = errorMessage(cause)
      if (cancelled.current || message === 'Đã huỷ.') {
        patchState(candidate.name, { status: 'idle' })
        return
      }
      patchState(candidate.name, { status: 'error', error: message })
    }
  }

  async function generate(): Promise<void> {
    setBusy('text')
    setError('')
    setCandidates([])
    setStates({})
    setProgressCount({ done: 0, total: count })
    cancelled.current = false

    try {
      const result = await characterApi.generate({
        description: description.trim(),
        count,
        language: 'vi',
        ...(llmModelId ? { modelId: llmModelId } : {}),
      })
      if (cancelled.current) return
      setCandidates(result.candidates)

      // Không chọn model ảnh: chỉ sinh mô tả, người dùng tự thêm nhân vật.
      if (!imageModelId) {
        setProgressCount({ done: result.candidates.length, total: result.candidates.length })
        return
      }

      setBusy('batch')
      setProgressCount({ done: 0, total: result.candidates.length })

      const queue = [...result.candidates]
      const savedNames: string[] = []
      let finished = 0

      const workers = Array.from({ length: Math.min(POOL_SIZE, queue.length) }, async () => {
        for (;;) {
          if (cancelled.current) return
          const candidate = queue.shift()
          if (!candidate) return
          await processCandidate(candidate, savedNames)
          finished += 1
          setProgressCount({ done: finished, total: result.candidates.length })
        }
      })
      await Promise.all(workers)

      if (savedNames.length) {
        onAdded(savedNames.join(', '))
        onNotify(
          `Đã tạo và lưu ${savedNames.length} nhân vật kèm ảnh tham chiếu (cận mặt + 4 góc nhìn).`,
        )
      }
    } catch (cause) {
      setError(errorMessage(cause))
      setCandidates([])
    } finally {
      if (!cancelled.current) {
        setBusy('')
        setProgressCount((current) => ({ ...current, done: current.total }))
      }
    }
  }

  /** Thêm thủ công (khi tắt tự lưu, hoặc ảnh lỗi mà vẫn muốn lưu). */
  async function add(candidate: GeneratedCharacter): Promise<void> {
    setBusy('save')
    setError('')
    try {
      const state = states[candidate.name]
      const illustration =
        state?.generationId && state.assetUrl
          ? { generationId: state.generationId, assetUrl: state.assetUrl }
          : undefined
      await saveCandidate(candidate, illustration)
      patchState(candidate.name, { status: 'saved' })
      onAdded(candidate.name)
      onNotify(
        illustration
          ? `Đã thêm nhân vật "${candidate.name}" kèm ảnh tham chiếu.`
          : `Đã thêm nhân vật "${candidate.name}" (chưa có ảnh tham chiếu).`,
      )
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy('')
    }
  }

  /** Tạo lại ảnh cho một thẻ bị lỗi. */
  async function retryImage(candidate: GeneratedCharacter): Promise<void> {
    setBusy('retry')
    setError('')
    const savedNames: string[] = []
    await processCandidate(candidate, savedNames)
    if (savedNames.length) {
      onAdded(savedNames.join(', '))
      onNotify(`Đã lưu nhân vật "${candidate.name}" kèm ảnh tham chiếu.`)
    }
    setBusy('')
  }

  const running = busy === 'text' || busy === 'batch'

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && busy === '') onClose()
      }}
    >
      <div
        className="modal-card character-ai-modal"
        role="dialog"
        aria-modal="true"
        aria-label="AI tạo nhân vật"
      >
        <div className="modal-header">
          <div>
            <div className="eyebrow"><span className="eyebrow-dot" /> AI character</div>
            <h2>AI tạo nhân vật</h2>
          </div>
          <button className="close-button" disabled={running} onClick={onClose} aria-label="Đóng">
            <X size={18} />
          </button>
        </div>

        <p className="modal-description">
          Mô tả nhân vật, chọn model ảnh rồi bấm một nút: AI viết hồ sơ và tạo <strong>ảnh tham chiếu
          gồm cận mặt + 4 góc nhìn</strong> cho từng nhân vật. Bật “Lưu ngay” thì nhân vật vào thư
          viện luôn, không phải bấm từng thẻ.
        </p>

        {!hasLlmModel ? (
          <div className="character-ai-empty">
            <BrainCircuit size={22} />
            <strong>Chưa có model LLM &amp; Chat</strong>
            <span>
              Cần một model văn bản để AI tạo nhân vật. Vào API &amp; Models, thêm provider rồi phân
              loại một model thành “LLM &amp; Chat”.
            </span>
            <button className="primary-small-button" onClick={onOpenSettings}>
              Mở API &amp; Models
            </button>
          </div>
        ) : (
          <>
            <div className="modal-form">
              <label>
                Mô tả nhân vật
                <textarea
                  value={description}
                  placeholder="Ví dụ: một phi hành gia trẻ, điềm tĩnh, người Việt, mặc đồ bay màu xanh"
                  maxLength={2000}
                  disabled={running}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>

              <div className="character-ai-controls">
                <label>
                  Số lượng
                  <div className="select-wrap">
                    <select
                      value={count}
                      disabled={running}
                      onChange={(event) => setCount(Number(event.target.value))}
                    >
                      {COUNT_OPTIONS.map((value) => (
                        <option key={value} value={value}>{value} nhân vật</option>
                      ))}
                    </select>
                  </div>
                </label>
                {llmModels.length > 1 && (
                  <label>
                    Model LLM &amp; Chat
                    <div className="select-wrap">
                      <select
                        value={llmModelId}
                        disabled={running}
                        onChange={(event) => setLlmModelId(event.target.value)}
                      >
                        {llmModels.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.displayName} · {model.providerName}
                          </option>
                        ))}
                      </select>
                    </div>
                  </label>
                )}
                <label>
                  Model tạo ảnh
                  <div className="select-wrap">
                    <select
                      value={imageModelId}
                      disabled={running || !imageModels.length}
                      onChange={(event) => setImageModelId(event.target.value)}
                    >
                      {imageModels.length ? (
                        imageModels.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.displayName} · {model.providerName}
                          </option>
                        ))
                      ) : (
                        <option value="">Chưa có model ảnh</option>
                      )}
                    </select>
                  </div>
                </label>
              </div>

              {/* Tick tự lưu và cảnh báo chi phí nằm chung một hàng cho gọn. */}
              <div className="character-ai-options">
                <label className="character-ai-autosave">
                  <input
                    type="checkbox"
                    checked={autoSave}
                    disabled={running}
                    onChange={(event) => setAutoSave(event.target.checked)}
                  />
                  <span>Lưu vào thư viện ngay</span>
                </label>

                {imageModelId ? (
                  <p className="character-ai-cost">
                    Tối đa <strong>{count}</strong> ảnh bằng API key của bạn, ảnh vào Thư viện.
                  </p>
                ) : (
                  <p className="character-ai-cost is-warn">
                    Chưa có model tạo ảnh: chỉ sinh hồ sơ nhân vật.
                  </p>
                )}
              </div>

              <div className="character-ai-run">
                <button
                  type="button"
                  className="secondary-button character-ai-generate"
                  disabled={!canGenerate}
                  onClick={() => void generate()}
                >
                  {running
                    ? <LoaderCircle size={15} className="spin" />
                    : <Sparkles size={15} />}
                  {busy === 'text'
                    ? 'AI đang viết hồ sơ…'
                    : busy === 'batch'
                      ? `Đang tạo ảnh… ${progressCount.done}/${progressCount.total}`
                      : imageModelId
                        ? `Tạo ${count} nhân vật + ảnh`
                        : `Tạo ${count} nhân vật`}
                </button>
                {busy === 'batch' && (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      cancelled.current = true
                      onNotify('Đã dừng tạo ảnh. Những nhân vật đã lưu vẫn được giữ.')
                    }}
                  >
                    <Square size={14} /> Huỷ
                  </button>
                )}
              </div>

              {error && <div className="form-error" role="alert">{error}</div>}
            </div>

            {candidates.length > 0 && (
              <div className="character-ai-results">
                <div className="character-ai-results-heading">
                  <span>{candidates.length} nhân vật mẫu</span>
                  <button
                    type="button"
                    className="text-button"
                    disabled={running}
                    onClick={() => void generate()}
                  >
                    <RefreshCw size={13} /> Tạo lại
                  </button>
                </div>
                <div className="character-ai-grid">
                  {candidates.map((candidate) => {
                    const state = states[candidate.name] ?? { status: 'idle' as CardStatus, progress: null }
                    const isSaved = state.status === 'saved'
                    return (
                      <article className="character-ai-card" key={candidate.name}>
                        <div className="character-ai-card-head">
                          <div className="project-character-avatar">
                            {candidate.name.slice(0, 1).toUpperCase()}
                          </div>
                          <h3>{candidate.name}</h3>
                          {isSaved && <span className="character-ai-status is-ok">Đã lưu</span>}
                          {state.status === 'error' && (
                            <span className="character-ai-status is-error">Lỗi ảnh</span>
                          )}
                        </div>

                        <div className="character-ai-sheet">
                          {state.assetUrl ? (
                            <button
                              type="button"
                              className="illustration-zoom"
                              title="Xem ảnh phóng to"
                              aria-label={`Xem ảnh phóng to của ${candidate.name}`}
                              onClick={() => setZoom({ url: state.assetUrl!, name: candidate.name })}
                            >
                              <img
                                className="illustration-image"
                                src={state.assetUrl}
                                alt={`Ảnh tham chiếu của ${candidate.name}`}
                                loading="lazy"
                              />
                            </button>
                          ) : state.status === 'imaging' || state.status === 'saving' ? (
                            <div className="illustration-placeholder">
                              <LoaderCircle size={20} className="spin" />
                              <span>
                                Đang tạo ảnh sheet…
                                {state.progress !== null ? ` ${state.progress}%` : ''}
                              </span>
                            </div>
                          ) : (
                            <div className="illustration-placeholder">
                              <ImagePlus size={20} />
                              <span>
                                {state.status === 'error'
                                  ? state.error
                                  : imageModelId
                                    ? 'Chưa tạo ảnh'
                                    : 'Chưa có model ảnh'}
                              </span>
                            </div>
                          )}
                        </div>

                        <p>{candidate.appearance || 'Chưa mô tả ngoại hình.'}</p>
                        <div className="character-library-tags">
                          {VOICE_LABELS.filter(({ key }) => candidate.voice[key]).map(({ key, label }) => (
                            <span key={key}>{label}: {candidate.voice[key]}</span>
                          ))}
                        </div>

                        <div className="character-ai-card-actions">
                          {state.status === 'error' && (
                            <button
                              type="button"
                              className="secondary-button"
                              disabled={running || busy !== ''}
                              onClick={() => void retryImage(candidate)}
                            >
                              <RotateCcw size={14} /> Thử lại ảnh
                            </button>
                          )}
                          <button
                            type="button"
                            className={isSaved ? 'secondary-button' : 'primary-small-button'}
                            disabled={running || busy !== '' || isSaved}
                            onClick={() => void add(candidate)}
                          >
                            {isSaved
                              ? 'Đã thêm'
                              : <><Plus size={14} /> {state.assetUrl ? 'Thêm kèm ảnh' : 'Thêm vào danh sách'}</>}
                          </button>
                        </div>
                      </article>
                    )
                  })}
                </div>
              </div>
            )}
          </>
        )}

        <div className="modal-actions">
          <button type="button" className="secondary-button" disabled={running} onClick={onClose}>
            Đóng
          </button>
        </div>
      </div>

      {zoom && (
        <ImageLightbox
          src={zoom.url}
          alt={`Ảnh tham chiếu của ${zoom.name}`}
          downloadHref={zoom.url}
          onClose={() => setZoom(null)}
        />
      )}
    </div>
  )
}
