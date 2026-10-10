import { useCallback, useEffect, useState } from 'react'
import {
  BrainCircuit,
  ChevronDown,
  Coins,
  Image as ImageIcon,
  KeyRound,
  Layers3,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  Trash2,
  Video,
  X,
} from 'lucide-react'
import type { ImageApiStyle, ModelInfo, ModelKind, Provider } from '../api/types'
import { errorMessage } from '../api/client'
import { providerApi } from '../api/endpoints'
import { formatNumber, useTranslation } from '../i18n'
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

/**
 * Đơn giá model được nhập ngay trong hàng model của Model catalog.
 *
 * Provider không trả giá trong API nên người dùng tự nhập: LLM theo 1K token vào/ra,
 * ảnh/video theo lượt. Bản nháp giữ dạng chuỗi để gõ tự do, chỉ đổi sang số khi lưu.
 */
type PriceDraft = {
  priceUnit: string
  priceInput1k: string
  priceOutput1k: string
  currency: string
}

type PriceStatus = { state: 'saving' | 'saved' | 'error'; message?: string }

const draftFromModel = (model: ModelInfo): PriceDraft => ({
  priceUnit: model.priceUnit == null ? '' : String(model.priceUnit),
  priceInput1k: model.priceInput1k == null ? '' : String(model.priceInput1k),
  priceOutput1k: model.priceOutput1k == null ? '' : String(model.priceOutput1k),
  currency: model.priceCurrency || 'USD',
})

/** '' → xoá đơn giá (null); số âm/không hợp lệ → undefined (báo lỗi). */
function parsePrice(raw: string): number | null | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const value = Number(trimmed.replace(',', '.'))
  if (!Number.isFinite(value) || value < 0) return undefined
  return value
}

