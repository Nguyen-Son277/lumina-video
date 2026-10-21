import { useId, useState } from 'react'
import { KeyRound, LoaderCircle } from 'lucide-react'
import { errorMessage } from '../api/client'
import type { ImageApiStyle, Provider, VideoReferenceStyle } from '../api/types'
import { useTranslation } from '../i18n'
import { providerKeysCatalog } from '../i18n/catalogs/providerKeys'
import { shellCatalog } from '../i18n/catalogs/shell'
import { CloseButton, DialogFrame, InlineNotice } from './ui'
import { ProviderConnectionFields, type ProviderConnectionDraft } from './settings/ProviderConnectionFields'
import { useSubmitGuard } from './settings/useSubmitGuard'

/** Dữ liệu sửa provider mà modal trả về; SettingsPage gọi API rồi tải lại. */
export type ProviderEditDraft = {
  name: string
  baseUrl: string
  imageApiStyle: ImageApiStyle
  videoReferenceStyle: VideoReferenceStyle
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
  const formId = useId()
  const beginSubmit = useSubmitGuard(busy)
  const [connection, setConnection] = useState<ProviderConnectionDraft>(() => ({
    name: provider.name,
    baseUrl: provider.baseUrl,
    imageApiStyle: provider.imageApiStyle,
    videoReferenceStyle: provider.videoReferenceStyle ?? 'image_url_object',
  }))
  const { name, baseUrl } = connection
  const canSave = Boolean(name.trim() && baseUrl.trim()) && !busy
  const errorText = error ? errorMessage(error) : ''

  return (
    <DialogFrame onClose={onClose} closeDisabled={busy} panelProps={{ 'aria-label': t('editProviderTitle') }}>
        <div className="modal-header">
          <div>
            <div className="eyebrow">
              <span className="eyebrow-dot" /> {tShell('providerModalEyebrow')}
            </div>
            <h2>{t('editProviderTitle')}</h2>
          </div>
          <CloseButton onClick={onClose} disabled={busy} aria-label={t('close')} />
        </div>
        <p className="modal-description">{t('editProviderDescription')}</p>
        <form id={formId} className="modal-form" onSubmit={event => {
          event.preventDefault()
          if (!canSave || !beginSubmit()) return
          onSave({ ...connection, name: name.trim(), baseUrl: baseUrl.trim() })
        }}>
          <ProviderConnectionFields value={connection} onChange={setConnection} labels={{
            name: t('providerNameField'),
            namePlaceholder: tShell('providerNamePlaceholder'),
            baseUrl: t('baseUrlField'),
            imageApiStyle: t('imageApiStyleField'),
            imageOpenai: tShell('imageStyleOpenaiFull'),
            imageExtraBody: tShell('imageStyleExtraBodyFull'),
            videoReferenceStyle: tShell('videoRefLabel'),
            videoObject: tShell('videoRefObjectFull'),
            videoString: tShell('videoRefStringFull'),
            videoHint: tShell('videoRefHint'),
          }} />
          {!name.trim() ? (
            <InlineNotice className="form-error" role="alert">{t('providerNameRequired')}</InlineNotice>
          ) : null}
          <div className="modal-warning">
            <KeyRound size={14} /> {tShell('keyEncryptionWarning')}
          </div>
          {errorText ? <InlineNotice className="form-error" role="alert">{errorText}</InlineNotice> : null}
        </form>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>{t('cancel')}</button>
          <button
            type="submit"
            form={formId}
            className="primary-small-button"
            disabled={!canSave}
          >
            {busy ? <LoaderCircle size={15} className="spin" /> : null} {t('saveChanges')}
          </button>
        </div>
    </DialogFrame>
  )
}
