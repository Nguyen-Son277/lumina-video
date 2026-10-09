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

const POLL_MS = 1500
const MAX_WAIT_MS = 4 * 60 * 1000

export type IllustrationState = { generationId: string; assetUrl: string }

/**
 * Mô tả tiến trình đang chạy — lưu descriptor thay vì câu chữ đã dịch, để khi
 * người dùng đổi ngôn ngữ giữa chừng thì dòng trạng thái cũng đổi theo.
 */
type IllustrationProgress = { kind: 'sending' } | { kind: 'generating'; percent: number | null }

/**
 * Ảnh tham chiếu là "phiếu thiết kế" (character sheet) gồm cận mặt và bốn góc
 * nhìn. Prompt do server dựng (`server/characters/portrait.ts`) nên giao diện chỉ
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
  onReady,
}: {
  character: { name: string; appearance: string }
  models: ModelInfo[]
  initial?: IllustrationState | null
  onReady?: (state: IllustrationState) => void
}) {
  const { t } = useTranslation(charactersCatalog)
  const imageModels = models.filter((model) => model.enabled && model.kind === 'image')

  const [modelId, setModelId] = useState(imageModels[0]?.id ?? '')
  const [state, setState] = useState<IllustrationState | null>(initial)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<IllustrationProgress | null>(null)
  // Descriptor lỗi: Error gốc hoặc khoá catalog, dịch lại theo ngôn ngữ lúc render.
  const [error, setError] = useState<CharactersUiError | null>(null)
  /** Ảnh đang xem phóng to. */
  const [zoom, setZoom] = useState(false)
  const cancelled = useRef(false)

  // Dừng vòng poll khi component bị gỡ để không setState sau khi unmount.
  useEffect(() => {
    cancelled.current = false
    return () => {
      cancelled.current = true
    }
  }, [])

  async function illustrate() {
    if (!modelId) return
    setBusy(true)
    setError(null)
    setProgress({ kind: 'sending' })
    try {
      const created = await characterApi.illustrate({
        modelId,
        name: character.name,
        appearance: character.appearance,
      })
      const generationId = created.generation.id
      const deadline = Date.now() + MAX_WAIT_MS

      while (!cancelled.current && Date.now() < deadline) {
        const current = (await generationApi.get(generationId)).generation

        if (current.status === 'succeeded') {
          const asset = current.assets[0]
          if (!asset) throw new CharactersLocalError('errorNoAsset')
          const next = { generationId, assetUrl: asset.url }
          if (cancelled.current) return
          setState(next)
          onReady?.(next)
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

        setProgress({ kind: 'generating', percent: current.progress })
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      }

      if (!cancelled.current) throw new CharactersLocalError('errorGenerationTimeout')
    } catch (cause) {
      if (!cancelled.current) setError(describeCharactersError(cause))
    } finally {
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
    <div className="illustration-panel">
      {state ? (
        <button
          type="button"
          className="illustration-zoom"
          title={t('zoomImageTitle')}
          aria-label={t('zoomImageTitle')}
          onClick={() => setZoom(true)}
        >
          <img
            className="illustration-image"
            src={state.assetUrl}
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

      {imageModels.length > 1 && (
        <label className="illustration-model">
          <span>{t('aiImageModelLabel')}</span>
          <div className="select-wrap">
            <select
              value={modelId}
              disabled={busy}
              onChange={(event) => setModelId(event.target.value)}
            >
              {imageModels.map((model) => (
                <option key={model.id} value={model.id}>{model.displayName}</option>
              ))}
            </select>
          </div>
        </label>
      )}

      <button
        type="button"
        className="secondary-button illustration-button"
        disabled={busy || !modelId}
        onClick={() => void illustrate()}
      >
        {busy ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}
        {state ? t('illustrationRegenerate') : t('illustrationGenerate')}
      </button>

      {progress && (
        <span className="illustration-progress" role="status">
          {progress.kind === 'sending'
            ? t('illustrationSending')
            : progress.percent !== null
              ? t('illustrationGeneratingPercent', { percent: progress.percent })
              : t('illustrationGenerating')}
        </span>
      )}
      {error && (
        <span className="illustration-error" role="alert" title={charactersErrorDetail(error)}>
          {charactersErrorMessage(error)}
        </span>
      )}
      <span className="illustration-cost">
        {t('illustrationCost')}
      </span>

      {zoom && state && (
        <ImageLightbox
          src={state.assetUrl}
          alt={t('referenceImageAlt', { name: character.name })}
          downloadHref={state.assetUrl}
          onClose={() => setZoom(false)}
        />
      )}
    </div>
  )
}
