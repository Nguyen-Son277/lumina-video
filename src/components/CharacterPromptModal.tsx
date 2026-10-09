import { useEffect, useState } from 'react'
import { Check, Copy, LoaderCircle } from 'lucide-react'
import { errorMessage } from '../api/client'
import { characterApi } from '../api/endpoints'
import type { ProjectCharacter } from '../api/projectTypes'
import { Modal } from './CharacterForm'

/**
 * Xuất prompt hoàn chỉnh của nhân vật để dùng ở công cụ khác.
 *
 * Prompt được ghép ở server từ đúng dữ liệu đã lưu, nên nội dung ở đây luôn khớp
 * với nhân vật đang có trong thư viện.
 */
export function CharacterPromptModal({
  character,
  onClose,
  onNotify,
}: {
  character: ProjectCharacter
  onClose: () => void
  onNotify: (message: string) => void
}) {
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let alive = true
    setLoading(true)
    characterApi
      .prompt(character.id)
      .then((result) => {
        if (alive) setPrompt(result.prompt)
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
  }, [character.id])

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt)
      setCopied(true)
      onNotify('Đã sao chép prompt nhân vật.')
    } catch {
      // Trình duyệt có thể chặn clipboard; văn bản vẫn chọn được thủ công.
      setError('Không sao chép tự động được. Hãy chọn văn bản trong ô rồi sao chép thủ công.')
    }
  }

  return (
    <Modal title={`Prompt nhân vật: ${character.name}`} onClose={onClose} busy={false}>
      <div className="modal-form">
        <p className="modal-description">
          Dán prompt này vào công cụ tạo ảnh hoặc video khác để giữ đúng ngoại hình và giọng nói
          của nhân vật.
        </p>

        {loading ? (
          <div className="empty-state"><LoaderCircle size={22} className="spin" /><h3>Đang tạo prompt…</h3></div>
        ) : (
          <textarea
            className="character-prompt-text"
            aria-label="Prompt nhân vật"
            readOnly
            value={prompt}
            rows={6}
            onFocus={(event) => event.currentTarget.select()}
          />
        )}

        {error && <div className="form-error" role="alert">{error}</div>}
      </div>
      <div className="modal-actions">
        <button type="button" className="secondary-button" onClick={onClose}>Đóng</button>
        <button type="button" className="primary-small-button" disabled={!prompt} onClick={() => void copy()}>
          {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Đã sao chép' : 'Sao chép prompt'}
        </button>
      </div>
    </Modal>
  )
}
