import { useCallback, useState } from 'react'
import {
  BrainCircuit,
  ChevronDown,
  Image as ImageIcon,
  KeyRound,
  Layers3,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
  Video,
  X,
} from 'lucide-react'
import type { ImageApiStyle, ModelInfo, ModelKind, Provider } from '../api/types'
import { errorMessage } from '../api/client'
import { providerApi } from '../api/endpoints'
import { useTranslation } from '../i18n'
import { shellCatalog, type ShellCatalogKey } from '../i18n/catalogs/shell'
import { providerKeysCatalog } from '../i18n/catalogs/providerKeys'
import { notification, type Notification } from '../i18n/messages'
import { ProviderCredentials } from '../components/ProviderCredentials'
import { ProviderEditModal, type ProviderEditDraft } from '../components/ProviderEditModal'

type ProviderKeysKey = keyof typeof providerKeysCatalog

/**
 * Khoá catalog cho nhãn hiển thị của từng phân loại model.
 * Chỉ lưu khoá (không lưu chuỗi đã dịch) để nhãn dịch lại khi đổi ngôn ngữ.
 */
const MODEL_KIND_KEYS: Record<ModelKind, ShellCatalogKey> = {
  image: 'modelKindImage',
  video: 'modelKindVideo',
  llm: 'modelKindLlm',
  unclassified: 'modelKindUnclassified',
}

const MODEL_KIND_ORDER: ModelKind[] = ['image', 'video', 'llm', 'unclassified']

/** Icon của từng phân loại; `llm` dùng cho model văn bản (chat, kịch bản). */
function ModelKindIcon({ kind, size = 15 }: { kind: ModelKind; size?: number }) {
  if (kind === 'image') return <ImageIcon size={size} />
  if (kind === 'video') return <Video size={size} />
  if (kind === 'llm') return <BrainCircuit size={size} />
  return <Layers3 size={size} />
}

/** Hậu tố class CSS theo phân loại, dùng cho badge trong Model catalog. */
function kindClass(kind: ModelKind): string {
  if (kind === 'image') return 'image-kind'
  if (kind === 'video') return 'video-kind'
  if (kind === 'llm') return 'llm-kind'
  return 'unknown-kind'
}

export function ProviderModal({ onClose, onSave, busy, error }: {
  onClose: () => void
  onSave: (draft: { name: string; baseUrl: string; apiKey: string; imageApiStyle: ImageApiStyle }) => void
  busy: boolean
  /** Lỗi gốc chưa dịch — dịch ở bước render để đổi ngôn ngữ là câu lỗi đổi ngay. */
  error: unknown
}) {
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [imageApiStyle, setImageApiStyle] = useState<ImageApiStyle>('openai')
  const canSave = Boolean(name.trim() && baseUrl.trim() && apiKey.trim()) && !busy
  const { t } = useTranslation(shellCatalog)
  const errorText = error ? errorMessage(error) : ''

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="modal-card">
        <div className="modal-header">
          <div>
            <div className="eyebrow"><span className="eyebrow-dot" /> {t('providerModalEyebrow')}</div>
            <h2>{t('addProvider')}</h2>
          </div>
          <button className="close-button" onClick={onClose} aria-label={t('close')}><X size={18} /></button>
        </div>
        <p className="modal-description">
          {t('providerModalDescription')}
        </p>
        <div className="modal-form">
          <label>
            {t('displayNameLabel')}
            <input
              placeholder={t('providerNamePlaceholder')}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            {t('baseUrlLabel')}
            <input
              placeholder="https://api.example.com/v1"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </label>
          <label>
            {t('imageApiStyleLabel')}
            <div className="select-wrap">
              <select
                value={imageApiStyle}
                onChange={(event) => setImageApiStyle(event.target.value as ImageApiStyle)}
              >
                <option value="openai">{t('imageStyleOpenaiFull')}</option>
                <option value="extra_body">{t('imageStyleExtraBodyFull')}</option>
              </select>
              <ChevronDown size={14} />
            </div>
          </label>
          <label>
            {t('apiKeyLabel')}
            <div className="key-input">
              <KeyRound size={15} />
              <input
                type="password"
                placeholder="sk-••••••••••••••••"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </div>
          </label>
          <div className="modal-warning">
            <KeyRound size={14} /> {t('keyEncryptionWarning')}
          </div>
          {errorText && <div className="form-error" role="alert">{errorText}</div>}
        </div>
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose}>{t('cancel')}</button>
          <button
            className="primary-small-button"
            disabled={!canSave}
            onClick={() => onSave({ name, baseUrl, apiKey, imageApiStyle })}
          >
            {busy ? <LoaderCircle size={15} className="spin" /> : null} {t('saveProvider')}
          </button>
        </div>
      </div>
    </div>
  )
}

