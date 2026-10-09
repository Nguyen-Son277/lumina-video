import { useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { errorMessage } from '../api/client'
import { characterApi } from '../api/endpoints'
import type { ProjectCharacter } from '../api/projectTypes'
import type { ModelInfo } from '../api/types'
import { IllustrationPanel, type IllustrationState } from './CharacterIllustrate'
import { Modal } from './CharacterForm'

/**
 * Sinh ảnh minh hoạ cho nhân vật đã lưu và gắn luôn làm ảnh tham chiếu.
 *
 * Ảnh được sao chép ở server từ tác vụ tạo ảnh sang thư mục ảnh tham chiếu, nên
 * không phải tải vòng qua trình duyệt.
 */
export function CharacterIllustrateModal({
  character,
  models,
  onClose,
  onAttached,
  onNotify,
}: {
  character: ProjectCharacter
  models: ModelInfo[]
  onClose: () => void
  onAttached: (character: ProjectCharacter) => void
  onNotify: (message: string) => void
}) {
  const [attaching, setAttaching] = useState(false)
  const [error, setError] = useState('')

  async function handleReady(state: IllustrationState) {
    setAttaching(true)
    setError('')
    try {
      const result = await characterApi.attachReferenceFromGeneration(
        character.id,
        state.generationId,
      )
      onAttached(result.character)
      onNotify(`Đã tạo và gắn ảnh tham chiếu cho "${character.name}".`)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setAttaching(false)
    }
  }

  return (
    <Modal title={`Minh hoạ nhân vật: ${character.name}`} onClose={onClose} busy={attaching}>
      <div className="modal-form">
        <p className="modal-description">
          Chọn model tạo ảnh để sinh ảnh minh hoạ. Ảnh xong sẽ tự động trở thành ảnh tham chiếu của
          nhân vật (thay ảnh tham chiếu cũ nếu có).
        </p>
        <div className="character-illustrate-preview">
          <p><strong>{character.appearance || 'Chưa mô tả ngoại hình.'}</strong></p>
        </div>
        <IllustrationPanel
          character={character}
          models={models}
          onReady={(state) => void handleReady(state)}
        />
        {attaching && (
          <div className="illustration-progress">
            <LoaderCircle size={14} className="spin" /> Đang gắn ảnh vào nhân vật…
          </div>
        )}
        {error && <div className="form-error" role="alert">{error}</div>}
      </div>
      <div className="modal-actions">
        <button type="button" className="secondary-button" disabled={attaching} onClick={onClose}>
          Đóng
        </button>
      </div>
    </Modal>
  )
}
