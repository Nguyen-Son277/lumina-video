import { useState } from 'react'
import {
  Check,
  ChevronDown,
  Image as ImageIcon,
  KeyRound,
  Layers3,
  LoaderCircle,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
  Video,
  X,
} from 'lucide-react'
import type { ImageApiStyle, ModelInfo, ModelKind, Provider } from '../api/types'

export function ProviderModal({ onClose, onSave, busy, error }: {
  onClose: () => void
  onSave: (draft: { name: string; baseUrl: string; apiKey: string; imageApiStyle: ImageApiStyle }) => void
  busy: boolean
  error: string
}) {
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [imageApiStyle, setImageApiStyle] = useState<ImageApiStyle>('openai')
  const canSave = Boolean(name.trim() && baseUrl.trim() && apiKey.trim()) && !busy

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="modal-card">
        <div className="modal-header">
          <div>
            <div className="eyebrow"><span className="eyebrow-dot" /> New connection</div>
            <h2>Thêm provider</h2>
          </div>
          <button className="close-button" onClick={onClose} aria-label="Đóng"><X size={18} /></button>
        </div>
        <p className="modal-description">
          Kết nối một endpoint tương thích OpenAI bằng Base URL và API key.
        </p>
        <div className="modal-form">
          <label>
            Tên hiển thị
            <input
              placeholder="Ví dụ: Production gateway"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            Base URL
            <input
              placeholder="https://api.example.com/v1"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </label>
          <label>
            Kiểu API tạo ảnh
            <div className="select-wrap">
              <select
                value={imageApiStyle}
                onChange={(event) => setImageApiStyle(event.target.value as ImageApiStyle)}
              >
                <option value="openai">Chuẩn OpenAI · /images/generations và /images/edits</option>
                <option value="extra_body">Ảnh nguồn trong extra_body · Agnes và gateway tương tự</option>
              </select>
              <ChevronDown size={14} />
            </div>
          </label>
          <label>
            API key
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
            <KeyRound size={14} /> Key được mã hóa AES-256-GCM và không bao giờ hiển thị lại.
          </div>
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose}>Hủy</button>
          <button
            className="primary-small-button"
            disabled={!canSave}
            onClick={() => onSave({ name, baseUrl, apiKey, imageApiStyle })}
          >
            {busy ? <LoaderCircle size={15} className="spin" /> : null} Lưu provider
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
  error: string
}) {
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '')
  const [modelId, setModelId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [kind, setKind] = useState<ModelKind>('image')
  const canSave = Boolean(providerId && modelId.trim()) && !busy

  if (!providers.length) {
    return (
      <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
        <div className="modal-card">
          <div className="modal-header">
            <div><div className="eyebrow"><span className="eyebrow-dot" /> Model</div><h2>Chưa có provider</h2></div>
            <button className="close-button" onClick={onClose} aria-label="Đóng"><X size={18} /></button>
          </div>
          <p className="modal-description">Bạn cần thêm provider trước khi thêm model.</p>
          <div className="modal-actions">
            <button className="secondary-button" onClick={onClose}>Hủy</button>
            <button className="primary-small-button" onClick={onNeedProvider}>Thêm provider</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="modal-card">
        <div className="modal-header">
          <div><div className="eyebrow"><span className="eyebrow-dot" /> Model</div><h2>Thêm model</h2></div>
          <button className="close-button" onClick={onClose} aria-label="Đóng"><X size={18} /></button>
        </div>
        <p className="modal-description">
          Nhập đúng model ID mà provider yêu cầu, sau đó chọn loại nội dung.
        </p>
        <div className="modal-form">
          <label>
            Provider
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
            Model ID
            <input
              placeholder="Ví dụ: gpt-image-1"
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
            />
          </label>
          <label>
            Tên hiển thị (tùy chọn)
            <input
              placeholder="Ví dụ: GPT Image 1"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
          <div className="kind-picker">
            {(['image', 'video', 'unclassified'] as ModelKind[]).map((option) => (
              <button
                key={option}
                className={kind === option ? 'active' : ''}
                onClick={() => setKind(option)}
                type="button"
              >
                {option === 'image' ? <ImageIcon size={15} /> : option === 'video' ? <Video size={15} /> : <Layers3 size={15} />}
                {option === 'image' ? 'Tạo ảnh' : option === 'video' ? 'Tạo video' : 'Chưa phân loại'}
              </button>
            ))}
          </div>
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose}>Hủy</button>
          <button
            className="primary-small-button"
            disabled={!canSave}
            onClick={() => onSave({ providerId, modelId, displayName, kind })}
          >
            {busy ? <LoaderCircle size={15} className="spin" /> : null} Lưu model
          </button>
        </div>
      </div>
    </div>
  )
}

