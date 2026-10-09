import { useEffect, useState } from 'react'
import { Check, Copy, LoaderCircle } from 'lucide-react'
import { characterApi } from '../api/endpoints'
import type { ProjectCharacter } from '../api/projectTypes'
import { useTranslation } from '../i18n'
import { charactersCatalog } from '../i18n/catalogs/characters'
import { notification, type Notification } from '../i18n/messages'
import {
  Modal,
  charactersErrorDetail,
  charactersErrorMessage,
  describeCharactersError,
  localCharactersError,
  type CharactersUiError,
} from './CharacterForm'

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
  onNotify: (message: Notification) => void
}) {
  const { t } = useTranslation(charactersCatalog)
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(true)
  // Lỗi giữ descriptor (Error gốc hoặc khoá catalog) để dịch lại khi đổi ngôn ngữ.
  const [error, setError] = useState<CharactersUiError | null>(null)
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
        if (alive) setError(describeCharactersError(cause))
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
      onNotify(notification('characters', 'promptCopiedNotify'))
    } catch {
      // Trình duyệt có thể chặn clipboard; văn bản vẫn chọn được thủ công.
      setError(localCharactersError('promptCopyError'))
    }
  }

  return (
    <Modal title={t('promptModalTitle', { name: character.name })} onClose={onClose} busy={false}>
      <div className="modal-form">
        <p className="modal-description">
          {t('promptDescription')}
        </p>

        {loading ? (
          <div className="empty-state" role="status"><LoaderCircle size={22} className="spin" /><h3>{t('promptLoading')}</h3></div>
        ) : (
          <textarea
            className="character-prompt-text"
            aria-label={t('promptTextareaLabel')}
            readOnly
            value={prompt}
            rows={6}
            onFocus={(event) => event.currentTarget.select()}
          />
        )}

        {error && <div className="form-error" role="alert" title={charactersErrorDetail(error)}>{charactersErrorMessage(error)}</div>}
      </div>
      <div className="modal-actions">
        <button type="button" className="secondary-button" onClick={onClose}>{t('close')}</button>
        <button type="button" className="primary-small-button" disabled={!prompt} onClick={() => void copy()}>
          {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? t('promptCopied') : t('promptCopy')}
        </button>
      </div>
    </Modal>
  )
}
