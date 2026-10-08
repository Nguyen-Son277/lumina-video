import { useEffect, useMemo, useState } from 'react'
import {
  ArrowUpRight,
  BookOpen,
  Copy,
  Image as ImageIcon,
  KeyRound,
  LoaderCircle,
  Play,
  Settings2,
  Sparkles,
  Upload,
  Video,
} from 'lucide-react'
import { errorMessage } from '../api/client'
import { generationApi } from '../api/endpoints'
import type { Generation, GenerationParamsInput, ModelInfo, Mode } from '../api/types'
import { CreationCard, SelectControl, statusLabel } from '../components/Common'
import type { Page } from '../components/Sidebar'

type Props = {
  mode: Mode
  onModeChange: (mode: Mode) => void
  models: ModelInfo[]
  creations: Generation[]
  loading: boolean
  onCreated: (generation: Generation) => void
  onNavigate: (page: Page) => void
  onNotify: (message: string) => void
}

export function StudioPage({
  mode, onModeChange, models, creations, loading, onCreated, onNavigate, onNotify,
}: Props) {
  const [prompt, setPrompt] = useState('')
  const [modelId, setModelId] = useState('')
  const [size, setSize] = useState('1024x1024')
  const [quality, setQuality] = useState('high')
  const [seconds, setSeconds] = useState('4')
  const [count, setCount] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const modelsForMode = useMemo(
    () => models.filter((model) => model.kind === mode && model.enabled),
    [models, mode],
  )

  const providerOptions = useMemo(
    () => Array.from(new Map(modelsForMode.map((model) => [model.providerId, model.providerName])).entries())
      .map(([value, label]) => ({ value, label })),
    [modelsForMode],
  )

  const [providerId, setProviderId] = useState('')
  useEffect(() => {
    const first = modelsForMode[0]
    setProviderId(first?.providerId ?? '')
    setModelId(first?.id ?? '')
  }, [modelsForMode])

  const providerModels = useMemo(
    () => modelsForMode.filter((model) => model.providerId === providerId),
    [modelsForMode, providerId],
  )

  const selectedModel = modelsForMode.find((model) => model.id === modelId)
  const latest = creations[0]
  const latestAsset = latest?.assets[0]

  async function generate() {
    if (busy || !prompt.trim() || !selectedModel) return

    setError('')
    setBusy(true)
    try {
      const params: GenerationParamsInput =
        mode === 'image'
          ? { size, quality, n: count }
          : { size, seconds }

      const result = await generationApi.create({
        modelId: selectedModel.id,
        prompt: prompt.trim(),
        params,
        // Khóa chống gửi trùng cho lần bấm này.
        idempotencyKey: crypto.randomUUID(),
      })
      onCreated(result.generation)
      onNotify('Đã gửi yêu cầu. Kết quả sẽ xuất hiện khi provider xử lý xong.')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page-content studio-page">
      <section className="page-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-dot" /> Studio</div>
          <h1>Tạo nội dung <em>với API của bạn.</em></h1>
          <p>Chọn provider, model và bắt đầu tạo ảnh hoặc video.</p>
        </div>
        <button className="secondary-button" onClick={() => onNavigate('library')}>
          <BookOpen size={16} /> Mở thư viện <ArrowUpRight size={15} />
        </button>
      </section>

      <div className="studio-grid">
        <section className="composer-card panel-card">
          <div className="mode-tabs">
            <button className={mode === 'image' ? 'active' : ''} onClick={() => onModeChange('image')}>
              <ImageIcon size={17} /> Tạo ảnh
            </button>
            <button className={mode === 'video' ? 'active' : ''} onClick={() => onModeChange('video')}>
              <Video size={17} /> Tạo video <span className="beta-pill">BETA</span>
            </button>
          </div>

          <div className="composer-body">
            <div className="field-label-row">
              <label htmlFor="prompt">Mô tả ý tưởng</label>
              <span className="counter">{prompt.length} / 8.000</span>
            </div>
            <div className="prompt-box">
              <textarea
                id="prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Mô tả điều bạn muốn tạo..."
                maxLength={8000}
              />
              <div className="prompt-footer">
                <button className="attach-button" onClick={() => onNotify('Ảnh tham chiếu chưa được hỗ trợ.')}>
                  <Upload size={15} /> Thêm ảnh tham chiếu
                </button>
              </div>
            </div>

            <div className="control-section">
              <div className="section-title">Cấu hình</div>
              {modelsForMode.length ? (
                <div className="controls-grid">
                  <SelectControl
                    label="Provider"
                    value={providerId}
                    options={providerOptions}
                    onChange={(value) => {
                      setProviderId(value)
                      const first = modelsForMode.find((model) => model.providerId === value)
                      if (first) setModelId(first.id)
                    }}
                  />
                  <SelectControl
                    label="Model"
                    value={selectedModel?.id ?? ''}
                    options={providerModels.map((model) => ({ value: model.id, label: model.displayName }))}
                    onChange={setModelId}
                  />
                  {mode === 'image' ? (
                    <>
                      <SelectControl
                        label="Kích thước"
                        value={size}
                        options={[
                          { value: '1024x1024', label: '1024x1024 · Vuông' },
                          { value: '1536x1024', label: '1536x1024 · Ngang' },
                          { value: '1024x1536', label: '1024x1536 · Dọc' },
                        ]}
                        onChange={setSize}
                      />
                      <SelectControl
                        label="Chất lượng"
                        value={quality}
                        options={[
                          { value: 'low', label: 'Thấp · Nhanh' },
                          { value: 'medium', label: 'Trung bình' },
                          { value: 'high', label: 'Cao' },
                        ]}
                        onChange={setQuality}
                      />
                      <SelectControl
                        label="Số ảnh"
                        value={String(count)}
                        options={[1, 2, 3, 4].map((value) => ({ value: String(value), label: `${value} ảnh` }))}
                        onChange={(value) => setCount(Number(value))}
                      />
                    </>
                  ) : (
                    <>
                      <SelectControl
                        label="Kích thước"
                        value={size}
                        options={[
                          { value: '1280x720', label: '1280x720 · Ngang' },
                          { value: '720x1280', label: '720x1280 · Dọc' },
                        ]}
                        onChange={setSize}
                      />
                      <SelectControl
                        label="Thời lượng"
                        value={seconds}
                        options={[
                          { value: '4', label: '4 giây' },
                          { value: '8', label: '8 giây' },
                          { value: '12', label: '12 giây' },
                        ]}
                        onChange={setSeconds}
                      />
                    </>
                  )}
                </div>
              ) : (
                <div className="empty-config">
                  <KeyRound size={20} />
                  <strong>Chưa có model {mode === 'image' ? 'ảnh' : 'video'}</strong>
                  <span>Thêm provider và phân loại model trong API &amp; Models để bắt đầu.</span>
                  <button className="text-button" onClick={() => onNavigate('settings')}>
                    Mở API &amp; Models <ArrowUpRight size={14} />
                  </button>
                </div>
              )}
            </div>

            {error && <div className="form-error">{error}</div>}

            <div className="advanced-row">
              <button onClick={() => onNotify('Thông số nâng cao phụ thuộc từng provider.')}>
                <Settings2 size={15} /> Thông số nâng cao
              </button>
              <span>
                <span className={`status-dot ${selectedModel ? 'ok' : ''}`} />
                {selectedModel ? 'Sẵn sàng' : 'Chưa cấu hình API'}
              </span>
            </div>

            <button
              className="generate-button"
              onClick={generate}
              disabled={busy || !prompt.trim() || !selectedModel}
            >
              {busy ? <LoaderCircle size={18} className="spin" /> : <Sparkles size={18} />}
              {busy ? 'Đang gửi...' : mode === 'image' ? 'Tạo hình ảnh' : 'Tạo video'}
            </button>
            <p className="cost-note">
              {selectedModel
                ? 'Mỗi lần tạo sẽ dùng API key của bạn và có thể phát sinh chi phí từ provider.'
                : 'Chưa có provider/model. Hãy thêm kết nối trong API & Models trước.'}
            </p>
          </div>
        </section>

        <section className="preview-column">
          <div className="preview-header">
            <div><div className="section-kicker">Kết quả gần đây</div><h2>Không gian của bạn</h2></div>
            <button className="text-button" onClick={() => onNavigate('library')}>
              Xem tất cả <ArrowUpRight size={14} />
            </button>
          </div>

          <div className={`result-preview ${latest ? (latest.kind === 'video' ? 'violet' : 'sunset') : 'idle'}`}>
            {latestAsset && latest.kind === 'image' && <img src={latestAsset.url} alt={latest.prompt} />}
            {latestAsset && latest.kind === 'video' && (
              <video src={latestAsset.url} controls preload="metadata" />
            )}
            {!latestAsset && (
              <div className="preview-placeholder">
                {latest && (latest.status === 'queued' || latest.status === 'running' || latest.status === 'downloading')
                  ? <LoaderCircle size={26} className="spin" />
                  : <Sparkles size={26} />}
                <span>{latest ? statusLabel(latest.status) : 'Chưa có kết quả nào'}</span>
              </div>
            )}
            {latest && (
              <div className="preview-meta">
                <div>
                  <span className="result-type">
                    {latest.kind === 'video' ? 'Video' : 'Image'} · {statusLabel(latest.status)}
                    {latest.progress !== null && latest.status !== 'succeeded' ? ` ${latest.progress}%` : ''}
                  </span>
                  <strong>{latest.prompt.slice(0, 60)}</strong>
                </div>
                <button
                  className="round-icon"
                  onClick={() => {
                    void navigator.clipboard?.writeText(latest.prompt)
                    onNotify('Đã sao chép prompt.')
                  }}
                  aria-label="Sao chép prompt"
                >
                  <Copy size={15} />
                </button>
              </div>
            )}
          </div>

          <div className="quick-stats">
            <div><span>Tổng creations</span><strong>{creations.length.toString().padStart(2, '0')}</strong></div>
            <div><span>Provider đang dùng</span><strong>{selectedModel?.providerName ?? 'Chưa cấu hình'}</strong></div>
            <div><span>Model đang chọn</span><strong>{selectedModel?.displayName ?? '—'}</strong></div>
          </div>
        </section>
      </div>

      <div className="recent-heading">
        <div><div className="section-kicker">Your canvas</div><h2>Creations gần đây</h2></div>
      </div>
      {loading ? (
        <div className="empty-state"><LoaderCircle size={26} className="spin" /><h3>Đang tải...</h3></div>
      ) : creations.length ? (
        <div className="creation-strip">
          {creations.slice(0, 3).map((generation) => (
            <CreationCard key={generation.id} generation={generation} />
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <Sparkles size={28} />
          <h3>Chưa có kết quả nào</h3>
          <p>Kết quả tạo ảnh và video sẽ xuất hiện ở đây.</p>
        </div>
      )}
    </div>
  )
}