export function SettingsPage({ providers, models, onAddProvider, onAddModel, onRemoveProvider, onUpdateProvider, onRemoveModel, onUpdateModel, onTest, onSync, busyId }: {
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
}) {
  const [activeTab, setActiveTab] = useState<'providers' | 'models'>('providers')

  return (
    <div className="page-content settings-page">
      <section className="page-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-dot" /> Configuration</div>
          <h1>API <em>của bạn.</em></h1>
          <p>Thêm provider, sau đó thêm model và phân loại ảnh hoặc video.</p>
        </div>
        <div className="heading-actions">
          <button className="secondary-button" onClick={onAddModel}><Layers3 size={16} /> Thêm model</button>
          <button className="primary-small-button" onClick={onAddProvider}><Plus size={16} /> Thêm provider</button>
        </div>
      </section>

      <div className="settings-tabs">
        <button className={activeTab === 'providers' ? 'active' : ''} onClick={() => setActiveTab('providers')}>
          <KeyRound size={16} /> Providers <span className="tab-count">{providers.length}</span>
        </button>
        <button className={activeTab === 'models' ? 'active' : ''} onClick={() => setActiveTab('models')}>
          <Layers3 size={16} /> Model catalog <span className="tab-count">{models.length}</span>
        </button>
      </div>

      {activeTab === 'providers' ? (
        <>
          <div className="notice-banner">
            <KeyRound size={18} />
            <div>
              <strong>API key được mã hóa AES-256-GCM</strong>
              <p>Key chỉ được giải mã ở phía máy chủ khi gọi provider và không bao giờ trả về trình duyệt.</p>
            </div>
          </div>

          {providers.length ? (
            <div className="provider-list">
              {providers.map((provider) => (
                <div className="provider-row" key={provider.id}>
                  <div className="provider-brand">{provider.name.slice(0, 1).toUpperCase()}</div>
                  <div className="provider-main">
                    <div className="provider-name-row">
                      <strong>{provider.name}</strong>
                      {provider.status === 'connected' ? (
                        <span className="connected-pill"><span /> Đã kết nối</span>
                      ) : provider.status === 'error' ? (
                        <span className="not-connected-pill" title={provider.lastError ?? ''}>Lỗi kết nối</span>
                      ) : (
                        <span className="not-connected-pill">Chưa kiểm tra</span>
                      )}
                    </div>
                    <span className="provider-url">{provider.baseUrl}</span>
                  </div>
                  <div className="provider-model-count">
                    <strong>{provider.modelCount}</strong>
                    <span>models</span>
                  </div>
                  <div className="provider-key"><KeyRound size={13} />{provider.keyHint}</div>
                  <label className="provider-image-style">
                    <span>API ảnh</span>
                    <div className="select-wrap">
                      <select
                        aria-label={`Kiểu API ảnh của ${provider.name}`}
                        value={provider.imageApiStyle}
                        disabled={busyId === provider.id}
                        onChange={(event) =>
                          onUpdateProvider(provider.id, {
                            imageApiStyle: event.target.value as ImageApiStyle,
                          })
                        }
                      >
                        <option value="openai">Chuẩn OpenAI</option>
                        <option value="extra_body">extra_body (Agnes)</option>
                      </select>
                      <ChevronDown size={13} />
                    </div>
                  </label>
                  <button
                    className="row-action"
                    onClick={() => onSync(provider.id)}
                    disabled={busyId === provider.id}
                    title="Lấy danh sách model"
                  >
                    <Layers3 size={15} /> Đồng bộ
                  </button>
                  <button
                    className="row-action"
                    onClick={() => onTest(provider.id)}
                    disabled={busyId === provider.id}
                  >
                    {busyId === provider.id
                      ? <LoaderCircle size={15} className="spin" />
                      : <RefreshCw size={15} />} Kiểm tra
                  </button>
                  <button
                    className="row-more"
                    onClick={() => onRemoveProvider(provider.id)}
                    aria-label="Xóa provider"
                    title="Xóa provider"
                    disabled={busyId === provider.id}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-settings">
              <KeyRound size={24} />
              <strong>Danh sách provider đang trống</strong>
              <span>Thêm kết nối đầu tiên bằng Base URL và API key để bắt đầu.</span>
              <button className="primary-small-button" onClick={onAddProvider}>
                <Plus size={15} /> Thêm provider
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="model-catalog">
          <div className="catalog-note">
            <Settings2 size={17} />
            <span>
              Phân loại model theo khả năng thật của provider. Model chưa phân loại sẽ không xuất hiện trong Studio.
            </span>
          </div>
          {models.length ? (
            models.map((model) => (
              <div className="model-row" key={model.id}>
                <div className={`model-kind ${model.kind === 'image' ? 'image-kind' : model.kind === 'video' ? 'video-kind' : 'unknown-kind'}`}>
                  {model.kind === 'image' ? <ImageIcon size={15} /> : model.kind === 'video' ? <Video size={15} /> : <Layers3 size={15} />}
                </div>
                <div className="model-details">
                  <strong>{model.displayName}</strong>
                  <span>{model.providerName} · {model.modelId}</span>
                </div>
                <div className="select-wrap model-kind-select">
                  <select
                    value={model.kind}
                    onChange={(event) => onUpdateModel(model.id, { kind: event.target.value as ModelKind })}
                    aria-label={`Phân loại ${model.displayName}`}
                  >
                    <option value="image">Tạo ảnh</option>
                    <option value="video">Tạo video</option>
                    <option value="unclassified">Chưa phân loại</option>
                  </select>
                  <ChevronDown size={14} />
                </div>
                <button
                  className="model-edit"
                  onClick={() => onRemoveModel(model.id)}
                  aria-label={`Xóa ${model.displayName}`}
                >
                  <Trash2 size={15} /> Xóa
                </button>
              </div>
            ))
          ) : (
            <div className="empty-settings">
              <Layers3 size={24} />
              <strong>Chưa có model nào</strong>
              <span>Thêm provider rồi bấm Đồng bộ, hoặc thêm model thủ công.</span>
              <button className="primary-small-button" onClick={onAddModel}>
                <Plus size={15} /> Thêm model
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export { Check }