export function ModelModal({ providers, onClose, onSave, onNeedProvider, busy, error }: {
  providers: Provider[]
  onClose: () => void
  onSave: (draft: { providerId: string; modelId: string; displayName: string; kind: ModelKind }) => void
  onNeedProvider: () => void
  busy: boolean
  /** Lỗi gốc chưa dịch — dịch ở bước render để đổi ngôn ngữ là câu lỗi đổi ngay. */
  error: unknown
}) {
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '')
  const [modelId, setModelId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [kind, setKind] = useState<ModelKind>('image')
  const canSave = Boolean(providerId && modelId.trim()) && !busy
  const { t } = useTranslation(shellCatalog)
  const errorText = error ? errorMessage(error) : ''

  if (!providers.length) {
    return (
      <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
        <div className="modal-card">
          <div className="modal-header">
            <div><div className="eyebrow"><span className="eyebrow-dot" /> {t('modelEyebrow')}</div><h2>{t('noProviderTitle')}</h2></div>
            <button className="close-button" onClick={onClose} aria-label={t('close')}><X size={18} /></button>
          </div>
          <p className="modal-description">{t('noProviderDescription')}</p>
          <div className="modal-actions">
            <button className="secondary-button" onClick={onClose}>{t('cancel')}</button>
            <button className="primary-small-button" onClick={onNeedProvider}>{t('addProvider')}</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="modal-card">
        <div className="modal-header">
          <div><div className="eyebrow"><span className="eyebrow-dot" /> {t('modelEyebrow')}</div><h2>{t('addModel')}</h2></div>
          <button className="close-button" onClick={onClose} aria-label={t('close')}><X size={18} /></button>
        </div>
        <p className="modal-description">
          {t('modelModalDescription')}
        </p>
        <div className="modal-form">
          <label>
            {t('providerLabel')}
            <div className="select-wrap">
              <select value={providerId} onChange={(event) => setProviderId(event.target.value)}>
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>{provider.name}</option>
                ))}
              </select>
              <ChevronDown size={14} />
            </div>
          </label>
          <label>
            {t('modelIdLabel')}
            <input
              placeholder={t('modelIdPlaceholder')}
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
            />
          </label>
          <label>
            {t('displayNameOptionalLabel')}
            <input
              placeholder={t('displayNamePlaceholder')}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
          <div className="kind-picker">
            {MODEL_KIND_ORDER.map((option) => (
              <button
                key={option}
                className={kind === option ? 'active' : ''}
                onClick={() => setKind(option)}
                type="button"
              >
                <ModelKindIcon kind={option} />
                {t(MODEL_KIND_KEYS[option])}
              </button>
            ))}
          </div>
          {errorText && <div className="form-error" role="alert">{errorText}</div>}
        </div>
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose}>{t('cancel')}</button>
          <button
            className="primary-small-button"
            disabled={!canSave}
            onClick={() => onSave({ providerId, modelId, displayName, kind })}
          >
            {busy ? <LoaderCircle size={15} className="spin" /> : null} {t('saveModel')}
          </button>
        </div>
      </div>
    </div>
  )
}

