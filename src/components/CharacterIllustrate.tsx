import { useEffect, useRef, useState } from 'react'
import { ImagePlus, LoaderCircle, Sparkles } from 'lucide-react'
import { errorMessage } from '../api/client'
import { characterApi, generationApi } from '../api/endpoints'
import type { ModelInfo } from '../api/types'
import { ImageLightbox } from './Lightbox'

const POLL_MS = 1500
const MAX_WAIT_MS = 4 * 60 * 1000

export type IllustrationState = { generationId: string; assetUrl: string }

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
  const imageModels = models.filter((model) => model.enabled && model.kind === 'image')

  const [modelId, setModelId] = useState(imageModels[0]?.id ?? '')
  const [state, setState] = useState<IllustrationState | null>(initial)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
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
    setError('')
    setProgress('Đang gửi yêu cầu…')
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
          if (!asset) throw new Error('Tác vụ hoàn tất nhưng không có ảnh nào để dùng.')
          const next = { generationId, assetUrl: asset.url }
          if (cancelled.current) return
          setState(next)
          onReady?.(next)
          return
        }
        if (current.status === 'failed' || current.status === 'unknown') {
          throw new Error(current.errorMessage ?? 'Tạo ảnh minh hoạ thất bại.')
        }

        setProgress(
          current.progress !== null ? `Đang tạo ảnh… ${current.progress}%` : 'Đang tạo ảnh…',
        )
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      }

      if (!cancelled.current) throw new Error('Tạo ảnh quá lâu. Hãy thử lại.')
    } catch (cause) {
      if (!cancelled.current) setError(errorMessage(cause))
    } finally {
      if (!cancelled.current) {
        setBusy(false)
        setProgress('')
      }
    }
  }

  if (!imageModels.length) {
    return (
      <div className="illustration-empty">
        <ImagePlus size={16} />
        <span>Chưa có model tạo ảnh. Thêm và phân loại model ảnh trong API &amp; Models.</span>
      </div>
    )
  }

  return (
    <div className="illustration-panel">
      {state ? (
        <button
          type="button"
          className="illustration-zoom"
          title="Xem ảnh phóng to"
          aria-label="Xem ảnh phóng to"
          onClick={() => setZoom(true)}
        >
          <img
            className="illustration-image"
            src={state.assetUrl}
            alt={`Ảnh tham chiếu của ${character.name}`}
            loading="lazy"
          />
        </button>
      ) : (
        <div className="illustration-placeholder">
          <ImagePlus size={20} />
          <span>Chưa có ảnh minh hoạ</span>
        </div>
      )}

      {imageModels.length > 1 && (
        <label className="illustration-model">
          <span>Model tạo ảnh</span>
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
        {state ? 'Tạo ảnh khác' : 'Tạo ảnh minh hoạ'}
      </button>

      {progress && <span className="illustration-progress">{progress}</span>}
      {error && <span className="illustration-error" role="alert">{error}</span>}
      <span className="illustration-cost">
        Ảnh dùng API key của bạn, có thể phát sinh chi phí và sẽ xuất hiện trong Thư viện.
      </span>

      {zoom && state && (
        <ImageLightbox
          src={state.assetUrl}
          alt={`Ảnh tham chiếu của ${character.name}`}
          downloadHref={state.assetUrl}
          onClose={() => setZoom(false)}
        />
      )}
    </div>
  )
}
