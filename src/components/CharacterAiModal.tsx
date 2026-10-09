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
import { useTranslation } from '../i18n'
import { charactersCatalog } from '../i18n/catalogs/characters'
import { notification, type Notification } from '../i18n/messages'
import {
  CharactersLocalError,
  CharactersStoredError,
  charactersErrorDetail,
  charactersErrorMessage,
  describeCharactersError,
  type CharactersUiError,
} from './CharacterForm'
import { ImageLightbox } from './Lightbox'

const COUNT_OPTIONS = [1, 2, 3, 4, 5, 6]
/** Số ảnh chạy song song; khớp trần tác vụ đồng thời mỗi người của backend. */
const POOL_SIZE = 2
const POLL_MS = 1500
const MAX_WAIT_MS = 4 * 60 * 1000

/** Khoá catalog cho nhãn rút gọn của hồ sơ giọng trên thẻ ứng viên. */
const VOICE_LABEL_KEYS = [
  { key: 'accent', labelKey: 'voiceSummaryAccent' },
  { key: 'pitch', labelKey: 'voiceSummaryPitch' },
  { key: 'timbre', labelKey: 'voiceSummaryTimbre' },
  { key: 'pace', labelKey: 'voiceSummaryPace' },
] as const satisfies ReadonlyArray<{
  key: keyof GeneratedCharacter['voice']
  labelKey: keyof typeof charactersCatalog
}>

/**
 * Lỗi nội bộ khi người dùng bấm dừng giữa chừng.
 *
 * Không phải câu chữ hiển thị: chỉ dùng để phân biệt "bị huỷ" với lỗi thật, nên
 * không phụ thuộc ngôn ngữ giao diện.
 */
class CancelledError extends Error {
  constructor() {
    super('cancelled')
    this.name = 'CancelledError'
  }
}

type CardStatus = 'idle' | 'imaging' | 'saving' | 'saved' | 'error'

