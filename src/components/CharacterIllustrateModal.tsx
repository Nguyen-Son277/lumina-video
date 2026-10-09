import { useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { characterApi } from '../api/endpoints'
import type { ProjectCharacter } from '../api/projectTypes'
import type { ModelInfo } from '../api/types'
import { useTranslation } from '../i18n'
import { charactersCatalog } from '../i18n/catalogs/characters'
import { notification, type Notification } from '../i18n/messages'
import { IllustrationPanel, type IllustrationState } from './CharacterIllustrate'
import {
  Modal,
  charactersErrorDetail,
  charactersErrorMessage,
  describeCharactersError,
  type CharactersUiError,
} from './CharacterForm'

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
  onNotify: (message: Notification) => void
}) {
  const { t } = useTranslation(charactersCatalog)
  const [attaching, setAttaching] = useState(false)
  // Descriptor lỗi: Error gốc của API, dịch lại theo ngôn ngữ lúc render.
  const [error, setError] = useState<CharactersUiError | null>(null)

  async function handleReady(state: IllustrationState) {
    setAttaching(true)
    setError(null)
    try {
      const result = await characterApi.attachReferenceFromGeneration(
        character.id,
        state.generationId,
      )
      onAttached(result.character)
      onNotify(notification('characters', 'illustrateAttachedNotify', { name: character.name }))
    } catch (cause) {
      setError(describeCharactersError(cause))
    } finally {
      setAttaching(false)
    }
  }

  return (
    <Modal title={t('illustrateModalTitle', { name: character.name })} onClose={onClose} busy={attaching}>
      <div className="modal-form">
        <p className="modal-description">
          {t('illustrateModalDescription')}
        </p>
        <div className="character-illustrate-preview">
          <p><strong>{character.appearance || t('appearanceEmpty')}</strong></p>
        </div>
        <IllustrationPanel
          character={character}
          models={models}
          onReady={(state) => void handleReady(state)}
        />
        {attaching && (
          <div className="illustration-progress" role="status">
            <LoaderCircle size={14} className="spin" /> {t('illustrateAttaching')}
          </div>
        )}
        {error && <div className="form-error" role="alert" title={charactersErrorDetail(error)}>{charactersErrorMessage(error)}</div>}
      </div>
      <div className="modal-actions">
        <button type="button" className="secondary-button" disabled={attaching} onClick={onClose}>
          {t('close')}
        </button>
      </div>
    </Modal>
  )
}
