import { useEffect, useMemo, useState } from 'react'
import {
  ArrowUpRight,
  BookOpen,
  Copy,
  Image as ImageIcon,
  KeyRound,
  LoaderCircle,
  Play,
  Settings2,
  Sparkles,
  Upload,
  UserRound,
  Video,
} from 'lucide-react'
import { ApiError, errorMessage } from '../api/client'
import { characterApi, generationApi } from '../api/endpoints'
import type { Generation, GenerationParamsInput, ModelInfo, Mode } from '../api/types'
import type { ProjectCharacter } from '../api/projectTypes'
import { CreationCard, SelectControl, statusLabel } from '../components/Common'
import type { Page } from '../components/Sidebar'
import { formatNumber, useTranslation } from '../i18n'
import { studioCatalog, type StudioKey } from '../i18n/catalogs/studio'
import { notification, type Notification } from '../i18n/messages'

type Props = {
  mode: Mode
  onModeChange: (mode: Mode) => void
  models: ModelInfo[]
  creations: Generation[]
  loading: boolean
  onCreated: (generation: Generation) => void
  onDelete: (id: string) => void
  busyId: string | null
  onNavigate: (page: Page) => void
  onNotify: (message: Notification) => void
}

/** Lựa chọn chỉ giữ `value` (giá trị gửi API) và khoá dịch cho nhãn hiển thị. */
type Option = { value: string; labelKey: StudioKey }

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

/**
 * Chi tiết thô từ provider/máy chủ, chỉ đặt ở tooltip: `errorMessage()` đã là bản dịch
 * theo ngôn ngữ hiện tại, còn văn bản gốc không bao giờ bị dịch máy.
 */
function rawErrorDetail(cause: unknown): string | undefined {
  if (!(cause instanceof ApiError)) return undefined
  const raw = cause.message.trim()
  return raw && raw !== errorMessage(cause) ? raw : undefined
}

