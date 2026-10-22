import { useEffect, useRef, useState } from 'react'
import { ImagePlus, LoaderCircle, Sparkles } from 'lucide-react'
import { characterApi, generationApi } from '../api/endpoints'
import type { ModelInfo } from '../api/types'
import { useTranslation } from '../i18n'
import { charactersCatalog } from '../i18n/catalogs/characters'
import {
  CharactersLocalError,
  CharactersStoredError,
  charactersErrorDetail,
  charactersErrorMessage,
  describeCharactersError,
  type CharactersUiError,
} from './CharacterForm'
import { ImageLightbox } from './Lightbox'
import { EntityImageSettings } from './entities/EntityImageSettings'
import { useEntityPreferences } from './entities/useEntityPreferences'
import { entityCreationCatalog } from '../i18n/catalogs/entityCreation'
import '../styles/character-illustration-loading.css'

const POLL_MS = 1500
const MAX_WAIT_MS = 4 * 60 * 1000

export type IllustrationState = { generationId: string; assetUrl: string }

/**
 * Mô tả tiến trình đang chạy — lưu descriptor thay vì câu chữ đã dịch, để khi
 * người dùng đổi ngôn ngữ giữa chừng thì dòng trạng thái cũng đổi theo.
 */
type IllustrationProgress = { kind: 'sending' } | { kind: 'attaching' } | { kind: 'generating'; percent: number | null }

function validPercent(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null
}

/**
 * Ảnh tham chiếu là "phiếu thiết kế" (character sheet) gồm toàn thân trước/sau
 * và cận mặt đủ đầu, tóc, cổ. Prompt do server dựng nên giao diện chỉ
 * gửi model + tên + ngoại hình.
 */

/**
 * Sinh ảnh minh hoạ cho một nhân vật bằng model tạo ảnh người dùng chọn.
 *
 * Ảnh là một tác vụ tạo ảnh thật (tốn chi phí theo key của người dùng) và xuất
 * hiện trong Thư viện. Component tự theo dõi tiến trình và báo ảnh khi xong.
 */