/** Model chữ tính theo token; các loại còn lại tính theo lượt. */
const usesTokenPricing = (kind: ModelKind): boolean => kind === 'llm'

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
  initialTab = 'providers',
}: {
  providers: Provider[]
  models: ModelInfo[]
  onAddProvider: () => void
  onAddModel: () => void
  onRemoveProvider: (id: string) => void
  onUpdateProvider: (id: string, patch: { imageApiStyle: ImageApiStyle }) => void
  onRemoveModel: (id: string) => void
  onUpdateModel: (
    id: string,
    patch: {
      kind?: ModelKind
      enabled?: boolean
      priceUnit?: number | null
      priceInput1k?: number | null
      priceOutput1k?: number | null
      priceCurrency?: string
    },
  ) => Promise<boolean>
  onTest: (id: string) => void
  onSync: (id: string) => void
  busyId: string | null
  /** Tuỳ chọn: App truyền vào để tải lại danh sách provider sau khi sửa key/provider. */
  onProvidersChanged?: () => void
  /** Tuỳ chọn: nhận descriptor thông báo đã bản địa hoá (namespace `providerKeys`). */
  onNotify?: (message: Notification) => void
  /** Tuỳ chọn: nhận lỗi gốc chưa dịch từ các thao tác key/provider. */
  onNotifyError?: (error: unknown) => void
  /** Tab mở đầu tiên; lối tắt từ Nhật ký sử dụng mở thẳng Model catalog. */
  initialTab?: 'providers' | 'models'
}) {
  const [activeTab, setActiveTab] = useState<'providers' | 'models'>(initialTab)
  /** Hàng model đang mở khối đơn giá (chỉ một hàng một lúc). */
  const [priceOpenId, setPriceOpenId] = useState<string | null>(null)
  const [priceDrafts, setPriceDrafts] = useState<Record<string, PriceDraft>>({})
  const [priceStatus, setPriceStatus] = useState<Record<string, PriceStatus>>({})
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>(null)
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null)
  const [providerEditBusy, setProviderEditBusy] = useState(false)
  /** Lỗi gốc chưa dịch của modal sửa provider; dịch ở bước render. */
  const [providerEditError, setProviderEditError] = useState<unknown>(null)
  /** Bản chỉnh sửa cục bộ để UI tự cập nhật ngay cả khi App chưa tải lại. */
  const [overrides, setOverrides] = useState<Record<string, Partial<Provider>>>({})
  /** Số key đã tải của từng provider, do bảng key báo lên. */
  const [keyCounts, setKeyCounts] = useState<Record<string, number>>({})
  const { t, locale } = useTranslation(shellCatalog)
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

  // Lối tắt từ Nhật ký sử dụng mở thẳng Model catalog; đổi prop là đổi tab.
  useEffect(() => {
    setActiveTab(initialTab)
  }, [initialTab])

  /** Bản nháp của một model: ưu tiên chữ đang gõ, chưa có thì suy từ dữ liệu model. */
  const priceDraftOf = useCallback(
    (model: ModelInfo): PriceDraft => priceDrafts[model.id] ?? draftFromModel(model),
    [priceDrafts],
  )

  const editPrice = useCallback((model: ModelInfo, field: keyof PriceDraft, value: string) => {
    setPriceDrafts((current) => ({
      ...current,
      [model.id]: { ...(current[model.id] ?? draftFromModel(model)), [field]: value },
    }))
    // Người dùng sửa lại thì bỏ trạng thái "Đã lưu"/lỗi của lần trước.
    setPriceStatus((current) => {
      if (!current[model.id]) return current
      const next = { ...current }
      delete next[model.id]
      return next
    })
  }, [])

  /** Lưu đơn giá: rỗng là xoá giá, số âm/chữ là lỗi và không gọi API. */
  async function savePrice(model: ModelInfo) {
    const draft = priceDraftOf(model)
    const unit = parsePrice(draft.priceUnit)
    const input = parsePrice(draft.priceInput1k)
    const output = parsePrice(draft.priceOutput1k)
    if (unit === undefined || input === undefined || output === undefined) {
      setPriceStatus((current) => ({ ...current, [model.id]: { state: 'error', message: t('modelPriceInvalid') } }))
      return
    }
    setPriceStatus((current) => ({ ...current, [model.id]: { state: 'saving' } }))
    const saved = await onUpdateModel(model.id, {
      priceUnit: unit,
      priceInput1k: input,
      priceOutput1k: output,
      priceCurrency: draft.currency.trim() || 'USD',
    })
    setPriceStatus((current) => ({
      ...current,
      [model.id]: saved ? { state: 'saved' } : { state: 'error', message: t('modelPriceSaveFailed') },
    }))
    if (saved) {
      // Bỏ bản nháp để hàng model lấy đúng đơn giá vừa lưu.
      setPriceDrafts((current) => {
        const next = { ...current }
        delete next[model.id]
        return next
      })
    }
  }

  /** Tóm tắt đơn giá hiển thị ngay trên hàng model khi chưa mở khối nhập. */
  const priceSummary = (model: ModelInfo): string => {
    const currency = model.priceCurrency || 'USD'
    const money = (value: number) => `${formatNumber(value, { maximumFractionDigits: 4 }, locale)} ${currency}`
    if (usesTokenPricing(model.kind)) {
      const parts: string[] = []
      if (model.priceInput1k != null) parts.push(t('modelPriceSummaryInput', { price: money(model.priceInput1k) }))
      if (model.priceOutput1k != null) parts.push(t('modelPriceSummaryOutput', { price: money(model.priceOutput1k) }))
      return parts.length ? parts.join(' · ') : ''
    }
    return model.priceUnit == null ? '' : t('modelPriceSummaryUnit', { price: money(model.priceUnit) })
  }

  const priceStatusText = (status: PriceStatus | undefined): string => {
    if (!status) return ''
    if (status.state === 'error') return status.message ?? ''
    return t(status.state === 'saving' ? 'modelPriceSaving' : 'modelPriceSaved')
  }

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
              <em className="catalog-note-price">{t('modelPriceNote')}</em>
            </span>
          </div>
          {models.length ? (
            models.map((model) => {
              const priceOpen = priceOpenId === model.id
              const draft = priceDraftOf(model)
              const status = priceStatus[model.id]
              const summary = priceSummary(model)
              return (
                <div className={`model-row ${priceOpen ? 'is-pricing' : ''}`} key={model.id}>
                  <div className={`model-kind ${kindClass(model.kind)}`}>
                    <ModelKindIcon kind={model.kind} />
                  </div>
                  <div className="model-details">
                    <strong>{model.displayName}</strong>
                    <span>{model.providerName} · {model.modelId}</span>
                    {/* Đơn giá hiện ngay trên hàng để không phải mở từng model. */}
                    <span className={`model-price-summary ${summary ? 'is-set' : ''}`}>
                      <Coins size={12} /> {summary || t('modelPriceNotSet')}
                    </span>
                  </div>
                  <div className="select-wrap model-kind-select">
                    <select
                      value={model.kind}
                      onChange={(event) => { void onUpdateModel(model.id, { kind: event.target.value as ModelKind }) }}
                      aria-label={t('classifyModelAria', { name: model.displayName })}
                    >
                      {MODEL_KIND_ORDER.map((option) => (
                        <option key={option} value={option}>{t(MODEL_KIND_KEYS[option])}</option>
                      ))}
                    </select>
                    <ChevronDown size={14} />
                  </div>
                  <button
                    type="button"
                    className="model-price-toggle"
                    aria-expanded={priceOpen}
                    aria-label={t('modelPriceOpenAria', { name: model.displayName })}
                    onClick={() => setPriceOpenId((current) => (current === model.id ? null : model.id))}
                  >
                    <Coins size={15} /> {t('modelPriceOpen')}
                  </button>
                  <button
                    className="model-edit"
                    onClick={() => onRemoveModel(model.id)}
                    aria-label={t('removeModelAria', { name: model.displayName })}
                  >
                    <Trash2 size={15} /> {t('delete')}
                  </button>

                  {priceOpen && (
                    <div className="model-price-editor" role="group" aria-label={t('modelPriceTitle', { name: model.displayName })}>
                      {usesTokenPricing(model.kind) ? (
                        <>
                          <label className="model-price-field">
                            <span>{t('modelPriceInput')}</span>
                            <input
                              type="number"
                              min="0"
                              inputMode="decimal"
                              value={draft.priceInput1k}
                              onChange={(event) => editPrice(model, 'priceInput1k', event.target.value)}
                              aria-label={`${t('modelPriceInput')} ${model.displayName}`}
                            />
                          </label>
                          <label className="model-price-field">
                            <span>{t('modelPriceOutput')}</span>
                            <input
                              type="number"
                              min="0"
                              inputMode="decimal"
                              value={draft.priceOutput1k}
                              onChange={(event) => editPrice(model, 'priceOutput1k', event.target.value)}
                              aria-label={`${t('modelPriceOutput')} ${model.displayName}`}
                            />
                          </label>
                        </>
                      ) : (
                        <label className="model-price-field">
                          <span>{t('modelPriceUnit')}</span>
                          <input
                            type="number"
                            min="0"
                            inputMode="decimal"
                            value={draft.priceUnit}
                            onChange={(event) => editPrice(model, 'priceUnit', event.target.value)}
                            aria-label={`${t('modelPriceUnit')} ${model.displayName}`}
                          />
                        </label>
                      )}
                      <label className="model-price-field is-currency">
                        <span>{t('modelPriceCurrency')}</span>
                        <input
                          type="text"
                          maxLength={10}
                          value={draft.currency}
                          onChange={(event) => editPrice(model, 'currency', event.target.value)}
                          aria-label={`${t('modelPriceCurrency')} ${model.displayName}`}
                        />
                      </label>
                      <div className="model-price-actions">
                        <button
                          type="button"
                          className="primary-small-button"
                          disabled={status?.state === 'saving'}
                          onClick={() => { void savePrice(model) }}
                        >
                          <Save size={13} /> {t('modelPriceSave')}
                        </button>
                        <button type="button" className="model-price-close" onClick={() => setPriceOpenId(null)}>
                          {t('modelPriceClose')}
                        </button>
                      </div>
                      <p className="model-price-hint">{t('modelPriceClearHint')}</p>
                      {status && (
                        <small
                          className={`model-price-status ${status.state === 'error' ? 'is-error' : status.state === 'saved' ? 'is-ok' : ''}`}
                          role="status"
                        >
                          {priceStatusText(status)}
                        </small>
                      )}
                    </div>
                  )}
                </div>
              )
            })
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

