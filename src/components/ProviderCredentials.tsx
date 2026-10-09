import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react'
import { errorMessage } from '../api/client'
import {
  providerApi,
  type ProviderCredentialInput,
  type ProviderCredentialPatch,
} from '../api/endpoints'
import type {
  CredentialPool,
  Provider,
  ProviderCredential,
  ProviderSelectionMode,
} from '../api/types'
import { useTranslation } from '../i18n'
import { providerKeysCatalog } from '../i18n/catalogs/providerKeys'
import { notification, type Notification } from '../i18n/messages'

/** Giới hạn key mỗi provider; khớp `MAX_CREDENTIALS_PER_PROVIDER` ở backend. */
export const MAX_PROVIDER_CREDENTIALS = 10

type ProviderKeysKey = keyof typeof providerKeysCatalog

/** Nhãn hiển thị của một key: nhãn người dùng đặt, nếu trống thì dùng gợi ý đã che. */
function credentialLabel(credential: ProviderCredential, fallback: string): string {
  const label = credential.label.trim()
  if (label) return label
  return credential.hint.trim() || fallback
}

/** Khoá catalog cho badge sức khoẻ của key. */
const HEALTH_KEYS: Record<ProviderCredential['healthStatus'], ProviderKeysKey> = {
  ok: 'statusOk',
  auth_failed: 'statusAuthFailed',
  cooldown: 'statusCooldown',
  unknown: 'statusUnknown',
}

/** Hậu tố class CSS theo trạng thái sức khoẻ (gạch dưới → gạch ngang). */
function healthClass(status: ProviderCredential['healthStatus']): string {
  return `status-${status.replace(/_/g, '-')}`
}

/**
 * Quản lý nhiều API key cho một provider.
 *
 * Component tự gọi `providerApi.credentials` rồi báo thay đổi lên cha qua
 * `onProvidersChanged`; nhờ vậy SettingsPage dùng được độc lập với App và App chỉ
 * cần truyền thêm callback tải lại danh sách. Bí mật đã lưu không bao giờ được
 * hiển thị: chỉ có `hint` do backend che sẵn.
 */
