import { useState } from 'react'
import {
  BrainCircuit,
  Check,
  ChevronDown,
  Image as ImageIcon,
  KeyRound,
  Layers3,
  LoaderCircle,
  Plus,
  RefreshCw,
  Settings2,
  Sparkles,
  Trash2,
  TriangleAlert,
  Video,
  X,
} from 'lucide-react'
import type { ImageApiStyle, LlmConnection, ModelInfo, ModelKind, Provider } from '../api/types'
import { ApiError, errorMessage } from '../api/client'
import { llmApi } from '../api/endpoints'

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

export function SettingsPage({ providers, models, llmConnections, onAddProvider, onAddModel, onAddLlm, onRemoveProvider, onUpdateProvider, onRemoveModel, onUpdateModel, onTest, onSync, onRemoveLlm, onTestLlm, onUpdateLlmModel, onNotifyLlm, busyId }: {
  providers: Provider[]
  models: ModelInfo[]
  /** Kết nối LLM dùng cho chat và tạo kịch bản ở giai đoạn sau. */
  llmConnections: LlmConnection[]
  onAddProvider: () => void
  onAddModel: () => void
  onAddLlm: () => void
  onRemoveProvider: (id: string) => void
  onUpdateProvider: (id: string, patch: { imageApiStyle: ImageApiStyle }) => void
  onRemoveModel: (id: string) => void
  onUpdateModel: (id: string, patch: { kind?: ModelKind; enabled?: boolean }) => void
  onTest: (id: string) => void
  onSync: (id: string) => void
  onRemoveLlm: (id: string) => void
  onTestLlm: (id: string) => void
  onUpdateLlmModel: (id: string, modelId: string) => void
  onNotifyLlm: (message: string) => void
  busyId: string | null
}) {
  const [activeTab, setActiveTab] = useState<'providers' | 'models' | 'llm'>('providers')
  /**
   * Model đã tải cho từng kết nối. Chỉ là gợi ý trong phiên hiện tại; kết nối
   * vẫn lưu đúng một `modelId` đã chọn.
   */
  const [llmModels, setLlmModels] = useState<Record<string, string[]>>({})
  const [llmLoading, setLlmLoading] = useState('')
  /** Kết nối không hỗ trợ /models thì cho nhập model thủ công. */
  const [llmManual, setLlmManual] = useState<Record<string, boolean>>({})

  /**
   * Tải danh sách model của một kết nối đã lưu để người dùng chọn.
   *
   * Không tự chọn model đầu tiên: model ảnh hưởng tới chi phí và chất lượng nên
   * người dùng phải chủ động chọn.
   */
  async function loadLlmModels(connection: LlmConnection) {
    setLlmLoading(connection.id)
    try {
      const result = await llmApi.models(connection.id)
      setLlmModels((current) => ({ ...current, [connection.id]: result.models }))
      if (!result.models.length) {
        setLlmManual((current) => ({ ...current, [connection.id]: true }))
        onNotifyLlm('Provider không trả về model nào. Hãy nhập model thủ công.')
      }
    } catch (cause) {
      // Provider không có GET /models vẫn dùng được bằng cách nhập model thủ công.
      if (cause instanceof ApiError && cause.code === 'MODELS_UNSUPPORTED') {
        setLlmManual((current) => ({ ...current, [connection.id]: true }))
        onNotifyLlm('Provider không hỗ trợ /models. Hãy nhập model thủ công.')
        return
      }
      onNotifyLlm(errorMessage(cause))
    } finally {
      setLlmLoading('')
    }
  }

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
          <button className="secondary-button" onClick={onAddLlm}><BrainCircuit size={16} /> Thêm LLM</button>
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
        <button className={activeTab === 'llm' ? 'active' : ''} onClick={() => setActiveTab('llm')}>
          <BrainCircuit size={16} /> LLM &amp; Chat <span className="tab-count">{llmConnections.length}</span>
        </button>
      </div>

      {activeTab === 'llm' ? (
        <>
          <div className="notice-banner">
            <BrainCircuit size={18} />
            <div>
              <strong>Key LLM dùng cho chat và tạo kịch bản</strong>
              <p>
                Key được mã hóa AES-256-GCM và chỉ giải mã ở máy chủ khi gọi model. Tính năng chat và
                tạo kịch bản sẽ dùng chính kết nối này.
              </p>
            </div>
          </div>

          {llmConnections.length ? (
            <div className="provider-list">
              {llmConnections.map((connection) => (
                <div className="provider-row" key={connection.id}>
                  <div className="provider-brand">{connection.name.slice(0, 1).toUpperCase()}</div>
                  <div className="provider-main">
                    <div className="provider-name-row">
                      <strong>{connection.name}</strong>
                      {connection.status === 'connected' ? (
                        <span className="connected-pill"><span /> Đã kết nối</span>
                      ) : connection.status === 'error' ? (
                        <span className="not-connected-pill" title={connection.lastError ?? ''}>Lỗi kết nối</span>
                      ) : (
                        <span className="not-connected-pill">Chưa kiểm tra</span>
                      )}
                      {!connection.modelId && (
                        <span className="not-connected-pill" title="Bấm Tải model rồi chọn model chat">
                          Chưa chọn model
                        </span>
                      )}
                    </div>
                    <span className="provider-url">{connection.baseUrl}</span>
                  </div>
                  <label className="provider-image-style">
                    <span>Model chat</span>
                    {/* Nhập tay khi provider không có GET /models. */}
                    {llmManual[connection.id] ? (
                      <input
                        className="llm-model-input"
                        aria-label={`Model chat của ${connection.name}`}
                        placeholder="Ví dụ: gpt-4o-mini"
                        defaultValue={connection.modelId}
                        disabled={busyId === connection.id}
                        onBlur={(event) => {
                          const value = event.target.value.trim()
                          if (value && value !== connection.modelId) {
                            onUpdateLlmModel(connection.id, value)
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') event.currentTarget.blur()
                        }}
                      />
                    ) : (
                      (() => {
                        const options = llmModels[connection.id] ?? []
                        const list = connection.modelId && !options.includes(connection.modelId)
                          ? [connection.modelId, ...options]
                          : options
                        return (
                          <div className="select-wrap llm-model-select">
                            <select
                              aria-label={`Model chat của ${connection.name}`}
                              value={connection.modelId}
                              disabled={busyId === connection.id || !list.length}
                              onChange={(event) => onUpdateLlmModel(connection.id, event.target.value)}
                            >
                              {/* Chưa chọn model thì phải tải danh sách rồi chọn. */}
                              {!connection.modelId && (
                                <option value="">
                                  {list.length ? 'Chọn model' : 'Bấm "Tải model" trước'}
                                </option>
                              )}
                              {list.map((model) => <option key={model} value={model}>{model}</option>)}
                              {!list.length && connection.modelId && (
                                <option value={connection.modelId}>{connection.modelId}</option>
                              )}
                            </select>
                            <ChevronDown size={13} />
                          </div>
                        )
                      })()
                    )}
                  </label>
                  <button
                    className="row-action"
                    onClick={() => void loadLlmModels(connection)}
                    disabled={busyId === connection.id || llmLoading === connection.id}
                    title="Tải danh sách model chat"
                  >
                    {llmLoading === connection.id
                      ? <LoaderCircle size={15} className="spin" />
                      : <Layers3 size={15} />} Tải model
                  </button>
                  <div className="provider-key"><KeyRound size={13} />{connection.keyHint}</div>
                  <button
                    className="row-action"
                    onClick={() => onTestLlm(connection.id)}
                    disabled={busyId === connection.id}
                  >
                    {busyId === connection.id
                      ? <LoaderCircle size={15} className="spin" />
                      : <RefreshCw size={15} />} Kiểm tra
                  </button>
                  <button
                    className="row-more"
                    onClick={() => onRemoveLlm(connection.id)}
                    aria-label={`Xóa kết nối ${connection.name}`}
                    title="Xóa kết nối"
                    disabled={busyId === connection.id}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-settings">
              <BrainCircuit size={24} />
              <strong>Chưa có kết nối LLM</strong>
              <span>Chỉ cần Base URL và API key — ứng dụng tải danh sách model để bạn chọn.</span>
              <button className="primary-small-button" onClick={onAddLlm}>
                <Sparkles size={15} /> Thêm kết nối LLM
              </button>
            </div>
          )}
        </>
      ) : activeTab === 'providers' ? (
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

/**
 * Modal thêm kết nối LLM.
 *
 * Người dùng chỉ nhập Base URL, API key và tên hiển thị. Bấm **Kiểm tra kết nối**
 * để xác nhận credential hoạt động; chỉ khi kiểm tra thành công mới lưu được.
 * Model chat được tải và chọn sau, ngay tại danh sách kết nối.
 */
type LlmTestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; count: number }
  | { kind: 'unsupported'; message: string }
  | { kind: 'error'; message: string }

export function LlmModal({ onClose, onSave, busy, error }: {
  onClose: () => void
  onSave: (draft: { name?: string; baseUrl: string; apiKey: string }) => void
  busy: boolean
  error: string
}) {
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [test, setTest] = useState<LlmTestState>({ kind: 'idle' })

  const filled = Boolean(baseUrl.trim() && apiKey.trim())
  const canTest = filled && test.kind !== 'testing' && !busy
  // Bắt buộc kiểm tra thành công trước khi lưu; ngoại lệ là provider không hỗ
  // trợ /models — vẫn cho lưu kèm cảnh báo, nếu không sẽ không thêm được.
  const canSave = filled && (test.kind === 'ok' || test.kind === 'unsupported') && !busy

  async function runTest() {
    setTest({ kind: 'testing' })
    try {
      const result = await llmApi.discoverModels({
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
      })
      if (!result.models.length) {
        setTest({
          kind: 'unsupported',
          message:
            'Kết nối hoạt động nhưng provider không trả về model nào. Sau khi lưu, hãy nhập model thủ công.',
        })
        return
      }
      setTest({ kind: 'ok', count: result.models.length })
    } catch (cause) {
      // Provider không có GET /models vẫn là kết nối dùng được.
      if (cause instanceof ApiError && cause.code === 'MODELS_UNSUPPORTED') {
        setTest({
          kind: 'unsupported',
          message:
            'Kết nối hoạt động nhưng provider không hỗ trợ /models. Sau khi lưu, hãy nhập model thủ công.',
        })
        return
      }
      setTest({ kind: 'error', message: errorMessage(cause) })
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-label="Thêm kết nối LLM">
        <div className="modal-header">
          <div>
            <div className="eyebrow"><span className="eyebrow-dot" /> New LLM</div>
            <h2>Thêm kết nối LLM</h2>
          </div>
          <button className="close-button" onClick={onClose} aria-label="Đóng"><X size={18} /></button>
        </div>
        <p className="modal-description">
          Chỉ cần Base URL, API key và tên hiển thị. Bấm <strong>Kiểm tra kết nối</strong> để chắc
          chắn key hoạt động, sau đó lưu lại. Model chat sẽ được tải và chọn ở danh sách kết nối.
        </p>
        <div className="modal-form">
          <label>
            Base URL
            <input
              placeholder="https://api.openai.com/v1"
              value={baseUrl}
              onChange={(event) => {
                setBaseUrl(event.target.value)
                // Đổi đích thì kết quả kiểm tra cũ không còn giá trị.
                setTest({ kind: 'idle' })
              }}
            />
          </label>
          <label>
            API key
            <div className="key-input">
              <KeyRound size={15} />
              <input
                type="password"
                placeholder="sk-••••••••••••••••"
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value)
                  setTest({ kind: 'idle' })
                }}
              />
            </div>
          </label>

          <label>
            Tên hiển thị (tùy chọn)
            <input
              placeholder="Để trống sẽ lấy theo tên miền"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>

          <button
            type="button"
            className="secondary-button llm-discover-button"
            disabled={!canTest}
            onClick={() => void runTest()}
          >
            {test.kind === 'testing'
              ? <LoaderCircle size={15} className="spin" />
              : <RefreshCw size={15} />} Kiểm tra kết nối
          </button>

          {test.kind === 'ok' && (
            <div className="llm-test-result ok" role="status">
              <Check size={14} /> Kết nối hoạt động · tìm thấy {test.count} model
            </div>
          )}
          {test.kind === 'unsupported' && (
            <div className="llm-test-result warn" role="status">
              <TriangleAlert size={14} /> {test.message}
            </div>
          )}
          {test.kind === 'error' && (
            <div className="llm-test-result error" role="alert">
              <TriangleAlert size={14} /> {test.message}
            </div>
          )}
          {test.kind === 'idle' && (
            <p className="llm-test-hint">Hãy kiểm tra kết nối trước khi lưu.</p>
          )}

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
            onClick={() =>
              onSave({
                ...(name.trim() ? { name: name.trim() } : {}),
                baseUrl: baseUrl.trim(),
                apiKey: apiKey.trim(),
              })
            }
          >
            {busy ? <LoaderCircle size={15} className="spin" /> : null} Lưu kết nối
          </button>
        </div>
      </div>
    </div>
  )
}

export { Check }