export function IllustrationPanel({
  character,
  models,
  initial = null,
  previewUrl = null,
  rememberSettings = false,
  onReady,
}: {
  character: { name: string; appearance: string }
  models: ModelInfo[]
  initial?: IllustrationState | null
  /** Existing saved reference stays visible while a new illustration is generated. */
  previewUrl?: string | null
  rememberSettings?: boolean
  onReady?: (state: IllustrationState) => void | Promise<void>
}) {
  const { t } = useTranslation(charactersCatalog)
  const imageModels = models.filter((model) => model.enabled && model.kind === 'image')

  const preferences = useEntityPreferences(rememberSettings)
  const { t: te } = useTranslation(entityCreationCatalog)
  const [localModelId, setLocalModelId] = useState(imageModels[0]?.id ?? '')
  const modelId = rememberSettings ? preferences.settings.imageModelId : localModelId
  const selectedModel = imageModels.find(model => model.id === modelId)
  const setModelId = (id: string) => rememberSettings ? preferences.update({ imageModelId: id }) : setLocalModelId(id)
  const [state, setState] = useState<IllustrationState | null>(initial)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<IllustrationProgress | null>(null)
  // Descriptor lỗi: Error gốc hoặc khoá catalog, dịch lại theo ngôn ngữ lúc render.
  const [error, setError] = useState<CharactersUiError | null>(null)
  /** Ảnh đang xem phóng to. */
  const [zoom, setZoom] = useState(false)
  const cancelled = useRef(false)
  const busyRef = useRef(false)
  const displayedUrl = state?.assetUrl ?? previewUrl
  const progressLabel = !progress ? '' : progress.kind === 'sending'
    ? t('illustrationSending')
    : progress.kind === 'attaching'
      ? t('illustrateAttaching')
      : progress.percent !== null
        ? t('illustrationGeneratingPercent', { percent: progress.percent })
        : t('illustrationGenerating')

  // Dừng vòng poll khi component bị gỡ để không setState sau khi unmount.
  useEffect(() => {
    cancelled.current = false
    return () => {
      cancelled.current = true
    }
  }, [])

  async function illustrate() {
    if (busyRef.current || !selectedModel || !preferences.loaded) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    setProgress({ kind: 'sending' })
    try {
      const created = await characterApi.illustrate({
        modelId,
        name: character.name,
        appearance: character.appearance,
        ...(rememberSettings ? { size: preferences.settings.size, quality: preferences.settings.quality } : {}),
      })
      if (cancelled.current) return
      const generationId = created.generation.id
      setProgress({ kind: 'generating', percent: validPercent(created.generation.progress) })
      const deadline = Date.now() + MAX_WAIT_MS

      while (!cancelled.current && Date.now() < deadline) {
        const current = (await generationApi.get(generationId)).generation
        if (cancelled.current) return

        if (current.status === 'succeeded') {
          const asset = current.assets[0]
          if (!asset) throw new CharactersLocalError('errorNoAsset')
          const next = { generationId, assetUrl: asset.url }
          if (cancelled.current) return
          setState(next)
          if (onReady) {
            setProgress({ kind: 'attaching' })
            await onReady(next)
          }
          return
        }
        if (current.status === 'failed' || current.status === 'unknown') {
          throw new CharactersStoredError(
            {
              errorCode: current.errorCode,
              errorMessage: current.errorMessage,
              errorMessageKey: current.errorMessageKey,
              errorMessageParams: current.errorMessageParams,
            },
            'errorIllustrationFailed',
          )
        }

        setProgress({ kind: 'generating', percent: validPercent(current.progress) })
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      }

      if (!cancelled.current) throw new CharactersLocalError('errorGenerationTimeout')
    } catch (cause) {
      if (!cancelled.current) setError(describeCharactersError(cause))
    } finally {
      busyRef.current = false
      if (!cancelled.current) {
        setBusy(false)
        setProgress(null)
      }
    }
  }

  if (!imageModels.length) {
    return (
      <div className="illustration-empty">
        <ImagePlus size={16} />
        <span>{t('illustrationEmptyModels')}</span>
      </div>
    )
  }

  return (
    <div className="illustration-panel" aria-busy={busy} data-illustration-phase={progress?.kind ?? 'idle'}>
      <div className="character-illustration-stage">
      {displayedUrl ? (
        <button
          type="button"
          className="illustration-zoom"
          title={t('zoomImageTitle')}
          aria-label={t('zoomImageTitle')}
          disabled={busy}
          onClick={() => setZoom(true)}
        >
          <img
            className="illustration-image"
            src={displayedUrl}
            alt={t('referenceImageAlt', { name: character.name })}
            loading="lazy"
          />
        </button>
      ) : (
        <div className="illustration-placeholder">
          <ImagePlus size={20} />
          <span>{t('illustrationNoImage')}</span>
        </div>
      )}
      {progress && <div className="character-illustration-loading" role="status" aria-live="polite" aria-atomic="true">
        <LoaderCircle size={28} className="character-illustration-spinner" aria-hidden="true" />
        <span>{progressLabel}</span>
        {progress.kind === 'generating' && progress.percent !== null && <progress max={100} value={progress.percent} aria-label={t('illustrationProgressLabel')} />}
      </div>}
      </div>

      {(rememberSettings || imageModels.length > 1) && (
        <label className="illustration-model">
          <span>{t('aiImageModelLabel')}</span>
          <div className="select-wrap">
            <select
              aria-label={t('aiImageModelLabel')}
              value={modelId}
              disabled={busy || !preferences.loaded}
              onChange={(event) => setModelId(event.target.value)}
            >
              {rememberSettings && <option value="">{te('chooseModel')}</option>}
              {rememberSettings && modelId && !selectedModel && <option value={modelId}>{te('unavailableModel')}</option>}
              {imageModels.map((model) => (
                <option key={model.id} value={model.id}>{model.displayName}</option>
              ))}
            </select>
          </div>
        </label>
      )}

      {rememberSettings && <>
        <EntityImageSettings size={preferences.settings.size} quality={preferences.settings.quality} model={selectedModel} disabled={busy || !preferences.loaded} onChange={preferences.update}/>
        <p className="entity-creation-hint" role={!preferences.loaded ? 'status' : undefined}>{te(!preferences.loaded ? 'preferencesLoading' : 'preferencesHint')}</p>
        {preferences.error != null && <div className="form-error" role="alert">{te('preferencesError')} <button type="button" onClick={preferences.retry}>{te('retryPreferences')}</button></div>}
      </>}
      <button
        type="button"
        className="secondary-button illustration-button"
        disabled={busy || !preferences.loaded || !selectedModel}
        onClick={() => void illustrate()}
      >
        {busy ? <LoaderCircle size={14} className="character-illustration-spinner" aria-hidden="true" /> : <Sparkles size={14} aria-hidden="true" />}
        {busy ? progressLabel : displayedUrl ? t('illustrationRegenerate') : t('illustrationGenerate')}
      </button>

      {error && (
        <span className="illustration-error" role="alert" title={charactersErrorDetail(error)}>
          {charactersErrorMessage(error)}
        </span>
      )}
      <span className="illustration-cost">
        {t('illustrationCost')}
      </span>

      {zoom && displayedUrl && (
        <ImageLightbox
          src={displayedUrl}
          alt={t('referenceImageAlt', { name: character.name })}
          downloadHref={displayedUrl}
          onClose={() => setZoom(false)}
        />
      )}
    </div>
  )
}