export function SettingsPage({
  providers,
  models,
  onAddProvider,
  onAddModel,
  onRemoveProvider,
  onUpdateProvider,
  onRemoveModel,
  onUpdateModel,
  onTest,
  onSync,
  busyId,
  onProvidersChanged,
  onNotify,
  onNotifyError,
}: {
  providers: Provider[]
  models: ModelInfo[]
  onAddProvider: () => void
  onAddModel: () => void
  onRemoveProvider: (id: string) => void
  onUpdateProvider: (id: string, patch: { imageApiStyle: ImageApiStyle }) => void
  onRemoveModel: (id: string) => void
  onUpdateModel: (id: string, patch: { kind?: ModelKind; enabled?: boolean }) => void
  onTest: (id: string) => void
  onSync: (id: string) => void
  busyId: string | null
  /** Tuỳ chọn: App truyền vào để tải lại danh sách provider sau khi sửa key/provider. */
  onProvidersChanged?: () => void
  /** Tuỳ chọn: nhận descriptor thông báo đã bản địa hoá (namespace `providerKeys`). */
  onNotify?: (message: Notification) => void
  /** Tuỳ chọn: nhận lỗi gốc chưa dịch từ các thao tác key/provider. */
  onNotifyError?: (error: unknown) => void
}) {
  const [activeTab, setActiveTab] = useState<'providers' | 'models'>('providers')
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>(null)
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null)
  const [providerEditBusy, setProviderEditBusy] = useState(false)
  /** Lỗi gốc chưa dịch của modal sửa provider; dịch ở bước render. */
  const [providerEditError, setProviderEditError] = useState<unknown>(null)
  /** Bản chỉnh sửa cục bộ để UI tự cập nhật ngay cả khi App chưa tải lại. */
  const [overrides, setOverrides] = useState<Record<string, Partial<Provider>>>({})
  /** Số key đã tải của từng provider, do bảng key báo lên. */
  const [keyCounts, setKeyCounts] = useState<Record<string, number>>({})
  const { t } = useTranslation(shellCatalog)
  const { t: tKeys } = useTranslation(providerKeysCatalog)

  const notifyProviderKeys = useCallback(
    (key: ProviderKeysKey, params?: Record<string, string | number>) => {
      onNotify?.(notification('providerKeys', key, params))
    },
    [onNotify],
  )

  const handleKeyCount = useCallback((id: string, count: number) => {
    setKeyCounts((current) => (current[id] === count ? current : { ...current, [id]: count }))
  }, [])

  async function saveProviderEdit(draft: ProviderEditDraft) {
    if (!editingProvider) return
    setProviderEditBusy(true)
    setProviderEditError(null)
    try {
      const result = await providerApi.update(editingProvider.id, draft)
      setOverrides((current) => ({ ...current, [editingProvider.id]: result.provider }))
      setEditingProvider(null)
      notifyProviderKeys('notifyProviderUpdated')
      onProvidersChanged?.()
    } catch (cause) {
      setProviderEditError(cause)
    } finally {
      setProviderEditBusy(false)
    }
  }

  const viewProviders = providers.map((provider) =>
    overrides[provider.id] ? { ...provider, ...overrides[provider.id] } : provider,
  )

  return (
    <div className="page-content settings-page">
      <section className="page-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-dot" /> {t('settingsEyebrow')}</div>
          <h1>{t('settingsTitleLead')}<em>{t('settingsTitleAccent')}</em></h1>
          <p>{t('settingsDescription')}</p>
        </div>
        <div className="heading-actions">
          <button className="secondary-button" onClick={onAddModel}><Layers3 size={16} /> {t('addModel')}</button>
          <button className="primary-small-button" onClick={onAddProvider}><Plus size={16} /> {t('addProvider')}</button>
        </div>
      </section>

      <div className="settings-tabs">
        <button className={activeTab === 'providers' ? 'active' : ''} onClick={() => setActiveTab('providers')}>
          <KeyRound size={16} /> {t('tabProviders')} <span className="tab-count">{providers.length}</span>
        </button>
        <button className={activeTab === 'models' ? 'active' : ''} onClick={() => setActiveTab('models')}>
          <Layers3 size={16} /> {t('tabModelCatalog')} <span className="tab-count">{models.length}</span>
        </button>
      </div>

      {activeTab === 'providers' ? (
        <>
          <div className="notice-banner">
            <KeyRound size={18} />
            <div>
              <strong>{t('noticeKeyEncryptedTitle')}</strong>
              <p>{t('noticeKeyEncryptedCaption')}</p>
            </div>
          </div>

          {viewProviders.length ? (
            <div className="provider-list">
              {viewProviders.map((provider) => {
                const keyCount = keyCounts[provider.id] ?? provider.credentials?.length
                const expanded = expandedProviderId === provider.id
                return (
                  <div className="provider-item" key={provider.id}>
                    <div className="provider-row">
                      <div className="provider-brand">{provider.name.slice(0, 1).toUpperCase()}</div>
                      <div className="provider-main">
                        <div className="provider-name-row">
                          <strong>{provider.name}</strong>
                          {provider.status === 'connected' ? (
                            <span className="connected-pill"><span /> {t('providerConnected')}</span>
                          ) : provider.status === 'error' ? (
                            <span className="not-connected-pill" title={provider.lastError ?? ''}>{t('providerError')}</span>
                          ) : (
                            <span className="not-connected-pill">{t('providerUnchecked')}</span>
                          )}
                        </div>
                        <span className="provider-url">{provider.baseUrl}</span>
                      </div>
                      <div className="provider-model-count">
                        <strong>{provider.modelCount}</strong>
                        <span>{t('modelsCountLabel')}</span>
                      </div>
                      <div className="provider-key"><KeyRound size={13} />{provider.keyHint}</div>
                      <label className="provider-image-style">
                        <span>{t('imageApiColumnLabel')}</span>
                        <div className="select-wrap">
                          <select
                            aria-label={t('imageApiStyleAria', { name: provider.name })}
                            value={provider.imageApiStyle}
                            disabled={busyId === provider.id}
                            onChange={(event) =>
                              onUpdateProvider(provider.id, {
                                imageApiStyle: event.target.value as ImageApiStyle,
                              })
                            }
                          >
                            <option value="openai">{t('imageStyleOpenaiShort')}</option>
                            <option value="extra_body">{t('imageStyleExtraBodyShort')}</option>
                          </select>
                          <ChevronDown size={13} />
                        </div>
                      </label>
                      <button
                        className="row-action keys-toggle"
                        type="button"
                        aria-expanded={expanded}
                        aria-label={tKeys('keysAria', { name: provider.name })}
                        title={tKeys('keysAria', { name: provider.name })}
                        onClick={() =>
                          setExpandedProviderId((current) =>
                            current === provider.id ? null : provider.id,
                          )
                        }
                      >
                        <KeyRound size={15} /> {tKeys('panelTitle')}
                        {typeof keyCount === 'number' ? (
                          <span className="keys-count">{keyCount}</span>
                        ) : null}
                      </button>
                      <button
                        className="row-action"
                        type="button"
                        aria-label={tKeys('editProviderAria', { name: provider.name })}
                        title={tKeys('editProvider')}
                        disabled={busyId === provider.id}
                        onClick={() => {
                          setProviderEditError(null)
                          setEditingProvider(provider)
                        }}
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        className="row-action"
                        onClick={() => onSync(provider.id)}
                        disabled={busyId === provider.id}
                        title={t('syncModelsTitle')}
                      >
                        <Layers3 size={15} /> {t('sync')}
                      </button>
                      <button
                        className="row-action"
                        onClick={() => onTest(provider.id)}
                        disabled={busyId === provider.id}
                      >
                        {busyId === provider.id
                          ? <LoaderCircle size={15} className="spin" />
                          : <RefreshCw size={15} />} {t('test')}
                      </button>
                      <button
                        className="row-more"
                        onClick={() => onRemoveProvider(provider.id)}
                        aria-label={t('removeProvider')}
                        title={t('removeProvider')}
                        disabled={busyId === provider.id}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                    {expanded ? (
                      <ProviderCredentials
                        provider={provider}
                        onProvidersChanged={onProvidersChanged}
                        onNotify={onNotify}
                        onNotifyError={onNotifyError}
                        onCountChange={(count) => handleKeyCount(provider.id, count)}
                      />
                    ) : null}
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="empty-settings">
              <KeyRound size={24} />
              <strong>{t('providersEmptyTitle')}</strong>
              <span>{t('providersEmptyCaption')}</span>
              <button className="primary-small-button" onClick={onAddProvider}>
                <Plus size={15} /> {t('addProvider')}
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="model-catalog">
          <div className="catalog-note">
            <Settings2 size={17} />
            <span>
              {t('catalogNote')}
            </span>
          </div>
          {models.length ? (
            models.map((model) => (
              <div className="model-row" key={model.id}>
                <div className={`model-kind ${kindClass(model.kind)}`}>
                  <ModelKindIcon kind={model.kind} />
                </div>
                <div className="model-details">
                  <strong>{model.displayName}</strong>
                  <span>{model.providerName} · {model.modelId}</span>
                </div>
                <div className="select-wrap model-kind-select">
                  <select
                    value={model.kind}
                    onChange={(event) => onUpdateModel(model.id, { kind: event.target.value as ModelKind })}
                    aria-label={t('classifyModelAria', { name: model.displayName })}
                  >
                    {MODEL_KIND_ORDER.map((option) => (
                      <option key={option} value={option}>{t(MODEL_KIND_KEYS[option])}</option>
                    ))}
                  </select>
                  <ChevronDown size={14} />
                </div>
                <button
                  className="model-edit"
                  onClick={() => onRemoveModel(model.id)}
                  aria-label={t('removeModelAria', { name: model.displayName })}
                >
                  <Trash2 size={15} /> {t('delete')}
                </button>
              </div>
            ))
          ) : (
            <div className="empty-settings">
              <Layers3 size={24} />
              <strong>{t('modelsEmptyTitle')}</strong>
              <span>{t('modelsEmptyCaption')}</span>
              <button className="primary-small-button" onClick={onAddModel}>
                <Plus size={15} /> {t('addModel')}
              </button>
            </div>
          )}
        </div>
      )}

      {editingProvider ? (
        <ProviderEditModal
          provider={editingProvider}
          onClose={() => setEditingProvider(null)}
          onSave={(draft) => void saveProviderEdit(draft)}
          busy={providerEditBusy}
          error={providerEditError}
        />
      ) : null}
    </div>
  )
}

