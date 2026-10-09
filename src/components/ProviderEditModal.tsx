import { useState } from 'react'
import { ChevronDown, KeyRound, LoaderCircle, X } from 'lucide-react'
import { errorMessage } from '../api/client'
import type { ImageApiStyle, Provider } from '../api/types'
import { useTranslation } from '../i18n'
import { providerKeysCatalog } from '../i18n/catalogs/providerKeys'
import { shellCatalog } from '../i18n/catalogs/shell'

/** Dữ liệu sửa provider mà modal trả về; SettingsPage gọi API rồi tải lại. */
export type ProviderEditDraft = {
  name: string
  baseUrl: string
  imageApiStyle: ImageApiStyle
}

/**
 * Hộp thoại sửa provider: tên hiển thị, Base URL và kiểu API ảnh.
 *
 * Không chứa ô API key: key được quản lý riêng trong `ProviderCredentials` để mỗi
 * key có nhãn, trạng thái và thứ tự riêng.
 */
export function ProviderEditModal({
  provider,
  onClose,
  onSave,
  busy,
  error,
}: {
  provider: Provider
  onClose: () => void
  onSave: (draft: ProviderEditDraft) => void
  busy: boolean
  /** Lỗi gốc chưa dịch — dịch ở bước render để đổi ngôn ngữ là câu lỗi đổi ngay. */
  error: unknown
}) {
  const { t } = useTranslation(providerKeysCatalog)
  const { t: tShell } = useTranslation(shellCatalog)
  const [name, setName] = useState(provider.name)
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl)
  const [imageApiStyle, setImageApiStyle] = useState<ImageApiStyle>(provider.imageApiStyle)
  const canSave = Boolean(name.trim() && baseUrl.trim()) && !busy
  const errorText = error ? errorMessage(error) : ''

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label={t('editProviderTitle')}
      >
        <div className="modal-header">
          <div>
            <div className="eyebrow">
              <span className="eyebrow-dot" /> {tShell('providerModalEyebrow')}
            </div>
            <h2>{t('editProviderTitle')}</h2>
          </div>
          <button className="close-button" onClick={onClose} aria-label={t('close')}><X size={18} /></button>
        </div>
        <p className="modal-description">{t('editProviderDescription')}</p>
        <div className="modal-form">
          <label>
            {t('providerNameField')}
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={tShell('providerNamePlaceholder')}
            />
          </label>
          <label>
            {t('baseUrlField')}
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.example.com/v1"
            />
          </label>
          <label>
            {t('imageApiStyleField')}
            <div className="select-wrap">
              <select
                value={imageApiStyle}
                onChange={(event) => setImageApiStyle(event.target.value as ImageApiStyle)}
              >
                <option value="openai">{tShell('imageStyleOpenaiFull')}</option>
                <option value="extra_body">{tShell('imageStyleExtraBodyFull')}</option>
              </select>
              <ChevronDown size={14} />
            </div>
          </label>
          {!name.trim() ? (
            <div className="form-error" role="alert">{t('providerNameRequired')}</div>
          ) : null}
          <div className="modal-warning">
            <KeyRound size={14} /> {tShell('keyEncryptionWarning')}
          </div>
          {errorText ? <div className="form-error" role="alert">{errorText}</div> : null}
        </div>
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose}>{t('cancel')}</button>
          <button
            className="primary-small-button"
            disabled={!canSave}
            onClick={() => onSave({ name: name.trim(), baseUrl: baseUrl.trim(), imageApiStyle })}
          >
            {busy ? <LoaderCircle size={15} className="spin" /> : null} {t('saveChanges')}
          </button>
        </div>
      </div>
    </div>
  )
}
