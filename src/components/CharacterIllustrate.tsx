import { useEffect, useRef, useState } from 'react'
import { ImagePlus, LoaderCircle, Sparkles } from 'lucide-react'
import { errorMessage } from '../api/client'
import { generationApi } from '../api/endpoints'
import type { ModelInfo } from '../api/types'

const POLL_MS = 1500
const MAX_WAIT_MS = 4 * 60 * 1000

export type IllustrationState = { generationId: string; assetUrl: string }

/**
 * Prompt minh hoạ nhân vật.
 *
 * Ảnh sinh ra được dùng làm ảnh tham chiếu nhận diện nên prompt hướng tới chân
 * dung chân thực, rõ khuôn mặt, nền trung tính — không kèm giọng nói vì không
 * liên quan tới ảnh.
 */
export function buildIllustrationPrompt(character: { name: string; appearance: string }): string {
  const parts = [`Chân dung nhân vật ${character.name.trim()}`.trim()]
  const appearance = character.appearance.trim()
  if (appearance) parts.push(`Ngoại hình: ${appearance}`)
  parts.push(
    'Ảnh chân dung cận trung, khuôn mặt rõ ràng hướng về phía máy ảnh, biểu cảm trung tính, ánh sáng mềm và đều, nền trung tính đơn giản, phong cách ảnh chụp chân thực, chi tiết cao, không có chữ trong ảnh.',
  )
  return parts.join('. ')
}

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
      const created = await generationApi.create({
        modelId,
        prompt: buildIllustrationPrompt(character),
        params: { size: '1024x1024', n: 1 },
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
        <img
          className="illustration-image"
          src={state.assetUrl}
          alt={`Ảnh minh hoạ của ${character.name}`}
          loading="lazy"
        />
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
    </div>
  )
}