type CardState = {
  status: CardStatus
  /** Phần trăm tác vụ tạo ảnh, null khi provider không trả tiến trình. */
  progress: number | null
  generationId?: string
  assetUrl?: string
  characterId?: string
  /** Descriptor lỗi để câu chữ dịch lại theo ngôn ngữ hiện tại. */
  error?: CharactersUiError
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Câu tiếng Việt mà server gửi kèm khi người dùng chạm trần tác vụ đồng thời. */
const BUSY_LIMIT_PATTERN = /đang có \d+ tác vụ/i

/**
 * Kiểm tra lỗi do chạm trần tác vụ đồng thời để thử lại thay vì báo lỗi cứng.
 *
 * `errorMessage()` đã dịch theo ngôn ngữ giao diện nên câu hiển thị có thể là
 * tiếng Anh; server vẫn gửi kèm câu gốc trong `message`. Kiểm tra cả hai để cơ
 * chế thử lại không phụ thuộc ngôn ngữ đang chọn.
 */
function isBusyLimit(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : ''
  return BUSY_LIMIT_PATTERN.test(raw) || BUSY_LIMIT_PATTERN.test(errorMessage(error))
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
  onNotify: (message: Notification) => void
}) {
  const { t } = useTranslation(charactersCatalog)
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
  // Descriptor lỗi để câu chữ dịch lại theo ngôn ngữ hiện tại.
  const [error, setError] = useState<CharactersUiError | null>(null)
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
        if (attempt < 39 && isBusyLimit(cause)) {
          await sleep(1500)
          continue
        }
        // Giữ nguyên Error gốc (ApiError) để câu lỗi dịch theo ngôn ngữ lúc render.
        throw cause
      }
    }

    const deadline = Date.now() + MAX_WAIT_MS
    while (!cancelled.current && Date.now() < deadline) {
      const current = (await generationApi.get(generationId)).generation
      if (current.status === 'succeeded') {
        const asset = current.assets[0]
        if (!asset) throw new CharactersLocalError('errorNoAsset')
        return { generationId, assetUrl: asset.url }
      }
      if (current.status === 'failed' || current.status === 'unknown') {
        throw new CharactersStoredError(
          {
            errorCode: current.errorCode,
            errorMessage: current.errorMessage,
            errorMessageKey: current.errorMessageKey,
            errorMessageParams: current.errorMessageParams,
          },
          'errorReferenceImageFailed',
        )
      }
      patchState(candidate.name, { status: 'imaging', progress: current.progress ?? null })
      await sleep(POLL_MS)
    }

    if (cancelled.current) throw new CancelledError()
    throw new CharactersLocalError('errorGenerationTimeout')
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
      if (cancelled.current || cause instanceof CancelledError) {
        patchState(candidate.name, { status: 'idle' })
        return
      }
      patchState(candidate.name, { status: 'error', error: describeCharactersError(cause) })
    }
  }

  async function generate(): Promise<void> {
    setBusy('text')
    setError(null)
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
        onNotify(notification('characters', 'aiNotifyBatchSaved', { count: savedNames.length }))
      }
    } catch (cause) {
      setError(describeCharactersError(cause))
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
    setError(null)
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
          ? notification('characters', 'aiNotifyAddedWithImage', { name: candidate.name })
          : notification('characters', 'aiNotifyAddedWithoutImage', { name: candidate.name }),
      )
    } catch (cause) {
      setError(describeCharactersError(cause))
    } finally {
      setBusy('')
    }
  }

  /** Tạo lại ảnh cho một thẻ bị lỗi. */
  async function retryImage(candidate: GeneratedCharacter): Promise<void> {
    setBusy('retry')
    setError(null)
    const savedNames: string[] = []
    await processCandidate(candidate, savedNames)
    if (savedNames.length) {
      onAdded(savedNames.join(', '))
      onNotify(notification('characters', 'aiNotifyRetrySaved', { name: candidate.name }))
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
        aria-label={t('aiTitle')}
      >
        <div className="modal-header">
          <div>
            <div className="eyebrow"><span className="eyebrow-dot" /> {t('aiEyebrow')}</div>
            <h2>{t('aiTitle')}</h2>
          </div>
          <button className="close-button" disabled={running} onClick={onClose} aria-label={t('close')}>
            <X size={18} />
          </button>
        </div>

        <p className="modal-description">
          {t('aiDescriptionLead')} <strong>{t('aiDescriptionHighlight')}</strong>{' '}
          {t('aiDescriptionTail')}
        </p>

        {!hasLlmModel ? (
          <div className="character-ai-empty">
            <BrainCircuit size={22} />
            <strong>{t('aiNoLlmTitle')}</strong>
            <span>{t('aiNoLlmDescription')}</span>
            <button className="primary-small-button" onClick={onOpenSettings}>
              {t('aiOpenSettings')}
            </button>
          </div>
        ) : (
          <>
            <div className="modal-form">
              <label>
                {t('aiDescriptionLabel')}
                <textarea
                  value={description}
                  placeholder={t('aiDescriptionPlaceholder')}
                  maxLength={2000}
                  disabled={running}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>

              <div className="character-ai-controls">
                <label>
                  {t('aiCountLabel')}
                  <div className="select-wrap">
                    <select
                      value={count}
                      disabled={running}
                      onChange={(event) => setCount(Number(event.target.value))}
                    >
                      {COUNT_OPTIONS.map((value) => (
                        <option key={value} value={value}>
                          {t('aiCountOption', { count: value })}
                        </option>
                      ))}
                    </select>
                  </div>
                </label>
                {llmModels.length > 1 && (
                  <label>
                    {t('aiLlmModelLabel')}
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
                  {t('aiImageModelLabel')}
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
                        <option value="">{t('aiNoImageModelOption')}</option>
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
                  <span>{t('aiAutoSave')}</span>
                </label>

                {imageModelId ? (
                  <p className="character-ai-cost">
                    {t('aiCostLead')} <strong>{count}</strong> {t('aiCostTail')}
                  </p>
                ) : (
                  <p className="character-ai-cost is-warn">
                    {t('aiCostNoImage')}
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
                    ? t('aiWritingProfiles')
                    : busy === 'batch'
                      ? t('aiGeneratingCount', { done: progressCount.done, total: progressCount.total })
                      : imageModelId
                        ? t('aiGenerateWithImages', { count })
                        : t('aiGenerateTextOnly', { count })}
                </button>
                {busy === 'batch' && (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      cancelled.current = true
                      onNotify(notification('characters', 'aiStopNotify'))
                    }}
                  >
                    <Square size={14} /> {t('aiStop')}
                  </button>
                )}
              </div>

              {error && <div className="form-error" role="alert" title={charactersErrorDetail(error)}>{charactersErrorMessage(error)}</div>}
            </div>

            {candidates.length > 0 && (
              <div className="character-ai-results">
                <div className="character-ai-results-heading">
                  <span>{t('aiResultsCount', { count: candidates.length })}</span>
                  <button
                    type="button"
                    className="text-button"
                    disabled={running}
                    onClick={() => void generate()}
                  >
                    <RefreshCw size={13} /> {t('aiRegenerate')}
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
                          {isSaved && <span className="character-ai-status is-ok">{t('aiStatusSaved')}</span>}
                          {state.status === 'error' && (
                            <span className="character-ai-status is-error" role="alert">{t('aiStatusImageError')}</span>
                          )}
                        </div>

                        <div className="character-ai-sheet">
                          {state.assetUrl ? (
                            <button
                              type="button"
                              className="illustration-zoom"
                              title={t('zoomImageTitle')}
                              aria-label={t('zoomImageAria', { name: candidate.name })}
                              onClick={() => setZoom({ url: state.assetUrl!, name: candidate.name })}
                            >
                              <img
                                className="illustration-image"
                                src={state.assetUrl}
                                alt={t('referenceImageAlt', { name: candidate.name })}
                                loading="lazy"
                              />
                            </button>
                          ) : state.status === 'imaging' || state.status === 'saving' ? (
                            <div className="illustration-placeholder" role="status">
                              <LoaderCircle size={20} className="spin" />
                              <span>
                                {t('aiSheetGenerating')}
                                {state.progress !== null ? ` ${state.progress}%` : ''}
                              </span>
                            </div>
                          ) : (
                            <div
                              className="illustration-placeholder"
                              role={state.status === 'error' ? 'alert' : undefined}
                              title={state.status === 'error' ? charactersErrorDetail(state.error) : undefined}
                            >
                              <ImagePlus size={20} />
                              <span>
                                {state.status === 'error'
                                  ? charactersErrorMessage(state.error)
                                  : imageModelId
                                    ? t('aiNoImageYet')
                                    : t('aiNoImageModelOption')}
                              </span>
                            </div>
                          )}
                        </div>

                        <p>{candidate.appearance || t('appearanceEmpty')}</p>
                        <div className="character-library-tags">
                          {VOICE_LABEL_KEYS.filter(({ key }) => candidate.voice[key]).map(({ key, labelKey }) => (
                            <span key={key}>{t(labelKey)}: {candidate.voice[key]}</span>
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
                              <RotateCcw size={14} /> {t('aiRetryImage')}
                            </button>
                          )}
                          <button
                            type="button"
                            className={isSaved ? 'secondary-button' : 'primary-small-button'}
                            disabled={running || busy !== '' || isSaved}
                            onClick={() => void add(candidate)}
                          >
                            {isSaved
                              ? t('aiAdded')
                              : <><Plus size={14} /> {state.assetUrl ? t('aiAddWithImage') : t('aiAddToList')}</>}
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
            {t('close')}
          </button>
        </div>
      </div>

      {zoom && (
        <ImageLightbox
          src={zoom.url}
          alt={t('referenceImageAlt', { name: zoom.name })}
          downloadHref={zoom.url}
          onClose={() => setZoom(null)}
        />
      )}
    </div>
  )
}