export function ProviderCredentials({
  provider,
  onProvidersChanged,
  onNotify,
  onNotifyError,
  onCountChange,
}: {
  provider: Provider
  /** Gọi sau khi đổi key/chế độ để App tải lại danh sách provider. */
  onProvidersChanged?: () => void
  /** Toast do component phát: descriptor đã bản địa hoá, không phải chuỗi dịch sẵn. */
  onNotify?: (message: Notification) => void
  /** Lỗi gốc chưa dịch do component phát. */
  onNotifyError?: (error: unknown) => void
  /** Báo số key hiện có cho hàng provider bên ngoài. */
  onCountChange?: (count: number) => void
}) {
  const { t } = useTranslation(providerKeysCatalog)
  const [pool, setPool] = useState<CredentialPool | null>(null)
  const [loading, setLoading] = useState(false)
  /** Lỗi gốc chưa dịch — dịch ở bước render để đổi ngôn ngữ là câu lỗi đổi ngay. */
  const [error, setError] = useState<unknown>(null)
  const [busyKeyId, setBusyKeyId] = useState<string | null>(null)
  const [testingKeyId, setTestingKeyId] = useState<string | null>(null)
  const [modeBusy, setModeBusy] = useState(false)
  const [modal, setModal] = useState<{ mode: 'add' } | { mode: 'edit'; credential: ProviderCredential } | null>(null)
  const [modalBusy, setModalBusy] = useState(false)
  const [modalError, setModalError] = useState<unknown>(null)
  const [confirming, setConfirming] = useState<ProviderCredential | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // Callback của cha giữ trong ref để effect tải dữ liệu không chạy lại mỗi lần render.
  const notifyRef = useRef(onNotify)
  const notifyErrorRef = useRef(onNotifyError)
  const countRef = useRef(onCountChange)
  const changedRef = useRef(onProvidersChanged)
  notifyRef.current = onNotify
  notifyErrorRef.current = onNotifyError
  countRef.current = onCountChange
  changedRef.current = onProvidersChanged

  const notifyKey = useCallback((key: ProviderKeysKey, params?: Record<string, string | number>) => {
    notifyRef.current?.(notification('providerKeys', key, params))
  }, [])

  const providerId = provider.id
  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await providerApi.credentials.list(providerId)
      setPool(result.pool)
      countRef.current?.(result.pool.credentials.length)
    } catch (cause) {
      setError(cause)
    } finally {
      setLoading(false)
    }
  }, [providerId])

  useEffect(() => {
    void load()
  }, [load])

  const credentials = pool?.credentials ?? []
  const sorted = useMemo(
    () => [...credentials].sort((a, b) => a.position - b.position),
    [credentials],
  )
  const limitReached = sorted.length >= MAX_PROVIDER_CREDENTIALS
  const activeCooldown = sorted.some(
    (credential) => credential.cooldownUntil !== null && credential.cooldownUntil > now,
  )

  // Đếm ngược cooldown: chỉ chạy đồng hồ khi thật sự có key đang tạm nghỉ.
  useEffect(() => {
    if (!activeCooldown) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [activeCooldown])

  const replaceCredential = useCallback((updated: ProviderCredential) => {
    setPool((current) =>
      current
        ? {
            ...current,
            credentials: current.credentials.map((item) =>
              item.id === updated.id ? updated : item,
            ),
          }
        : current,
    )
  }, [])

  async function saveCredential(input: ProviderCredentialInput | ProviderCredentialPatch) {
    // Sửa key mà không đổi gì thì đóng luôn, tránh gửi PATCH rỗng.
    if (modal?.mode === 'edit' && Object.keys(input).length === 0) {
      setModal(null)
      return
    }
    setModalBusy(true)
    setModalError(null)
    try {
      if (modal?.mode === 'edit') {
        const result = await providerApi.credentials.update(providerId, modal.credential.id, input)
        replaceCredential(result.credential)
        notifyKey('notifyKeyUpdated')
      } else {
        const result = await providerApi.credentials.create(providerId, input as ProviderCredentialInput)
        setPool((current) =>
          current
            ? { ...current, credentials: [...current.credentials, result.credential] }
            : current,
        )
        countRef.current?.(sorted.length + 1)
        notifyKey('notifyKeyAdded')
      }
      setModal(null)
      changedRef.current?.()
    } catch (cause) {
      setModalError(cause)
    } finally {
      setModalBusy(false)
    }
  }

  async function toggleEnabled(credential: ProviderCredential) {
    setBusyKeyId(credential.id)
    setError(null)
    try {
      const result = await providerApi.credentials.update(providerId, credential.id, {
        enabled: !credential.enabled,
      })
      replaceCredential(result.credential)
    } catch (cause) {
      setError(cause)
      notifyErrorRef.current?.(cause)
    } finally {
      setBusyKeyId(null)
    }
  }

  async function moveCredential(credential: ProviderCredential, direction: -1 | 1) {
    const ids = sorted.map((item) => item.id)
    const index = ids.indexOf(credential.id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= ids.length) return
    ;[ids[index], ids[target]] = [ids[target], ids[index]]
    setBusyKeyId(credential.id)
    setError(null)
    try {
      const result = await providerApi.credentials.reorder(providerId, ids)
      setPool((current) => (current ? { ...current, credentials: result.credentials } : current))
      notifyKey('notifyKeyReordered')
    } catch (cause) {
      setError(cause)
      notifyErrorRef.current?.(cause)
    } finally {
      setBusyKeyId(null)
    }
  }

  async function testCredential(credential: ProviderCredential) {
    setTestingKeyId(credential.id)
    setError(null)
    try {
      const result = await providerApi.credentials.test(providerId, credential.id)
      replaceCredential(result.credential)
      notifyKey(result.ok ? 'notifyKeyTestOk' : 'notifyKeyTestFailed')
    } catch (cause) {
      setError(cause)
      notifyErrorRef.current?.(cause)
    } finally {
      setTestingKeyId(null)
    }
  }

  async function removeCredential(credential: ProviderCredential) {
    setBusyKeyId(credential.id)
    setError(null)
    try {
      await providerApi.credentials.remove(providerId, credential.id)
      const next = sorted.filter((item) => item.id !== credential.id)
      setPool((current) => (current ? { ...current, credentials: next } : current))
      countRef.current?.(next.length)
      notifyKey('notifyKeyRemoved')
      setConfirming(null)
      changedRef.current?.()
    } catch (cause) {
      setError(cause)
      notifyErrorRef.current?.(cause)
    } finally {
      setBusyKeyId(null)
    }
  }

  async function changeMode(mode: ProviderSelectionMode) {
    if (!pool || pool.selectionMode === mode) return
    setModeBusy(true)
    setError(null)
    try {
      await providerApi.update(providerId, { selectionMode: mode })
      setPool((current) => (current ? { ...current, selectionMode: mode } : current))
      notifyKey('notifyModeChanged')
      changedRef.current?.()
    } catch (cause) {
      setError(cause)
      notifyErrorRef.current?.(cause)
    } finally {
      setModeBusy(false)
    }
  }

  const errorText = error ? errorMessage(error) : ''
  const mode = pool?.selectionMode ?? provider.selectionMode ?? 'failover'

  return (
    <div className="provider-credentials-panel" aria-label={t('keysAria', { name: provider.name })}>
      <div className="credentials-toolbar">
        <div className="credentials-heading">
          <KeyRound size={15} />
          <div>
            <strong>{t('panelTitle')}</strong>
            <span>{t('panelDescription')}</span>
          </div>
        </div>
        <button
          className="row-action"
          type="button"
          onClick={() => { setModalError(null); setModal({ mode: 'add' }) }}
          disabled={limitReached || loading}
          title={limitReached ? t('limitReached', { max: MAX_PROVIDER_CREDENTIALS }) : t('addKey')}
        >
          <Plus size={14} /> {t('addKey')}
        </button>
      </div>

      {pool ? (
        <div className="credentials-mode">
          <label className="credentials-mode-field">
            <span>{t('modeLabel')}</span>
            <div className="select-wrap">
              <select
                aria-label={t('modeAria', { name: provider.name })}
                value={mode}
                disabled={modeBusy || loading}
                onChange={(event) => void changeMode(event.target.value as ProviderSelectionMode)}
              >
                <option value="failover">{t('modeFailover')}</option>
                <option value="round_robin">{t('modeRoundRobin')}</option>
              </select>
              <ChevronDown size={13} />
            </div>
          </label>
          <p className="credentials-mode-hint">
            {mode === 'round_robin' ? t('modeRoundRobinHint') : t('modeFailoverHint')}
          </p>
        </div>
      ) : null}

      {errorText ? <div className="form-error" role="alert">{errorText}</div> : null}

      {!pool && loading ? (
        <div className="credentials-loading" role="status">
          <LoaderCircle size={15} className="spin" /> {t('loadingKeys')}
        </div>
      ) : sorted.length ? (
        <ul className="credential-list">
          {sorted.map((credential, index) => {
            const label = credentialLabel(credential, t('untitledKey'))
            const busy = busyKeyId === credential.id || testingKeyId === credential.id
            const remaining =
              credential.cooldownUntil && credential.cooldownUntil > now
                ? Math.max(1, Math.ceil((credential.cooldownUntil - now) / 1000))
                : 0
            return (
              <li className="credential-row" key={credential.id}>
                <div className="credential-order">
                  <button
                    type="button"
                    onClick={() => void moveCredential(credential, -1)}
                    disabled={busy || index === 0}
                    aria-label={t('moveUpAria', { label })}
                    title={t('moveUp')}
                  >
                    <ChevronUp size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void moveCredential(credential, 1)}
                    disabled={busy || index === sorted.length - 1}
                    aria-label={t('moveDownAria', { label })}
                    title={t('moveDown')}
                  >
                    <ChevronDown size={13} />
                  </button>
                </div>

                <div className="credential-main">
                  <div className="credential-name-row">
                    <strong>{label}</strong>
                    <span className={`credential-status ${healthClass(credential.healthStatus)}`}>
                      {t(HEALTH_KEYS[credential.healthStatus])}
                    </span>
                  </div>
                  <div className="credential-meta">
                    <code className="credential-hint">
                      {credential.hint.trim() || t('maskedHintPlaceholder')}
                    </code>
                    {remaining > 0 ? (
                      <span className="credential-cooldown">
                        {t('cooldownRemaining', { seconds: remaining })}
                      </span>
                    ) : null}
                  </div>
                </div>

                <label className="credential-toggle">
                  <input
                    type="checkbox"
                    checked={credential.enabled}
                    disabled={busy}
                    onChange={() => void toggleEnabled(credential)}
                    aria-label={
                      credential.enabled
                        ? t('disableKeyAria', { label })
                        : t('enableKeyAria', { label })
                    }
                  />
                  <span>{credential.enabled ? t('enabledBadge') : t('disabledBadge')}</span>
                </label>

                <div className="credential-actions">
                  <button
                    type="button"
                    className="credential-action"
                    disabled={busy}
                    onClick={() => void testCredential(credential)}
                    aria-label={t('testKeyAria', { label })}
                    title={t('testKey')}
                  >
                    {testingKeyId === credential.id
                      ? <LoaderCircle size={14} className="spin" />
                      : <RefreshCw size={14} />}
                    <span>{testingKeyId === credential.id ? t('testingKey') : t('testKey')}</span>
                  </button>
                  <button
                    type="button"
                    className="credential-action"
                    disabled={busy}
                    onClick={() => { setModalError(null); setModal({ mode: 'edit', credential }) }}
                    aria-label={t('editKeyAria', { label })}
                    title={t('editKey')}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    className="credential-action danger"
                    disabled={busy}
                    onClick={() => setConfirming(credential)}
                    aria-label={t('deleteKeyAria', { label })}
                    title={t('deleteKey')}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      ) : (
        <div className="credentials-empty">
          <KeyRound size={20} />
          <strong>{t('emptyTitle')}</strong>
          <span>{t('emptyCaption')}</span>
          <button
            className="primary-small-button"
            type="button"
            onClick={() => { setModalError(null); setModal({ mode: 'add' }) }}
            disabled={limitReached}
          >
            <Plus size={14} /> {t('addKey')}
          </button>
        </div>
      )}

      {limitReached ? (
        <p className="credentials-limit" role="note">
          {t('limitReached', { max: MAX_PROVIDER_CREDENTIALS })}
        </p>
      ) : null}

      {modal ? (
        <CredentialEditModal
          mode={modal.mode}
          credential={modal.mode === 'edit' ? modal.credential : undefined}
          fallbackLabel={t('untitledKey')}
          busy={modalBusy}
          error={modalError}
          onClose={() => setModal(null)}
          onSave={(input) => void saveCredential(input)}
        />
      ) : null}

      {confirming ? (
        <DeleteCredentialDialog
          credential={confirming}
          fallbackLabel={t('untitledKey')}
          busy={busyKeyId === confirming.id}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void removeCredential(confirming)}
        />
      ) : null}
    </div>
  )
}

/**
 * Hộp thoại thêm/sửa một API key.
 *
 * Khi sửa, ô bí mật để trống nghĩa là giữ nguyên bí mật hiện tại — không bao giờ
 * hiển thị lại key đã lưu.
 */
export function CredentialEditModal({
  mode,
  credential,
  fallbackLabel,
  busy,
  error,
  onClose,
  onSave,
}: {
  mode: 'add' | 'edit'
  credential?: ProviderCredential
  fallbackLabel: string
  busy: boolean
  /** Lỗi gốc chưa dịch — dịch ở bước render. */
  error: unknown
  onClose: () => void
  onSave: (input: ProviderCredentialInput | ProviderCredentialPatch) => void
}) {
  const { t } = useTranslation(providerKeysCatalog)
  const isEdit = mode === 'edit'
  const [label, setLabel] = useState(credential?.label ?? '')
  const [apiKey, setApiKey] = useState('')
  const canSave = (isEdit || apiKey.trim() !== '') && !busy
  const errorText = error ? errorMessage(error) : ''
  const title = isEdit ? t('editKeyTitle') : t('addKeyTitle')

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div className="modal-card" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <div>
            <div className="eyebrow"><span className="eyebrow-dot" /> {t('panelTitle')}</div>
            <h2>{title}</h2>
          </div>
          <button className="close-button" onClick={onClose} aria-label={t('close')}><X size={18} /></button>
        </div>
        <p className="modal-description">
          {isEdit ? t('editKeyDescription') : t('addKeyDescription')}
        </p>
        <div className="modal-form">
          <label>
            {t('labelField')}
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={isEdit ? credential ? credentialLabel(credential, fallbackLabel) : '' : t('labelPlaceholder')}
            />
          </label>
          <label>
            {t('secretField')}
            <div className="key-input">
              <KeyRound size={15} />
              <input
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={isEdit ? t('secretPlaceholderKeep') : t('secretPlaceholderNew')}
              />
            </div>
          </label>
          <div className="modal-warning">
            <KeyRound size={14} /> {t('secretNote')}
          </div>
          {errorText ? <div className="form-error" role="alert">{errorText}</div> : null}
        </div>
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose}>{t('cancel')}</button>
          <button
            className="primary-small-button"
            disabled={!canSave}
            onClick={() => {
              const trimmedLabel = label.trim()
              const trimmedKey = apiKey.trim()
              const payload: ProviderCredentialPatch = {}
              if (!isEdit) {
                payload.label = trimmedLabel || undefined
                payload.apiKey = trimmedKey
              } else {
                if (trimmedLabel !== (credential?.label ?? '')) payload.label = trimmedLabel
                if (trimmedKey) payload.apiKey = trimmedKey
              }
              onSave(payload)
            }}
          >
            {busy ? <LoaderCircle size={15} className="spin" /> : null} {isEdit ? t('saveChanges') : t('saveKey')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Xác nhận xoá một key: thao tác không thể hoàn tác nên luôn hỏi trước. */
export function DeleteCredentialDialog({
  credential,
  fallbackLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  credential: ProviderCredential
  fallbackLabel: string
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation(providerKeysCatalog)
  const label = credentialLabel(credential, fallbackLabel)

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel() }}
    >
      <div className="modal-card" role="dialog" aria-modal="true" aria-label={t('deleteConfirmTitle')}>
        <div className="modal-header">
          <div>
            <div className="eyebrow"><span className="eyebrow-dot" /> {t('panelTitle')}</div>
            <h2>{t('deleteConfirmTitle')}</h2>
          </div>
          <button className="close-button" onClick={onCancel} aria-label={t('close')}><X size={18} /></button>
        </div>
        <p className="modal-description">{t('deleteConfirmBody')}</p>
        <div className="credential-confirm-target">{label}</div>
        <div className="modal-actions">
          <button className="secondary-button" onClick={onCancel}>{t('cancel')}</button>
          <button className="primary-small-button" disabled={busy} onClick={onConfirm}>
            {busy ? <LoaderCircle size={15} className="spin" /> : null} {t('confirmDelete')}
          </button>
        </div>
      </div>
    </div>
  )
}