export function StudioPage({
  mode, onModeChange, models, creations, loading, onCreated, onDelete, busyId, onNavigate, onNotify,
}: Props) {
  const { t, locale } = useTranslation(studioCatalog)
  const [prompt, setPrompt] = useState('')
  const [modelId, setModelId] = useState('')
  const [size, setSize] = useState(IMAGE_SIZES[0].value)
  const [quality, setQuality] = useState('')
  const [seconds, setSeconds] = useState(VIDEO_SECONDS[0].value)
  const [count, setCount] = useState(1)
  const [busy, setBusy] = useState(false)
  /**
   * Lỗi được lưu dưới dạng đối tượng gốc, không định dạng sẵn: `errorMessage()` đọc
   * ngôn ngữ tại thời điểm render nên thông báo tự dịch lại khi đổi en/vi.
   */
  const [error, setError] = useState<unknown>(null)

  // Nhân vật dùng chung của thư viện, gắn tùy chọn cho lần tạo này.
  const [characters, setCharacters] = useState<ProjectCharacter[]>([])
  const [characterId, setCharacterId] = useState('')
  const [sendReference, setSendReference] = useState(true)

  useEffect(() => {
    let alive = true
    characterApi
      .list()
      .then((result) => {
        if (alive) setCharacters(result.characters)
      })
      .catch(() => {
        // Thư viện nhân vật chỉ là tùy chọn; không chặn việc tạo nội dung.
      })
    return () => {
      alive = false
    }
  }, [])

  const selectedCharacter = characters.find((item) => item.id === characterId) ?? null
  const willSendReference = Boolean(selectedCharacter?.referenceUrl && sendReference)

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
    const first = modelsForMode[0]
    setProviderId(first?.providerId ?? '')
    setModelId(first?.id ?? '')
  }, [modelsForMode])

  const providerModels = useMemo(
    () => modelsForMode.filter((model) => model.providerId === providerId),
    [modelsForMode, providerId],
  )

  const selectedModel = modelsForMode.find((model) => model.id === modelId)
  const latest = creations[0]
  const latestAsset = latest?.assets[0]

  async function generate() {
    if (busy || !prompt.trim() || !selectedModel) return

    setError(null)
    setBusy(true)
    try {
      const params: GenerationParamsInput =
        mode === 'image'
          ? { size, ...(quality ? { quality } : {}), n: count }
          : { size, seconds }

      const result = await generationApi.create({
        modelId: selectedModel.id,
        prompt: prompt.trim(),
        // Gửi ảnh tham chiếu nhân vật để model bám đúng ngoại hình.
        params: { ...params, ...(selectedCharacter ? { useCharacterReference: willSendReference } : {}) },
        ...(selectedCharacter ? { characterId: selectedCharacter.id } : {}),
        // Khóa chống gửi trùng cho lần bấm này.
        idempotencyKey: crypto.randomUUID(),
      })
      onCreated(result.generation)
      onNotify(notification('studio', 'notifyRequestSent'))
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy(false)
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
          <div className="mode-tabs">
            <button className={mode === 'image' ? 'active' : ''} onClick={() => onModeChange('image')}>
              <ImageIcon size={17} /> {t('modeImage')}
            </button>
            <button className={mode === 'video' ? 'active' : ''} onClick={() => onModeChange('video')}>
              <Video size={17} /> {t('modeVideo')} <span className="beta-pill">{t('betaBadge')}</span>
            </button>
          </div>

          <div className="composer-body">
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
                  ) : (
                    <>
                      <SelectControl
                        label={t('sizeLabel')}
                        value={size}
                        options={VIDEO_SIZES.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
                        onChange={setSize}
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

            <div className="quick-character">
              <div className="field-label-row">
                <label htmlFor="quick-character">{t('characterOptionalLabel')}</label>
                <span className="counter">
                  {characters.length
                    ? t('charactersInLibrary', { count: characters.length })
                    : t('charactersLibraryEmpty')}
                </span>
              </div>
              <SelectControl
                label={t('characterLabel')}
                value={characterId}
                options={[
                  { value: '', label: t('noCharacterAttached') },
                  ...characters.map((character) => ({
                    value: character.id,
                    label: character.referenceUrl
                      ? t('characterWithReference', { name: character.name })
                      : t('characterDescriptionOnly', { name: character.name }),
                  })),
                ]}
                onChange={setCharacterId}
              />
              {selectedCharacter && (
                <div className="quick-character-preview">
                  <div className="project-character-avatar">
                    {selectedCharacter.referenceUrl ? (
                      <img
                        src={selectedCharacter.referenceUrl}
                        alt={t('characterReferenceAlt', { name: selectedCharacter.name })}
                        loading="lazy"
                      />
                    ) : (
                      selectedCharacter.name.slice(0, 1).toUpperCase()
                    )}
                  </div>
                  <div>
                    <strong>{selectedCharacter.name}</strong>
                    <p>{selectedCharacter.appearance || t('noAppearance')}</p>
                  </div>
                </div>
              )}
              {selectedCharacter?.referenceUrl ? (
                <label className="project-checkbox">
                  <input
                    type="checkbox"
                    checked={sendReference}
                    onChange={(event) => setSendReference(event.target.checked)}
                  />
                  <span>
                    {t('sendReferencePrefix')}<strong>{selectedCharacter.name}</strong>
                    {t('sendReferenceSuffixContent')}
                  </span>
                </label>
              ) : selectedCharacter ? (
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
              disabled={busy || !prompt.trim() || !selectedModel}
            >
              {busy ? <LoaderCircle size={18} className="spin" /> : <Sparkles size={18} />}
              {busy ? t('sending') : mode === 'image' ? t('generateImage') : t('generateVideo')}
            </button>
            <p className="cost-note">
              {selectedModel ? t('costNoteWithModel') : t('costNoteNoModel')}
            </p>
          </div>
        </section>

        <section className="preview-column">
          <div className="preview-header">
            <div><div className="section-kicker">{t('recentResults')}</div><h2>{t('yourSpace')}</h2></div>
            <button className="text-button" onClick={() => onNavigate('library')}>
              {t('viewAll')} <ArrowUpRight size={14} />
            </button>
          </div>

          <div className={`result-preview ${latest ? (latest.kind === 'video' ? 'violet' : 'sunset') : 'idle'}`}>
            {latestAsset && latest.kind === 'image' && <img src={latestAsset.url} alt={latest.prompt} />}
            {latestAsset && latest.kind === 'video' && (
              <video src={latestAsset.url} controls preload="metadata" />
            )}
            {!latestAsset && (
              <div className="preview-placeholder">
                {latest && (latest.status === 'queued' || latest.status === 'running' || latest.status === 'downloading')
                  ? <LoaderCircle size={26} className="spin" />
                  : <Sparkles size={26} />}
                <span>{latest ? statusLabel(latest.status) : t('noResultsYet')}</span>
              </div>
            )}
            {latest && (
              <div className="preview-meta">
                <div>
                  <span className="result-type">
                    {latest.kind === 'video' ? t('kindVideo') : t('kindImage')} · {statusLabel(latest.status)}
                    {latest.progress !== null && latest.status !== 'succeeded' ? ` ${latest.progress}%` : ''}
                  </span>
                  <strong>{latest.prompt.slice(0, 60)}</strong>
                </div>
                <button
                  className="round-icon"
                  onClick={() => {
                    void navigator.clipboard?.writeText(latest.prompt)
                    onNotify(notification('studio', 'notifyPromptCopied'))
                  }}
                  aria-label={t('copyPrompt')}
                >
                  <Copy size={15} />
                </button>
              </div>
            )}
          </div>

          <div className="quick-stats">
            <div><span>{t('totalCreations')}</span><strong>{creations.length.toString().padStart(2, '0')}</strong></div>
            <div><span>{t('providerInUse')}</span><strong>{selectedModel?.providerName ?? t('notConfigured')}</strong></div>
            <div><span>{t('modelSelected')}</span><strong>{selectedModel?.displayName ?? '—'}</strong></div>
          </div>
        </section>
      </div>

      <div className="recent-heading">
        <div><div className="section-kicker">{t('canvasEyebrow')}</div><h2>{t('recentCreations')}</h2></div>
      </div>
      {loading ? (
        <div className="empty-state"><LoaderCircle size={26} className="spin" /><h3>{t('loadingShort')}</h3></div>
      ) : creations.length ? (
        <div className="creation-strip">
          {creations.slice(0, 3).map((generation) => (
            <CreationCard
                key={generation.id}
                generation={generation}
                onDelete={() => onDelete(generation.id)}
                busy={busyId === generation.id}
              />
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <Sparkles size={28} />
          <h3>{t('noResultsYet')}</h3>
          <p>{t('studioEmptyHint')}</p>
        </div>
      )}
    </div>
  )
}
